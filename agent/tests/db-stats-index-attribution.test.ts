/**
 * Аудит 2026-08-12: размер по таблицам не сходился с размером файла, и не
 * «примерно», а в разы.
 *
 * dbStats считает так:
 *
 *   SELECT SUM(pgsize) FROM dbstat WHERE name = ?   -- name = имя таблицы
 *
 * В `dbstat` строка на КАЖДОЕ btree: и на таблицу, и отдельно на каждый её
 * индекс, под собственным именем. Значит страницы индексов не приписываются
 * никому: в STAT_TABLES нет ни одного индекса, и запрос по имени таблицы их
 * не видит.
 *
 * Замер на реальном `data/memory.db` (856 064 B, 2026-08-12):
 *
 *   tasks                       249 856
 *   sqlite_autoindex_tasks_1    102 400
 *   idx_tasks_status_created     49 152
 *   idx_tasks_assigned_status    45 056
 *   idx_tasks_chat_status        40 960
 *   idx_tasks_parent             24 576
 *   idx_tasks_assigned_to        24 576
 *
 * То есть индексы `tasks` весят БОЛЬШЕ самой таблицы (286 720 против 249 856),
 * а экран показывает только вторую цифру — занижение в 2.1 раза. Сумма всех
 * строк STAT_TABLES давала ~300 КБ при файле 856 КБ; остальные две трети
 * (индексы, shadow-таблицы wiki_fts, sqlite_schema) не показывались нигде.
 *
 * Это ровно тот вопрос, ради которого статистику и правили 2026-08-08 —
 * «откуда взялся размер файла». Ответа по-прежнему не было: строка
 * `__db_file__` больше суммы остальных строк, и почему — не видно.
 *
 * Чиним: страницы индекса приписываем таблице-владельцу (tbl_name из
 * sqlite_master), а неучтённый остаток кладём явной строкой `__other__`,
 * чтобы столбец сходился с `__db_file__`, а не молчал о разнице.
 */
import { describe, test, expect } from "bun:test";
import { db } from "../lib/db.ts";
import { dbStats } from "../lib/db-maint.ts";

/** Есть ли в сборке dbstat — без неё все размеры честно нулевые. */
function hasDbstat(): boolean {
  try {
    db.prepare(`SELECT SUM(pgsize) FROM dbstat`).get();
    return true;
  } catch {
    return false;
  }
}

describe("dbStats: страницы индексов", () => {
  test("размер таблицы включает её индексы", () => {
    if (!hasDbstat()) return;
    const owned = db
      .prepare(
        `SELECT SUM(d.pgsize) AS s FROM dbstat d
         JOIN sqlite_master m ON m.name = d.name
         WHERE m.tbl_name = 'tasks'`,
      )
      .get() as { s: number | null };
    const bare = db
      .prepare(`SELECT SUM(pgsize) AS s FROM dbstat WHERE name = 'tasks'`)
      .get() as { s: number | null };
    // Предпосылка замера: у tasks есть индексы, иначе тест ничего не проверяет.
    expect(owned.s ?? 0).toBeGreaterThan(bare.s ?? 0);

    const stats = dbStats();
    const tasks = stats.find((s) => s.table === "tasks")!;
    expect(tasks.size_bytes).toBe(owned.s ?? 0);
  });

  test("столбец размеров сходится с размером файла", () => {
    if (!hasDbstat()) return;
    const total = (
      db.prepare(`SELECT SUM(pgsize) AS s FROM dbstat`).get() as {
        s: number | null;
      }
    ).s;
    const stats = dbStats();
    const sum = stats
      .filter((s) => s.table !== "__db_file__")
      .reduce((a, s) => a + s.size_bytes, 0);
    expect(sum).toBe(total ?? 0);
    // И остаток виден отдельной строкой, а не растворён в таблицах.
    expect(stats.some((s) => s.table === "__other__")).toBe(true);
  });

  test("одна строка на каждую таблицу STAT_TABLES остаётся", () => {
    const stats = dbStats();
    const names = stats.map((s) => s.table);
    for (const t of ["tasks", "messages", "agent_actions", "approvals"]) {
      expect(names.filter((n) => n === t).length).toBe(1);
    }
    expect(names).toContain("__db_file__");
  });
});
