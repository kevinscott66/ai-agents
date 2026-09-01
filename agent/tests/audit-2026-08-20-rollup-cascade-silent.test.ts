/**
 * Аудит 2026-08-20: сбой каскадного rollup'а в проде не оставлял следа.
 *
 * Обе каскадные ветки (`rollupParent:548`, `reconcileExpectedChildren:474`)
 * ловили исключение и писали `log.debug`. В проде уровень — `info`
 * (`log.ts:91`: `fallback = isProduction ? 'info' : 'debug'`), то есть строка
 * не печаталась вовсе, а функция возвращала нормальный успех.
 *
 * Сценарий: rollupParent штампует родителя терминальным, каскад к деду бросает
 * (SQLITE_BUSY от второго соединения — `tools/*`, mac-bridge, restore; такие
 * соединения в репо документированы в applyMigration и gcStaleTasks). Дед
 * остаётся pending/running без единого признака сбоя; через сутки его подберёт
 * `gcStaleTasks` и перепишет в failed с `error='gc_stale'` — успешно
 * завершённое дерево получает ложную причину провала. Ровно тот исход, от
 * которого защищались в forceTerminalStatus.
 *
 * Соседний catch на том же классе ошибки (`updateTaskStatus:285`) пишет
 * `log.error` — то есть уровень здесь занижен непоследовательно, а не по
 * политике.
 */
import { test, expect, describe, afterEach } from "bun:test";
import { spyOn } from "bun:test";
import { db } from "../lib/db.ts";
import { log } from "../lib/log.ts";
import { createTask, getTask, updateTaskStatus, rollupParent } from "../lib/tasks.ts";

const CHAT = -100820021;
const realPrepare = db.prepare.bind(db);

afterEach(() => {
  (db as unknown as { prepare: typeof realPrepare }).prepare = realPrepare;
});

describe("сбой каскада виден в проде", () => {
  test("падение rollup'а к деду логируется на error, а не на debug", () => {
    const g = createTask({ title: "дед", createdBy: "orchestrator", chatId: CHAT });
    const p = createTask({ title: "родитель", createdBy: "orchestrator", chatId: CHAT, parentId: g.id });
    const c = createTask({ title: "ребёнок", createdBy: "orchestrator", chatId: CHAT, parentId: p.id });
    updateTaskStatus(c.id, "running");

    const errSpy = spyOn(log, "error").mockImplementation(() => {});
    const dbgSpy = spyOn(log, "debug").mockImplementation(() => {});
    try {
      // Первый набор детей (для p) читается штатно, второй (для деда) —
      // падает: так выглядит SQLITE_BUSY от второго соединения.
      let seen = 0;
      (db as unknown as { prepare: typeof realPrepare }).prepare = ((sql: string) => {
        if (sql.includes("SELECT id, status, error FROM tasks WHERE parent_id")) {
          seen += 1;
          if (seen > 1) throw new Error("SQLITE_BUSY: второе соединение");
        }
        return realPrepare(sql);
      }) as typeof realPrepare;

      updateTaskStatus(c.id, "done");
      (db as unknown as { prepare: typeof realPrepare }).prepare = realPrepare;

      // Предусловия: родитель закрылся, а каскад до деда не доехал —
      // иначе утверждение ниже проверяло бы не тот путь.
      expect(seen).toBe(2);
      expect(getTask(p.id)!.status).toBe("done");
      expect(getTask(g.id)!.status).not.toBe("done");

      // Различающее утверждение: соседний catch в updateTaskStatus пишет
      // "[tasks] rollupParent error" без слова cascade, так что случайно
      // пройти на нём нельзя.
      const messages = errSpy.mock.calls.map((c) => String(c[0])).join(" | ");
      expect(messages).toContain("cascade failed");
    } finally {
      (db as unknown as { prepare: typeof realPrepare }).prepare = realPrepare;
      errSpy.mockRestore();
      dbgSpy.mockRestore();
    }
  });
});
