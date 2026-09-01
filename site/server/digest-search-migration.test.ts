/**
 * Миграция `digests.search_text` на базе, созданной до её появления.
 *
 * Отдельный файл, потому что базу нужно собрать старым DDL ДО первого импорта
 * `db.ts` — иначе миграция отработает на пустой таблице и проверять будет
 * нечего. Живая база на VPS как раз такая: 102 дайджеста, записанных когда
 * колонки ещё не было. Если бэкфилл не сработает, поиск после деплоя
 * замолчит на всём архиве — это ровно тот случай, который стоит проверять.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "web3puls-search-migr-"));
const LEGACY = join(TMP, "legacy.db");
const PREV_PATH = process.env.SITE_DB_PATH;

// Схема ровно та, что была до правки: search_text отсутствует.
{
  const raw = new Database(LEGACY, { create: true });
  raw.run(`CREATE TABLE digests (
    id           TEXT PRIMARY KEY,
    title        TEXT NOT NULL,
    date         TEXT NOT NULL,
    summary      TEXT NOT NULL,
    items_json   TEXT NOT NULL DEFAULT '[]',
    source_count INTEGER NOT NULL DEFAULT 0,
    body         TEXT NOT NULL DEFAULT ''
  )`);
  const ins = raw.query(
    `INSERT INTO digests (id, title, date, summary, items_json)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  );
  ins.run(
    "old-normal",
    "Старая Запись Про Биткоин",
    "2026-01-01",
    "Аннотация С Большой Буквы",
    JSON.stringify([{ text: "Внутренний Пункт Про Эфириум" }]),
  );
  // Битый JSON в items_json пишет модель через ингест — бэкфилл обязан его
  // пережить, а не уронить старт сервера.
  ins.run("old-broken", "Битая Запись", "2026-01-02", "Аннотация", "{не json");
  // Валидный JSON тоже может содержать элементы не из DigestItem.
  ins.run("old-null", "Запись С Null", "2026-01-03", "Аннотация", "[null]");
  raw.close();
}

process.env.SITE_DB_PATH = LEGACY;
const { countSearchDigests, searchDigests, getDb } = await import("./db.ts");

afterAll(() => {
  // CLAUDE.md §3.8.7: env не течёт в соседние файлы тестов.
  if (PREV_PATH === undefined) delete process.env.SITE_DB_PATH;
  else process.env.SITE_DB_PATH = PREV_PATH;
});

describe("бэкфилл search_text на старой базе", () => {
  test("колонка появляется", () => {
    const cols = getDb()
      .query("PRAGMA table_info(digests)")
      .all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("search_text");
  });

  test("старая строка ищется в любом регистре по всем трём полям", () => {
    for (const q of [
      "старая запись",
      "СТАРАЯ ЗАПИСЬ",
      "аннотация с большой буквы",
      "внутренний пункт про эфириум",
      "ВНУТРЕННИЙ ПУНКТ",
    ]) {
      expect(countSearchDigests(q)).toBeGreaterThan(0);
    }
    expect(searchDigests("биткоин", 10, 0).map((d) => d.id)).toContain("old-normal");
  });

  test("строка с битым items_json не теряется — заголовок ищется", () => {
    expect(searchDigests("битая запись", 10, 0).map((d) => d.id)).toContain(
      "old-broken",
    );
  });

  test("массив с null не роняет бэкфилл — заголовок ищется", () => {
    expect(searchDigests("запись с null", 10, 0).map((d) => d.id)).toContain(
      "old-null",
    );
  });

  test("повторное открытие базы не перетирает бэкфилл", () => {
    // Второй проход migrate() обязан быть no-op: колонка уже есть, значит
    // addColumnIfMissing вернёт false и бэкфилл не побежит по всей таблице
    // на каждом рестарте.
    getDb().close();
    // @ts-expect-error — сбрасываем кэш модуля через смену пути и обратно.
    void 0;
    process.env.SITE_DB_PATH = join(TMP, "other.db");
    countSearchDigests("x");
    process.env.SITE_DB_PATH = LEGACY;
    expect(countSearchDigests("СТАРАЯ ЗАПИСЬ")).toBeGreaterThan(0);
  });
});
