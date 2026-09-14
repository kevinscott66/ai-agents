/**
 * Аудит 2026-09-14: денилист QUERY_DB закрывал таблицы по имени, а
 * виртуальная таблица `dbstat` отдаёт статистику страниц ЛЮБОЙ из них.
 *
 * Замер на bun:sqlite этой версии: `SELECT name, payload FROM dbstat` работает
 * (движок собран с DBSTAT_VTAB) и отвечает, сколько байт полезной нагрузки
 * лежит в `messages`, `approvals`, `agent_prompts` — постранично. Текста там
 * нет, но объём и динамика переписки — ровно то, ради чего `messages` в
 * денилисте: «сколько писали в чате за ночь» читается разностью двух
 * запросов. Роль под prompt-injection получала это одной строкой.
 *
 * `sqlite_dbpage` (сырые байты страниц — полный обход денилиста) в этой
 * сборке нет; второй тест держит это предположение, чтобы обновление Bun,
 * включившее модуль, покраснело здесь, а не прошло тихо.
 */
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { validateQueryDbSql } from "../lib/query-db.ts";

describe("QUERY_DB: статистика страниц закрыта", () => {
  test("dbstat отклоняется валидатором", () => {
    for (const sql of [
      "SELECT name, payload FROM dbstat",
      "select sum(payload) from DBSTAT where name = 'messages'",
      "SELECT * FROM dbstat('main')",
    ]) {
      expect(validateQueryDbSql(sql).ok).toBe(false);
    }
  });

  test("предпосылка: sqlite_dbpage в сборке нет", () => {
    const db = new Database(":memory:");
    try {
      expect(() => db.query("SELECT data FROM sqlite_dbpage").all()).toThrow(/no such table/);
    } finally {
      db.close();
    }
  });

  test("обычные таблицы по-прежнему читаются", () => {
    expect(validateQueryDbSql("SELECT id, status FROM tasks").ok).toBe(true);
  });
});
