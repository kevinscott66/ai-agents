/**
 * Аудит 2026-08-12: имя scope лежало в полнотекстовом индексе и подмешивалось
 * в результаты поиска по вики.
 *
 * lib/db.ts, схема:
 *
 *   CREATE VIRTUAL TABLE wiki_fts USING fts5(
 *     scope,          -- ИНДЕКСИРУЕТСЯ
 *     slug UNINDEXED,
 *     title,
 *     content,
 *     tokenize='unicode61'
 *   );
 *
 * `slug` от индекса отвязали, а `scope` — нет. Значит запрос со словом,
 * совпадающим с именем области («backend», «design», «product», «team» —
 * unicode61 режет `_team` по подчёркиванию), матчится КАЖДОЙ страницей этой
 * области, даже если самого слова в ней нет.
 *
 * Чем это плохо ровно здесь: wikiSearch отдаёт всего пять хитов, и они идут в
 * промпт роли как «вот что мы про это знаем». Пять слотов забиваются
 * случайными страницами своей же области, а страница с ответом, лежащая в
 * другой, до промпта не доходит. При этом WHERE scope IN (...) уже и так
 * ограничивает выборку областью — участие scope в MATCH не даёт ничего, кроме
 * шума.
 *
 * Инвариант: MATCH ищет по заголовку и телу. Имя области — фильтр (WHERE), а
 * не текст, в котором ищут.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { wikiSearch, wikiWrite } from "../lib/memory.ts";
import { db } from "../lib/db.ts";
import { MIGRATIONS } from "../lib/migrations.ts";

const MEMORY_DIR = process.env.MEMORY_DIR ?? "memory";
/**
 * Имя области — обычное слово, которое может встретиться в запросе. Берём
 * синтетическое, а не реальный ключ роли: clean() сносит каталог области, а у
 * настоящих ролей там лежат файлы вики, которые под контролем версий.
 */
const SCOPE = "ftsnoise";
const SCOPE_DIR = join(MEMORY_DIR, SCOPE);
/** wikiWrite канонизирует ключ: «pages/x» хранится как «x». */
const SLUGS = ["noise-a", "noise-b", "noise-hit"];

function clean() {
  for (const slug of SLUGS) {
    db.prepare(`DELETE FROM wiki_fts WHERE scope = ? AND slug = ?`).run(
      SCOPE,
      slug,
    );
  }
  rmSync(SCOPE_DIR, { recursive: true, force: true });
}

beforeEach(() => {
  clean();
  wikiWrite({
    scope: SCOPE as any,
    slug: SLUGS[0]!,
    title: "Расписание дежурств",
    content: "Кто дежурит по понедельникам и что делать при инциденте.",
  });
  wikiWrite({
    scope: SCOPE as any,
    slug: SLUGS[1]!,
    title: "Формат отчётов",
    content: "Как оформлять еженедельный отчёт для команды.",
  });
  wikiWrite({
    scope: SCOPE as any,
    slug: SLUGS[2]!,
    title: "Деплой ftsnoise на VPS",
    content: "Ftsnoise выкатывается скриптом deploy.sh под systemd.",
  });
});

afterEach(clean);

describe("wikiSearch: имя области не участвует в полнотекстовом поиске", () => {
  test("запрос со словом-именем области не тащит все страницы области", () => {
    const hits = wikiSearch("ftsnoise деплой", [SCOPE as any], 10);
    const slugs = hits.map((h) => h.slug);
    expect(slugs).toContain(SLUGS[2]);
    // Ни в заголовке, ни в теле этих двух слова «ftsnoise» нет.
    expect(slugs).not.toContain(SLUGS[0]);
    expect(slugs).not.toContain(SLUGS[1]);
  });

  test("страница с ответом не вытесняется шумом из пяти слотов", () => {
    const hits = wikiSearch("ftsnoise", [SCOPE as any], 5);
    expect(hits.map((h) => h.slug)).toEqual([SLUGS[2]]);
  });

  test("фильтр по области продолжает работать", () => {
    const hits = wikiSearch("деплой", [SCOPE as any], 10);
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) expect(h.scope).toBe(SCOPE);
  });

  test("обычный поиск по телу не сломан", () => {
    const hits = wikiSearch("дежурит понедельникам", [SCOPE as any], 10);
    expect(hits.map((h) => h.slug)).toContain(SLUGS[0]);
  });
});

describe("миграция 041: пересборка таблицы на существующей базе", () => {
  const up = MIGRATIONS.find((m) => m.name === "041_wiki_fts_scope_unindexed")!
    .up;

  /** Схема ровно та, что была в проде до аудита. */
  function oldSchemaDb(): Database {
    const mem = new Database(":memory:");
    mem.exec(`
      CREATE VIRTUAL TABLE wiki_fts USING fts5(
        scope,
        slug UNINDEXED,
        title,
        content,
        tokenize='unicode61'
      );
    `);
    mem.prepare(
      `INSERT INTO wiki_fts(scope, slug, title, content) VALUES (?, ?, ?, ?)`,
    ).run("ftsnoise", "keep-me", "Расписание", "Кто дежурит по понедельникам.");
    return mem;
  }

  test("scope становится UNINDEXED, строки на месте", () => {
    const mem = oldSchemaDb();
    try {
      up(mem);
      const sql = (
        mem
          .prepare(
            `SELECT sql FROM sqlite_master WHERE type='table' AND name='wiki_fts'`,
          )
          .get() as { sql: string }
      ).sql;
      expect(sql).toMatch(/scope\s+UNINDEXED/i);
      const row = mem
        .prepare(`SELECT scope, slug, title FROM wiki_fts`)
        .get() as { scope: string; slug: string; title: string };
      expect(row).toEqual({
        scope: "ftsnoise",
        slug: "keep-me",
        title: "Расписание",
      });
    } finally {
      mem.close();
    }
  });

  test("после миграции имя области больше не матчится", () => {
    const mem = oldSchemaDb();
    try {
      up(mem);
      const hits = mem
        .prepare(`SELECT slug FROM wiki_fts WHERE wiki_fts MATCH ?`)
        .all('"ftsnoise"*') as Array<{ slug: string }>;
      expect(hits).toEqual([]);
    } finally {
      mem.close();
    }
  });

  test("повторный прогон миграций ничего не ломает", () => {
    const mem = oldSchemaDb();
    try {
      up(mem);
      up(mem);
      const n = mem.prepare(`SELECT COUNT(*) AS n FROM wiki_fts`).get() as {
        n: number;
      };
      expect(n.n).toBe(1);
    } finally {
      mem.close();
    }
  });
});
