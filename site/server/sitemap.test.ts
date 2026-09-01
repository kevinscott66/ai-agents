/**
 * Аудит 2026-08-12: у сайта нет ни robots.txt, ни sitemap.xml — и оба адреса
 * отвечают не 404, а главной страницей с кодом 200.
 *
 * SPA-фолбэк отдаёт `index.html` на любой неизвестный путь (index.ts,
 * serveStatic). Значит:
 *
 *   GET /robots.txt   → 200, Content-Type: text/html, тело — вся страница SPA
 *   GET /sitemap.xml  → 200, Content-Type: text/html, тело — вся страница SPA
 *
 * Это хуже отсутствия файла. robots.txt, который парсится как HTML, — мусорные
 * строки, и в нём негде указать sitemap. А `sitemap.xml`, отвечающий HTML'ом с
 * кодом 200, невозможно скормить ни одной панели вебмастера: она видит 200 и
 * ругается на формат, а не на отсутствие.
 *
 * Цена конкретная: постовик кладёт в канал ссылки вида
 * `https://delabs.space/digest/<id>`, при этом ни одна статья нигде не
 * перечислена. RSS (/rss.xml) отдаёт только 20 последних — это лента, а не
 * карта сайта: статья, уехавшая за двадцатую позицию, не встречается ни в
 * одном машиночитаемом списке.
 *
 * Инвариант: оба адреса обслуживаются сервером ДО статического фолбэка, отдают
 * свой content-type, sitemap перечисляет все статьи и сам себя объявляет в
 * robots.txt.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "web3puls-sitemap-"));
process.env.SITE_DB_PATH = join(TMP, "sitemap-test.db");

const { seedIfEmpty } = await import("./seed.ts");
const { makeFetchHandler } = await import("./index.ts");
const { listDigests } = await import("./db.ts");

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  process.env.SITE_DB_PATH = join(TMP, "sitemap-test.db");
  seedIfEmpty();
  server = Bun.serve({ port: 0, fetch: makeFetchHandler() });
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

describe("GET /robots.txt", () => {
  test("это текст, а не оболочка SPA", async () => {
    const r = await fetch(`${base}/robots.txt`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/plain");
    const body = await r.text();
    expect(body).not.toContain("<html");
    expect(body).toMatch(/^User-agent: \*/m);
  });

  test("объявляет карту сайта абсолютным адресом", async () => {
    const body = await (await fetch(`${base}/robots.txt`)).text();
    expect(body).toMatch(/^Sitemap: https:\/\/delabs\.space\/sitemap\.xml$/m);
  });

  test("служебные пути ингеста закрыты от обхода", async () => {
    // Ответ на /api/internal/* и так требует токена, но незачем звать туда
    // краулера: каждый обход — лишние 401 в логе и в рейт-лимите.
    const body = await (await fetch(`${base}/robots.txt`)).text();
    expect(body).toMatch(/^Disallow: \/api\//m);
  });
});

describe("GET /sitemap.xml", () => {
  test("это XML, а не оболочка SPA", async () => {
    const r = await fetch(`${base}/sitemap.xml`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("xml");
    const body = await r.text();
    expect(body).not.toContain("<html");
    expect(body.startsWith("<?xml")).toBe(true);
    expect(body).toContain(
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    );
  });

  test("перечислены ВСЕ статьи, а не двадцать последних как в RSS", async () => {
    const body = await (await fetch(`${base}/sitemap.xml`)).text();
    const all = listDigests(10_000, 0);
    expect(all.length).toBeGreaterThan(0);
    for (const d of all) {
      expect(body).toContain(
        `<loc>https://delabs.space/digest/${encodeURIComponent(d.id)}</loc>`,
      );
    }
    const locs = [...body.matchAll(/<loc>/g)].length;
    // Плюс статические разделы — их меньше десятка, но больше нуля.
    expect(locs).toBeGreaterThan(all.length);
    expect(body).toContain("<loc>https://delabs.space/</loc>");
  });

  test("динамический текст экранирован", async () => {
    // Заголовки и id пишет модель и приносит ингест — в XML они не должны
    // ломать документ. В <loc> идёт percent-encoded id, амперсанд — сущностью.
    const body = await (await fetch(`${base}/sitemap.xml`)).text();
    const inLoc = [...body.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]!);
    for (const loc of inLoc) {
      expect(loc).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
      expect(loc).not.toContain("<");
    }
  });

  test("HEAD отвечает так же, без тела", async () => {
    const r = await fetch(`${base}/sitemap.xml`, { method: "HEAD" });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("xml");
  });
});
