/**
 * Аудит 2026-09-14: две админские ручки Mini App проверяли в теле только
 * главное поле, а побочное отдавали в SQLite как есть.
 *
 * `POST /api/approvals/:id/decide` — `reason`, `POST /api/tasks/:id/status` —
 * `error`. Замер до правки: объект в любом из них отвечал
 * `400 {"error":"Binding expected string, TypedArray, …"}` — сообщение
 * драйвера уезжало клиентом как текст ошибки API; строка в 100 КБ в `reason`
 * решала заявку и ложилась в `approvals.reason` целиком, хотя соседний
 * писатель той же колонки (`markApprovalFailed`) режет до 2000.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { buildInitData } from "../lib/miniapp-auth.ts";
import { startMiniappServer, type MiniappServerHandle } from "../lib/miniapp-server.ts";
import { createApproval, getApproval } from "../lib/approvals.ts";
import { createTask, getTask } from "../lib/tasks.ts";
import { db } from "../lib/db.ts";
import { _resetRateLimiter } from "../lib/http-utils.ts";

const BOT_TOKEN = "test_bot_token_body_field_types";
const ADMIN_ID = 811_914_401;
const CHAT_ID = -100_900_914_4;

let server: MiniappServerHandle;
let base: string;

function initData(): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: "q-body",
    user: JSON.stringify({ id: ADMIN_ID, first_name: "A" }),
  });
}

function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "X-Telegram-Init-Data": initData(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(() => {
  _resetRateLimiter();
  server = startMiniappServer({
    port: 0,
    allowedUserIds: [ADMIN_ID],
    adminUserIds: [ADMIN_ID],
    botToken: BOT_TOKEN,
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop();
  db.prepare(`DELETE FROM approvals WHERE chat_id = ?`).run(CHAT_ID);
  db.prepare(`DELETE FROM tasks WHERE chat_id = ?`).run(CHAT_ID);
  _resetRateLimiter();
});

function pendingApproval(): string {
  return createApproval({
    actionId: crypto.randomUUID(),
    chatId: CHAT_ID,
    requestedBy: "smm",
    actionType: "SEND_MESSAGE" as any,
    payload: { text: "x" } as any,
  }).id;
}

describe("decide: reason", () => {
  for (const [name, reason] of [
    ["объект", { x: 1 }],
    ["число", 42],
    ["строка сверх потолка", "x".repeat(2001)],
  ] as const) {
    test(`${name} — 400 без сообщения драйвера, заявка не решена`, async () => {
      const id = pendingApproval();
      const r = await post(`/api/approvals/${id}/decide`, { decision: "rejected", reason });
      expect(r.status).toBe(400);
      expect(await r.text()).not.toContain("Binding");
      expect(getApproval(id)!.status).toBe("pending");
    });
  }

  test("строка в пределах и отсутствие поля проходят", async () => {
    const a = pendingApproval();
    expect((await post(`/api/approvals/${a}/decide`, { decision: "rejected", reason: "не то" })).status).toBe(200);
    expect(getApproval(a)!.reason).toBe("не то");
    const b = pendingApproval();
    expect((await post(`/api/approvals/${b}/decide`, { decision: "rejected" })).status).toBe(200);
    expect(getApproval(b)!.status).toBe("rejected");
  });
});

describe("tasks/:id/status: error", () => {
  test("объект — 400 без сообщения драйвера, задача не тронута", async () => {
    const t = createTask({ title: "t", chatId: CHAT_ID, createdBy: "smm", assignedTo: "aieng" });
    const r = await post(`/api/tasks/${t.id}/status`, { status: "running", error: { x: 1 } });
    expect(r.status).toBe(400);
    expect(await r.text()).not.toContain("Binding");
    expect(getTask(t.id)!.status).toBe("pending");
  });

  test("строка и null проходят", async () => {
    const t = createTask({ title: "t", chatId: CHAT_ID, createdBy: "smm", assignedTo: "aieng" });
    expect((await post(`/api/tasks/${t.id}/status`, { status: "running", error: null })).status).toBe(200);
    expect((await post(`/api/tasks/${t.id}/status`, { status: "failed", error: "сломалось" })).status).toBe(200);
    expect(getTask(t.id)!.error).toBe("сломалось");
  });
});
