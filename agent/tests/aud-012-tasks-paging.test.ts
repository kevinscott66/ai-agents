/**
 * AUD-012: задачи за краем окна должны быть достижимы.
 *
 * До правки `GET /api/tasks` честно ставил `truncated`, но сдвинуть окно было
 * нечем: `limit` режется на 200, `offset` не было. На доске с 250 задачами
 * одного статуса и исполнителя последние 50 не открывались никак.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { buildInitData } from "../lib/miniapp-auth.ts";
import { startMiniappServer, _resetRateLimiter, type MiniappServerHandle } from "../lib/miniapp-server.ts";
import { createTask } from "../lib/tasks.ts";
import { db } from "../lib/db.ts";
import { cleanupChat } from "./_helpers.ts";
import { loadTaskPages, type TaskPage } from "../miniapp/src/lib/task-pages.ts";

const BOT_TOKEN = "test_bot_token_tasks_paging_aud012";
const USER_ID = 912_012;
const CHAT = -1_000_912_012;
const T0 = 1_700_000_000_000;
const N = 250;

function freshInitData(): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: `q${Math.random().toString(36).slice(2)}`,
    user: JSON.stringify({ id: USER_ID, username: "pg", first_name: "P" }),
  });
}

let server: MiniappServerHandle;
let base: string;

beforeAll(() => {
  server = startMiniappServer({ port: 0, allowedUserIds: [USER_ID], adminUserIds: [USER_ID], botToken: BOT_TOKEN });
  base = `http://127.0.0.1:${server.port}`;
  cleanupChat(CHAT);
  for (let i = 0; i < N; i++) {
    const t = createTask({ chatId: CHAT, createdBy: "qa", title: `p${i}`, assignedTo: "qa" });
    db.prepare(`UPDATE tasks SET created_at = ? WHERE id = ?`).run(T0 + i, t.id);
  }
});

afterAll(() => {
  server.stop();
  cleanupChat(CHAT);
});

beforeEach(() => _resetRateLimiter());

async function page(query: string, offset: number): Promise<TaskPage> {
  const res = await fetch(`${base}/api/tasks?${query}&limit=100&offset=${offset}`, {
    headers: { "x-telegram-init-data": freshInitData() },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as TaskPage;
}

async function all(query: string, depth: number) {
  return loadTaskPages((offset) => page(query, offset), depth);
}

describe("250 задач одного статуса и исполнителя достижимы целиком", () => {
  test("ветка assignee: первая, средняя и последняя", async () => {
    const q = `assignee=qa&chat_id=${CHAT}&status=pending`;
    const first = await all(q, 1);
    expect(first.tasks.length).toBe(100);
    expect(first.truncated).toBe(true);
    const r = await all(q, 3);
    expect(r.truncated).toBe(false);
    expect(r.tasks.length).toBe(N);
    const titles = r.tasks.map((t) => t.title);
    expect(new Set(titles).size).toBe(N);
    // Очередь роли: при равном приоритете — старые сверху.
    expect(titles[0]).toBe("p0");
    expect(titles[125]).toBe("p125");
    expect(titles[N - 1]).toBe(`p${N - 1}`);
  });

  test("ветка chat_id: вторая страница — следующие по старшинству", async () => {
    const q = `chat_id=${CHAT}&status=pending`;
    const p1 = await page(q, 0);
    expect(p1.nextOffset).toBe(100);
    expect(p1.tasks[0].title).toBe("p150");
    expect(p1.tasks[99].title).toBe("p249");
    const p3 = await page(q, 200);
    expect(p3.truncated).toBe(false);
    expect(p3.nextOffset).toBeNull();
    expect(p3.tasks.map((t) => t.title)).toEqual(Array.from({ length: 50 }, (_, i) => `p${i}`));
  });

  test("прямой скан: offset сдвигает окно", async () => {
    const r = await all("status=pending", 50);
    const mine = r.tasks.filter((t) => t.chat_id === CHAT).map((t) => t.title);
    expect(mine.length).toBe(N);
    expect(mine).toContain("p0");
    expect(mine).toContain(`p${N - 1}`);
  });

  test("отрицательный и мусорный offset — это первая страница", async () => {
    const q = `assignee=qa&chat_id=${CHAT}`;
    const base0 = await page(q, 0);
    for (const bad of ["-5", "abc", "1.9"]) {
      const res = await fetch(`${base}/api/tasks?${q}&limit=100&offset=${bad}`, {
        headers: { "x-telegram-init-data": freshInitData() },
      });
      const body = (await res.json()) as TaskPage;
      if (bad === "1.9") expect(body.tasks[0].title).toBe("p1");
      else expect(body.tasks[0].title).toBe(base0.tasks[0].title);
    }
  });
});

describe("loadTaskPages", () => {
  const t = (id: string) => ({ id, title: id }) as any;
  test("дубль на стыке страниц не удваивает задачу", async () => {
    const pages: Record<number, TaskPage> = {
      0: { tasks: [t("a"), t("b")], truncated: true, nextOffset: 2 },
      2: { tasks: [t("b"), t("c")], truncated: false, nextOffset: null },
    };
    const r = await loadTaskPages(async (o) => pages[o], 5);
    expect(r.tasks.map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(r.truncated).toBe(false);
  });

  test("глубина ограничивает число запросов", async () => {
    let calls = 0;
    const r = await loadTaskPages(async (o) => {
      calls++;
      return { tasks: [t(`x${o}`)], truncated: true, nextOffset: o + 1 };
    }, 2);
    expect(calls).toBe(2);
    expect(r.truncated).toBe(true);
  });
});
