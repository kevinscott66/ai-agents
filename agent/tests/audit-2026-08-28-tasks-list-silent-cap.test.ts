/**
 * Аудит 2026-08-28: доска задач обрезалась молча.
 *
 * `GET /api/tasks` отдаёт `{ tasks }` и ничего больше. Ответ на сто задач из
 * ста и ответ на сто задач из трёхсот выглядят одинаково: код 200, массив
 * ровно по лимиту, ни поля, ни заголовка, ни «показать ещё». Tasks.tsx просит
 * `limit: 100` и рисует полученное как всю доску — то есть у чата, где задач
 * больше сотни, часть просто не существует с точки зрения владельца.
 *
 * Это не гипотетика про будущее: ручка сама режет `limit` потолком 200
 * (`parseIntOr(..., 50, 200)`), то есть выборка больше двух сотен невозможна
 * в принципе, а таблица растёт от каждой из 12 ролей.
 *
 * Соседняя ручка того же файла — `/api/wiki/list` — ровно эту ситуацию уже
 * подписывает флагом `truncated`. Берём тот же приём: спрашиваем у СУБД на
 * строку больше лимита и по ней узнаём, есть ли что-то за краем.
 *
 * Отдельная тонкость в ветке `chat_id`: там выдача ВОЗРАСТАЮЩАЯ, а `limit`
 * берёт N свежайших (аудит того же дня, F1). Лишняя строка в такой выборке —
 * самая старая, то есть первая, и `slice(0, limit)` выкинул бы самую свежую
 * задачу — ровно ту, ради которой доску и открывают.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { buildInitData } from "../lib/miniapp-auth.ts";
import {
  startMiniappServer,
  _resetRateLimiter,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";
import { createTask } from "../lib/tasks.ts";
import { db } from "../lib/db.ts";
import { cleanupChat } from "./_helpers.ts";

const BOT_TOKEN = "test_bot_token_tasks_cap_0828";
const USER_ID = 828_301;
const CHAT = -1_000_828_301;

function freshInitData(): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: `q${Math.random().toString(36).slice(2)}`,
    user: JSON.stringify({ id: USER_ID, username: "cap", first_name: "C" }),
  });
}

let server: MiniappServerHandle;
let base: string;

/** Задача с проставленным вручную `created_at`: createTask берёт Date.now(),
 *  и пять задач подряд получают одну и ту же метку. */
function taskAt(
  title: string,
  createdAt: number,
  extra: { assignedTo?: string; priority?: number; status?: string } = {},
): string {
  const t = createTask({
    chatId: CHAT,
    createdBy: "qa",
    title,
    assignedTo: extra.assignedTo ?? null,
    priority: extra.priority,
  });
  db.prepare(`UPDATE tasks SET created_at = ? WHERE id = ?`).run(createdAt, t.id);
  if (extra.status) {
    db.prepare(`UPDATE tasks SET status = ? WHERE id = ?`).run(extra.status, t.id);
  }
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
  cleanupChat(CHAT);
});

beforeEach(() => {
  _resetRateLimiter();
  cleanupChat(CHAT);
});

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    headers: { "x-telegram-init-data": freshInitData() },
  });
  return { status: res.status, body: await res.json() };
}

const T0 = 1_700_000_000_000;

describe("предпосылки", () => {
  test("лимит выборки жёстко ограничен сверху — «попросить всё» нельзя", async () => {
    for (let i = 0; i < 3; i++) taskAt(`t${i}`, T0 + i);
    const r = await get(`/api/tasks?chat_id=${CHAT}&limit=100000`);
    expect(r.status).toBe(200);
    // Потолок 200: значение из запроса до СУБД не доезжает, и клиент не может
    // гарантировать себе полную выдачу, сколько бы ни просил.
    const src = readFileSync(new URL("../lib/miniapp-server.ts", import.meta.url), "utf-8");
    expect(src).toContain('parseIntOr(url.searchParams.get("limit"), 50, 200)');
  });

  test("соседняя ручка того же файла обрезку подписывает", async () => {
    const r = await get("/api/wiki/list");
    expect(r.status).toBe(200);
    expect(typeof r.body.truncated).toBe("boolean");
  });
});

describe("ветка chat_id", () => {
  test("обрезка объявлена флагом", async () => {
    for (let i = 0; i < 5; i++) taskAt(`t${i}`, T0 + i);
    const r = await get(`/api/tasks?chat_id=${CHAT}&limit=3`);
    expect(r.body.tasks.length).toBe(3);
    expect(r.body.truncated).toBe(true);
  });

  test("режется лишняя СТАРАЯ строка, а не свежая", async () => {
    for (let i = 0; i < 5; i++) taskAt(`t${i}`, T0 + i);
    const r = await get(`/api/tasks?chat_id=${CHAT}&limit=3`);
    // Порядок наружу возрастающий, содержимое — три свежайших.
    expect(r.body.tasks.map((t: any) => t.title)).toEqual(["t2", "t3", "t4"]);
  });

  test("выдача целиком — флаг снят, а не отсутствует", async () => {
    for (let i = 0; i < 3; i++) taskAt(`t${i}`, T0 + i);
    for (const limit of [3, 4, 200]) {
      const r = await get(`/api/tasks?chat_id=${CHAT}&limit=${limit}`);
      expect(r.body.tasks.length).toBe(3);
      expect(r.body.truncated).toBe(false);
    }
  });

  test("пустой чат не считается обрезанным", async () => {
    const r = await get(`/api/tasks?chat_id=${CHAT}&limit=1`);
    expect(r.body.tasks).toEqual([]);
    expect(r.body.truncated).toBe(false);
  });

  test("фильтр по статусу применяется ДО обрезки", async () => {
    for (let i = 0; i < 5; i++) taskAt(`p${i}`, T0 + i);
    taskAt("d0", T0 + 10, { status: "done" });
    taskAt("d1", T0 + 11, { status: "done" });
    const r = await get(`/api/tasks?chat_id=${CHAT}&status=done&limit=1`);
    expect(r.body.tasks.length).toBe(1);
    expect(r.body.tasks[0].title).toBe("d1");
    expect(r.body.truncated).toBe(true);
    // Пять pending мимо фильтра флаг не поднимают.
    const full = await get(`/api/tasks?chat_id=${CHAT}&status=done&limit=2`);
    expect(full.body.truncated).toBe(false);
  });
});

describe("ветка assignee", () => {
  test("обрезка объявлена, очередь режется сверху по приоритету", async () => {
    taskAt("low", T0, { assignedTo: "qa", priority: 1 });
    taskAt("mid", T0 + 1, { assignedTo: "qa", priority: 5 });
    taskAt("top", T0 + 2, { assignedTo: "qa", priority: 9 });
    const r = await get(`/api/tasks?assignee=qa&chat_id=${CHAT}&limit=2`);
    expect(r.body.truncated).toBe(true);
    expect(r.body.tasks.map((t: any) => t.title)).toEqual(["top", "mid"]);
  });

  test("вся очередь целиком — флаг снят", async () => {
    taskAt("a", T0, { assignedTo: "qa" });
    taskAt("b", T0 + 1, { assignedTo: "qa" });
    const r = await get(`/api/tasks?assignee=qa&chat_id=${CHAT}&limit=5`);
    expect(r.body.tasks.length).toBe(2);
    expect(r.body.truncated).toBe(false);
  });
});

describe("ветка без фильтров (прямой скан)", () => {
  test("обрезка объявлена и здесь", async () => {
    // Две свои pending-задачи гарантируют, что глобально их не меньше двух;
    // соседние тесты в общем прогоне могут добавить своих — на limit=1 это
    // ничего не меняет.
    taskAt("g0", T0, {});
    taskAt("g1", T0 + 1, {});
    const r = await get(`/api/tasks?status=pending&limit=1`);
    expect(r.body.tasks.length).toBe(1);
    expect(r.body.truncated).toBe(true);
  });
});

describe("применение", () => {
  const SRC = readFileSync(new URL("../lib/miniapp-server.ts", import.meta.url), "utf-8");
  const ROUTE = SRC.slice(
    SRC.indexOf('if (path === "/api/tasks" && method === "GET")'),
    SRC.indexOf('if (path === "/api/wiki/list"'),
  );

  test("срез окна берётся из выборки на строку шире лимита", () => {
    expect(ROUTE).toContain("const probe = limit + 1;");
    // Все три ветки спрашивают у СУБД именно probe: любая, оставшаяся на
    // `limit`, вернула бы truncated=false на ровно полной странице.
    expect(ROUTE.split("probe").length - 1).toBeGreaterThanOrEqual(4);
  });

  test("флаг уезжает клиенту рядом со списком", () => {
    expect(ROUTE).toContain("truncated,");
  });

  test("клиентский тип обещает флаг, а не забывает про него", () => {
    const api = readFileSync(new URL("../miniapp/src/lib/api.ts", import.meta.url), "utf-8");
    const tasksFn = api.slice(api.indexOf("  tasks: (params:"), api.indexOf("  task: (id:"));
    expect(tasksFn).toContain("req<{ tasks: Task[]; truncated: boolean }>");
  });

  test("страница задач показывает предупреждение, а не проглатывает флаг", () => {
    const page = readFileSync(
      new URL("../miniapp/src/pages/Tasks.tsx", import.meta.url),
      "utf-8",
    );
    expect(page).toContain("setTruncated(Boolean(r.truncated))");
    expect(page).toContain("Показаны не все задачи");
  });
});
