/**
 * Аудит 2026-08-13, три дыры в связке «компактор → вики».
 *
 * 1. Слияние переименовывало страницу. `mergeAndWrite` срезает у существующей
 *    страницы первую строку (`replace(/^#\s.*\n/, "")`) и отдаёт остаток в
 *    `wikiWrite` вместе со СВОИМ title, а `prepareWikiPage` собирает тело как
 *    `# ${title}\n\n…`. То есть при каждом дозаписывании имя страницы менялось
 *    на то, как её назвал компактор в этот раз, — а `normalizeOp` при
 *    отсутствии title кладёт туда слаг. Переименование не остаётся
 *    косметическим: тот же заголовок уходит в `wiki_fts` (его отдаёт wikiSearch
 *    в контекст каждого хода и Mini App), а `rebuildWikiIndex` на старте
 *    перечитывает заголовок уже из файла — старого имени не остаётся нигде.
 *
 * 2. `normalizeOp` собирал поля через `??`, который ловит только null и
 *    undefined. `title: ""` не null → фолбэка на слаг не было, страница
 *    писалась с телом `# \n\n…` и с пустым заголовком в индексе, то есть
 *    переставала находиться поиском по имени. `title: {ru:"…"}` уезжало в
 *    `String(v)` и становилось `[object Object]`.
 *
 * 3. `index.md` имел трёх читателей (`wikiIndex`, `wikiIndexAsync`,
 *    промпт-сборка) и ни одного писателя. Индекс всегда был пуст, поэтому
 *    правило компактора «сверься с индексом, не заводи дубль» не могло
 *    сработать физически — он сверялся с пустой строкой и заводил новую
 *    страницу на каждую тему заново. Индекс теперь генерируется из wiki_fts на
 *    чтении: отдельный писатель в ту же папку был бы третьей гонкой с
 *    компактором и WRITE_WIKI, а генерация не может протухнуть.
 *
 * Инварианты: слияние дописывает секцию и не трогает имя страницы; непустая
 * строка — единственный источник title/slug/content; индекс непуст, когда в
 * скоупе есть страницы, но рукописный index.md главнее.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  wikiWrite,
  wikiIndex,
  buildWikiIndex,
  pagePath,
  WIKI_INDEX_MAX_PAGES,
} from "../lib/memory.ts";
import { wikiIndexAsync } from "../lib/memory-async.ts";
import { existingTitle, _compactorInternals } from "../lib/compactor.ts";
import { db } from "../lib/db.ts";

const { normalizeOp, mergeAndWrite } = _compactorInternals;

const SCOPE = "wikiidxtest";
const MEMORY_DIR = process.env.MEMORY_DIR ?? "memory";
const SCOPE_DIR = join(MEMORY_DIR, SCOPE);

afterEach(() => {
  db.prepare(`DELETE FROM wiki_fts WHERE scope = ?`).run(SCOPE);
  rmSync(SCOPE_DIR, { recursive: true, force: true });
});

function fileOf(slug: string): string {
  return readFileSync(pagePath(SCOPE, slug), "utf8");
}

function ftsTitle(slug: string): string {
  const row = db
    .prepare(`SELECT title FROM wiki_fts WHERE scope = ? AND slug = ?`)
    .get(SCOPE, slug) as { title: string } | undefined;
  return row?.title ?? "";
}

describe("existingTitle: имя страницы читается с первой строки", () => {
  test("заголовок первого уровня", () => {
    expect(existingTitle("# Дорожная карта продукта\n\nтело")).toBe(
      "Дорожная карта продукта",
    );
  });

  test("хвостовые пробелы не попадают в имя", () => {
    expect(existingTitle("#   Карта   \n\nтело")).toBe("Карта");
  });

  test("страница без заголовка — null, а не пустая строка", () => {
    expect(existingTitle("просто текст\n\nещё")).toBeNull();
    expect(existingTitle("## Раздел\n\nтело")).toBeNull();
    expect(existingTitle("#беззазора\n\nтело")).toBeNull();
    expect(existingTitle("")).toBeNull();
  });
});

describe("слияние не переименовывает страницу", () => {
  test("имя, данное агентом, переживает дозаписывание компактора", () => {
    wikiWrite({
      scope: SCOPE,
      slug: "roadmap",
      title: "Дорожная карта продукта",
      content: "исходное описание",
    });

    // Компактор дозаписывает секцию и приносит СВОЙ title — в реальности это
    // слаг, потому что LLM его чаще всего не присылает.
    mergeAndWrite(SCOPE, "roadmap", "roadmap", "новая секция");

    expect(fileOf("roadmap").split("\n", 1)[0]).toBe("# Дорожная карта продукта");
    expect(ftsTitle("roadmap")).toBe("Дорожная карта продукта");
  });

  test("дозаписанная секция и исходное тело оба на месте", () => {
    wikiWrite({
      scope: SCOPE,
      slug: "roadmap",
      title: "Дорожная карта продукта",
      content: "исходное описание",
    });
    mergeAndWrite(SCOPE, "roadmap", "roadmap", "новая секция");

    const page = fileOf("roadmap");
    expect(page).toContain("исходное описание");
    expect(page).toContain("новая секция");
    // Ровно один заголовок первого уровня — срезанный `#` не должен всплывать
    // в теле вторым.
    expect(page.split("\n").filter((l) => l.startsWith("# ")).length).toBe(1);
  });

  test("новой страницей имя берётся у того, кто её заводит", () => {
    mergeAndWrite(SCOPE, "fresh", "Свежая страница", "тело");
    expect(fileOf("fresh").split("\n", 1)[0]).toBe("# Свежая страница");
    expect(ftsTitle("fresh")).toBe("Свежая страница");
  });

  test("страница без заголовка получает имя от компактора, а не пустое", () => {
    const p = pagePath(SCOPE, "headless");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "тело без заголовка\n");
    mergeAndWrite(SCOPE, "headless", "Имя от компактора", "секция");
    expect(fileOf("headless").split("\n", 1)[0]).toBe("# Имя от компактора");
  });
});

describe("normalizeOp: поле принимается только непустой строкой", () => {
  const upsert = (extra: Record<string, unknown>) =>
    normalizeOp({ op: "upsert_team_page", slug: "projects/x", content: "тело", ...extra });

  test("нормальная операция проходит целиком", () => {
    expect(upsert({ title: "Заголовок" })).toEqual({
      op: "upsert_team_page",
      slug: "projects/x",
      title: "Заголовок",
      content: "тело",
    });
  });

  test('title: "" не даёт странице пустое имя — фолбэк на слаг', () => {
    expect(upsert({ title: "" })).toMatchObject({ title: "projects/x" });
  });

  test("title: пробелы — тоже пустое имя", () => {
    expect(upsert({ title: "   " })).toMatchObject({ title: "projects/x" });
  });

  test("нестроковый title не превращается в [object Object]", () => {
    expect(upsert({ title: { ru: "Заголовок" } })).toMatchObject({
      title: "projects/x",
    });
    expect(upsert({ title: 42 })).toMatchObject({ title: "projects/x" });
  });

  test("нестроковый slug — операция не понята, а не записана под именем «42»", () => {
    expect(
      normalizeOp({ op: "upsert_team_page", slug: 42, content: "тело" }),
    ).toBeNull();
  });

  test("пустой content не заводит пустую страницу", () => {
    expect(
      normalizeOp({ op: "upsert_team_page", slug: "projects/x", content: "  " }),
    ).toBeNull();
  });

  test("пустая строка лога не дописывается", () => {
    expect(normalizeOp({ op: "team_log", line: "" })).toBeNull();
    expect(normalizeOp({ op: "private_log", line: "   " })).toBeNull();
    expect(normalizeOp({ op: "team_log", line: "решение принято" })).toEqual({
      op: "team_log",
      line: "решение принято",
    });
  });
});

describe("индекс вики собирается сам, когда index.md нет", () => {
  function seed(pages: [slug: string, title: string][]) {
    for (const [slug, title] of pages) {
      wikiWrite({ scope: SCOPE, slug, title, content: `тело ${slug}` });
    }
  }

  test("страницы перечислены со слагом и именем", () => {
    seed([
      ["projects/alpha", "Проект Альфа"],
      ["decisions/beta", "Решение Бета"],
    ]);
    const idx = buildWikiIndex(SCOPE);
    expect(idx).toContain("- projects/alpha — Проект Альфа");
    expect(idx).toContain("- decisions/beta — Решение Бета");
  });

  test("имя, равное слагу, не дублируется в строке", () => {
    seed([["roadmap", "roadmap"]]);
    expect(buildWikiIndex(SCOPE)).toBe("- roadmap");
  });

  test("чужие скоупы в индекс не подмешиваются", () => {
    seed([["mine", "Моя"]]);
    expect(buildWikiIndex(SCOPE)).toBe("- mine — Моя");
    expect(buildWikiIndex("_team")).not.toContain("- mine");
  });

  test("индекс ограничен потолком страниц", () => {
    seed([
      ["p1", "Один"],
      ["p2", "Два"],
      ["p3", "Три"],
    ]);
    expect(buildWikiIndex(SCOPE, 2).split("\n").length).toBe(2);
    expect(WIKI_INDEX_MAX_PAGES).toBeGreaterThan(0);
  });

  test("пустой скоуп — пустая строка, а не мусор", () => {
    expect(buildWikiIndex(SCOPE)).toBe("");
  });

  test("wikiIndex без index.md отдаёт сгенерированный список", () => {
    seed([["projects/alpha", "Проект Альфа"]]);
    expect(wikiIndex(SCOPE)).toContain("- projects/alpha — Проект Альфа");
  });

  test("рукописный index.md главнее генерации", () => {
    seed([["projects/alpha", "Проект Альфа"]]);
    writeFileSync(join(SCOPE_DIR, "index.md"), "отобрано руками");
    expect(wikiIndex(SCOPE)).toBe("отобрано руками");
  });

  test("пустой index.md за отбор не считается", () => {
    seed([["projects/alpha", "Проект Альфа"]]);
    writeFileSync(join(SCOPE_DIR, "index.md"), "\n  \n");
    expect(wikiIndex(SCOPE)).toContain("- projects/alpha — Проект Альфа");
  });

  test("асинхронный близнец ведёт себя так же", async () => {
    seed([["projects/alpha", "Проект Альфа"]]);
    expect(await wikiIndexAsync(SCOPE)).toContain("- projects/alpha — Проект Альфа");
    writeFileSync(join(SCOPE_DIR, "index.md"), "отобрано руками");
    expect(await wikiIndexAsync(SCOPE)).toBe("отобрано руками");
    writeFileSync(join(SCOPE_DIR, "index.md"), "   ");
    expect(await wikiIndexAsync(SCOPE)).toContain("- projects/alpha — Проект Альфа");
  });
});
