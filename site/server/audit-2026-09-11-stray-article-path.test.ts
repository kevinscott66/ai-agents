/**
 * Аудит 2026-09-11: вложенный путь в статейном пространстве отдавал главную.
 *
 * `articleIdFromPath` разбирает ровно `/<prefix>/<id>` — сегмент в её регэкспе
 * записан как `[^/]+`, вложенность отсекается намеренно. Но отсечённый путь
 * ничем не подхватывался: `digestIdFromPath` возвращала null, ветка статьи не
 * срабатывала, и `/digest/foo/bar` проваливался прямо в `serveStatic`. Тот на
 * любом не-ассетном маршруте отдаёт `index.html` — со статусом **200**.
 *
 * То есть снаружи существовала бесконечная россыпь адресов, каждый из которых
 * отвечал 200 и отдавал og-теги главной страницы без `X-Robots-Tag: noindex`.
 * Это ровно тот дефект, который закрывал аудит 2026-08-13 («удаление данных
 * обязано выражаться в статусе», T-743) и повторил 2026-08-20 для гайдов, —
 * просто зашедший с третьей стороны: не «статьи нет», а «формы пути нет».
 *
 * Клиентских маршрутов в этом пространстве, кроме `/digest/:id` и
 * `/activity/:id`, нет вовсе (списки живут на `/digests` и `/activities`), так
 * что всё остальное внутри него — заведомо 404. Множественное число при этом
 * обязано остаться нетронутым: `/digests` — настоящая страница SPA.
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
const { makeFetchHandler, _resetRateLimiter, isStrayArticlePath } =
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

describe("isStrayArticlePath", () => {
  test("вложенность и голый префикс — статейный 404", () => {
    for (const p of [
      "/digest",
      "/digest/",
      "/digest/foo/bar",
      "/digest/foo/bar/baz",
      "/activity",
      "/activity/",
      "/activity/foo/bar",
    ]) {
      expect(isStrayArticlePath(p)).toBe(true);
    }
  });

  test("правильная форма пути сюда не попадает: её разбирает статья", () => {
    for (const p of ["/digest/abc-123", "/digest/abc-123/", "/activity/x"]) {
      expect(isStrayArticlePath(p)).toBe(false);
    }
  });

  test("множественное число — настоящие страницы SPA, не трогаем", () => {
    for (const p of [
      "/",
      "/digests",
      "/digests/",
      "/activities",
      "/unlocks",
      "/about",
      "/digestibles",
      "/api/health",
    ]) {
      expect(isStrayArticlePath(p)).toBe(false);
    }
  });
});

describe("вложенный статейный путь отвечает 404 и noindex", () => {
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
});
