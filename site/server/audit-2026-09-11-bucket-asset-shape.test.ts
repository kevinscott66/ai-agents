/**
 * Аудит 2026-09-11 (круг 17): освобождение от ведра выдавалось по РАСШИРЕНИЮ,
 * а не по наличию файла.
 *
 * Круг 15 заменил ручное перечисление путей на «лимитируем всё, кроме файлов
 * сборки», и мерку «файл сборки» взял из `looksLikeAsset` — каталог `assets/`
 * ИЛИ известное расширение из таблицы MIME. Обоснование у освобождения одно:
 * такой запрос отдаёт ядро, страница тянет их пачкой, и общий бюджет её бы
 * задушил. Для несуществующего файла это обоснование не работает вовсе, а
 * мерка его всё равно освобождала — достаточно приписать к адресу `.png`.
 *
 * Что это давало:
 *
 *  1. `/digest/<что угодно>.png` подходит и под освобождение, и под
 *     `digestIdFromPath` — то есть запрос шёл мимо ведра и всё равно делал
 *     запрос в SQLite. Бесплатный способ дёргать базу.
 *  2. `/1.png`, `/2.png`, … мимо ведра, а в ответ — ЦЕЛАЯ оболочка
 *     index.html с `Cache-Control: no-cache`. До круга 15 на такой адрес
 *     уходило девять байт «Not Found».
 *
 * Мерка теперь одна и честная: мимо ведра идёт то, что на диске ЕСТЬ.
 * Отсутствующий файл сборки стоит ведру токена и отвечает коротким 404 —
 * оболочка нужна читателю-человеку, а не тегу <img>.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "web3puls-bucket-shape-"));
const DIST = join(TMP, "dist");
mkdirSync(join(DIST, "assets"), { recursive: true });
writeFileSync(
  join(DIST, "index.html"),
  `<!doctype html><html><head><title>оболочка</title></head><body><div id="app"></div></body></html>`,
);
writeFileSync(join(DIST, "assets", "app-abcdef.js"), "console.log(1)\n");
writeFileSync(join(DIST, "favicon.ico"), "\0\0\1\0");

const PREV_DIST = process.env.SITE_WEB_DIST;
process.env.SITE_WEB_DIST = DIST;

const { makeFetchHandler, _resetRateLimiter, _resetShellCache } = await import(
  "./index.ts"
);
const handle = makeFetchHandler();

function get(path: string, ip: string): Promise<Response> {
  return handle(
    new Request(`http://x${path}`, { headers: { "x-forwarded-for": ip } }),
  );
}

/** Статус 61-го запроса подряд с одного адреса: ведро на 60. */
async function floodStatus(path: string, ip: string): Promise<number> {
  let last = 0;
  for (let i = 0; i < 61; i++) last = (await get(path, ip)).status;
  return last;
}

afterAll(() => {
  if (PREV_DIST === undefined) delete process.env.SITE_WEB_DIST;
  else process.env.SITE_WEB_DIST = PREV_DIST;
  _resetRateLimiter();
  _resetShellCache();
});

beforeEach(() => {
  _resetRateLimiter();
  _resetShellCache();
});

describe("мимо ведра идут только существующие файлы сборки", () => {
  test("существующий бандл — мимо ведра", async () => {
    for (let i = 0; i < 80; i++) {
      const res = await get("/assets/app-abcdef.js", "10.2.0.1");
      expect(res.status).toBe(200);
    }
  });

  test("существующий файл в корне сборки — мимо ведра", async () => {
    for (let i = 0; i < 80; i++) {
      expect((await get("/favicon.ico", "10.2.0.2")).status).toBe(200);
    }
  });

  test("несуществующий бандл лимитируется: отдавать его ядру нечего", async () => {
    expect(await floodStatus("/assets/нет-такого-abc.js", "10.2.0.3")).toBe(429);
  });

  test("статейный путь с расширением картинки лимитируется", async () => {
    // Ходит в SQLite через digestIdFromPath и при этом подходил под
    // освобождение — ровно то сочетание, ради которого правка и сделана.
    expect(await floodStatus("/digest/чего-нет.png", "10.2.0.4")).toBe(429);
  });

  test("выдуманный адрес с расширением лимитируется", async () => {
    expect(await floodStatus("/1.png", "10.2.0.5")).toBe(429);
  });

  test("оболочку по прямому адресу ведро тоже считает", async () => {
    // index.html на диске ЕСТЬ, но это оболочка, а не файл сборки: стоит
    // чтения и отдаётся с no-cache.
    expect(await floodStatus("/index.html", "10.2.0.6")).toBe(429);
  });
});

describe("отсутствующий файл сборки не стоит целой оболочки", () => {
  test("несуществующая картинка — короткий 404, а не index.html", async () => {
    const res = await get("/2.png", "10.3.0.1");
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain("<div id=\"app\">");
    expect(body.length).toBeLessThan(64);
  });

  test("несуществующий бандл — тоже короткий 404", async () => {
    const res = await get("/assets/нет-такого-def.js", "10.3.0.2");
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("<div id=\"app\">");
  });

  test("выдуманный адрес без расширения по-прежнему отдаёт оболочку", async () => {
    // Это читатель, а не тег <img>: ему нужна страница с навигацией.
    const res = await get("/ниоткуда", "10.3.0.3");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("<div id=\"app\">");
  });
});
