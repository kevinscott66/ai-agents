/**
 * Аудит 2026-08-13: slug страницы резолвился в служебный файл scope.
 *
 * У каждого scope есть два файла, которые страницами не являются: `index.md` —
 * общий индекс, уходящий в системный промпт всех двенадцати ролей на каждом
 * сообщении, и `log.md` — append-only лог команды, который дописывается
 * построчно и читается только хвостом.
 *
 * `walkAndIndex` про это знал и оба файла при ребилде пропускал. `pagePath` —
 * нет. А после фикса 2026-08-10 (страница может лежать в корне scope, не только
 * в каталоге по умолчанию) второй кандидат резолва для slug'а без слэша — это
 * ровно `<scope>/<slug>.md`. То есть `WRITE_WIKI{scope:"_team", slug:"index"}`
 * открывал `_team/index.md` и записывал поверх — с ответом `{ok:true}`.
 *
 * Придумывать такой вызов не требовалось: системный промпт роли сам показывает
 * эти файлы как разделы памяти («ОБЩИЙ ИНДЕКС КОМАНДЫ (_team/index.md)»,
 * метка `wiki:_team/log.md`), а описание инструмента разрешает перезаписать
 * страницу. Просьбы «обнови индекс команды» достаточно. Тем же путём ходит
 * компактор: slug для новой страницы сочиняет модель.
 *
 * Инвариант: пространство страниц и пространство служебных файлов не
 * пересекаются, и список исключений на оба — ровно один.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  wikiWrite,
  wikiRead,
  wikiIndex,
  wikiLog,
  rebuildWikiIndex,
  wikiSearch,
  ReservedSlugError,
  InvalidSlugError,
} from "../lib/memory.ts";
import { wikiWriteAsync } from "../lib/memory-async.ts";
import { handleWriteWiki } from "../lib/dispatch/misc.ts";
import { executeTool } from "../lib/tools-schema.ts";
import { db } from "../lib/db.ts";

const MEMORY_DIR = process.env.MEMORY_DIR ?? "memory";
/**
 * Отдельный scope, а не живой `_team`/`qa`: если запрет отвалится, тест не
 * должен снести настоящий индекс команды, лежащий в репозитории.
 */
const SCOPE = "zzreserved";
const SCOPE_DIR = join(MEMORY_DIR, SCOPE);
const CHAT = -1_000_813_444;

const INDEX_BODY = "# Индекс команды\n\n- projects/roadmap — дорожная карта\n";
const LOG_BODY = "\n2026-08-01 12:00 | pm | собрали бэклог";

function seedServiceFiles(): void {
  mkdirSync(SCOPE_DIR, { recursive: true });
  writeFileSync(join(SCOPE_DIR, "index.md"), INDEX_BODY);
  writeFileSync(join(SCOPE_DIR, "log.md"), LOG_BODY);
}

function cleanup(): void {
  rmSync(SCOPE_DIR, { recursive: true, force: true });
  db.prepare(`DELETE FROM wiki_fts WHERE scope = ?`).run(SCOPE);
}

beforeEach(() => {
  cleanup();
  seedServiceFiles();
});
afterEach(cleanup);

/** Контекст обработчика: пишем в собственный scope, чужого здесь нет. */
const CTX = {
  agentKey: SCOPE,
  chatId: CHAT,
  resolveUserbot: async () => null,
};

describe("служебные файлы scope нельзя перезаписать как страницу", () => {
  test("slug 'index' отвергается, индекс на диске цел", () => {
    expect(() =>
      wikiWrite({ scope: SCOPE, slug: "index", title: "Индекс", content: "новое" }),
    ).toThrow(ReservedSlugError);
    expect(readFileSync(join(SCOPE_DIR, "index.md"), "utf8")).toBe(INDEX_BODY);
  });

  test("slug 'log' отвергается, лог на диске цел", () => {
    expect(() =>
      wikiWrite({ scope: SCOPE, slug: "log", title: "Лог", content: "заметка" }),
    ).toThrow(ReservedSlugError);
    expect(readFileSync(join(SCOPE_DIR, "log.md"), "utf8")).toBe(LOG_BODY);
  });

  test("асинхронный писатель отказывает так же", async () => {
    // Путь агентов идёт именно через него; разъезд синхронной и асинхронной
    // половин уже дважды стоил багов, поэтому проверяется отдельно.
    await expect(
      wikiWriteAsync({ scope: SCOPE, slug: "index", title: "Индекс", content: "новое" }),
    ).rejects.toThrow(ReservedSlugError);
    expect(readFileSync(join(SCOPE_DIR, "index.md"), "utf8")).toBe(INDEX_BODY);
  });

  test("регистр запрет не обходит", () => {
    // Грамматика slug'а разрешает заглавные, а ФС на Mac разработчика
    // регистронезависима: `Index.md` и `index.md` там один файл.
    for (const slug of ["Index", "LOG", "Log"]) {
      expect(() =>
        wikiWrite({ scope: SCOPE, slug, title: "T", content: "c" }),
      ).toThrow(ReservedSlugError);
    }
    expect(readFileSync(join(SCOPE_DIR, "index.md"), "utf8")).toBe(INDEX_BODY);
    expect(readFileSync(join(SCOPE_DIR, "log.md"), "utf8")).toBe(LOG_BODY);
  });

  test("подпапка запрет не обходит и файла не создаёт", () => {
    // `projects/index.md` живой индекс не затрёт, но ребилд такой файл
    // пропустит по имени: получилась бы «записанная» страница, которой нет ни
    // в поиске, ни в Mini App, и молча исчезающая при первом же рестарте.
    expect(() =>
      wikiWrite({ scope: SCOPE, slug: "projects/index", title: "T", content: "c" }),
    ).toThrow(ReservedSlugError);
    expect(existsSync(join(SCOPE_DIR, "projects", "index.md"))).toBe(false);
  });

  test("ReservedSlugError ловится как InvalidSlugError", () => {
    // От этого зависят три потребителя: WRITE_WIKI, READ_WIKI и
    // `GET /api/wiki/page`, который на родителе отдаёт 400, а не пятисотку.
    try {
      wikiWrite({ scope: SCOPE, slug: "index", title: "T", content: "c" });
      throw new Error("не бросил");
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidSlugError);
    }
  });
});

describe("инструмент отвечает отказом с причиной, а не ok:true", () => {
  test("WRITE_WIKI: ok:false и названная причина", async () => {
    const r = await handleWriteWiki(
      { scope: SCOPE, slug: "index", title: "Индекс", content: "новое" } as never,
      CTX,
    );
    // Сужение типа заодно и есть утверждение: `ok:true` — это ровно тот
    // ответ, ради которого тест написан.
    if (r.ok) throw new Error("ожидался отказ, получен ok:true");
    // Голое `invalid_slug` модель прочитает как опечатку и повторит тот же
    // slug — его ей показал собственный системный промпт.
    expect(String(r.error)).toContain("reserved_slug");
    expect(String(r.error)).toContain("index");
  });

  test("READ_WIKI: лог не отдаётся целиком", async () => {
    // Штатные читатели берут хвост 64 КБ, потому что файл растёт до мегабайта;
    // READ_WIKI этот механизм обходил голым readFileSync. Мегабайт кириллицы в
    // tool_result — это ход, который не влезает в контекстное окно и падает
    // целиком.
    const out = await executeTool(
      "READ_WIKI",
      { scope: "qa", slug: "log" },
      { agentKey: "qa", chatId: CHAT },
    );
    const r = JSON.parse(out);
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("reserved_slug");
    expect(r.content).toBeUndefined();
  });
});

describe("здоровые пути не тронуты", () => {
  test("обычная страница пишется и читается", async () => {
    const r = await handleWriteWiki(
      { scope: SCOPE, slug: "roadmap", title: "Дорожная карта", content: "тело" } as never,
      CTX,
    );
    expect(r.ok).toBe(true);
    expect(wikiRead(SCOPE, "roadmap")).toContain("тело");
  });

  test("slug, лишь начинающийся с зарезервированного, проходит", () => {
    // Запрет — по полному имени файла, а не по префиксу: «indexing» и
    // «logbook» это обычные страницы, и отказ по ним был бы новым дефектом.
    for (const slug of ["indexing", "logbook", "index-old", "team-index"]) {
      wikiWrite({ scope: SCOPE, slug, title: slug, content: `тело ${slug}` });
      expect(wikiRead(SCOPE, slug)).toContain(`тело ${slug}`);
    }
  });

  test("штатные читатели служебных файлов работают как прежде", () => {
    expect(wikiIndex(SCOPE)).toBe(INDEX_BODY);
    expect(wikiLog(SCOPE)).toContain("собрали бэклог");
  });

  test("ребилд индексирует страницы и пропускает служебные файлы", () => {
    wikiWrite({ scope: SCOPE, slug: "handbook", title: "Справочник", content: "тело справочника" });
    rebuildWikiIndex();

    expect(wikiSearch("справочника", [SCOPE], 4).length).toBe(1);
    // Строк со служебными слагами в индексе нет — ни одна из них не могла бы
    // пережить рестарт, зато мешала бы поиску до него.
    const junk = db
      .prepare(`SELECT count(*) AS n FROM wiki_fts WHERE scope = ? AND slug IN ('index','log')`)
      .get(SCOPE) as { n: number };
    expect(junk.n).toBe(0);
  });
});
