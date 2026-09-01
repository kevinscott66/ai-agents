/**
 * Аудит 2026-08-13: страница вики писалась поверх себя.
 *
 * Оба писателя открывали целевой файл на запись — `writeFileSync(p, body)` в
 * `wikiWrite` и `await writeFile(p, body)` в `wikiWriteAsync`. Это сперва
 * обрезание файла в ноль, потом запись тела. Двумя функциями выше, у подрезки
 * log.md, ровно это уже посчитали неприемлемым и завели запись через временный
 * файл — а страница как минимум не дешевле лога: её содержимое агенты писали
 * руками, и восстановить его неоткуда.
 *
 * Что правка чинит: смерть процесса между обрезанием и записью (deploy делает
 * `systemctl restart` в любой момент) — на диске оставался бы пустой или
 * недописанный файл, и `rebuildWikiIndex` на следующем старте занёс бы обрубок
 * в FTS. И чтение каталога чужим процессом (`tar` бэкапа).
 *
 * Чего НЕ чинит — замерено, а не предположено, и поэтому здесь не проверяется:
 *  - читателей внутри процесса: Bun выполняет `fs.promises.writeFile` одной
 *    задачей пула, не отдавая цикл событий между open(O_TRUNC) и write; замер
 *    на телах 12 KB / 1 MB / 20 MB не показал ни одного промежуточного
 *    состояния, то есть READ_WIKI и компактор обрубок увидеть не могли и до
 *    правки;
 *  - потерю обновления: `mergeAndWrite` — read-modify-write без блокировки.
 *
 * Тестами закрыт механизм, а не сама долговечность (её без убийства процесса
 * посреди записи не показать): временный файл лежит там, где `rename` атомарен,
 * не выглядит страницей для обходчика индекса, уникален на вызов и не остаётся
 * после записи.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { rmSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import {
  wikiWrite,
  wikiRead,
  pagePath,
  pageTmpPath,
  prepareWikiPage,
} from "../lib/memory.ts";
import { wikiWriteAsync } from "../lib/memory-async.ts";
import { db } from "../lib/db.ts";

const SCOPE = "atomicwrite";
const MEMORY_DIR = process.env.MEMORY_DIR ?? "memory";

afterEach(() => {
  db.prepare(`DELETE FROM wiki_fts WHERE scope = ?`).run(SCOPE);
  rmSync(join(MEMORY_DIR, SCOPE), { recursive: true, force: true });
});

/** Все файлы каталога страницы — чтобы поймать осиротевшие временные. */
function siblings(slug: string): string[] {
  const dir = dirname(pagePath(SCOPE, slug));
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

describe("временный файл страницы", () => {
  test("лежит рядом с целевым — rename атомарен только внутри каталога", () => {
    const p = pagePath(SCOPE, "page");
    expect(dirname(pageTmpPath(p))).toBe(dirname(p));
  });

  test("не .md — иначе walkAndIndex проиндексировал бы недописанное", () => {
    const name = basename(pageTmpPath(pagePath(SCOPE, "page")));
    expect(name.endsWith(".tmp")).toBe(true);
    expect(name.endsWith(".md")).toBe(false);
  });

  test("уникален на вызов — два писателя не наложатся друг на друга", () => {
    // У log.md имя фиксированное (`${p}.tmp`) и это верно: писатель там один.
    // У страницы их двое — компактор синхронно и WRITE_WIKI через async.
    const p = pagePath(SCOPE, "page");
    const names = new Set(Array.from({ length: 50 }, () => pageTmpPath(p)));
    expect(names.size).toBe(50);
  });

  test("после записи не остаётся — ни у синхронного писателя, ни у async", async () => {
    wikiWrite({ scope: SCOPE, slug: "page", title: "Т", content: "тело" });
    expect(siblings("page")).toEqual(["page.md"]);
    await wikiWriteAsync({ scope: SCOPE, slug: "page", title: "Т", content: "другое" });
    expect(siblings("page")).toEqual(["page.md"]);
  });

  test("пачка параллельных записей не оставляет мусора в каталоге", async () => {
    const N = 16;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        wikiWriteAsync({
          scope: SCOPE,
          slug: "hot",
          title: `Страница ${i}`,
          content: `секция-${i}`,
        }),
      ),
    );
    expect(siblings("hot")).toEqual(["hot.md"]);
  });
});

describe("оба писателя идут через rename", () => {
  /**
   * Проверка структурная, и это осознанно. Поведенчески правку не отличить:
   * долговечность видна только при убийстве процесса посреди записи, а
   * читателям внутри процесса Bun обрубка не показывает ни до, ни после (см.
   * шапку файла). Инвариант при этом настоящий и легко теряемый — писать в
   * целевой файл напрямую снова начнут при первой же правке рядом.
   */
  const SYNC_SRC = readFileSync(new URL("../lib/memory.ts", import.meta.url), "utf8");
  const ASYNC_SRC = readFileSync(new URL("../lib/memory-async.ts", import.meta.url), "utf8");

  test("синхронный писатель не пишет в целевой файл напрямую", () => {
    expect(SYNC_SRC).toContain("writePageAtomic(p, body)");
    expect(SYNC_SRC).not.toContain("writeFileSync(p, body)");
    expect(SYNC_SRC).toContain("renameSync(tmp, p)");
  });

  test("асинхронный писатель — тоже", () => {
    expect(ASYNC_SRC).toContain("await rename(tmp, p)");
    expect(ASYNC_SRC).not.toContain("await writeFile(p, body)");
  });
});

describe("содержимое страницы правкой не изменилось", () => {
  test("синхронный писатель кладёт ровно тело prepareWikiPage", () => {
    wikiWrite({ scope: SCOPE, slug: "page", title: "Заголовок", content: "тело" });
    expect(wikiRead(SCOPE, "page")).toBe(
      prepareWikiPage("Заголовок", "тело").body,
    );
  });

  test("асинхронный — тоже, и страница после него читается целиком", async () => {
    await wikiWriteAsync({
      scope: SCOPE,
      slug: "page",
      title: "Заголовок",
      content: "тело " + "я".repeat(6000),
    });
    expect(wikiRead(SCOPE, "page")).toBe(
      prepareWikiPage("Заголовок", "тело " + "я".repeat(6000)).body,
    );
  });
});
