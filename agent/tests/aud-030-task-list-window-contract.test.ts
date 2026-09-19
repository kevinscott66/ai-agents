/**
 * AUD-030: контракт окна списка задач (lib/task-list-window.ts) отдельно от
 * HTTP. Страницы через `nextOffset` покрывают выборку целиком, без дыр и
 * повторов, в каждой из трёх веток; `truncated` честен и на ровно полной
 * странице; клиентская страница Mini App не шире серверного потолка.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTask } from "../lib/tasks.ts";
import { db } from "../lib/db.ts";
import { cleanupChat } from "./_helpers.ts";
import { listTaskWindow, TASK_LIST_MAX_LIMIT, type TaskListQuery } from "../lib/task-list-window.ts";
import { TASK_PAGE_SIZE } from "../miniapp/src/lib/task-pages.ts";

const CHAT = -1_000_930_030;
// Метки из далёкого будущего: в ветке без фильтров (скан всей таблицы, общей
// с другими файлами процесса) эти задачи гарантированно свежайшие.
const T0 = 4_000_000_000_000;
const N = 7;
const ids: string[] = [];

beforeAll(() => {
  cleanupChat(CHAT);
  for (let i = 0; i < N; i++) {
    const t = createTask({ chatId: CHAT, createdBy: "qa", title: `w${i}`, assignedTo: "qa" });
    db.prepare(`UPDATE tasks SET created_at = ? WHERE id = ?`).run(T0 + i, t.id);
    ids.push(t.id);
  }
});
afterAll(() => cleanupChat(CHAT));

/** Пройти все страницы по `nextOffset`, как это делает loadTaskPages. */
function walk(q: Omit<TaskListQuery, "offset">, maxPages = 10) {
  const pages: ReturnType<typeof listTaskWindow>[] = [];
  let offset: number | null = 0;
  while (offset !== null && pages.length < maxPages) {
    const w = listTaskWindow({ ...q, offset });
    pages.push(w);
    expect(w.tasks.length).toBeLessThanOrEqual(q.limit);
    offset = w.nextOffset;
  }
  return pages;
}

describe("страницы покрывают выборку без дыр и повторов", () => {
  for (const [name, q] of [
    ["assignee", { assignee: "qa", chatId: CHAT }],
    ["chat_id", { assignee: null, chatId: CHAT }],
  ] as const) {
    test(`ветка ${name}: 7 задач страницами по 3`, () => {
      const pages = walk({ ...q, limit: 3 });
      expect(pages.map((p) => p.tasks.length)).toEqual([3, 3, 1]);
      expect(pages.map((p) => p.truncated)).toEqual([true, true, false]);
      expect(pages.map((p) => p.nextOffset)).toEqual([3, 6, null]);
      const seen = pages.flatMap((p) => p.tasks.map((t) => t.id));
      expect(new Set(seen).size).toBe(N);
      expect([...seen].sort()).toEqual([...ids].sort());
    });

    test(`ветка ${name}: ровно полная последняя страница — truncated=false`, () => {
      // 7 задач, окно 7: лишней строки нет, «показать ещё» не нужно.
      const w = listTaskWindow({ ...q, limit: N, offset: 0 });
      expect(w.tasks.length).toBe(N);
      expect(w.truncated).toBe(false);
      expect(w.nextOffset).toBeNull();
    });
  }

  test("ветка chat_id: внутри страницы по возрастанию, первая страница — свежайшие", () => {
    const [first] = walk({ assignee: null, chatId: CHAT, limit: 3 }, 1);
    expect(first.tasks.map((t) => t.title)).toEqual(["w4", "w5", "w6"]);
  });

  test("ветка без фильтров: свежайшие задачи по убыванию, стык страниц без повтора", () => {
    const pages = walk({ assignee: null, limit: 3 }, 3);
    const titles = pages.flatMap((p) => p.tasks.map((t) => t.title)).slice(0, N);
    expect(titles).toEqual(["w6", "w5", "w4", "w3", "w2", "w1", "w0"]);
    expect(pages[0].truncated).toBe(true);
    expect(pages[0].nextOffset).toBe(3);
  });

  test("фильтр статуса сужает все ветки одинаково", () => {
    db.prepare(`UPDATE tasks SET status = 'done' WHERE id = ?`).run(ids[0]);
    try {
      for (const q of [
        { assignee: "qa", chatId: CHAT },
        { assignee: null, chatId: CHAT },
      ]) {
        const seen = walk({ ...q, statuses: ["pending"], limit: 3 }).flatMap((p) => p.tasks.map((t) => t.id));
        expect(seen.length).toBe(N - 1);
        expect(seen).not.toContain(ids[0]);
      }
    } finally {
      db.prepare(`UPDATE tasks SET status = 'pending' WHERE id = ?`).run(ids[0]);
    }
  });
});

describe("клиент и сервер согласны о размере страницы", () => {
  test("страница Mini App не шире серверного потолка", () => {
    // Иначе сервер молча урежет окно, а клиент сдвинет offset на свой
    // размер страницы и пропустит задачи на стыке.
    expect(TASK_PAGE_SIZE).toBeLessThanOrEqual(TASK_LIST_MAX_LIMIT);
  });
});
