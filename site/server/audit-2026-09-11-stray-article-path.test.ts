/**
 * Аудит 2026-09-11: путь, которого нет в роутере фронта, отдавал главную.
 *
 * Круг 14 нашёл частный случай. `articleIdFromPath` разбирает ровно
 * `/<prefix>/<id>` — сегмент в её регэкспе записан как `[^/]+`, вложенность
 * отсекается намеренно. Но отсечённый путь ничем не подхватывался:
 * `digestIdFromPath` возвращала null, ветка статьи не срабатывала, и
 * `/digest/foo/bar` проваливался прямо в `serveStatic`. Тот на любом
 * не-ассетном маршруте отдаёт `index.html` — со статусом **200**.
 *
 * То есть снаружи существовала бесконечная россыпь адресов, каждый из которых
 * отвечал 200 и отдавал og-теги главной страницы без `X-Robots-Tag: noindex`.
 * Это ровно тот дефект, который закрывал аудит 2026-08-13 («удаление данных
 * обязано выражаться в статусе», T-743) и повторил 2026-08-20 для гайдов, —
 * просто зашедший с третьей стороны: не «статьи нет», а «формы пути нет».
 *
 * Круг 15 (этот файл в нынешнем виде): наблюдение было верным, а починка —
 * узкой. `isStrayArticlePath` сверялась с двумя префиксами, в точной форме и
 * в точном регистре, поэтому мимо неё проходили:
 *
 *   • `/about/x`, `/unlocks/1`, `/totally-made-up` — 200 и og-теги главной;
 *   • `/Digest/x` — то же самое, при том что `/digest/x` рядом честно
 *     отвечал 404 (URL регистр пути сохраняет, а сравнение было точным).
 *
 * Перечислять «что не маршрут» бессмысленно: список бесконечен. Таблица
 * маршрутов фронта, наоборот, конечна и лежит в `site/web/src/App.tsx`, так
 * что вопрос перевёрнут — `isKnownSpaRoute` отвечает 200 только на известное,
 * всё остальное 404. Множественное число при этом обязано остаться живым:
 * `/digests` — настоящая страница SPA.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "web3puls-stray-article-"));
const DIST = join(TMP, "dist");
mkdirSync(DIST, { recursive: true });
// Оболочка нужна настоящая: без dist сервер намеренно оставляет прежнее
// поведение «фронт не собран», и проверять было бы нечего.
writeFileSync(
  join(DIST, "index.html"),
  `<!doctype html><html><head><title>DeLabs — крипта и AI без шума</title>` +
    `<meta property="og:url" content="https://delabs.space/" />` +
    `</head><body><div id="app"></div></body></html>`,
);

// Снимок env берётся ДО подмены (P5, гонка тестов сайта 2026-09-10).
const PREV_DIST = process.env.SITE_WEB_DIST;

process.env.SITE_DB_PATH = join(TMP, "audit.db");
process.env.SITE_WEB_DIST = DIST;

const { seedIfEmpty } = await import("./seed.ts");
const { makeFetchHandler, _resetRateLimiter, isKnownSpaRoute } =
  await import("./index.ts");

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  seedIfEmpty();
  server = Bun.serve({ port: 0, fetch: makeFetchHandler() });
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  // CLAUDE.md §3.8.7: env не течёт в соседние файлы тестов, ведро лимитера
  // тоже состояние процесса.
  if (PREV_DIST === undefined) delete process.env.SITE_WEB_DIST;
  else process.env.SITE_WEB_DIST = PREV_DIST;
  _resetRateLimiter();
});

beforeEach(() => _resetRateLimiter());

describe("isKnownSpaRoute: отвечаем 200 только на известное", () => {
  test("вся таблица роутера фронта — известные маршруты", () => {
    for (const p of [
      "/",
      "/digests",
      "/unlocks",
      "/drops",
      "/activities",
      "/about",
      // Служебная страница: она есть в App.tsx, но не в карте сайта.
      "/status",
    ]) {
      expect(isKnownSpaRoute(p)).toBe(true);
    }
  });

  test("хвостовой слэш и регистр — тот же маршрут", () => {
    for (const p of ["/digests/", "/DIGESTS", "/About/", "/"]) {
      expect(isKnownSpaRoute(p)).toBe(true);
    }
  });

  test("статейное пространство, вложенность и выдумка — не маршруты", () => {
    for (const p of [
      "/digest",
      "/digest/",
      "/digest/abc-123",
      "/Digest/abc-123",
      "/digest/foo/bar",
      "/activity",
      "/activity/foo/bar",
      "/about/x",
      "/unlocks/1",
      "/digestibles",
      "/totally-made-up",
    ]) {
      expect(isKnownSpaRoute(p)).toBe(false);
    }
  });
});

describe("адрес вне таблицы маршрутов отвечает 404 и noindex", () => {
  test("/digest/foo/bar больше не отдаёт главную со статусом 200", async () => {
    const res = await fetch(`${base}/digest/foo/bar`);
    expect(res.status).toBe(404);
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
    // Оболочку отдаём ту же — клиентский роутер сам покажет «не найдено».
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(await res.text()).toContain("<div id=\"app\">");
  });

  test("голый префикс и гайды — так же", async () => {
    for (const p of ["/digest", "/digest/", "/activity/foo/bar", "/activity"]) {
      const res = await fetch(`${base}${p}`);
      expect(res.status).toBe(404);
      expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
    }
  });

  test("страницы списков остались живыми: 200 и без noindex", async () => {
    for (const p of ["/digests", "/activities"]) {
      const res = await fetch(`${base}${p}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("X-Robots-Tag")).toBeNull();
    }
  });

  test("адреса вне статейного пространства — так же 404", async () => {
    // Круг 14 их не закрывал: они не начинались с `/digest` или `/activity`.
    for (const p of ["/about/x", "/unlocks/1", "/totally-made-up", "/drops/2/3"]) {
      const res = await fetch(`${base}${p}`);
      expect(res.status).toBe(404);
      expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
    }
  });

  test("регистр не открывает обход: /Digest/x тоже 404", async () => {
    const lower = await fetch(`${base}/digest/несуществующая`);
    const upper = await fetch(`${base}/Digest/несуществующая`);
    expect(lower.status).toBe(404);
    expect(upper.status).toBe(404);
    expect(upper.headers.get("X-Robots-Tag")).toBe("noindex");
  });

  test("известные маршруты живы в любом регистре и с хвостовым слэшем", async () => {
    for (const p of ["/", "/digests/", "/About", "/status"]) {
      const res = await fetch(`${base}${p}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("X-Robots-Tag")).toBeNull();
    }
  });

  test("/status отвечает 200, но в карту сайта не попадает", async () => {
    const res = await fetch(`${base}/status`);
    expect(res.status).toBe(200);
    const map = await (await fetch(`${base}/sitemap.xml`)).text();
    expect(map).toContain("/digests");
    expect(map).not.toContain("/status");
  });
});
