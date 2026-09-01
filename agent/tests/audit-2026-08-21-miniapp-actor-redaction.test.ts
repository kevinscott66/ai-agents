/**
 * Аудит 2026-08-21: наблюдателю Mini App отдавался сырой Telegram-ID того, кто
 * нажал кнопку.
 *
 * `redactContent` резала ТЕЛА (payload/result/error/description), потому что
 * оттуда читались переписка и промпты. Но actor-поля телом не считаются и
 * проходили насквозь: `tasks.created_by` и `approvals.decided_by` пишутся как
 * `miniapp:<сырой telegram id>` (miniapp-server.ts, POST /api/tasks и
 * /api/approvals/:id/decide). То есть любой, кого пустили посмотреть, получал
 * личный ID администратора — по нему открывается t.me/{id} и профиль.
 *
 * Прецедент — #457, где ровно этот же ID утекал через budget_settings.updated_by.
 *
 * Резать поле целиком нельзя: заявленная политика модуля — «списки остаются
 * видимы (кто, что, когда, чем кончилось), тела — нет». Поэтому ID
 * укорачивается до последних четырёх цифр, как это уже делает
 * `redactUserId` в lib/log.ts.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { buildInitData } from "../lib/miniapp-auth.ts";
import {
  startMiniappServer,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";
import { createApproval, decideApproval } from "../lib/approvals.ts";
import { createTask } from "../lib/tasks.ts";
import { logAction } from "../lib/audit.ts";
import { db } from "../lib/db.ts";
import { _resetRateLimiter } from "../lib/http-utils.ts";

const BOT_TOKEN = "test_bot_token_for_actor_redaction";
// ID администратора намеренно не пересекается по цифрам с CHAT_ID: иначе
// проверка «сырого ID нет во всём ответе» ловила бы chat_id и была бы вечно
// красной вне зависимости от редакции.
const ADMIN_ID = 811_223_344;
const VIEWER_ID = 811_223_355; // в allowlist, но не админ
const CHAT_ID = -100_900_821;

/** Сырой ID, который уезжал в created_by / decided_by. */
const ACTOR = `miniapp:${ADMIN_ID}`;
const ACTOR_SHORT = "miniapp:…3344";

function initDataFor(userId: number): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: `q-${userId}`,
    user: JSON.stringify({ id: userId, first_name: "U" }),
  });
}

let server: MiniappServerHandle;
let base: string;
let taskId: string;
let agentTaskId: string;
let approvalId: string;

async function get(path: string, userId: number): Promise<any> {
  const r = await fetch(`${base}${path}`, {
    headers: { "X-Telegram-Init-Data": initDataFor(userId) },
  });
  expect(r.status).toBe(200);
  return r.json();
}

beforeAll(() => {
  server = startMiniappServer({
    port: 0,
    allowedUserIds: [ADMIN_ID, VIEWER_ID],
    adminUserIds: [ADMIN_ID],
    botToken: BOT_TOKEN,
  });
  base = `http://127.0.0.1:${server.port}`;

  // Задача, заведённая через Mini App: created_by = miniapp:<raw id>.
  // Контентных полей нет намеренно — так видно, что укорачивание актора не
  // ставит флаг `redacted` (он означает «тело скрыто», а тела здесь нет).
  taskId = createTask({
    chatId: CHAT_ID,
    createdBy: ACTOR,
    assignedTo: "aieng",
    title: "актор-редакция: задача из Mini App",
  }).id;

  // Контроль: актор-агент — не человек, укорачивать нечего.
  agentTaskId = createTask({
    chatId: CHAT_ID,
    createdBy: "smm",
    assignedTo: "aieng",
    title: "актор-редакция: задача от роли",
  }).id;

  const actionId = logAction({
    agentKey: "smm",
    chatId: CHAT_ID,
    actionType: "SEND_MESSAGE",
    payload: { chatId: CHAT_ID },
    status: "pending_approval",
  }).id;
  approvalId = createApproval({
    actionId,
    chatId: CHAT_ID,
    requestedBy: "smm",
    actionType: "SEND_MESSAGE",
    payload: { chatId: CHAT_ID },
  }).id;
  decideApproval(approvalId, "approved", ACTOR);
});

afterAll(() => {
  server.stop();
  _resetRateLimiter();
  db.prepare(`DELETE FROM tasks WHERE chat_id = ?`).run(CHAT_ID);
  db.prepare(`DELETE FROM approvals WHERE chat_id = ?`).run(CHAT_ID);
  db.prepare(`DELETE FROM agent_actions WHERE chat_id = ?`).run(CHAT_ID);
});

describe("наблюдатель не видит сырой Telegram-ID актора", () => {
  test("GET /api/tasks: created_by укорочен, ID не встречается нигде в ответе", async () => {
    const body = await get(`/api/tasks?chat_id=${CHAT_ID}&limit=200`, VIEWER_ID);
    // Утечка была именно здесь.
    expect(JSON.stringify(body)).not.toContain(String(ADMIN_ID));
    const mine = body.tasks.find((t: any) => t.id === taskId);
    expect(mine).toBeTruthy();
    expect(mine.created_by).toBe(ACTOR_SHORT);
    // Метаданные остаются: доска читаема.
    expect(mine.title).toBe("актор-редакция: задача из Mini App");
    expect(mine.assigned_to).toBe("aieng");
    // `redacted` означает «тело скрыто». Тела у этой строки нет.
    expect(mine.redacted).toBeUndefined();
  });

  test("GET /api/tasks: ключ роли — не человек, остаётся как есть", async () => {
    const body = await get(`/api/tasks?chat_id=${CHAT_ID}&limit=200`, VIEWER_ID);
    const agentRow = body.tasks.find((t: any) => t.id === agentTaskId);
    expect(agentRow).toBeTruthy();
    expect(agentRow.created_by).toBe("smm");
  });

  test("GET /api/approvals?status=approved: decided_by укорочен", async () => {
    const body = await get(
      `/api/approvals?status=approved&chat_id=${CHAT_ID}&limit=200`,
      VIEWER_ID,
    );
    expect(JSON.stringify(body)).not.toContain(String(ADMIN_ID));
    const mine = body.approvals.find((a: any) => a.id === approvalId);
    expect(mine).toBeTruthy();
    expect(mine.decided_by).toBe(ACTOR_SHORT);
    // requested_by — ключ роли, не трогаем.
    expect(mine.requested_by).toBe("smm");
    expect(mine.status).toBe("approved");
  });

  test("GET /api/dashboard: та же задача в recentTasks тоже укорочена", async () => {
    const body = await get(`/api/dashboard`, VIEWER_ID);
    expect(JSON.stringify(body)).not.toContain(String(ADMIN_ID));
    const mine = body.recentTasks.find((t: any) => t.id === taskId);
    if (mine) expect(mine.created_by).toBe(ACTOR_SHORT);
  });

  test("админу actor-поля видны целиком", async () => {
    const tasks = await get(`/api/tasks?chat_id=${CHAT_ID}&limit=200`, ADMIN_ID);
    expect(tasks.tasks.find((t: any) => t.id === taskId).created_by).toBe(ACTOR);
    const appr = await get(
      `/api/approvals?status=approved&chat_id=${CHAT_ID}&limit=200`,
      ADMIN_ID,
    );
    expect(appr.approvals.find((a: any) => a.id === approvalId).decided_by).toBe(
      ACTOR,
    );
  });
});
