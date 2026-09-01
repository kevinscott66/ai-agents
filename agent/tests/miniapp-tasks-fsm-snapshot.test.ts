/**
 * Аудит 2026-08-14: две находки в одной странице задач, обе про рассинхрон.
 *
 * 1. Таблица переходов жила в двух копиях — серверной (`lib/tasks.ts`) и
 *    своей в Mini App — и копии УЖЕ разошлись. Сервер разрешал
 *    `pending → awaiting_approval` и `running → awaiting_approval`, а кнопок
 *    для этого не существовало ни в списке, ни в карточке: перевод задачи в
 *    «ждёт аппрува» из интерфейса был недоступен, хотя API его принимает.
 *    Расхождение молчаливо в обе стороны — лишний переход в копии Mini App
 *    дал бы кнопку, на которую сервер отвечает ошибкой.
 *
 * 2. Открытая карточка задачи была снимком: в состояние клали объект. Список
 *    при этом перезагружается по каждому `task.updated` от любого из 12
 *    агентов. Пока карточка открыта, задачу могли увести в `done` — карточка
 *    продолжала показывать старый статус и строить по нему кнопки переходов.
 *
 * Инвариант: таблица переходов одна на обе стороны, а карточка показывает то
 * же, что список.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TASK_TRANSITIONS, type TaskStatus } from "../lib/task-fsm.ts";
import { TASK_FSM } from "../lib/tasks.ts";
import { pickSelected } from "../miniapp/src/pages/Tasks.tsx";
import type { Task } from "../miniapp/src/lib/types.ts";

const SRC = readFileSync(
  join(import.meta.dir, "..", "miniapp", "src", "pages", "Tasks.tsx"),
  "utf8",
);

function task(over: Partial<Task> = {}): Task {
  return {
    id: "t1",
    parent_id: null,
    depth: 0,
    chat_id: -100,
    created_by: "orchestrator",
    assigned_to: "backend",
    title: "почини индекс",
    description: null,
    status: "running",
    priority: 0,
    deadline: null,
    input: null,
    output: null,
    error: null,
    created_at: 1_760_000_000_000,
    updated_at: 1_760_000_000_000,
    ...over,
  } as Task;
}

describe("таблица переходов одна на сервер и на Mini App", () => {
  test("сервер валидирует ровно по общей таблице", () => {
    expect(TASK_FSM).toBe(TASK_TRANSITIONS);
  });

  test("переходы, которых Mini App не показывал, в таблице есть", () => {
    // Ровно те два, на которых копии разошлись.
    expect(TASK_TRANSITIONS.pending).toContain("awaiting_approval");
    expect(TASK_TRANSITIONS.running).toContain("awaiting_approval");
  });

  test("страница больше не заводит свою таблицу", () => {
    expect(SRC).toContain("TASK_TRANSITIONS");
    // Прежняя форма: литеральный объект прямо в странице.
    expect(SRC).not.toMatch(/NEXT_STATUS\s*:\s*Record<TaskStatus/);
  });

  test("терминальные статусы остались терминальными", () => {
    for (const s of ["done", "failed", "cancelled"] as TaskStatus[]) {
      expect(TASK_TRANSITIONS[s]).toHaveLength(0);
    }
  });

  test("в таблице нет статуса, которого нет в словаре", () => {
    const known = new Set(Object.keys(TASK_TRANSITIONS));
    for (const [from, to] of Object.entries(TASK_TRANSITIONS)) {
      for (const next of to) {
        expect(known.has(next)).toBe(true);
        expect(next).not.toBe(from); // переход в себя же — не переход
      }
    }
  });
});

describe("карточка показывает то же, что список", () => {
  test("статус берётся из свежего списка, а не из снимка", () => {
    const stale = task({ status: "running" });
    const fresh = task({ status: "done" });
    expect(pickSelected([fresh], "t1", stale)?.status).toBe("done");
  });

  test("кнопки строятся по свежему статусу — из done их нет", () => {
    const shown = pickSelected([task({ status: "done" })], "t1", task());
    expect(TASK_TRANSITIONS[shown!.status]).toHaveLength(0);
  });

  test("выпала из фильтра — показываем снимок, а не пустоту", () => {
    const snap = task({ status: "done" });
    expect(pickSelected([], "t1", snap)).toBe(snap);
  });

  test("ничего не выбрано — карточки нет", () => {
    expect(pickSelected([task()], null, task())).toBeNull();
  });

  test("чужие задачи в списке не подменяют выбранную", () => {
    const other = task({ id: "t2", status: "failed" });
    const snap = task({ status: "running" });
    expect(pickSelected([other], "t1", snap)).toBe(snap);
  });
});

describe("страница действительно через это ходит", () => {
  test("в состоянии лежит id, а не объект задачи", () => {
    expect(SRC).toContain("pickSelected(tasks, selectedId, selectedSnapshot)");
    // Прежняя форма: сам объект в состоянии и один сеттер на всё.
    expect(SRC.includes("const [selected, setSelected]")).toBe(false);
    expect(SRC.includes("setSelected(")).toBe(false);
  });

  test("закрытие сбрасывает и id, и снимок", () => {
    const close = SRC.slice(SRC.indexOf("function closeTask("));
    expect(close).toContain("setSelectedId(null)");
    expect(close).toContain("setSelectedSnapshot(null)");
  });

  test("ответ смены статуса освежает запасной снимок", () => {
    expect(SRC).toContain("if (selectedId === id) setSelectedSnapshot(r.task)");
  });
});
