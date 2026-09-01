/**
 * Аудит 2026-08-10: мост через `running` проверяет не ту половину достижимости.
 *
 * forceTerminalStatus ставит терминал в обход FSM, но, если прямой переход
 * нелегален, сначала пишет промежуточный `running` — «чтобы в истории не
 * осталось перехода, которого нет в таблице». Обоснование в докстринге:
 * running достижим из любого нетерминального статуса. Это верно и не имеет
 * значения: мост обязан быть легален с ОБЕИХ сторон, а проверена только
 * входящая.
 *
 * FSM.running = [done, failed, awaiting_review, awaiting_approval] — cancelled
 * там нет. Значит для target = "cancelled" мост не спасает ничего: из running
 * и awaiting_review родитель, у которого все дети отменены, всё равно уходит
 * переходом, которого в таблице не существует. Для done/failed мост работает,
 * поэтому дыра и не всплывала — единственный target, до которого из running не
 * дойти, встречается реже двух остальных.
 *
 * Наблюдаемого ущерба нет: таблицы истории переходов и триггеров на tasks в
 * схеме нет, промежуточная запись перетирается в той же синхронной функции.
 * Но инвариант, который пинят соседние тесты, при этом просто неверен, а
 * первый же читатель истории (если он появится) получит ровно ту запись, от
 * которой мост должен был защитить. Поэтому проверяется цепочка записей, а не
 * конечный статус: конечный статус одинаков и с мостом, и без него.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import { createTask, getTask, updateTaskStatus, type TaskStatus } from "../lib/tasks.ts";

const CHAT = -99887;

/** Копия таблицы переходов из lib/tasks.ts — тест обязан быть независим. */
const FSM: Record<string, string[]> = {
  pending: ["running", "cancelled", "awaiting_approval"],
  running: ["done", "failed", "awaiting_review", "awaiting_approval"],
  awaiting_approval: ["running", "cancelled"],
  awaiting_review: ["running", "done", "failed"],
  done: [],
  failed: [],
  cancelled: [],
};

/**
 * Записать последовательность статусов, которую задача получает в БД.
 *
 * Иначе мост не наблюдаем вообще: обе записи идут подряд без await, и снаружи
 * видно только конечное значение.
 */
function recordStatusWrites<T>(taskId: string, fn: () => T): { result: T; chain: string[] } {
  const chain: string[] = [];
  const origPrepare = db.prepare.bind(db);
  (db as unknown as { prepare: unknown }).prepare = (sql: string) => {
    const stmt = origPrepare(sql);
    if (!/^\s*UPDATE tasks SET[\s\S]*status/i.test(sql)) return stmt;
    const origRun = stmt.run.bind(stmt);
    (stmt as unknown as { run: unknown }).run = (...args: unknown[]) => {
      // status либо зашит в SQL (status='running'), либо идёт первым плейсхолдером.
      const literal = sql.match(/status\s*=\s*'([a-z_]+)'/i);
      const value = literal ? literal[1]! : String(args[0]);
      if (args.includes(taskId) && value in FSM) chain.push(value);
      return origRun(...(args as never[]));
    };
    return stmt;
  };
  try {
    return { result: fn(), chain };
  } finally {
    (db as unknown as { prepare: unknown }).prepare = origPrepare;
  }
}

/** Первый нелегальный переход в цепочке, или null. */
function illegalHop(from: TaskStatus, chain: string[]): string | null {
  let cur: string = from;
  for (const next of chain) {
    if (next === cur) continue; // запись того же статуса переходом не является
    if (!FSM[cur]!.includes(next)) return `${cur} → ${next}`;
    cur = next;
  }
  return null;
}

beforeEach(() => {
  db.prepare(`DELETE FROM tasks WHERE chat_id = ?`).run(CHAT);
});

afterEach(() => {
  db.prepare(`DELETE FROM tasks WHERE chat_id = ?`).run(CHAT);
});

function parentWithCancelledChild(parentStatus: TaskStatus) {
  const parent = createTask({
    chatId: CHAT,
    createdBy: "orchestrator",
    title: `[split] ${parentStatus}`,
    inputPayload: { type: "split", expectedChildren: 1 },
  });
  // Довести родителя до нужного статуса легальными переходами.
  updateTaskStatus(parent.id, "running");
  if (parentStatus === "awaiting_review") updateTaskStatus(parent.id, "awaiting_review");
  const child = createTask({
    chatId: CHAT,
    createdBy: "orchestrator",
    parentId: parent.id,
    title: "child",
  });
  return { parent, child };
}

describe("мост доводит родителя до cancelled только легальными переходами", () => {
  for (const from of ["running", "awaiting_review"] as TaskStatus[]) {
    test(`${from} → cancelled идёт через статус, из которого cancelled достижим`, () => {
      const { parent, child } = parentWithCancelledChild(from);
      expect(getTask(parent.id)!.status).toBe(from);

      // Отмена единственного ребёнка тянет rollupParent → target "cancelled".
      const { chain } = recordStatusWrites(parent.id, () =>
        updateTaskStatus(child.id, "cancelled"),
      );

      expect(getTask(parent.id)!.status).toBe("cancelled");
      // До фикса цепочка была [running, cancelled] — то есть ровно тот переход,
      // которого в FSM нет, только записанный дважды.
      expect(illegalHop(from, chain)).toBeNull();
    });
  }

  test("прямой вызов на этом же переходе по-прежнему запрещён", () => {
    // Если FSM вдруг разрешит running → cancelled, тесты выше станут
    // бессмысленными — пусть это упадёт здесь, а не тихо пройдёт там.
    const t = createTask({ chatId: CHAT, createdBy: "orchestrator", title: "direct" });
    updateTaskStatus(t.id, "running");
    expect(() => updateTaskStatus(t.id, "cancelled")).toThrow(
      /invalid status transition/,
    );
  });
});

describe("мост не сломан для остальных целей", () => {
  for (const [from, target] of [
    ["pending", "failed"],
    ["pending", "done"],
    ["awaiting_review", "failed"],
    ["awaiting_approval", "done"],
  ] as Array<[TaskStatus, TaskStatus]>) {
    test(`${from} → ${target}`, () => {
      const parent = createTask({
        chatId: CHAT,
        createdBy: "orchestrator",
        title: `[split] ${from}-${target}`,
        inputPayload: { type: "split", expectedChildren: 1 },
      });
      if (from === "awaiting_approval") updateTaskStatus(parent.id, "awaiting_approval");
      if (from === "awaiting_review") {
        updateTaskStatus(parent.id, "running");
        updateTaskStatus(parent.id, "awaiting_review");
      }
      const child = createTask({
        chatId: CHAT,
        createdBy: "orchestrator",
        parentId: parent.id,
        title: "child",
      });
      updateTaskStatus(child.id, "running");

      const { chain } = recordStatusWrites(parent.id, () =>
        updateTaskStatus(child.id, target),
      );

      expect(getTask(parent.id)!.status).toBe(target);
      expect(illegalHop(from, chain)).toBeNull();
    });
  }
});
