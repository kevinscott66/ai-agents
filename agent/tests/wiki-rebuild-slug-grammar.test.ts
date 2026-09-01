/**
 * Аудит 2026-08-12: файл вики с «неудобным» именем клал в FTS-индекс слаг,
 * который читатель принять не может, — и ронял ход агента.
 *
 * `walkAndIndex` кладёт в `wiki_fts` слаг, выведенный из имени файла, БЕЗ
 * валидации:
 *   const slug = slugFromPath(scope, full);
 *   db.prepare(`INSERT INTO wiki_fts(...) VALUES (?, ?, ?, ?)`).run(...)
 * Потребитель же валидирует строго: `pagePath()` первой строкой зовёт
 * `validateSlug`, а SLUG_RE разрешает только [a-zA-Z0-9_-] и ≤4 сегмента.
 *
 * Замер грамматики: "roadmap.v2" → false, "release notes" → false,
 * "Плана-нет" → false, "2026-08-12.notes" → false, "projects/a/b/c/d" → false.
 * То есть одного файла `roadmap.v2.md`, положенного руками в memory/_team/,
 * достаточно.
 *
 * Дальше хит поиска уходит в чтение без обёртки:
 *   const hits = wikiSearch(text, ["_team", def.key], 4);
 *   await Promise.all([..., ...hits.map((h) => wikiReadAsync(h.scope, h.slug))])
 * `InvalidSlugError` роняет `Promise.all` и весь ход: в message-handler.ts
 * пользователь получает «внутренняя ошибка», в handoff.ts делегат молча
 * возвращает null. Причём ломается это для ЛЮБОГО сообщения, чьи токены
 * попадают в OR-запрос FTS по этой странице, — и для всех ролей со страницей
 * в scope.
 *
 * Что важно: остальные потребители того же слага исключение ждут и гасят
 * (READ_WIKI → invalid_slug, SEARCH_WIKI → ok:false, /api/wiki/page → 400).
 * Незакрытыми были ровно два пути сборки промпта — то есть проблема не в
 * потребителях, а в том, что индекс вообще содержит ключи вне грамматики.
 *
 * Инвариант: в wiki_fts не попадает слаг, который не примет validateSlug.
 * Файл с непригодным именем пропускается с предупреждением (его видно и можно
 * переименовать), а не превращается в мину для каждого хода.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { rebuildWikiIndex, validateSlug, wikiSearch } from "../lib/memory.ts";
import { db } from "../lib/db.ts";

const MEMORY_DIR = process.env.MEMORY_DIR ?? "memory";
const SCOPE = "slugrammartest";
const SCOPE_DIR = join(MEMORY_DIR, SCOPE);

/** Имена, которые человек кладёт руками, а грамматика слагов не принимает. */
const BAD_FILES = [
  "roadmap.v2.md",
  "release notes.md",
  "Плана-нет.md",
  "2026-08-12.notes.md",
];

function slugs(): string[] {
  return (
    db
      .prepare(`SELECT slug FROM wiki_fts WHERE scope = ? ORDER BY slug`)
      .all(SCOPE) as { slug: string }[]
  ).map((r) => r.slug);
}

beforeEach(() => {
  rmSync(SCOPE_DIR, { recursive: true, force: true });
  mkdirSync(join(SCOPE_DIR, "pages"), { recursive: true });
});

afterEach(() => {
  rmSync(SCOPE_DIR, { recursive: true, force: true });
  db.prepare(`DELETE FROM wiki_fts WHERE scope = ?`).run(SCOPE);
});

describe("ребилд индекса не кладёт слаги вне грамматики", () => {
  test("файлы с непригодными именами в индекс не попадают", () => {
    for (const name of BAD_FILES) {
      writeFileSync(join(SCOPE_DIR, "pages", name), `# ${name}\n\nтекст про мониторинг\n`);
    }
    rebuildWikiIndex();
    expect(slugs()).toEqual([]);
  });

  test("нормальные страницы рядом с непригодными индексируются как обычно", () => {
    writeFileSync(join(SCOPE_DIR, "pages", "roadmap.v2.md"), "# v2\n\nмониторинг\n");
    writeFileSync(join(SCOPE_DIR, "pages", "roadmap-v2.md"), "# v2\n\nмониторинг\n");
    rebuildWikiIndex();
    expect(slugs()).toEqual(["roadmap-v2"]);
  });

  test("каждый слаг из индекса проходит validateSlug — то есть читаем", () => {
    writeFileSync(join(SCOPE_DIR, "pages", "release notes.md"), "# Заметки\n\nмониторинг\n");
    writeFileSync(join(SCOPE_DIR, "pages", "ok-page.md"), "# Ок\n\nмониторинг\n");
    mkdirSync(join(SCOPE_DIR, "a", "b", "c", "d"), { recursive: true });
    writeFileSync(join(SCOPE_DIR, "a", "b", "c", "d", "deep.md"), "# Глубоко\n\nмониторинг\n");
    rebuildWikiIndex();

    const all = slugs();
    expect(all.length).toBeGreaterThan(0);
    for (const s of all) expect(() => validateSlug(s)).not.toThrow();
  });

  test("хит поиска по такой странице больше не появляется", () => {
    writeFileSync(join(SCOPE_DIR, "pages", "Плана-нет.md"), "# План\n\nмониторинг стенда\n");
    rebuildWikiIndex();
    const hits = wikiSearch("мониторинг", [SCOPE], 4);
    for (const h of hits) expect(() => validateSlug(h.slug)).not.toThrow();
  });
});
