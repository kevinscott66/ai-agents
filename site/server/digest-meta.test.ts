/**
 * Аудит 2026-08-12: у каждой статьи сайта была превьюшка главной страницы.
 *
 * `/digest/<id>` — обычный SPA-фолбэк: сервер отдаёт тот же `index.html` со
 * статическими og-тегами, а подставить заголовок статьи мог бы только JS,
 * которого ни у Telegram, ни у поисковых ботов нет. Замер до правки —
 * ответ сервера на `/digest/bittensor-tao-ai-etf-2026-06-18`:
 *
 *   <title>DeLabs — крипта и AI без шума</title>
 *   og:type    = "website"
 *   og:url     = "https://delabs.space/"      ← у ВСЕХ статей главная
 *   og:title   = "DeLabs — крипта и AI без шума"
 *   twitter:title = то же
 *
 * при том что сама статья называется «Bittensor (TAO) растёт на AI-нарративе
 * и заявках на ETF». Ровно эти ссылки постовик кладёт в канал строкой
 * `[Подробнее →](https://delabs.space/digest/<id>)` — то есть весь смысл
 * «детали по ссылкам на сайте» приезжал подписчику девятью одинаковыми
 * карточками. `og:url`, указывающий на главную, вдобавок говорит краулеру,
 * что канонический адрес статьи — корень сайта.
 *
 * Инвариант: HTML статьи несёт мета-данные этой статьи, и всё подставляемое
 * экранировано — заголовки и summary пишет модель, они приходят через ингест.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestIdFromPath, injectDigestMeta } from "./index.ts";
import type { Digest } from "./types.ts";

/** Настоящая оболочка сайта — источник тех самых og-тегов. */
const SHELL = readFileSync(
  join(import.meta.dir, "..", "web", "index.html"),
  "utf8",
);

const D: Digest = {
  id: "bittensor-tao-ai-etf-2026-06-18",
  title: "Bittensor (TAO) растёт на AI-нарративе и заявках на ETF",
  date: new Date("2026-06-18T00:00:00.000Z").toISOString(),
  summary: "TAO прибавил 20% на фоне заявок на спотовый ETF.",
  items: [{ text: "Источник", url: "https://example.org/tao" }],
  sourceCount: 2,
};

function metaOf(html: string, kind: "property" | "name", key: string): string | null {
  const re = new RegExp(
    `<meta\\s[^>]*${kind}="${key}"[^>]*content="([^"]*)"`,
    "i",
  );
  const m = html.match(re) ?? html.match(
    new RegExp(`<meta\\s[^>]*content="([^"]*)"[^>]*${kind}="${key}"`, "i"),
  );
  return m ? m[1]! : null;
}

describe("маршрут статьи", () => {
  test("/digest/<id> распознаётся, id декодируется", () => {
    expect(digestIdFromPath("/digest/abc-123")).toBe("abc-123");
    expect(digestIdFromPath("/digest/abc-123/")).toBe("abc-123");
    expect(digestIdFromPath("/digest/a%20b")).toBe("a b");
  });

  test("остальные маршруты — не статья", () => {
    expect(digestIdFromPath("/")).toBeNull();
    expect(digestIdFromPath("/digest")).toBeNull();
    expect(digestIdFromPath("/digest/")).toBeNull();
    expect(digestIdFromPath("/digest/a/b")).toBeNull();
    expect(digestIdFromPath("/api/digests/abc")).toBeNull();
  });

  test("битый percent-encoding не роняет разбор", () => {
    expect(() => digestIdFromPath("/digest/%E0%A4%A")).not.toThrow();
    expect(digestIdFromPath("/digest/%E0%A4%A")).toBe("%E0%A4%A");
  });
});

describe("мета-теги статьи", () => {
  const out = injectDigestMeta(SHELL, D);

  test("заголовок вкладки — заголовок статьи", () => {
    expect(out).toContain(`<title>${D.title} — DeLabs</title>`);
  });

  test("og:title и twitter:title — заголовок статьи", () => {
    expect(metaOf(out, "property", "og:title")).toBe(D.title);
    expect(metaOf(out, "name", "twitter:title")).toBe(D.title);
  });

  test("og:description и twitter:description — summary статьи", () => {
    expect(metaOf(out, "property", "og:description")).toBe(D.summary);
    expect(metaOf(out, "name", "twitter:description")).toBe(D.summary);
  });

  test("og:url — адрес самой статьи, а не главной", () => {
    expect(metaOf(out, "property", "og:url")).toBe(
      `https://delabs.space/digest/${D.id}`,
    );
  });

  test("og:type — article", () => {
    expect(metaOf(out, "property", "og:type")).toBe("article");
  });

  test("оболочка в остальном цела", () => {
    expect(out).toContain('<div id="app"></div>');
    expect(out).toContain("manrope-cyrillic-400.woff2");
    // Ровно один <title> и ровно по одному og:title/og:url.
    expect(out.match(/<title>/g)?.length).toBe(1);
    expect(out.match(/property="og:title"/g)?.length).toBe(1);
    expect(out.match(/property="og:url"/g)?.length).toBe(1);
  });
});

describe("сервер отдаёт это на самом маршруте", () => {
  // Фронт в репозитории не собран (dist в .gitignore), поэтому проверяем оба
  // мира: со сборкой — мета-теги статьи, без неё — прежнее поведение.
  const built = existsSync(join(import.meta.dir, "..", "web", "dist", "index.html"));

  test("GET /digest/<id>", async () => {
    const TMP = mkdtempSync(join(tmpdir(), "web3puls-og-"));
    const previousSiteDbPath = process.env.SITE_DB_PATH;
    process.env.SITE_DB_PATH = join(TMP, "og.db");
    const { seedIfEmpty } = await import("./seed.ts");
    const { makeFetchHandler } = await import("./index.ts");
    const { listDigests } = await import("./db.ts");
    seedIfEmpty();
    const d = listDigests(1, 0)[0]!;
    // Bind the ephemeral test listener to loopback explicitly. Without a
    // hostname Bun can reuse the wildcard listener used by another isolated
    // server test and report EADDRINUSE for port 0.
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: makeFetchHandler(),
    });
    try {
      const r = await fetch(`http://localhost:${server.port}/digest/${d.id}`);
      const html = await r.text();
      if (built) {
        expect(r.status).toBe(200);
        expect(html).toContain(`<title>${d.title} — DeLabs</title>`);
        expect(html).not.toContain('content="https://delabs.space/" />');
      } else {
        expect(r.status).toBe(404);
      }
    } finally {
      server.stop(true);
      if (previousSiteDbPath === undefined) delete process.env.SITE_DB_PATH;
      else process.env.SITE_DB_PATH = previousSiteDbPath;
    }
  });
});

describe("подстановка экранируется", () => {
  const evil: Digest = {
    ...D,
    id: 'x"><script>alert(1)</script>',
    title: 'Заголовок с "кавычкой" и <script>alert(1)</script>',
    summary: "A & B < C",
  };
  const out = injectDigestMeta(SHELL, evil);

  test("из атрибута не выйти", () => {
    expect(out).not.toContain("<script>alert(1)</script>");
    expect(metaOf(out, "property", "og:title")).toBe(
      "Заголовок с &quot;кавычкой&quot; и &lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });

  test("амперсанд и угловая скобка в summary экранированы", () => {
    expect(metaOf(out, "property", "og:description")).toBe("A &amp; B &lt; C");
  });

  test("id в og:url тоже не ломает атрибут", () => {
    const u = metaOf(out, "property", "og:url")!;
    expect(u).not.toContain('"');
    expect(u).not.toContain("<");
  });

  test("тег <title> не даёт вставить разметку", () => {
    const title = out.match(/<title>([\s\S]*?)<\/title>/)![1]!;
    expect(title).not.toContain("<script");
    expect(title).toContain("&lt;script&gt;");
  });
});

/**
 * Аудит 2026-08-12: `$` в заголовке ломал og-теги и дублировал документ.
 *
 * Подстановка шла в СТРОКУ ЗАМЕНЫ `String.replace`, где `$1`, `$&`, `` $` ``,
 * `$'`, `$$` — управляющие последовательности. htmlAttrEscape экранирует
 * `& < > "`, но не `$`, а заголовки вида «Биткоин пробил $100 000» и «a16z
 * вложил $1 млрд» — обычное дело для крипто-ленты, и текст этот пишет модель.
 *
 * Замер на настоящей оболочке site/web/index.html (исходно 2257 байт,
 * og:title — 1 тег):
 *   title «a16z вложил $1 млрд в блокчейн»
 *     og:title content = "a16z вложил <meta property="   | og:title тегов: 2
 *   title «Биткоин пробил $100 000»
 *     og:title content = "Биткоин пробил <meta property=" | og:title тегов: 2
 *   summary «Цена $' упала»
 *     байт: 6342 | <div id="app">: 8 | <script type="module">: 8
 *
 * То есть в Telegram и поиске карточка с обрезанным заголовком, а на `$'` —
 * страница, где приложение подключено восемь раз. Существующий блок
 * «подстановка экранируется» этого не ловил: он проверяет `" < > &`.
 */
describe("$ в подставляемом тексте — не спецсимвол", () => {
  const shellDivs = (SHELL.match(/<div id="app">/g) ?? []).length;
  const shellScripts = (SHELL.match(/<script type="module"/g) ?? []).length;

  const CASES: Array<[string, string, string]> = [
    ["$1 в заголовке", "a16z вложил $1 млрд в блокчейн", "обычное резюме"],
    ["$100 в заголовке", "Биткоин пробил $100 000", "обычное резюме"],
    ["$' в summary", "Обычный заголовок", "Цена $' упала"],
    ["$& в summary", "Обычный заголовок", "Скидка $& на всё"],
    ["$` в summary", "Обычный заголовок", "Бэктик $` внутри"],
    ["$$ в заголовке", "Пара $$ подряд", "обычное резюме"],
  ];

  for (const [name, title, summary] of CASES) {
    test(name, () => {
      const out = injectDigestMeta(SHELL, { ...D, title, summary });
      expect(metaOf(out, "property", "og:title")).toBe(title.replace(/&/g, "&amp;"));
      expect(metaOf(out, "property", "og:description")).toBe(
        summary.replace(/&/g, "&amp;"),
      );
      // Документ не размножился: оболочка осталась одной.
      expect((out.match(/property="og:title"/g) ?? []).length).toBe(1);
      expect((out.match(/<div id="app">/g) ?? []).length).toBe(shellDivs);
      expect((out.match(/<script type="module"/g) ?? []).length).toBe(shellScripts);
      expect(out.match(/<title>([\s\S]*?)<\/title>/)![1]).toBe(`${title} — DeLabs`);
    });
  }
});
