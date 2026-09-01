/**
 * Аудит 2026-08-12: фикстуры подмешивались в живую базу сайта.
 *
 * `bootstrap()` зовёт `seedIfEmpty()` на КАЖДОМ старте, а решение тот
 * принимает по каждой таблице отдельно: `if (countDrops() === 0) …`. Значит
 * достаточно, чтобы одна таблица оказалась пустой — и в базу, где уже лежат
 * настоящие статьи из ингеста, доедут июньские фикстуры. Никакой отметки о
 * том, что базу уже разворачивали, не было: пустая таблица через полгода
 * работы выглядела ровно как первый запуск.
 *
 * Замер до правки (одна база, три перезапуска подряд):
 *   1. чистая база                   → digests 9, drops 11, activities 2
 *   2. DELETE FROM drops; restart    → drops 11 (июньские фикстуры вернулись)
 *   3. DELETE FROM digests; restart  → digests 9 (все статьи из ингеста
 *      заменены июньскими — на публичном сайте)
 *
 * Инвариант: фикстуры — это разворачивание пустой базы, один раз. База, в
 * которой уже что-то есть (или что-то было), не досеивается никогда.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let TMP: string;

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "web3puls-seed-"));
  process.env.SITE_DB_PATH = join(TMP, "seed.db");
});

afterEach(() => {
  delete process.env.SITE_DB_PATH;
});

async function mods() {
  const { seedIfEmpty } = await import("./seed.ts");
  const db = await import("./db.ts");
  return { seedIfEmpty, ...db };
}

describe("разворачивание базы — один раз", () => {
  test("на чистой базе фикстуры ставятся", async () => {
    const { seedIfEmpty, countDigests, countDrops } = await mods();
    const r = seedIfEmpty();
    expect(r.digests).toBeGreaterThan(0);
    expect(r.drops).toBeGreaterThan(0);
    expect(countDigests()).toBe(r.digests);
    expect(countDrops()).toBe(r.drops);
  });

  test("повторный старт ничего не добавляет", async () => {
    const { seedIfEmpty } = await mods();
    seedIfEmpty();
    expect(seedIfEmpty()).toEqual({ digests: 0, drops: 0, activities: 0 });
  });

  test("опустевшая таблица не возвращает фикстуры", async () => {
    const { seedIfEmpty, getDb, countDrops, countDigests } = await mods();
    seedIfEmpty();
    getDb().run("DELETE FROM drops");
    getDb().run("DELETE FROM digests");
    expect(countDrops()).toBe(0);

    seedIfEmpty();

    // Ровно это и происходило на проде: сайт с настоящими статьями из
    // ингеста после чистки одной таблицы получал июньский набор обратно.
    expect(countDrops()).toBe(0);
    expect(countDigests()).toBe(0);
  });

  test("база с чужим содержимым не досеивается", async () => {
    // Живая база: статьи пришли ингестом, фикстур в ней не было никогда.
    const { seedIfEmpty, upsertDigest, countDigests, countDrops } = await mods();
    upsertDigest({
      id: "real-2026-08-12",
      title: "Настоящая статья из ингеста",
      date: new Date("2026-08-12T00:00:00.000Z").toISOString(),
      summary: "Пришла через /api/ingest.",
      items: [],
      sourceCount: 1,
    });

    const r = seedIfEmpty();

    expect(r).toEqual({ digests: 0, drops: 0, activities: 0 });
    expect(countDigests()).toBe(1);
    expect(countDrops()).toBe(0);
  });
});
