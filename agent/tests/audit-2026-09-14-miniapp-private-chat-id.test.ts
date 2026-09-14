/**
 * Аудит 2026-09-14: id администратора уезжал наблюдателю через `chat_id`.
 *
 * Правило «человек-актор укорачивается до последних четырёх цифр»
 * (`redactContent`, `redactBusPayload` в miniapp-server.ts) смотрело только на
 * строки вида `miniapp:<id>` / `tg:<id>`. Но две ручки Mini App пишут аудит с
 * `chatId: user.id`: POST /api/permissions (`setPermission` → `logAction`) и
 * POST /api/mac/stop (`dispatchAndAudit("MAC_STOP")`). В Telegram id личного
 * чата с ботом совпадает с id человека, и в строке оказывалось
 * `agent_key: "miniapp:…3344"` рядом с `chat_id: 811223344` — укорачивание не
 * прятало ничего. Строку отдают наблюдателю `GET /api/actions` и блок
 * «последние действия» дашборда.
 *
 * Положительный `chat_id` — всегда личный чат, то есть человек; группы и
 * каналы в Bot API отрицательные. Mini App поле строк не читает (только
 * передаёт фильтром в запрос), так что `null` наблюдателю ничего не ломает.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { buildInitData } from "../lib/miniapp-auth.ts";
import { startMiniappServer, type MiniappServerHandle } from "../lib/miniapp-server.ts";
import { logAction } from "../lib/audit.ts";
import { db } from "../lib/db.ts";
import { _resetRateLimiter } from "../lib/http-utils.ts";

const BOT_TOKEN = "test_bot_token_private_chat_id";
const ADMIN_ID = 811_914_344;
const VIEWER_ID = 811_914_355;
const GROUP_CHAT = -100_900_914;
const AGENT = "miniapp:" + ADMIN_ID;

function initDataFor(userId: number): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: `q-${userId}`,
    user: JSON.stringify({ id: userId, first_name: "U" }),
  });
}

let server: MiniappServerHandle;
let base: string;

async function getText(path: string, userId: number): Promise<string> {
  const r = await fetch(`${base}${path}`, {
    headers: { "X-Telegram-Init-Data": initDataFor(userId) },
  });
  expect(r.status).toBe(200);
  return r.text();
}

beforeAll(() => {
  _resetRateLimiter();
  server = startMiniappServer({
    port: 0,
    allowedUserIds: [ADMIN_ID, VIEWER_ID],
    adminUserIds: [ADMIN_ID],
    botToken: BOT_TOKEN,
  });
  base = `http://127.0.0.1:${server.port}`;
  // Ровно то, что пишет POST /api/permissions от админа.
  logAction({ agentKey: AGENT, chatId: ADMIN_ID, actionType: "GRANT_PERMISSION" as any, status: "ok" });
  // И обычная строка группового чата — её трогать нельзя.
  logAction({ agentKey: "smm", chatId: GROUP_CHAT, actionType: "SEND_MESSAGE", status: "ok" });
});

afterAll(() => {
  server.stop();
  db.prepare(`DELETE FROM agent_actions WHERE agent_key IN (?, 'smm') AND chat_id IN (?, ?)`).run(
    AGENT,
    ADMIN_ID,
    GROUP_CHAT,
  );
  _resetRateLimiter();
});

describe("личный чат админа не уезжает наблюдателю", () => {
  test("GET /api/actions", async () => {
    const body = await getText(`/api/actions?limit=200`, VIEWER_ID);
    expect(body).not.toContain(String(ADMIN_ID));
    const actions = JSON.parse(body).actions as Array<{ agent_key: string; chat_id: number | null }>;
    const mine = actions.find((a) => a.agent_key === `miniapp:…${String(ADMIN_ID).slice(-4)}`);
    expect(mine).toBeDefined();
    expect(mine!.chat_id).toBeNull();
    expect(actions.some((a) => a.chat_id === GROUP_CHAT)).toBe(true);
  });

  test("GET /api/dashboard", async () => {
    const body = await getText(`/api/dashboard`, VIEWER_ID);
    expect(body).not.toContain(String(ADMIN_ID));
  });

  test("админу строка отдаётся как есть", async () => {
    const actions = JSON.parse(await getText(`/api/actions?limit=200`, ADMIN_ID)).actions as Array<{
      agent_key: string;
      chat_id: number | null;
    }>;
    expect(actions.find((a) => a.agent_key === AGENT)?.chat_id).toBe(ADMIN_ID);
  });
});
