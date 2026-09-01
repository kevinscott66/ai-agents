/**
 * Аудит 2026-08-08: у таблицы audit_logs было три писателя и ноль читателей.
 *
 * emitAlert и отказы UPDATE_AGENT_PROMPT исправно наполняли журнал, db-maint
 * исправно уносил старые строки в архив — и никто их никогда не видел: ни
 * ручки в API, ни команды в Telegram. При этом system prompt роли `perm`
 * прямым текстом велит «прочитай audit_logs» при разборе денаев, то есть
 * промпт обещал возможность, которой в рантайме не было.
 *
 * GET /api/audit-logs — читалка. Admin-only: там алерты и отказы по правкам
 * system prompt'ов.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { buildInitData } from "../lib/miniapp-auth.ts";
import {
  startMiniappServer,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";
import { db } from "../lib/db.ts";

const BOT_TOKEN = "test_bot_token_for_audit_logs";
const ADMIN_ID = 810810;
const VIEWER_ID = 810811;
const CHAT_ID = -1_000_810;

function initData(userId: number): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: `q-audit-${userId}`,
    user: JSON.stringify({ id: userId, username: "u", first_name: "U" }),
  });
}

let server: MiniappServerHandle;
let base: string;

beforeAll(() => {
  server = startMiniappServer({
    port: 0,
    allowedUserIds: [ADMIN_ID, VIEWER_ID],
    adminUserIds: [ADMIN_ID],
    botToken: BOT_TOKEN,
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop();
});

function insertLog(eventType: string, agentKey: string, createdAt: number, payload: string) {
  db.prepare(
    `INSERT INTO audit_logs(id, agent_key, chat_id, event_type, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(crypto.randomUUID(), agentKey, CHAT_ID, eventType, payload, createdAt);
}

async function get(pathAndQuery: string, userId: number) {
  const r = await fetch(`${base}${pathAndQuery}`, {
    headers: { "x-telegram-init-data": initData(userId) },
  });
  return { status: r.status, body: await r.json() };
}

describe("GET /api/audit-logs", () => {
  beforeEach(() => {
    db.prepare(`DELETE FROM audit_logs WHERE chat_id = ?`).run(CHAT_ID);
  });

  test("не-админ не видит журнал", async () => {
    const { status } = await get(`/api/audit-logs?chat_id=${CHAT_ID}`, VIEWER_ID);
    expect(status).toBe(403);
  });

  test("админ читает записи, свежие первыми, payload разобран", async () => {
    insertLog("UPDATE_AGENT_PROMPT_REJECTED", "smm", 1_000, JSON.stringify({ decided_by: "tg:1" }));
    insertLog("alert.watchdog", "system", 2_000, JSON.stringify({ severity: "high" }));

    const { status, body } = await get(`/api/audit-logs?chat_id=${CHAT_ID}`, ADMIN_ID);
    expect(status).toBe(200);
    expect(body.logs.length).toBe(2);
    expect(body.logs[0].eventType).toBe("alert.watchdog");
    expect(body.logs[0].payload.severity).toBe("high");
    expect(body.logs[1].payload.decided_by).toBe("tg:1");
  });

  test("фильтры по agent и event_type", async () => {
    insertLog("UPDATE_AGENT_PROMPT_REJECTED", "smm", 1_000, "{}");
    insertLog("alert.watchdog", "system", 2_000, "{}");

    const byAgent = await get(`/api/audit-logs?chat_id=${CHAT_ID}&agent=smm`, ADMIN_ID);
    expect(byAgent.body.logs.length).toBe(1);
    expect(byAgent.body.logs[0].agentKey).toBe("smm");

    const byType = await get(
      `/api/audit-logs?chat_id=${CHAT_ID}&event_type=alert.watchdog`,
      ADMIN_ID,
    );
    expect(byType.body.logs.length).toBe(1);
    expect(byType.body.logs[0].eventType).toBe("alert.watchdog");
  });

  test("курсор before + nextBefore перелистывают журнал без пропусков", async () => {
    for (let i = 1; i <= 3; i++) insertLog("alert.x", "system", i * 1_000, "{}");

    const page1 = await get(`/api/audit-logs?chat_id=${CHAT_ID}&limit=2`, ADMIN_ID);
    expect(page1.body.logs.map((l: { createdAt: number }) => l.createdAt)).toEqual([3_000, 2_000]);
    expect(page1.body.nextBefore).toBe(2_000);

    const page2 = await get(
      `/api/audit-logs?chat_id=${CHAT_ID}&limit=2&before=${page1.body.nextBefore}`,
      ADMIN_ID,
    );
    expect(page2.body.logs.map((l: { createdAt: number }) => l.createdAt)).toEqual([1_000]);
    // Последняя страница неполная → курсора дальше нет.
    expect(page2.body.nextBefore).toBeNull();
  });

  test("битый JSON в payload не роняет весь ответ", async () => {
    insertLog("alert.broken", "system", 5_000, "{не json");
    const { status, body } = await get(`/api/audit-logs?chat_id=${CHAT_ID}`, ADMIN_ID);
    expect(status).toBe(200);
    expect(body.logs[0].payload).toEqual({ raw: "{не json" });
  });
});
