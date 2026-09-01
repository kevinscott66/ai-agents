/**
 * Санитар зависших задач не затирает чужой результат (аудит 2026-08-04).
 *
 * gcStaleTasks отбирал строки SELECT'ом, а потом применял
 * `UPDATE tasks SET status='failed', error='gc_stale' WHERE id=?` — то есть
 * повторял условие отбора на веру. SELECT и транзакция не атомарны, и второе
 * соединение на той же БД (tools/*, restore, mac-bridge) успевает довести таск
 * до 'done' в этом окне. Тогда санитар штамповал failed поверх успешного
 * результата — и возвращал его в `ids` как «зависший».
 *
 * Само окно в одном процессе не воспроизводится (между SELECT и транзакцией нет
 * await), поэтому инвариант закреплён по тексту запроса, а поведенчески
 * проверяется то свойство, которое ломалось: всё, что функция объявила
 * проваленным, действительно провалено в БД.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { db } from "../lib/db.ts";
import { gcStaleTasks } from "../lib/db-maint.ts";
import { DAY_MS } from "../lib/time-constants.ts";

const CHAT = -1009005151;

function cleanup(): void {
  db.prepare(`DELETE FROM tasks WHERE chat_id = ?`).run(CHAT);
}

beforeEach(cleanup);
afterEach(cleanup);

/** Создать задачу напрямую: нужен контроль над status и updated_at. */
function mkTask(id: string, status: string, updatedAt: number): string {
  db.prepare(
    `INSERT INTO tasks (id, parent_id, depth, chat_id, created_by, assigned_to,
                        title, status, created_at, updated_at)
     VALUES (?, NULL, 0, ?, 'orchestrator', 'qa', ?, ?, ?, ?)`,
  ).run(id, CHAT, `задача ${id}`, status, updatedAt, updatedAt);
  return id;
}

function statusOf(id: string): { status: string; error: string | null } {
  return db.prepare(`SELECT status, error FROM tasks WHERE id = ?`).get(id) as {
    status: string;
    error: string | null;
  };
}

describe("отчёт совпадает с БД", () => {
  test("каждый id из ответа действительно провален", () => {
    const now = Date.now();
    const stale = mkTask("gc-stale-1", "running", now - 48 * 3600_000);
    mkTask("gc-fresh-1", "pending", now);

    const res = gcStaleTasks({ now });

    expect(res.ids).toContain(stale);
    expect(res.failed).toBe(res.ids.length);
    for (const id of res.ids) {
      const row = statusOf(id);
      expect(row.status).toBe("failed");
      expect(row.error).toBe("gc_stale");
    }
  });

  test("свежая задача не попадает ни в отчёт, ни под UPDATE", () => {
    const now = Date.now();
    const fresh = mkTask("gc-fresh-2", "running", now - 60_000);

    const res = gcStaleTasks({ now });

    expect(res.ids).not.toContain(fresh);
    expect(statusOf(fresh).status).toBe("running");
  });

  test("уже завершённая задача не воскрешается в failed", () => {
    const now = Date.now();
    // Старая, но давно закрытая: 'done' не входит в отбор зависших.
    const done = mkTask("gc-done-1", "done", now - 10 * DAY_MS);

    const res = gcStaleTasks({ now });

    expect(res.ids).not.toContain(done);
    expect(statusOf(done).status).toBe("done");
  });

  test("статусы ожидания человека не считаются зависшими", () => {
    const now = Date.now();
    const waiting = mkTask("gc-wait-1", "awaiting_approval", now - 10 * DAY_MS);

    gcStaleTasks({ now });

    // Ревью через выходные легально длится дольше суток, а у awaiting_approval
    // своя строка в approvals — пометить таск failed значило бы разъехаться с
    // ней.
    expect(statusOf(waiting).status).toBe("awaiting_approval");
  });
});

describe("структура решения", () => {
  const SRC = readFileSync(new URL("../lib/db-maint.ts", import.meta.url), "utf8");
  const UPD = SRC.slice(SRC.indexOf("UPDATE tasks SET status='failed'"));

  test("UPDATE повторяет условие отбора, а не верит SELECT'у", () => {
    const stmt = UPD.slice(0, 220);
    expect(stmt).toMatch(/status IN \('pending','running'\)/);
    expect(stmt).toMatch(/updated_at < \?/);
  });

  test("в отчёт идут только реально изменённые строки", () => {
    expect(SRC).toMatch(/\.changes > 0\) failedRows\.push/);
    expect(SRC).toMatch(/failed: failedRows\.length/);
  });
});
