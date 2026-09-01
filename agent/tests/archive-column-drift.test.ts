/**
 * Аудит 2026-08-08: архивация переносит колонки по захардкоженному списку.
 *
 * `moveToArchive` строит INSERT ... SELECT из `ArchiveSpec.columns`, а сразу
 * следом удаляет строки из источника. Колонка, добавленная миграцией в источник
 * и не дописанная в спеку, теряется на каждом суточном прогоне — без ошибки, без
 * отличия в логе. Так уже случилось с `request_id`, `transport` и
 * `tg_message_id` (чинила миграция 040), и ничто не мешало этому повториться:
 * список и схема связаны только вниманием того, кто пишет миграцию.
 *
 * Этот тест — и есть недостающая связь. Он падает в CI на следующей миграции,
 * которая добавит колонку и забудет спеку, то есть до того, как что-то потеряется
 * на проде.
 */
import { describe, test, expect } from "bun:test";
import { db } from "../lib/db.ts";
import {
  MESSAGES_SPEC,
  AGENT_ACTIONS_SPEC,
  AUDIT_LOGS_SPEC,
  type ArchiveSpec,
} from "../lib/db-maint.ts";

function columnsOf(table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
    .map((c) => c.name);
}

const SPECS: ArchiveSpec[] = [
  MESSAGES_SPEC,
  AGENT_ACTIONS_SPEC,
  AUDIT_LOGS_SPEC,
];

function declaredColumns(spec: ArchiveSpec): string[] {
  return [...spec.columns, ...(spec.optionalColumns ?? [])];
}

describe("ArchiveSpec не отстаёт от схемы", () => {
  // Схема берётся из живой БД тестов: базовые таблицы объявлены прямо в db.ts,
  // а не миграцией, так что собрать её отдельно в :memory: нельзя — получилась бы
  // другая схема, и тест сторожил бы не то.

  for (const spec of SPECS) {
    test(`${spec.source}: каждая колонка источника переносится в архив`, () => {
      const actual = columnsOf(spec.source);
      expect(actual.length).toBeGreaterThan(0);
      const listed = new Set(declaredColumns(spec));
      const dropped = actual.filter((c) => !listed.has(c));
      // Пустой список — единственный допустимый результат: всё, что есть в
      // источнике, должно доехать до архива, иначе DELETE это сотрёт.
      expect(dropped).toEqual([]);
    });

    test(`${spec.source}: спека не перечисляет несуществующих колонок`, () => {
      // Обратная сторона: лишнее имя в спеке уронит INSERT целиком, и
      // архивация встанет молча — до следующего чтения логов.
      const actual = new Set(columnsOf(spec.source));
      const phantom = spec.columns.filter((c) => !actual.has(c));
      expect(phantom).toEqual([]);
    });

    test(`${spec.source}: архив принимает ровно эти колонки + archived_at`, () => {
      const archive = new Set(columnsOf(spec.archive));
      expect(archive.size).toBeGreaterThan(0);
      const source = new Set(columnsOf(spec.source));
      const missing = declaredColumns(spec).filter(
        (c) => source.has(c) && !archive.has(c),
      );
      expect(missing).toEqual([]);
      expect(archive.has("archived_at")).toBe(true);
    });

    test(`${spec.source}: колонка отбора по времени существует`, () => {
      expect(columnsOf(spec.source)).toContain(spec.cutoffColumn);
    });
  }
});
