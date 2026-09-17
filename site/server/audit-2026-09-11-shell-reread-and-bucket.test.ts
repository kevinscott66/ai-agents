/**
 * Аудит 2026-09-11 (круг 15): оболочка читалась с диска на каждый запрос, и
 * самый дешёвый для сканера адрес был самым дорогим для сервера.
 *
 * Две находки, связанные одной причиной — списком путей, который расходился с
 * диспетчером.
 *
 *  1. `shellHtml()` делал `readFileSync(index.html)` на КАЖДЫЙ вызов: на
 *     каждой статье, на каждом гайде и — после правки статейного 404 —
 *     на каждом несуществующем адресе. Синхронное чтение в потоке обработчика.
 *     Кэш ключуется путём, mtime и размером: редеплой меняет файл, и оболочка
 *     перечитывается сама, а подмена `SITE_WEB_DIST` в тестах меняет путь.
 *
 *  2. Ведро на 60 запросов в минуту перечисляло пути вручную, и перечисление
 *     разъезжалось с диспетчером третий раз подряд: голые `/digest` и
 *     `/activity` (без слэша) ходили мимо ведра. После правки 404 они стали
 *     ещё и стоить чтения оболочки — то есть бесплатный способ заставить
 *     сервер читать файл. Перечислять больше нечего: лимитируется всё, что
 *     стоит оболочки, мимо ведра идут только файлы сборки (страница тянет их
 *     пачкой, общий бюджет её бы задушил).
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "web3puls-shell-cache-"));
const DIST = join(TMP, "dist");
const INDEX = join(DIST, "index.html");
mkdirSync(join(DIST, "assets"), { recursive: true });
// Настоящий файл сборки: освобождение от ведра выдаётся по наличию файла
// (аудит 2026-09-11, круг 17 — audit-2026-09-11-bucket-asset-shape.test.ts),
// а не по расширению в адресе.
writeFileSync(join(DIST, "assets", "app-abcdef.js"), "console.log(1)\n");

function shell(marker: string): string {
  return `<!doctype html><html><head><title>${marker}</title></head><body><div id="app"></div></body></html>`;
}
writeFileSync(INDEX, shell("первая-сборка"));

const PREV_DIST = process.env.SITE_WEB_DIST;
process.env.SITE_WEB_DIST = DIST;

const { makeFetchHandler, _resetRateLimiter, _resetShellCache } = await import(
  "./index.ts"
);

const handle = makeFetchHandler();

/** Запрос с собственным адресом клиента: своё ведро на каждый тест. */
function get(path: string, ip: string): Promise<Response> {
  return handle(
    new Request(`http://x${path}`, { headers: { "x-forwarded-for": ip } }),
  );
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

describe("оболочка читается с диска не на каждый запрос", () => {
  test("второй запрос отдаёт ту же оболочку", async () => {
    writeFileSync(INDEX, shell("первая-сборка"));
    const a = await get("/выдуманный-адрес", "10.0.0.1");
    const b = await get("/другой-выдуманный", "10.0.0.1");
    expect(a.status).toBe(404);
    expect(await a.text()).toContain("первая-сборка");
    expect(await b.text()).toContain("первая-сборка");
  });

  test("подмена файла БЕЗ смены mtime и размера не видна — это и есть кэш", async () => {
    // Метки одной длины: размер файла не меняется. Время выставляем руками и
    // ровно то же самое — `utimesSync` режет доли миллисекунды, поэтому
    // снимок `statSync` берём уже ПОСЛЕ выставления, а не до.
    const STAMP = new Date(1_700_000_000_000);
    writeFileSync(INDEX, shell("build-AAA"));
    utimesSync(INDEX, STAMP, STAMP);
    expect(await (await get("/адрес-1", "10.0.0.2")).text()).toContain("build-AAA");

    const st = statSync(INDEX);
    writeFileSync(INDEX, shell("build-BBB"));
    utimesSync(INDEX, STAMP, STAMP);
    expect(statSync(INDEX).mtimeMs).toBe(st.mtimeMs);
    expect(statSync(INDEX).size).toBe(st.size);

    // Файл на диске другой, ответ прежний: чтения не было.
    expect(await (await get("/адрес-2", "10.0.0.2")).text()).toContain("build-AAA");
  });

  test("редеплой виден: mtime изменился — оболочка перечитана", async () => {
    writeFileSync(INDEX, shell("сборка-до-редеплоя"));
    expect(await (await get("/адрес-3", "10.0.0.3")).text()).toContain(
      "сборка-до-редеплоя",
    );

    writeFileSync(INDEX, shell("сборка-после-редеплоя"));
    const st = statSync(INDEX);
    utimesSync(INDEX, st.atime, new Date(st.mtimeMs + 5_000));

    expect(await (await get("/адрес-4", "10.0.0.3")).text()).toContain(
      "сборка-после-редеплоя",
    );
  });
});

describe("ведро считает всё, что стоит оболочки", () => {
  test("голый /digest тоже лимитируется", async () => {
    writeFileSync(INDEX, shell("ведро"));
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await get("/digest", "10.1.0.1")).status;
    expect(last).toBe(429);
  });

  test("выдуманный адрес лимитируется так же", async () => {
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await get("/ниоткуда", "10.1.0.2")).status;
    expect(last).toBe(429);
  });

  test("файлы сборки идут мимо ведра: страница тянет их пачкой", async () => {
    for (let i = 0; i < 80; i++) {
      const res = await get("/assets/app-abcdef.js", "10.1.0.3");
      expect(res.status).toBe(200);
    }
  });

  test("известная страница живёт до предела и умирает на нём", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 61; i++) codes.push((await get("/about", "10.1.0.4")).status);
    expect(codes.slice(0, 60).every((c) => c === 200)).toBe(true);
    expect(codes[60]).toBe(429);
  });
});
