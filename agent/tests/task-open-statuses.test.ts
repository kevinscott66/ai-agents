/**
 * Аудит 2026-08-12: «открытая задача» определялась литеральным списком в
 * одном месте — и список был неполный.
 *
 * FSM в tasks.ts терминальными делает ровно три статуса (done/failed/cancelled
 * — у них пустой список переходов). Незакрытых, значит, четыре: pending,
 * running, awaiting_approval, awaiting_review. `tasks_open` в
 * miniapp-metrics.ts считал три из четырёх — awaiting_review не попадал.
 *
 * Само по себе это «-1 в гейдже», но сходится с другим фактом в паре скверно:
 * gcStaleTasks намеренно не трогает awaiting_*, и обоснование в его комментарии
 * было ложным — «у awaiting_approval своя строка в approvals». В таблице
 * `approvals` нет колонки task_id вовсе (миграция 004: id, action_id, chat_id,
 * requested_by, action_type, payload, status, decided_by, decided_at, reason,
 * created_at). Два контура не связаны ничем, то есть задачу в awaiting_* не
 * держит открытой никакой второй механизм: её не закроет ни санитар, ни
 * одобрение. Единственное, что о ней сообщает, — счётчик. Он и обязан её видеть.
 *
 * Решение оставить awaiting_* вне gc — правильное (это ожидание человека, а не
 * зависшая работа, и парковку делает админ руками). Меняется не оно, а
 * определение «открытой» и честность обоснования.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import {
  createTask,
  updateTaskStatus,
  OPEN_TASK_STATUSES,
  TASK_FSM,
  type TaskStatus,
} from "../lib/tasks.ts";
import { gcStaleTasks } from "../lib/db-maint.ts";
import { renderMetrics } from "../lib/miniapp-metrics.ts";

const CHAT_ID = -100_920_001;

afterEach(() => {
  db.prepare(`DELETE FROM tasks WHERE chat_id = ?`).run(CHAT_ID);
});

function mk(title: string): string {
  return createTask({
    chatId: CHAT_ID,
    createdBy: "test",
    assignedTo: null,
    title,
  }).id;
}

describe("определение открытой задачи", () => {
  test("OPEN_TASK_STATUSES выводится из FSM, а не переписан руками", () => {
    const terminal = (Object.entries(TASK_FSM) as [TaskStatus, TaskStatus[]][])
      .filter(([, next]) => next.length === 0)
      .map(([s]) => s)
      .sort();
    expect(terminal).toEqual(["cancelled", "done", "failed"]);
    // Добавят статус в FSM — он сам попадёт в «открытые» или в «терминальные»,
    // и ни один счётчик не придётся вспоминать.
    const open = [...OPEN_TASK_STATUSES].sort();
    expect(open).toEqual(
      (Object.keys(TASK_FSM) as TaskStatus[])
        .filter((s) => TASK_FSM[s].length > 0)
        .sort(),
    );
    expect(open).toContain("awaiting_review");
  });

  test("tasks_open видит задачу, припаркованную в awaiting_review", () => {
    const id = mk("припаркована на ревью");
    updateTaskStatus(id, "running");
    updateTaskStatus(id, "awaiting_review");

    const before = openGauge();
    expect(before).toBeGreaterThan(0);

    // Контроль: закрытая задача из счётчика уходит.
    updateTaskStatus(id, "done");
    expect(openGauge()).toBe(before - 1);
  });

  test("gcStaleTasks по-прежнему не трогает awaiting_* — но она видна", () => {
    const parked = mk("ждёт человека вторую неделю");
    updateTaskStatus(parked, "running");
    updateTaskStatus(parked, "awaiting_review");
    // Состариваем строку: санитар смотрит на updated_at.
    db.prepare(`UPDATE tasks SET updated_at = ? WHERE id = ?`).run(
      Date.now() - 30 * 24 * 3600 * 1000,
      parked,
    );

    const res = gcStaleTasks();
    expect(res.ids).not.toContain(parked);

    // Ничего второго её не держит: в approvals нет колонки под задачу вовсе —
    // именно это ложно утверждал старый комментарий в db-maint.ts.
    const cols = db
      .prepare(`PRAGMA table_info(approvals)`)
      .all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).not.toContain("task_id");
  });
});

/** Значение гейджа tasks_open из отрендеренного Prometheus-текста. */
function openGauge(): number {
  const line = renderMetrics()
    .split("\n")
    .find((l) => l.startsWith("tasks_open "));
  expect(line).toBeTruthy();
  return Number(line!.split(/\s+/)[1]);
}
