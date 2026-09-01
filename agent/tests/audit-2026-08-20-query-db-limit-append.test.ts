/**
 * Аудит 2026-08-20: авто-LIMIT отключался словом «limit» и глотался комментарием.
 *
 * `validateQueryDbSql` дописывает границу, только если её нет:
 * `!/\blimit\b/i.test(raw)`. Проверка шла по СЫРОМУ тексту, поэтому:
 *
 *   1. `SELECT id FROM tasks WHERE title LIKE '%limit%'` — слово внутри
 *      строкового литерала считалось клаузой, и запрос уходил в базу вовсе без
 *      границы. Это данные, а не SQL.
 *   2. `SELECT id FROM tasks --` — граница дописывалась ПОСЛЕ начала
 *      комментария (`... -- LIMIT 50`), то есть внутрь него, и не значила
 *      ничего.
 *
 * Число в дописанной клаузе — `limit + 1`, а не `limit`: аудит 2026-08-28
 * добавил разведочную строку, без которой воркер не мог отличить «строк ровно
 * пятьдесят» от «первые пятьдесят из трёхсот». Проверяемое здесь — не число, а
 * то, ЧТО клауза дописывается и куда.
 *
 * Число отданных строк это не меняло: воркер обрывает итерацию по
 * `input.limit` независимо от текста запроса (`query-db-worker.ts:48`). Цена
 * другая — работа самой базы. Без LIMIT движок честно отрабатывает полный скан
 * и сортировку, и единственной защитой остаётся SIGKILL через 5 секунд; плюс
 * `v.sql` перестаёт быть самоограниченным, хотя читается как таковой, — любой
 * будущий вызов вне воркера унаследует запрос без границы.
 */
import { describe, expect, test } from "bun:test";
import { validateQueryDbSql } from "../lib/query-db.ts";

function okSql(sql: string): string {
  const v = validateQueryDbSql(sql);
  expect(v.ok).toBe(true);
  return (v as { ok: true; sql: string }).sql;
}

describe("авто-LIMIT: слово в литерале клаузой не считается", () => {
  test("одинарные кавычки", () => {
    // До правки здесь границы не появлялось вовсе.
    expect(okSql("SELECT id FROM tasks WHERE title LIKE '%limit%'")).toBe(
      "SELECT id FROM tasks WHERE title LIKE '%limit%' LIMIT 51",
    );
  });

  test("двойные кавычки", () => {
    expect(okSql('SELECT id FROM tasks WHERE title LIKE "%limit%"')).toBe(
      'SELECT id FROM tasks WHERE title LIKE "%limit%" LIMIT 51',
    );
  });

  test("настоящая клауза второй раз не дописывается", () => {
    expect(okSql("SELECT id FROM tasks LIMIT 5")).toBe(
      "SELECT id FROM tasks LIMIT 5",
    );
    expect(okSql("select id from tasks limit 5")).toBe(
      "select id from tasks limit 5",
    );
  });

  test("обычный запрос границу получает", () => {
    expect(okSql("SELECT * FROM tasks")).toBe("SELECT * FROM tasks LIMIT 51");
  });
});

describe("комментарии отклоняются целиком", () => {
  for (const sql of [
    "SELECT id FROM tasks --",
    "SELECT id FROM tasks -- всё остальное",
    "SELECT id FROM tasks /* limit */",
    "SELECT /* messages */ id FROM tasks",
  ]) {
    test(JSON.stringify(sql), () => {
      const v = validateQueryDbSql(sql);
      expect(v.ok).toBe(false);
      expect((v as { ok: false; error: string }).error).toContain(
        "комментарии",
      );
    });
  }
});

describe("вырезание литералов не ослабляет денилист", () => {
  // Денилист работает по исходному тексту — иначе закавыченное имя закрытой
  // таблицы вырезалось бы вместе с литералом и проходило насквозь.
  for (const sql of [
    'SELECT * FROM "messages"',
    "SELECT * FROM [messages]",
    "SELECT * FROM main.messages",
    "SELECT * FROM approvals",
  ]) {
    test(JSON.stringify(sql), () => {
      const v = validateQueryDbSql(sql);
      expect(v.ok).toBe(false);
      expect((v as { ok: false; error: string }).error).toContain("закрыта");
    });
  }
});
