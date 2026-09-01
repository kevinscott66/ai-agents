/**
 * Аудит 2026-08-28: авто-LIMIT делал признак `truncated` недостижимым.
 *
 * Аудит того же дня научил воркер помечать обрыв по числу строк: итератор УЖЕ
 * отдал строку сверх лимита — значит в результате есть ещё хотя бы одна
 * (`query-db-worker.ts:48`). Закрыта этим была редкая ветка — модель написала
 * собственный `LIMIT 200` и не передала аргумент `limit`.
 *
 * Ветка по умолчанию осталась открытой, и она же основная. Валидатор
 * дописывает `LIMIT ${limit}` — РОВНО то число, которое уходит воркеру как
 * `input.limit`. SQLite отдаёт по этой границе ровно 50 строк, итератор
 * завершается на 50-й, в тело цикла с `taken >= input.limit` управление на
 * 51-й не заходит, потому что 51-й строки нет. `truncated` остаётся false.
 *
 * Роль `backend` спрашивает `SELECT id, title FROM tasks WHERE status='open'`,
 * открытых задач 300 — и получает 50 строк со словом, что это полный ответ.
 * Дальше по ним считается сумма или делается вывод «открытых всего 50»: та
 * самая тихая, неотличимая от правды ошибка, ради которой писался фикс.
 *
 * Починка не меняет ни одной отданной строки: спрашиваем у базы на строку
 * больше, чем готовы отдать, и воркер снова видит сигнал, на котором построен.
 */
import { describe, expect, test } from "bun:test";
import { runQueryDbSandboxed, validateQueryDbSql } from "../lib/query-db.ts";

/** N строк без обращения к таблицам — результат не зависит от состояния БД. */
const rows = (n: number) =>
  `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < ${n}) SELECT x FROM c`;

function validated(sql: string, limit?: number) {
  const v = validateQueryDbSql(sql, limit);
  expect(v.ok).toBe(true);
  return v as { ok: true; sql: string; limit: number };
}

/** Полный путь тула: валидатор отдаёт воркеру ровно то, что собрал сам. */
async function endToEnd(sql: string, limit?: number) {
  const v = validated(sql, limit);
  return runQueryDbSandboxed(v.sql, v.limit, { timeoutMs: 10_000 });
}

describe("предпосылки", () => {
  test("граница, равная лимиту воркера, обрыв скрывает", async () => {
    // Ровно та форма, которую собирал валидатор до правки. Она остаётся
    // достижимой руками, поэтому проверяем на ней сам механизм слепоты:
    // строк триста, отдано пятьдесят, и ни следа обрезки.
    const res = await runQueryDbSandboxed(`${rows(300)} LIMIT 50`, 50, {
      timeoutMs: 10_000,
    });
    expect(res).toMatchObject({ ok: true, count: 50 });
    expect((res as { truncated?: boolean }).truncated ?? false).toBe(false);
  }, 20_000);
});

describe("валидатор просит на строку больше, чем отдаёт", () => {
  test("дефолтный лимит: в SQL 51, наружу 50", () => {
    const v = validated("SELECT * FROM tasks");
    expect(v.sql).toBe("SELECT * FROM tasks LIMIT 51");
    expect(v.limit).toBe(50);
  });

  test("явный лимит: та же разница в единицу", () => {
    expect(validated("SELECT * FROM tasks", 3)).toMatchObject({
      sql: "SELECT * FROM tasks LIMIT 4",
      limit: 3,
    });
    expect(validated("SELECT * FROM tasks", 1)).toMatchObject({
      sql: "SELECT * FROM tasks LIMIT 2",
      limit: 1,
    });
  });

  test("лимит зажимается до 200, и разведочная строка считается от зажатого", () => {
    expect(validated("SELECT * FROM tasks", 5000)).toMatchObject({
      sql: "SELECT * FROM tasks LIMIT 201",
      limit: 200,
    });
  });

  test("своя клауза остаётся нетронутой — второй границы не появляется", () => {
    expect(validated("SELECT id FROM tasks LIMIT 5").sql).toBe(
      "SELECT id FROM tasks LIMIT 5",
    );
    expect(validated("select id from tasks limit 5").sql).toBe(
      "select id from tasks limit 5",
    );
  });
});

describe("сквозной путь тула", () => {
  test("строк больше лимита по умолчанию — обрыв помечен", async () => {
    const res = await endToEnd(rows(300));
    expect(res).toMatchObject({ ok: true, count: 50, truncated: true });
  }, 20_000);

  test("строк ровно по лимиту — обрыва нет и врать не о чем", async () => {
    const res = await endToEnd(rows(50));
    expect(res).toMatchObject({ ok: true, count: 50 });
    expect((res as { truncated?: boolean }).truncated ?? false).toBe(false);
  }, 20_000);

  test("строк меньше лимита — тоже нет", async () => {
    const res = await endToEnd(rows(7));
    expect(res).toMatchObject({ ok: true, count: 7 });
    expect((res as { truncated?: boolean }).truncated ?? false).toBe(false);
  }, 20_000);

  test("явный лимит режет по нему же, а не по разведочной строке", async () => {
    const res = await endToEnd(rows(300), 3);
    expect(res).toMatchObject({ ok: true, count: 3, truncated: true });
  }, 20_000);

  test("собственная клауза модели по-прежнему помечается", async () => {
    // Ветка, закрытая утренним аудитом: границу писала модель, воркер режет
    // по своей. Проверяем, что правка её не расшатала.
    const res = await endToEnd(`${rows(300)} LIMIT 200`);
    expect(res).toMatchObject({ ok: true, count: 50, truncated: true });
  }, 20_000);
});
