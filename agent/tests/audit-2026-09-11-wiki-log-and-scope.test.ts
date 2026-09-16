/**
 * Аудит 2026-09-11, круг 31 — три находки в слое памяти.
 *
 * 1. Санитизация строки лога жила двумя отдельно написанными копиями
 *    (`wikiAppendLog` в memory.ts и `wikiAppendLogAsync` в memory-async.ts),
 *    посимвольно одинаковыми. Обе снимали `\n` и не снимали `\r` — тогда как
 *    соседний `sanitizeWikiTitle` в том же файле снимает оба конца строки.
 *    Формат лога — одна запись на строку, хвост лога уходит в system-промпт
 *    каждого хода, и возврат каретки внутри записи остаётся в файле.
 *
 * 2. `walkAndIndex` выводил заголовок как
 *    `content.split("\n")[0]?…  ?? entry.name`. Ветка с `??` недостижима:
 *    `split` всегда отдаёт минимум один элемент. Страница, начинающаяся с
 *    пустой строки, индексировалась с ПУСТЫМ title, а запасной вариант, на
 *    который рассчитывал читатель этой строки, не существовал.
 *
 * 3. `scopeDir` собирал `join(MEMORY_DIR, scope)` без проверки на выход за
 *    корень. Достижимого пути нет — все вызывающие передают литерал `_team`
 *    или ключ роли из CHARACTERS, — но инвариант держался на вызывающих, а не
 *    на том, кто путь собирает. Плюс копий у `scopeDir` было две: своя в
 *    memory-async.ts, и правка одной не доехала бы до второй.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  sanitizeWikiLogLine,
  scopeDir,
  wikiAppendLog,
  wikiLog,
  rebuildWikiIndex,
  InvalidSlugError,
} from "../lib/memory.ts";
import { wikiAppendLogAsync } from "../lib/memory-async.ts";
import { db } from "../lib/db.ts";

const MEMORY_DIR = process.env.MEMORY_DIR ?? "memory";
const SCOPE = "audit0911scope";
const SCOPE_DIR = join(MEMORY_DIR, SCOPE);

beforeEach(() => {
  rmSync(SCOPE_DIR, { recursive: true, force: true });
  db.prepare(`DELETE FROM wiki_fts WHERE scope = ?`).run(SCOPE);
});
afterEach(() => {
  rmSync(SCOPE_DIR, { recursive: true, force: true });
  db.prepare(`DELETE FROM wiki_fts WHERE scope = ?`).run(SCOPE);
});

describe("строка лога: перевод строки и возврат каретки — оба", () => {
  test("возврат каретки не доживает до файла", () => {
    expect(sanitizeWikiLogLine("до\rпосле")).toBe("до после");
  });

  test("CRLF схлопывается в один пробел, а не в два", () => {
    expect(sanitizeWikiLogLine("до\r\nпосле")).toBe("до после");
  });

  test("перевод строки по-прежнему снимается", () => {
    expect(sanitizeWikiLogLine("до\nпосле")).toBe("до после");
  });

  test("потолок в 240 символов на месте", () => {
    expect(sanitizeWikiLogLine("x".repeat(500))).toHaveLength(240);
  });

  test("синхронный писатель кладёт в лог ровно одну строку", () => {
    wikiAppendLog(SCOPE, "первая\rвторая", "qa");
    const raw = readFileSync(join(SCOPE_DIR, "log.md"), "utf8");
    expect(raw).not.toContain("\r");
    expect(raw.trim().split("\n")).toHaveLength(1);
  });

  test("асинхронный писатель ведёт себя так же — правило одно на двоих", async () => {
    await wikiAppendLogAsync(SCOPE, "первая\rвторая", "qa");
    const raw = readFileSync(join(SCOPE_DIR, "log.md"), "utf8");
    expect(raw).not.toContain("\r");
    expect(wikiLog(SCOPE)).toContain("первая вторая");
  });
});

describe("ребилд индекса: заголовок страницы без годной первой строки", () => {
  const title = (slug: string): string | undefined =>
    (
      db
        .prepare(`SELECT title FROM wiki_fts WHERE scope = ? AND slug = ?`)
        .get(SCOPE, slug) as { title: string } | undefined
    )?.title;

  test("файл, начинающийся с пустой строки, получает имя файла заголовком", () => {
    mkdirSync(join(SCOPE_DIR, "pages"), { recursive: true });
    writeFileSync(join(SCOPE_DIR, "pages", "roadmap.md"), "\n# Не первая строка\n\nтело\n");
    rebuildWikiIndex();
    expect(title("roadmap")).toBe("roadmap");
  });

  test("нормальный заголовок берётся из первой строки, как и раньше", () => {
    mkdirSync(join(SCOPE_DIR, "pages"), { recursive: true });
    writeFileSync(join(SCOPE_DIR, "pages", "plan.md"), "# Дорожная карта\n\nтело\n");
    rebuildWikiIndex();
    expect(title("plan")).toBe("Дорожная карта");
  });

  test("пустой файл тоже не даёт пустого заголовка", () => {
    mkdirSync(join(SCOPE_DIR, "pages"), { recursive: true });
    writeFileSync(join(SCOPE_DIR, "pages", "empty.md"), "");
    rebuildWikiIndex();
    expect(title("empty")).toBe("empty");
  });
});

describe("scopeDir: корень памяти сторожит тот, кто собирает путь", () => {
  test("обычный scope проходит", () => {
    expect(scopeDir(SCOPE)).toBe(join(MEMORY_DIR, SCOPE));
  });

  test("scope со сходом вверх отбивается", () => {
    expect(() => scopeDir("../../etc")).toThrow(InvalidSlugError);
  });

  test("сход вверх из глубины scope отбивается тоже", () => {
    expect(() => scopeDir("_team/../../etc")).toThrow(InvalidSlugError);
  });

  // Не сторож, а факт про `join`: ведущий слэш он считает сегментом, а не
  // корнем, так что абсолютный scope и до правки оставался внутри памяти.
  // Записано, чтобы следующий читатель не завёл на это лишнюю проверку.
  test("абсолютный scope join сводит внутрь корня сам", () => {
    expect(scopeDir("/etc")).toBe(join(MEMORY_DIR, "etc"));
  });

  test("лог по такому scope не пишется — сторож стоит до файловой операции", () => {
    expect(() => wikiAppendLog("../../tmp", "строка", "qa")).toThrow(InvalidSlugError);
  });

  test("копия scopeDir в memory-async.ts не завелась заново", () => {
    const src = readFileSync(new URL("../lib/memory-async.ts", import.meta.url), "utf8");
    expect(src).not.toContain("function scopeDir(");
  });
});
