/**
 * Аудит 2026-08-28: обрезка по числу строк не помечалась `truncated`.
 *
 * В воркере два бюджета и два выхода из цикла. Байтовый ставит
 * `truncated = true` (query-db-worker.ts:52), строчный — `if (taken >=
 * input.limit) break;` — не ставил ничего. Разница видна снаружи: `truncated`
 * доезжает до модели через tools-schema.ts:1006.
 *
 * Знать об обрыве есть откуда: итератор УЖЕ отдал очередную строку, которую мы
 * выбрасываем, — значит в результате есть ещё как минимум одна.
 *
 * Кому это важно: модель, написавшая собственный `LIMIT 200` и не передавшая
 * аргумент `limit`, получает 50 строк (авто-граница воркера) и слово, что это
 * полный ответ. Дальше она считает по ним сумму или делает вывод «таких задач
 * всего 50» — тихая, неотличимая от правды ошибка. Байтовая обрезка ровно этот
 * же случай честно помечает.
 */
import { describe, expect, test } from "bun:test";
import { runQueryDbSandboxed } from "../lib/query-db.ts";

/** N строк без обращения к таблицам — результат не зависит от состояния БД. */
const rows = (n: number) =>
  `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < ${n}) SELECT x FROM c`;

const run = (sql: string, limit: number) =>
  runQueryDbSandboxed(sql, limit, { timeoutMs: 10_000 });

describe("обрыв по числу строк помечается", () => {
  test("строк больше лимита — truncated", async () => {
    const res = await run(rows(10), 3);
    expect(res.ok).toBe(true);
    expect(res).toMatchObject({ count: 3, truncated: true });
  }, 20_000);

  test("лимит 1 при десяти строках — тоже", async () => {
    const res = await run(rows(10), 1);
    expect(res).toMatchObject({ count: 1, truncated: true });
  }, 20_000);
});

describe("полный ответ остаётся полным", () => {
  test("строк ровно по лимиту — не truncated", async () => {
    const res = await run(rows(3), 3);
    expect(res).toMatchObject({ count: 3 });
    expect((res as { truncated?: boolean }).truncated).toBeUndefined();
  }, 20_000);

  test("строк меньше лимита — не truncated", async () => {
    const res = await run(rows(2), 50);
    expect(res).toMatchObject({ count: 2 });
    expect((res as { truncated?: boolean }).truncated).toBeUndefined();
  }, 20_000);

  test("пустой результат — не truncated", async () => {
    const res = await run("SELECT 1 AS n WHERE 0", 50);
    expect(res).toMatchObject({ ok: true, count: 0 });
    expect((res as { truncated?: boolean }).truncated).toBeUndefined();
  }, 20_000);
});
