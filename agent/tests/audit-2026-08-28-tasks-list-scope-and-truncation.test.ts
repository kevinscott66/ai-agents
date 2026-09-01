/**
 * Аудит 2026-08-28 — выборка задач: с какого конца режем и по какой области.
 *
 * F1. `listTasksByChat` резал не с того конца. Порядок у чата —
 *     `created_at ASC`, значит `LIMIT ?` брал N САМЫХ СТАРЫХ задач. В чате на
 *     300 задач `GET /api/tasks?chat_id=X&limit=50` показывал первые полсотни
 *     за всю жизнь чата — почти сплошь done и cancelled, — а всё сегодняшнее
 *     оставалось за кадром. Ответ при этом 200 и «полный»: отличить его от
 *     «задач всего пятьдесят» нельзя.
 *
 *     Соседняя ветка того же обработчика (без chat_id) уже брала
 *     `ORDER BY created_at DESC LIMIT ?`, то есть свежие — одна ручка отвечала
 *     двумя разными способами в зависимости от наличия фильтра.
 *
 *     У `listTasksByAssignee` та же строка означает противоположное: там
 *     `priority DESC, created_at ASC` — очередь работы, сверху то, что делать
 *     первым, и её top-N правильный. Он намеренно НЕ трогается; тест это
 *     фиксирует, чтобы «починить по аналогии» никто не пришёл.
 *
 * F2. `assignee` выигрывал у `chat_id` и молча его выбрасывал:
 *     `?assignee=qa&chat_id=-100` отдавал задачи роли из ВСЕХ чатов с кодом
 *     200 — сужение области выглядело применённым. commands.ts то же самое
 *     доделывал руками (`.filter(t => t.chat_id === args.chatId)`), то есть
 *     нужность фильтра была уже признана — просто не в Mini App.
 */
process.env.MINIAPP_BOT_TOKEN = "test_bot_token_tasks_0828";

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { buildInitData } from "../lib/miniapp-auth.ts";
import {
  startMiniappServer,
  _resetRateLimiter,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";
import { createTask, listTasksByChat, listTasksByAssignee } from "../lib/tasks.ts";
import { cmdTasks } from "../lib/commands.ts";
import { db } from "../lib/db.ts";
import { cleanupChat } from "./_helpers.ts";

const BOT_TOKEN = "test_bot_token_tasks_0828";
const USER_ID = 828_201;
const CHAT_A = -1_000_828_201;
const CHAT_B = -1_000_828_202;

function freshInitData(): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: `q${Math.random().toString(36).slice(2)}`,
    user: JSON.stringify({ id: USER_ID, username: "tsk", first_name: "T" }),
  });
}

let server: MiniappServerHandle;
let base: string;

/**
 * Задача с проставленным вручную `created_at`. Ставить время после вставки
 * надёжнее, чем ловить миллисекунды: createTask берёт Date.now(), и десять
 * задач подряд получают одну и ту же метку.
 */
function taskAt(
  chatId: number,
  title: string,
  createdAt: number,
  extra: { assignedTo?: string; priority?: number } = {},
): string {
  const t = createTask({
    chatId,
    createdBy: "qa",
    title,
    assignedTo: extra.assignedTo ?? null,
    priority: extra.priority,
  });
  db.prepare(`UPDATE tasks SET created_at = ? WHERE id = ?`).run(createdAt, t.id);
  return t.id;
}

beforeAll(() => {
  server = startMiniappServer({
    port: 0,
    allowedUserIds: [USER_ID],
    adminUserIds: [USER_ID],
    botToken: BOT_TOKEN,
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop();
  cleanupChat(CHAT_A);
  cleanupChat(CHAT_B);
});

beforeEach(() => {
  _resetRateLimiter();
  cleanupChat(CHAT_A);
  cleanupChat(CHAT_B);
});

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    headers: { "x-telegram-init-data": freshInitData() },
  });
  return { status: res.status, body: await res.json() };
}

describe("F1 — listTasksByChat режет свежий конец, а не древний", () => {
  const T0 = 1_700_000_000_000;

  test("limit отдаёт САМЫЕ СВЕЖИЕ N, в прежнем возрастающем порядке", () => {
    for (let i = 0; i < 5; i++) taskAt(CHAT_A, `t${i}`, T0 + i * 1000);

    const got = listTasksByChat(CHAT_A, undefined, 2).map((t) => t.title);
    // До фикса здесь было ["t0", "t1"] — доска чата открывалась на самом
    // старом, что в ней есть.
    expect(got).toEqual(["t3", "t4"]);
  });

  test("без limit возвращается всё и по-прежнему по возрастанию", () => {
    for (let i = 0; i < 5; i++) taskAt(CHAT_A, `t${i}`, T0 + i * 1000);

    expect(listTasksByChat(CHAT_A).map((t) => t.title)).toEqual([
      "t0",
      "t1",
      "t2",
      "t3",
      "t4",
    ]);
  });

  test("limit больше числа задач ничего не меняет", () => {
    for (let i = 0; i < 3; i++) taskAt(CHAT_A, `t${i}`, T0 + i * 1000);

    expect(listTasksByChat(CHAT_A, undefined, 100).map((t) => t.title)).toEqual([
      "t0",
      "t1",
      "t2",
    ]);
  });

  test("задачи с одинаковым created_at не тасуются между страницами", () => {
    // Одна миллисекунда на всех — так кладёт подзадачи SPLIT_TASK.
    for (let i = 0; i < 6; i++) taskAt(CHAT_A, `same${i}`, T0);

    const page = listTasksByChat(CHAT_A, undefined, 3).map((t) => t.title);
    expect(page).toEqual(["same3", "same4", "same5"]);
    // Повторный вызов даёт то же самое, а не «как повезёт планировщику».
    expect(listTasksByChat(CHAT_A, undefined, 3).map((t) => t.title)).toEqual(page);
  });

  test("фильтр по статусу применяется ДО обрезки", () => {
    taskAt(CHAT_A, "old-pending", T0);
    const done = taskAt(CHAT_A, "new-done", T0 + 5000);
    db.prepare(`UPDATE tasks SET status = 'done' WHERE id = ?`).run(done);

    const got = listTasksByChat(CHAT_A, ["pending"], 1).map((t) => t.title);
    expect(got).toEqual(["old-pending"]);
  });

  test("GET /api/tasks?chat_id=…&limit=… отдаёт свежие", async () => {
    for (let i = 0; i < 4; i++) taskAt(CHAT_A, `h${i}`, T0 + i * 1000);

    const r = await get(`/api/tasks?chat_id=${CHAT_A}&limit=2`);
    expect(r.status).toBe(200);
    expect(r.body.tasks.map((t: any) => t.title)).toEqual(["h2", "h3"]);
  });

  test("очередь роли по-прежнему режется сверху (priority DESC)", () => {
    taskAt(CHAT_A, "low", T0, { assignedTo: "smm", priority: 1 });
    taskAt(CHAT_A, "high", T0 + 5000, { assignedTo: "smm", priority: 9 });

    // Приоритет важнее свежести: top-1 очереди — это «high», хотя она новее.
    expect(
      listTasksByAssignee("smm", undefined, 1, CHAT_A).map((t) => t.title),
    ).toEqual(["high"]);
  });
});

describe("F2 — assignee больше не выбрасывает chat_id", () => {
  const T0 = 1_700_000_100_000;

  test("listTasksByAssignee с chatId сужает область", () => {
    taskAt(CHAT_A, "in-a", T0, { assignedTo: "smm" });
    taskAt(CHAT_B, "in-b", T0 + 1000, { assignedTo: "smm" });

    expect(listTasksByAssignee("smm", undefined, undefined, CHAT_A).map((t) => t.title))
      .toEqual(["in-a"]);
    expect(listTasksByAssignee("smm", undefined, undefined, CHAT_B).map((t) => t.title))
      .toEqual(["in-b"]);
  });

  test("без chatId поведение прежнее — обе задачи", () => {
    taskAt(CHAT_A, "in-a", T0, { assignedTo: "smm" });
    taskAt(CHAT_B, "in-b", T0 + 1000, { assignedTo: "smm" });

    const titles = listTasksByAssignee("smm").map((t) => t.title);
    expect(titles).toContain("in-a");
    expect(titles).toContain("in-b");
  });

  test("GET /api/tasks?assignee=…&chat_id=… не приносит чужой чат", async () => {
    taskAt(CHAT_A, "in-a", T0, { assignedTo: "smm" });
    taskAt(CHAT_B, "in-b", T0 + 1000, { assignedTo: "smm" });

    const r = await get(`/api/tasks?assignee=smm&chat_id=${CHAT_A}&limit=200`);
    expect(r.status).toBe(200);
    // До фикса здесь приходили обе: сужение по чату молча терялось.
    expect(r.body.tasks.map((t: any) => t.title)).toEqual(["in-a"]);
  });

  test("GET /api/tasks?assignee=… без chat_id по-прежнему глобальный", async () => {
    taskAt(CHAT_A, "in-a", T0, { assignedTo: "smm" });
    taskAt(CHAT_B, "in-b", T0 + 1000, { assignedTo: "smm" });

    const r = await get("/api/tasks?assignee=smm&limit=200");
    const titles = r.body.tasks.map((t: any) => t.title);
    expect(titles).toContain("in-a");
    expect(titles).toContain("in-b");
  });

  test("/tasks <роль> печатает только свой чат (фильтр переехал в SQL)", () => {
    taskAt(CHAT_A, "in-a", T0, { assignedTo: "smm" });
    taskAt(CHAT_B, "in-b", T0 + 1000, { assignedTo: "smm" });

    const out = cmdTasks({ chatId: CHAT_A, agentKey: "smm" });
    expect(out).toContain("in-a");
    expect(out).not.toContain("in-b");
  });
});
