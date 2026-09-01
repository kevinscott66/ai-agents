/**
 * Аудит 2026-08-27: у `shouldProcessTrigger` политика на сбой БД объявлена, но
 * выполнялась только на трети пути.
 *
 * Catch у INSERT'а формулирует её прямо: «пропуск триггера — это молчание бота,
 * которое пользователь не отличит от поломки, а лишний повтор хотя бы виден и
 * редок». Уборка (`DELETE`) и проверка дубля (`SELECT`) стояли ВНЕ try/catch,
 * поэтому сбой БД на них улетал исключением из функции в telegraf-хендлер
 * (orchestrator/message-handler.ts:359). Тот роняет обработку апдейта целиком —
 * ровно то молчание, которое catch внизу и запрещал.
 *
 * Стенд подменяет `db.prepare` так, чтобы падал ровно один нужный запрос:
 * важно, что функция отвечает `true` (обрабатываем), а не то, как именно
 * bun:sqlite сообщает о сбое.
 */
import { test, expect, describe, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import { shouldProcessTrigger } from "../lib/trigger-anti-dup.ts";

const CHAT = "-100827001";
const originalPrepare = db.prepare.bind(db);

function breakStatement(fragment: string): void {
  (db as { prepare: typeof db.prepare }).prepare = ((sql: string, ...rest: unknown[]) => {
    if (sql.includes(fragment)) throw new Error("database disk image is malformed");
    return (originalPrepare as (...a: unknown[]) => unknown)(sql, ...rest);
  }) as typeof db.prepare;
}

afterEach(() => {
  (db as { prepare: typeof db.prepare }).prepare = originalPrepare;
  originalPrepare(`DELETE FROM processed_triggers WHERE chat_id = ?`).run(CHAT);
});

describe("trigger-anti-dup: сбой БД не глотает сообщение", () => {
  test("падение SELECT'а даёт обработку, а не исключение", () => {
    breakStatement("SELECT 1 FROM processed_triggers");
    expect(shouldProcessTrigger(CHAT, 101)).toBe(true);
  });

  test("падение уборки не мешает дедупу работать дальше", () => {
    breakStatement("DELETE FROM processed_triggers");
    expect(shouldProcessTrigger(CHAT, 102)).toBe(true);
    // Уборка — это размер таблицы, а не ответ: дубль ловится по-прежнему.
    expect(shouldProcessTrigger(CHAT, 102)).toBe(false);
  });

  test("падение INSERT'а тоже даёт обработку", () => {
    breakStatement("INSERT OR IGNORE INTO processed_triggers");
    expect(shouldProcessTrigger(CHAT, 103)).toBe(true);
  });

  test("на здоровой БД поведение прежнее: первый — да, второй — нет", () => {
    expect(shouldProcessTrigger(CHAT, 104)).toBe(true);
    expect(shouldProcessTrigger(CHAT, 104)).toBe(false);
  });
});
