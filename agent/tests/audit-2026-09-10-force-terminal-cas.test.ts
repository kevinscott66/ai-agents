/**
 * Аудит 2026-09-10: `forceTerminalStatus` писала по снимку, прочитанному до
 * транзакции.
 *
 * Оба вызывающих — реконсиляторы: `failTask` и `rollupParent` читают задачу,
 * считают детей и только потом пишут. Между этим чтением и первой записью
 * статус успевает измениться — вторым ребёнком, отменой из Mini App, воркером.
 * Транзакция от аудита 2026-08-14 сделала запись атомарной, но не
 * обусловленной: WHERE был `id=?`, а путь моста считался от уже устаревшего
 * `task.status`. Отменённая человеком задача молча проезжала
 * `cancelled → running → done`.
 *
 * Где именно окно. Оно ровно одно — между снимком и НАЧАЛОМ транзакции. Со
 * своей первой записи транзакция держит RESERVED, и до коммита чужой писатель
 * в эту строку не войдёт, так что вклиниться в середину моста снаружи нельзя
 * в принципе. Условие на шагах моста от этого не лишнее (оно ловит и своих:
 * вложенный вызов через SAVEPOINT), но проверяемо здесь только первое — и
 * тесты не делают вид, что воспроизводят невозможное.
 *
 * Гонка ставится подменой `db.prepare`: чужой UPDATE идёт сразу после SELECT'а,
 * которым вызывающий берёт снимок. По-другому её не поймать — дальше всё
 * синхронно, await'ов внутри нет.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import { createTask, getTask, failTask, updateTaskStatus } from "../lib/tasks.ts";

const CHAT = -99232;

/**
 * Выполнить `fn`, вклинив чужой UPDATE сразу после первого SELECT'а этой
 * задачи — то есть ровно в окно между снимком реконсилятора и его записью.
 * Это единственное место, куда посторонний писатель может попасть, поэтому
 * подмена бьёт по SELECT'у, а не по UPDATE'ам: вклинившись между шагами моста,
 * тест оказался бы ВНУТРИ чужой транзакции и откатился бы вместе с ней —
 * измерялся бы артефакт стенда, а не защита.
 */
function raceAfterSnapshot<T>(taskId: string, intruder: string, fn: () => T): T {
  const origPrepare = db.prepare.bind(db);
  let fired = false;
  (db as unknown as { prepare: unknown }).prepare = (sql: string) => {
    const stmt = origPrepare(sql);
    if (!/^\s*SELECT \* FROM tasks WHERE id/i.test(sql)) return stmt;
    const origGet = stmt.get.bind(stmt);
    (stmt as unknown as { get: unknown }).get = (...args: unknown[]) => {
      const row = origGet(...(args as never[]));
      if (!fired && args[0] === taskId) {
        fired = true;
        // origPrepare, а не db.prepare — иначе перехват поймает сам себя.
        origPrepare(`UPDATE tasks SET status=?, updated_at=? WHERE id=?`).run(
          intruder,
          Date.now(),
          taskId,
        );
      }
      return row;
    };
    return stmt;
  };
  try {
    return fn();
  } finally {
    (db as unknown as { prepare: unknown }).prepare = origPrepare;
  }
}

describe("forceTerminalStatus не пишет по устаревшему снимку", () => {
  beforeEach(() => {
    db.prepare(`DELETE FROM tasks WHERE chat_id=?`).run(CHAT);
  });
  afterEach(() => {
    db.prepare(`DELETE FROM tasks WHERE chat_id=?`).run(CHAT);
  });

  test("прямой переход: чужой финиш побеждает, failed не пишется", () => {
    const t = createTask({ chatId: CHAT, createdBy: "pm", title: "прямой" });
    updateTaskStatus(t.id, "running");
    updateTaskStatus(t.id, "awaiting_review");

    // Чужой переход берём легальный по FSM (awaiting_review → done): гонка
    // здесь не про нелегальную запись, а про то, чей вывод новее.
    raceAfterSnapshot(t.id, "done", () => failTask(t.id, "gc_stale"));

    const after = getTask(t.id)!;
    expect(after.status).toBe("done");
    expect(after.error).toBe(null);
  });

  test("мост: чужая отмена побеждает целиком, running не пишется", () => {
    // pending → failed идёт через мост: FSM.pending терминалов не содержит.
    // Именно этот путь до аудита и проезжал целиком по устаревшему снимку —
    // отменённая задача получала `cancelled → running → failed`, причём
    // промежуточный `running` был переходом, которого в таблице нет.
    const t = createTask({ chatId: CHAT, createdBy: "pm", title: "мост" });

    raceAfterSnapshot(t.id, "cancelled", () => failTask(t.id, "gc_stale"));

    const after = getTask(t.id)!;
    expect(after.status).toBe("cancelled");
    expect(after.status).not.toBe("running");
    expect(after.error).toBe(null);
  });

  test("контроль: без гонки failTask по-прежнему доводит до failed", () => {
    const t = createTask({ chatId: CHAT, createdBy: "pm", title: "контроль" });

    expect(failTask(t.id, "boom")).toBe("failed");
    const after = getTask(t.id)!;
    expect(after.status).toBe("failed");
    expect(after.error).toBe("boom");
  });
});
