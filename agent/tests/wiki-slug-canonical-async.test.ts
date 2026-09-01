/**
 * Аудит 2026-08-10: фикс канонического slug'а (2026-08-08) доехал только до
 * синхронной половины.
 *
 * `wikiWrite` кладёт в FTS ключ, выведенный из пути файла, и чистит все три
 * формы ключа. Его асинхронный близнец `wikiWriteAsync` пишет `args.slug` как
 * есть и удаляет ровно одну форму. А через него идёт инструмент WRITE_WIKI
 * (dispatch/misc.ts:50) — то есть основной путь записи агентами; синхронный
 * остался только у компактора. Починенной оказалась та половина, которой
 * пользуется один вызывающий, а живая осталась сломанной.
 *
 * Последствие ровно то же, что и в исходном аудите: после рестарта (когда
 * rebuildWikiIndex выводит ключ из пути) следующая перезапись страницы не
 * попадает DELETE'ом в существующую строку и заводит вторую. Один файл — две
 * строки FTS, у старой контент, которого больше нет ни на диске, ни где-либо
 * ещё; SEARCH_WIKI отдаёт оба хита и тратит два слота из четырёх, а snippet()
 * показывает модели устаревший текст.
 *
 * Дополнительно: компактор и WRITE_WIKI — два писателя одной страницы с разной
 * деривацией ключа, так что расходились они и без рестарта.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { wikiWrite, wikiSearch, slugFromPath } from "../lib/memory.ts";
import { wikiWriteAsync, wikiReadAsync } from "../lib/memory-async.ts";
import { db } from "../lib/db.ts";

const SCOPE = "slugasync";
const MEMORY_DIR = process.env.MEMORY_DIR ?? "memory";

afterEach(() => {
  db.prepare(`DELETE FROM wiki_fts WHERE scope = ?`).run(SCOPE);
  rmSync(join(MEMORY_DIR, SCOPE), { recursive: true, force: true });
});

function rows(): { slug: string; content: string }[] {
  return db
    .prepare(`SELECT slug, content FROM wiki_fts WHERE scope = ? ORDER BY slug`)
    .all(SCOPE) as { slug: string; content: string }[];
}

/** Ключ, который выведет обход файловой системы при рестарте. */
function slugFromDisk(relPath: string): string {
  return slugFromPath(SCOPE, resolve(MEMORY_DIR, SCOPE, relPath));
}

describe("wikiWriteAsync индексирует под тем же ключом, что и рестарт", () => {
  test("ключ записи совпадает с выведенным из пути", async () => {
    await wikiWriteAsync({
      scope: SCOPE,
      slug: "roadmap",
      title: "Roadmap",
      content: "alpha",
    });
    expect(rows().map((r) => r.slug)).toEqual([slugFromDisk("pages/roadmap.md")]);
    expect(rows()[0]!.slug).toBe("roadmap");
  });

  test("две формы slug'а от вызывающего дают одну строку", async () => {
    await wikiWriteAsync({
      scope: SCOPE,
      slug: "roadmap",
      title: "Roadmap",
      content: "alpha",
    });
    await wikiWriteAsync({
      scope: SCOPE,
      slug: "pages/roadmap",
      title: "Roadmap",
      content: "beta",
    });
    // Обе формы резолвятся в один файл — значит и строка обязана быть одна,
    // со свежим содержимым.
    expect(rows().length).toBe(1);
    expect(rows()[0]!.content).toBe("beta");
  });

  // Запас по таймауту, а не ускорение: тело пишет файлы на диск и переиндексирует
  // FTS. Вхолостую это меньше секунды, но в полном прогоне на 392 файла упиралось
  // в дефолтные 5 с и краснело «timed out» — то есть зависело от загруженности
  // машины, а не от кода. Писателя не мокаем: проверяется ровно то, что запись и
  // индекс сходятся на одном ключе.
  test("перезапись после рестарта не заводит дубль", async () => {
    await wikiWriteAsync({
      scope: SCOPE,
      slug: "pages/roadmap",
      title: "Roadmap",
      content: "цена 100",
    });
    // Имитируем то, что делает rebuildWikiIndex при старте: строка живёт под
    // ключом из пути.
    db.prepare(`DELETE FROM wiki_fts WHERE scope = ?`).run(SCOPE);
    db.prepare(
      `INSERT INTO wiki_fts(scope, slug, title, content) VALUES (?, ?, ?, ?)`,
    ).run(SCOPE, slugFromDisk("pages/roadmap.md"), "Roadmap", "цена 100");

    await wikiWriteAsync({
      scope: SCOPE,
      slug: "pages/roadmap",
      title: "Roadmap",
      content: "цена 200",
    });

    // До фикса: DELETE по "pages/roadmap" мимо строки "roadmap" → две строки,
    // в старой «цена 100» — текста, которого уже нет на диске.
    expect(rows().length).toBe(1);
    expect(rows()[0]!.content).toBe("цена 200");
  }, 30_000);

  test("поиск не тратит два слота на один файл", async () => {
    await wikiWriteAsync({
      scope: SCOPE,
      slug: "pricing",
      title: "Прайс",
      content: "цена 100",
    });
    db.prepare(`DELETE FROM wiki_fts WHERE scope = ?`).run(SCOPE);
    db.prepare(
      `INSERT INTO wiki_fts(scope, slug, title, content) VALUES (?, ?, ?, ?)`,
    ).run(SCOPE, slugFromDisk("pages/pricing.md"), "Прайс", "цена 100");
    await wikiWriteAsync({
      scope: SCOPE,
      slug: "pricing",
      title: "Прайс",
      content: "цена 200",
    });

    const hits = wikiSearch("цена", [SCOPE], 4);
    expect(hits.length).toBe(1);
    // Slug из хита обязан читаться обратно в файл — иначе потребитель промпта
    // получит заголовок с пустым телом.
    expect(await wikiReadAsync(SCOPE, hits[0]!.slug)).toContain("цена 200");
  });
});

describe("компактор и WRITE_WIKI сходятся на одном ключе", () => {
  test("страница, записанная обоими путями, остаётся одной строкой", async () => {
    // Компактор пишет team-страницу slug'ом с каталогом (так требует его SYSTEM),
    // инструмент — тем же slug'ом из модели. Раньше это давало два разных ключа.
    wikiWrite({
      scope: SCOPE,
      slug: "pages/pricing",
      title: "Pricing",
      content: "от компактора",
    });
    await wikiWriteAsync({
      scope: SCOPE,
      slug: "pages/pricing",
      title: "Pricing",
      content: "от WRITE_WIKI",
    });

    expect(rows().length).toBe(1);
    expect(rows()[0]!.content).toBe("от WRITE_WIKI");
  });

  test("и в обратном порядке тоже", async () => {
    await wikiWriteAsync({
      scope: SCOPE,
      slug: "pricing",
      title: "Pricing",
      content: "от WRITE_WIKI",
    });
    wikiWrite({
      scope: SCOPE,
      slug: "pricing",
      title: "Pricing",
      content: "от компактора",
    });

    expect(rows().length).toBe(1);
    expect(rows()[0]!.content).toBe("от компактора");
  });
});
