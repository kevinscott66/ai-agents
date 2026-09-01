/**
 * Аудит 2026-08-10: страница в корне scope индексируется, но не читается.
 *
 * rebuildWikiIndex обходит `<scope>` целиком и заводит строку на каждый .md
 * кроме index.md/log.md — включая файлы, лежащие прямо в корне scope. Ключ
 * выводится из пути: для `<scope>/foo.md` относительный путь — «foo», без
 * слэша, то есть slug выходит «foo».
 *
 * Обратное преобразование этой формы не знает. pagePath для slug'а без слэша
 * подставляет каталог по умолчанию — `<scope>/pages/foo.md` (или
 * `_team/projects/foo.md`). Такого файла нет, wikiRead возвращает null.
 *
 * Итог: страница находится поиском, попадает в /api/wiki/list Mini App и в
 * список хитов SEARCH_WIKI — а при попытке прочитать её отдаётся пусто.
 * Потребитель промпта получает заголовок без тела и слот из четырёх, потрачен-
 * ный ни на что; в Mini App — страница, которая не открывается.
 *
 * Ровно тот случай, ради которого ребилд и существует: комментарий над ним
 * говорит «на случай ручных правок вики», а руками файл кладут именно в корень
 * scope — сами агенты пишут только через wikiWrite, то есть всегда в pages/.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { rebuildWikiIndex, wikiRead, wikiSearch, wikiWrite } from "../lib/memory.ts";
import { wikiReadAsync } from "../lib/memory-async.ts";
import { db } from "../lib/db.ts";

const MEMORY_DIR = process.env.MEMORY_DIR ?? "memory";
const SCOPE = "rootpage";
const SCOPE_DIR = join(MEMORY_DIR, SCOPE);

beforeEach(() => {
  rmSync(SCOPE_DIR, { recursive: true, force: true });
  db.prepare(`DELETE FROM wiki_fts WHERE scope = ?`).run(SCOPE);
});

afterEach(() => {
  rmSync(SCOPE_DIR, { recursive: true, force: true });
  db.prepare(`DELETE FROM wiki_fts WHERE scope = ?`).run(SCOPE);
});

function putRootPage(name: string, body: string): void {
  mkdirSync(SCOPE_DIR, { recursive: true });
  writeFileSync(join(SCOPE_DIR, `${name}.md`), body);
}

describe("страница в корне scope читается тем же ключом, под которым проиндексирована", () => {
  test("slug из индекса резолвится в файл", () => {
    putRootPage("handbook", "# Handbook\n\nтело справочника\n");
    rebuildWikiIndex();

    const hits = wikiSearch("справочника", [SCOPE], 4);
    expect(hits.length).toBe(1);
    // До фикса: pagePath подставлял `pages/handbook.md`, которого нет, и тут
    // приходил null — страница есть в выдаче, но пустая.
    expect(wikiRead(SCOPE, hits[0]!.slug)).toContain("тело справочника");
  });

  test("асинхронный читатель ведёт себя так же", async () => {
    // WRITE_WIKI/READ_WIKI у агентов идут через async-половину, и своя копия
    // pagePath там уже расходилась с синхронной (аудит 2026-08-10, upsertWikiFts).
    putRootPage("handbook", "# Handbook\n\nтело справочника\n");
    rebuildWikiIndex();
    expect(await wikiReadAsync(SCOPE, "handbook")).toContain("тело справочника");
  });

  test("новая страница по-прежнему создаётся в каталоге по умолчанию", () => {
    // Иначе «починка» превратила бы дефолтную раскладку в свалку в корне.
    wikiWrite({ scope: SCOPE, slug: "fresh", title: "Fresh", content: "новое" });
    expect(wikiRead(SCOPE, "fresh")).toContain("новое");
    expect(
      require("node:fs").existsSync(join(SCOPE_DIR, "pages", "fresh.md")),
    ).toBe(true);
    expect(require("node:fs").existsSync(join(SCOPE_DIR, "fresh.md"))).toBe(false);
  });

  test("при коллизии выигрывает каталог по умолчанию", () => {
    // Один slug на два файла: `<scope>/dup.md` и `<scope>/pages/dup.md` дают
    // одинаковое «dup». Читать надо тот, куда пишут, иначе запись и чтение
    // разъезжаются.
    putRootPage("dup", "# Dup\n\nиз корня\n");
    wikiWrite({ scope: SCOPE, slug: "dup", title: "Dup", content: "из pages" });
    expect(wikiRead(SCOPE, "dup")).toContain("из pages");
  });

  test("страница в подкаталоге не задета", () => {
    mkdirSync(join(SCOPE_DIR, "notes"), { recursive: true });
    writeFileSync(join(SCOPE_DIR, "notes", "deep.md"), "# Deep\n\nв подкаталоге\n");
    rebuildWikiIndex();
    const hits = wikiSearch("подкаталоге", [SCOPE], 4);
    expect(hits.length).toBe(1);
    expect(hits[0]!.slug).toBe("notes/deep");
    expect(wikiRead(SCOPE, hits[0]!.slug)).toContain("в подкаталоге");
  });
});
