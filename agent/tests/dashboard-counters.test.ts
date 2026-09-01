/**
 * Аудит 2026-08-12: счётчики на главной Mini App считались по спискам, которые
 * сервер намеренно обрезает.
 *
 * `/api/dashboard` отдаёт превью: 10 последних задач, 10 аппрувов, 20 последних
 * действий. Dashboard.tsx делал из них цифры на карточках:
 *
 *   setTasksPending(d.recentTasks.filter((t) => t.status === "pending").length);
 *   setApprovalsPending(d.pendingApprovals.length);
 *   setActionsToday(d.recentActions.filter((a) => a.created_at >= cutoff).length);
 *
 * То есть «Задач в очереди» физически не могло показать больше десяти, а
 * «Действий сегодня» — больше двадцати, независимо от того, сколько их на самом
 * деле. Замер: карточка показывала 1, когда `/api/tasks?status=pending&limit=200`
 * возвращал 200 задач — потому что среди 10 последних по created_at pending
 * была одна.
 *
 * Это не «неточность»: карточки на главной существуют ровно затем, чтобы
 * ответить «сколько ждёт меня сейчас», и они отвечали на другой вопрос —
 * «сколько среди последних десяти». Заниженная цифра здесь читается как
 * «разгребать нечего».
 *
 * Инвариант: счётчики приходят с сервера отдельными числами (COUNT по всей
 * таблице), а не выводятся из длины превью-списка.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { buildInitData } from "../lib/miniapp-auth.ts";
import {
  startMiniappServer,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";
import { createTask } from "../lib/tasks.ts";
import { logAction } from "../lib/audit.ts";
import { db } from "../lib/db.ts";
import { _resetRateLimiter } from "../lib/http-utils.ts";

const BOT_TOKEN = "test_bot_token_for_dashboard_counters";
const ADMIN_ID = 900_601;
const CHAT_ID = -100_900_601;
/** Больше, чем превью (10 задач / 20 действий) — в этом весь смысл. */
const TASKS = 14;
const ACTIONS = 26;

let server: MiniappServerHandle;
let base: string;

function initData(userId: number): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: `q-${userId}`,
    user: JSON.stringify({ id: userId, first_name: "U" }),
  });
}

async function get(path: string): Promise<any> {
  const r = await fetch(`${base}${path}`, {
    headers: { "X-Telegram-Init-Data": initData(ADMIN_ID) },
  });
  expect(r.status).toBe(200);
  return r.json();
}

beforeAll(() => {
  server = startMiniappServer({
    port: 0,
    allowedUserIds: [ADMIN_ID],
    adminUserIds: [ADMIN_ID],
    botToken: BOT_TOKEN,
  });
  base = `http://127.0.0.1:${server.port}`;

  for (let i = 0; i < TASKS; i++) {
    createTask({
      chatId: CHAT_ID,
      createdBy: "orchestrator",
      assignedTo: "backend",
      title: `dashboard counter probe ${i}`,
      description: "x",
    });
  }
  for (let i = 0; i < ACTIONS; i++) {
    logAction({
      agentKey: "dashboard_counter_probe",
      chatId: CHAT_ID,
      actionType: "SEND_MESSAGE",
      payload: {},
      status: "ok",
    });
  }
});

afterAll(() => {
  server.stop();
  _resetRateLimiter();
  db.prepare(`DELETE FROM tasks WHERE chat_id = ?`).run(CHAT_ID);
  db.prepare(`DELETE FROM agent_actions WHERE agent_key = ?`).run(
    "dashboard_counter_probe",
  );
});

describe("/api/dashboard: счётчики не зависят от длины превью", () => {
  test("pending-задач считается по всей таблице, а не по 10 последним", async () => {
    const d = await get("/api/dashboard");
    expect(d.recentTasks.length).toBeLessThanOrEqual(10);
    const real = db
      .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status = 'pending'`)
      .get() as { n: number };
    expect(d.counts.tasksPending).toBe(real.n);
    expect(d.counts.tasksPending).toBeGreaterThanOrEqual(TASKS);
  });

  test("действий за период считается по всей таблице, а не по 20 последним", async () => {
    const since = Date.now() - 60_000;
    const d = await get(`/api/dashboard?since=${since}`);
    expect(d.recentActions.length).toBeLessThanOrEqual(20);
    const real = db
      .prepare(`SELECT COUNT(*) AS n FROM agent_actions WHERE created_at >= ?`)
      .get(since) as { n: number };
    expect(d.counts.actionsSince).toBe(real.n);
    expect(d.counts.actionsSince).toBeGreaterThanOrEqual(ACTIONS);
  });

  test("аппрувов — тоже число, а не длина списка из десяти", async () => {
    const d = await get("/api/dashboard");
    const real = db
      .prepare(`SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'`)
      .get() as { n: number };
    expect(d.counts.approvalsPending).toBe(real.n);
  });

  test("since — начало суток КЛИЕНТА; кривой параметр не роняет ручку", async () => {
    const d = await get("/api/dashboard?since=не-число");
    expect(typeof d.counts.actionsSince).toBe("number");
  });
});
