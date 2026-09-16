/**
 * Аудит 2026-09-14: санитар проваливал родителя, у которого работают дети.
 *
 * `gcStaleTasks` отбирал зависшие по одному признаку — собственный
 * `updated_at` старше суток при статусе `pending`/`running`. Но родитель,
 * пока работают дети, свой `updated_at` не трогает: смена статуса ребёнка
 * пишет строку ребёнка, `rollupParent` пишет родителя только когда набор
 * закрыт, а родитель SPLIT_TASK вообще всю жизнь `pending`. Значит родитель
 * «зависал» в глазах санитара ровно тогда, когда дети шли дольше суток —
 * например, ребёнок на ревью (`awaiting_review` санитар сознательно не
 * трогает: ожидание человека легально длится дольше суток).
 *
 * Дальше ошибка становилась необратимой: `rollupParent` на терминальном
 * родителе выходит сразу, и успешное закрытие ребёнка уже ничего не меняло —
 * родитель навсегда `failed/gc_stale` при наборе из одних `done`.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import { gcStaleTasks } from "../lib/db-maint.ts";
import { updateTaskStatus } from "../lib/tasks.ts";
import { HOUR_MS } from "../lib/time-constants.ts";

const CHAT = -100_914_031;

function cleanup(): void {
  db.prepare(`DELETE FROM tasks WHERE chat_id = ?`).run(CHAT);
}
beforeEach(cleanup);
afterEach(cleanup);

function mkTask(
  id: string,
  status: string,
  updatedAt: number,
  parentId: string | null = null,
): string {
  db.prepare(
    `INSERT INTO tasks (id, parent_id, depth, chat_id, created_by, assigned_to,
                        title, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'orchestrator', 'qa', ?, ?, ?, ?)`,
  ).run(id, parentId, parentId ? 1 : 0, CHAT, `задача ${id}`, status, updatedAt, updatedAt);
  return id;
}

function row(id: string): { status: string; error: string | null } {
  return db.prepare(`SELECT status, error FROM tasks WHERE id = ?`).get(id) as {
    status: string;
    error: string | null;
  };
}

describe("родитель с незакрытыми детьми — не зависший", () => {
  test("ребёнок на ревью: родитель не проваливается и закрывается по итогу ребёнка", () => {
    const now = Date.now();
    const parent = mkTask("gc-par-review", "pending", now - 25 * HOUR_MS);
    const child = mkTask("gc-par-review-c", "awaiting_review", now - 25 * HOUR_MS, parent);

    const res = gcStaleTasks({ now });

    expect(res.ids).not.toContain(parent);
    expect(row(parent).status).toBe("pending");

    // Ревьюер принял работу — итог родителя обязан это отразить.
    updateTaskStatus(child, "done");
    expect(row(parent).status).toBe("done");
  });

  test("свежий ребёнок в работе: старый родитель не трогается", () => {
    const now = Date.now();
    const parent = mkTask("gc-par-run", "running", now - 72 * HOUR_MS);
    mkTask("gc-par-run-c", "running", now - 60_000, parent);

    const res = gcStaleTasks({ now });

    expect(res.ids).not.toContain(parent);
    expect(row(parent).status).toBe("running");
  });

  test("зависший ребёнок: провален он, родитель закрывается каскадом, а не санитаром", () => {
    const now = Date.now();
    const parent = mkTask("gc-par-both", "pending", now - 48 * HOUR_MS);
    const child = mkTask("gc-par-both-c", "running", now - 48 * HOUR_MS, parent);

    const res = gcStaleTasks({ now });

    expect(res.ids).toContain(child);
    expect(row(child)).toEqual({ status: "failed", error: "gc_stale" });
    // Родителя закрыл rollup по проваленному ребёнку, с ошибкой ребёнка.
    expect(row(parent).status).toBe("failed");
  });

  test("родитель, у которого все дети закрыты, по-прежнему зависший", () => {
    const now = Date.now();
    const parent = mkTask("gc-par-closed", "running", now - 48 * HOUR_MS);
    mkTask("gc-par-closed-c", "done", now - 47 * HOUR_MS, parent);

    const res = gcStaleTasks({ now });

    expect(res.ids).toContain(parent);
    expect(row(parent)).toEqual({ status: "failed", error: "gc_stale" });
  });
});
