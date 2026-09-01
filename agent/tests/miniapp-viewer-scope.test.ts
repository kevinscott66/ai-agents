/**
 * Что видит и что может «наблюдатель» Mini App (аудит 2026-08-02).
 *
 * MINIAPP_ALLOWED_USER_IDS и MINIAPP_ADMIN_USER_IDS — разные списки, и код
 * это предполагает: мутирующие ручки требуют админа, читающие — только
 * allowlist. То есть роль «пустили посмотреть, но прав не дали» существует.
 *
 * Ей при этом отдавались тела действий целиком: agent_actions.payload/result
 * и approvals.payload никогда не редактировались. Оттуда читаются тексты
 * исходящих сообщений по всем чатам, промпты MAC_RUN_CLAUDE, а из result у
 * LIST_RECENT_MESSAGES — дословная входящая переписка чатов, в которых
 * наблюдателя нет. chat_id был фильтром, а не ограничением.
 *
 * Плюс здесь же два ресурсных потолка, которых не было: рейт-лимит стоял
 * только на POST, а тяжёлые ручки — GET; и число SSE-потоков на пользователя
 * не считалось вообще.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { sseUrl } from "./_sse.ts";
import { buildInitData } from "../lib/miniapp-auth.ts";
import {
  startMiniappServer,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";
import { logAction } from "../lib/audit.ts";
import { createApproval } from "../lib/approvals.ts";
import { createTask, updateTaskStatus } from "../lib/tasks.ts";
import { db } from "../lib/db.ts";
import { _resetRateLimiter } from "../lib/http-utils.ts";

const BOT_TOKEN = "test_bot_token_for_viewer_scope";
const ADMIN_ID = 900_001;
const VIEWER_ID = 900_002; // в allowlist, но не админ
const CHAT_ID = -100_900_001;

const SECRET_TEXT = "пароль от сейфа лежит в третьем ящике";

function initDataFor(userId: number): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: `q-${userId}`,
    user: JSON.stringify({ id: userId, first_name: "U" }),
  });
}

let server: MiniappServerHandle;
let base: string;
let actionId: string;
let approvalId: string;
let errActionId: string;
let taskId: string;

async function get(path: string, userId: number): Promise<Response> {
  return fetch(`${base}${path}`, {
    headers: { "X-Telegram-Init-Data": initDataFor(userId) },
  });
}

beforeAll(() => {
  server = startMiniappServer({
    port: 0,
    allowedUserIds: [ADMIN_ID, VIEWER_ID],
    adminUserIds: [ADMIN_ID],
    botToken: BOT_TOKEN,
  });
  base = `http://127.0.0.1:${server.port}`;

  actionId = logAction({
    agentKey: "smm",
    chatId: CHAT_ID,
    actionType: "SEND_MESSAGE",
    payload: { chatId: CHAT_ID, text: SECRET_TEXT },
    // Было "success" — такого статуса в ActionStatus нет и logAction его
    // никогда не пишет; фикстура изображала строку, которой в agent_actions
    // не бывает. Успешное действие — это "ok".
    status: "ok",
    result: { messages: [{ text: SECRET_TEXT }] },
  }).id;

  approvalId = createApproval({
    actionId,
    chatId: CHAT_ID,
    requestedBy: "smm",
    actionType: "SEND_MESSAGE",
    payload: { chatId: CHAT_ID, text: SECRET_TEXT },
  }).id;

  // Повторный аудит 2026-08-04: `error` — такой же свободный текст от
  // хендлеров, как payload. Telegram возвращает в ошибке текст сообщения,
  // SPLIT_TASK склеивает причины отказов, QUERY_DB — фрагменты SQL.
  errActionId = logAction({
    agentKey: "smm",
    chatId: CHAT_ID,
    actionType: "SEND_MESSAGE",
    payload: { chatId: CHAT_ID },
    status: "error",
    error: `400: message text is invalid: ${SECRET_TEXT}`,
  }).id;

  // Ровно то, что делает C15 self-diag: провалившийся payload уезжает в
  // inputPayload задачи, а текст ошибки — в description.
  taskId = createTask({
    chatId: CHAT_ID,
    createdBy: "smm",
    assignedTo: "aieng",
    title: "Tool error: SEND_MESSAGE",
    description: `не отправилось: ${SECRET_TEXT}`,
    inputPayload: {
      actionType: "SEND_MESSAGE",
      payload: { text: SECRET_TEXT },
      _diag: true,
    },
  }).id;
  updateTaskStatus(taskId, "running");
  updateTaskStatus(taskId, "failed", {
    output: { lastAttempt: SECRET_TEXT },
    error: `retry exhausted: ${SECRET_TEXT}`,
  });
});

afterAll(() => {
  server.stop();
  _resetRateLimiter();
  db.prepare(`DELETE FROM tasks WHERE chat_id = ?`).run(CHAT_ID);
});

describe("наблюдатель не видит содержимое действий", () => {
  test("GET /api/actions: payload и result скрыты, метаданные остаются", async () => {
    const r = await get("/api/actions?limit=200", VIEWER_ID);
    expect(r.status).toBe(200);
    const body = await r.json();
    const mine = body.actions.find((a: any) => a.id === actionId);
    expect(mine).toBeTruthy();
    // Утечка была именно здесь.
    expect(JSON.stringify(body)).not.toContain(SECRET_TEXT);
    expect(mine.redacted).toBe(true);
    // Роут не должен превращаться в 403: список действий сам по себе нужен.
    expect(mine.action_type).toBe("SEND_MESSAGE");
    expect(mine.agent_key).toBe("smm");
    expect(mine.status).toBe("ok");
  });

  test("GET /api/actions: админ получает payload и result целиком", async () => {
    const r = await get("/api/actions?limit=200", ADMIN_ID);
    const body = await r.json();
    const mine = body.actions.find((a: any) => a.id === actionId);
    expect(mine.payload).toMatchObject({ text: SECRET_TEXT });
    expect(mine.redacted).toBeUndefined();
  });

  test("GET /api/approvals: очередь видна, тело заявки — нет", async () => {
    const r = await get("/api/approvals?status=pending&limit=200", VIEWER_ID);
    const body = await r.json();
    const mine = body.approvals.find((a: any) => a.id === approvalId);
    expect(mine).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain(SECRET_TEXT);
    expect(mine.redacted).toBe(true);
    expect(mine.action_type).toBe("SEND_MESSAGE");
  });

  test("GET /api/approvals: админ видит payload", async () => {
    const r = await get("/api/approvals?status=pending&limit=200", ADMIN_ID);
    const body = await r.json();
    const mine = body.approvals.find((a: any) => a.id === approvalId);
    expect(JSON.stringify(mine.payload)).toContain(SECRET_TEXT);
  });

  test("GET /api/dashboard: те же поля скрыты в агрегате", async () => {
    // Дашборд собирает те же строки отдельным кодом — редактировать надо и там.
    const r = await get("/api/dashboard", VIEWER_ID);
    expect(r.status).toBe(200);
    expect(await r.text()).not.toContain(SECRET_TEXT);
  });

  test("GET /api/actions: error режется наравне с payload", async () => {
    // Поля error в списке не было вовсе, при этом строка всё равно получала
    // redacted:true — то есть ВЫГЛЯДЕЛА очищенной, оставаясь дырой.
    const r = await get("/api/actions?limit=200", VIEWER_ID);
    const body = await r.json();
    const mine = body.actions.find((a: any) => a.id === errActionId);
    expect(mine).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain(SECRET_TEXT);
    expect(mine.redacted).toBe(true);
    expect(mine.status).toBe("error"); // сам факт провала виден
  });

  test("GET /api/actions: админ видит текст ошибки", async () => {
    const r = await get("/api/actions?limit=200", ADMIN_ID);
    const body = await r.json();
    const mine = body.actions.find((a: any) => a.id === errActionId);
    expect(mine.error).toContain(SECRET_TEXT);
  });
});

describe("наблюдатель не видит содержимое задач", () => {
  // /api/actions редактировался, а /api/tasks — нет, хотя C15 self-diag кладёт
  // провалившийся payload прямо в tasks.input. Скрытый в одном роуте payload
  // отдавался целиком соседним.
  test("GET /api/tasks: input/output/description/error скрыты", async () => {
    const r = await get("/api/tasks?limit=200", VIEWER_ID);
    expect(r.status).toBe(200);
    const body = await r.json();
    const mine = body.tasks.find((t: any) => t.id === taskId);
    expect(mine).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain(SECRET_TEXT);
    expect(mine.redacted).toBe(true);
    // Доска остаётся читаемой: кто, что, кому, чем кончилось.
    expect(mine.title).toBe("Tool error: SEND_MESSAGE");
    expect(mine.assigned_to).toBe("aieng");
    expect(mine.status).toBe("failed");
  });

  test("GET /api/tasks/:id: одиночная задача режется так же", async () => {
    const r = await get(`/api/tasks/${taskId}`, VIEWER_ID);
    expect(r.status).toBe(200);
    expect(await r.text()).not.toContain(SECRET_TEXT);
  });

  test("GET /api/dashboard: recentTasks режутся вместе с recentActions", async () => {
    const r = await get("/api/dashboard", VIEWER_ID);
    const text = await r.text();
    expect(text).not.toContain(SECRET_TEXT);
    const body = JSON.parse(text);
    expect(body.recentTasks.find((t: any) => t.id === taskId)?.redacted).toBe(
      true,
    );
  });

  test("админу задачи отдаются целиком", async () => {
    const r = await get(`/api/tasks/${taskId}`, ADMIN_ID);
    const body = await r.json();
    expect(body.task.description).toContain(SECRET_TEXT);
    expect(JSON.stringify(body.task.input)).toContain(SECRET_TEXT);
    expect(body.task.error).toContain(SECRET_TEXT);
    expect(body.task.redacted).toBeUndefined();
  });
});

describe("ресурсные потолки", () => {
  test("GET рейт-лимитится: серия запросов упирается в 429", async () => {
    _resetRateLimiter();
    // Ведро GET — 120 токенов, долив 4/сек. Запросы идут ПАРАЛЛЕЛЬНО намеренно:
    // при последовательных await 200 round-trip'ов растягивались на секунды, за
    // которые ведро успевало долиться, и тест то упирался в 5-секундный таймаут
    // bun, то (на медленной машине) вовсе не доходил до 429 — флак, а не баг.
    // Залпом долив не успевает ничего изменить.
    const codes = await Promise.all(
      Array.from({ length: 200 }, () =>
        get("/api/agents", VIEWER_ID).then((r) => r.status),
      ),
    );
    expect(codes.filter((c) => c === 200).length).toBeGreaterThan(100);
    expect(codes).toContain(429);
    _resetRateLimiter();
  }, 20_000);

  test("обычная навигация под лимит не попадает", async () => {
    _resetRateLimiter();
    // Dashboard делает ~5 запросов, Agents — по одному на каждую из 12 ролей.
    const codes = await Promise.all(
      Array.from({ length: 20 }, () =>
        get("/api/agents", ADMIN_ID).then((r) => r.status),
      ),
    );
    expect(codes.every((c) => c === 200)).toBe(true);
    _resetRateLimiter();
  });

  test("SSE: сверх лимита потоков на пользователя — 429", async () => {
    const ctrls: AbortController[] = [];
    const statuses: number[] = [];
    try {
      for (let i = 0; i < 7; i++) {
        const ac = new AbortController();
        ctrls.push(ac);
        const r = await fetch(
          await sseUrl(base, initDataFor(ADMIN_ID)),
          { signal: ac.signal },
        );
        statuses.push(r.status);
        if (r.status !== 200) ac.abort();
      }
      expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
      expect(statuses[5]).toBe(429);
    } finally {
      for (const c of ctrls) {
        try {
          c.abort();
        } catch {
          /* поток уже закрыт */
        }
      }
    }
  });

  test("после закрытия потоков счётчик освобождается", async () => {
    // Утечка счётчика была бы хуже отсутствия лимита: пользователь навсегда
    // терял бы live-обновления после нескольких переподключений.
    await Bun.sleep(50);
    const ac = new AbortController();
    const r = await fetch(
      await sseUrl(base, initDataFor(ADMIN_ID)),
      { signal: ac.signal },
    );
    expect(r.status).toBe(200);
    ac.abort();
  });
});
