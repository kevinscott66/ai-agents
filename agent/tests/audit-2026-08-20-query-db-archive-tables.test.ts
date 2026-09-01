/**
 * Аудит 2026-08-20: денилист QUERY_DB не закрывал `approvals_archive`.
 *
 * В `lib/query-db.ts` перечислены `messages`, `audit_logs`, `agent_actions`,
 * `approvals` — и архивы первых трёх. Архив апрувов пропущен, а проверка идёт
 * регэкспом `\bИМЯ\b`: между `s` и `_` границы слова нет (оба символа
 * словесные), поэтому `\bapprovals\b` не совпадает с `approvals_archive`.
 *
 * Сценарий: роль `backend` или `orchestrator` — единственные, кому отдан
 * QUERY_DB (`permissions.ts`), — под prompt-injection зовёт
 * `QUERY_DB { sql: "SELECT action_type, payload, reason FROM approvals_archive" }`.
 * Валидатор пропускает: префикс `select` разрешён, `;` нет, денилист молчит.
 * Соединение `readonly` не мешает — это чтение. Модель получает `payload` и
 * `reason` всех архивных заявок: тела постов, тексты сообщений, аргументы
 * MAC_RUN_CLAUDE, причины отказов владельца.
 *
 * Таблица живая: схема в `migrations.ts`, наполняется `ArchiveSpec` в
 * `db-maint.ts`, попадает в холодный экспорт `cold-storage.ts`. Пропуск не
 * политика, а недосмотр: `approvals` начал архивироваться позже остальных
 * (миграция 042), и список с тех пор не трогали.
 *
 * Инвариант: если таблица закрыта, её архив закрыт тоже — и это проверяется
 * против СХЕМЫ, а не против копии списка, иначе следующая `*_archive`
 * повторит историю.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { validateQueryDbSql } from "../lib/query-db.ts";

function blocked(sql: string): boolean {
  const r = validateQueryDbSql(sql);
  return !r.ok && r.error.includes("закрыта");
}

/** Все `*_archive`, реально объявленные в схеме. */
function archiveTablesFromSchema(): string[] {
  const src = readFileSync(
    new URL("../lib/migrations.ts", import.meta.url).pathname,
    "utf-8",
  );
  const names = new Set<string>();
  for (const m of src.matchAll(
    /CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+_archive)\b/g,
  )) {
    names.add(m[1]);
  }
  return [...names].sort();
}

describe("QUERY_DB: архивы приватных таблиц закрыты", () => {
  test("approvals_archive не читается", () => {
    expect(blocked("SELECT action_type, payload, reason FROM approvals_archive"))
      .toBe(true);
  });

  test("каждая *_archive из схемы закрыта денилистом", () => {
    const tables = archiveTablesFromSchema();
    // Если тут пусто — сломался парсер, а не схема: молчаливо зелёный тест
    // хуже отсутствующего.
    expect(tables.length).toBeGreaterThanOrEqual(4);

    const open = tables.filter((t) => !blocked(`SELECT * FROM ${t}`));
    expect(open).toEqual([]);
  });

  test("база тоже закрыта — архив не подменяет проверку исходной таблицы", () => {
    for (const t of ["approvals", "messages", "audit_logs", "agent_actions"]) {
      expect({ table: t, blocked: blocked(`SELECT * FROM ${t}`) }).toEqual({
        table: t,
        blocked: true,
      });
    }
  });

  test("рабочие таблицы по-прежнему читаются", () => {
    // Смысл денилиста — приватный контент, а не запрет на QUERY_DB вообще.
    for (const t of ["tasks", "permissions", "agent_states"]) {
      const r = validateQueryDbSql(`SELECT * FROM ${t}`);
      expect({ table: t, ok: r.ok }).toEqual({ table: t, ok: true });
    }
  });
});
