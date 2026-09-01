/**
 * Серверный аудит 2026-08-13, второй заход. Четыре находки, все
 * воспроизведены на живом проде до правки.
 *
 * 1. Поиск по кириллице был регистрозависимым. `LIKE` в SQLite складывает
 *    регистр только для латиницы, а весь контент сайта русский. На живом
 *    delabs.space одно и то же слово давало три разных ответа:
 *    «Биткоин» → 3, «биткоин» → 8, «БИТКОИН» → 0. Читатель, набравший слово
 *    не с той буквы, видел пустую выдачу и ни одного признака сбоя.
 *
 * 2. `/rss.xml` и `/sitemap.xml` списывали по два токена лимитера за запрос:
 *    правка 08-12 добавила их в список «дорогих», правка 08-13 — отдельный
 *    лимитер в блоке xmlRoute, мердж сохранил оба. Бюджет этих маршрутов был
 *    вдвое меньше объявленного, и заметнее всего за прокси, где вся аудитория
 *    делит одно ведро.
 *
 * 3. `HEAD` на любом `/api/*` отдавал 405, хотя `/rss.xml` его принимает.
 *    Монитор на `HEAD /api/health` — самая дешёвая идиоматичная проба —
 *    показывал бы «лежит» на здоровом сервисе.
 *
 * 4. `Bun.serve` звался без `hostname`, то есть слушал 0.0.0.0: сайт целиком
 *    отвечал по голому HTTP на публичном адресе в обход nginx и TLS.
 *    Проверено снаружи: `curl http://203.0.113.10:8790/api/stats` → 200.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "web3puls-audit0813b-"));
process.env.SITE_DB_PATH = join(TMP, "audit.db");

const { seedIfEmpty } = await import("./seed.ts");
const { upsertDigest, searchDigests, countSearchDigests } = await import("./db.ts");
const { makeFetchHandler, _resetRateLimiter } = await import("./index.ts");

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  process.env.SITE_DB_PATH = join(TMP, "audit.db");
  seedIfEmpty();
  upsertDigest({
    id: "cyrillic-probe",
    title: "Биткоин держит уровень",
    date: "2026-08-13",
    summary: "Эфириум и Солана следом",
    items: [{ text: "Отдельный пункт про Полкадот", url: "https://example.com/a" }],
    sourceCount: 1,
  });
  server = Bun.serve({ port: 0, fetch: makeFetchHandler() });
  base = `http://localhost:${server.port}`;
});

afterAll(() => server.stop(true));

beforeEach(() => _resetRateLimiter());

describe("поиск складывает регистр кириллицы", () => {
  // Три поля, по которым идёт поиск: заголовок, аннотация, текст пункта.
  for (const [field, word] of [
    ["заголовок", "биткоин"],
    ["аннотация", "эфириум"],
    ["пункт", "полкадот"],
  ] as const) {
    test(`${field}: три написания дают одну и ту же выдачу`, () => {
      const forms = [word, word.toUpperCase(), word[0]!.toUpperCase() + word.slice(1)];
      const totals = forms.map((f) => countSearchDigests(f));
      // Само слово должно находиться — иначе тест проходит на трёх нулях.
      expect(totals[0]).toBeGreaterThan(0);
      expect(new Set(totals).size).toBe(1);
      const ids = forms.map((f) => searchDigests(f, 50, 0).map((d) => d.id).join(","));
      expect(new Set(ids).size).toBe(1);
      expect(ids[0]).toContain("cyrillic-probe");
    });
  }

  test("латиница по-прежнему регистронезависима", () => {
    upsertDigest({
      id: "ascii-probe",
      title: "Bittensor растёт",
      date: "2026-08-13",
      summary: "",
      items: [],
      sourceCount: 0,
    });
    expect(countSearchDigests("bittensor")).toBe(countSearchDigests("BITTENSOR"));
    expect(countSearchDigests("bittensor")).toBeGreaterThan(0);
  });

  test("подстановочные знаки в запросе остаются буквальными", () => {
    // escapeLike применяется уже к приведённой строке — проверяем, что
    // приведение регистра не сломало экранирование. Голый «%» не годится:
    // проценты в текстах есть и находятся честно. Берём шаблон, который без
    // экранирования сматчил бы «биткоин», а буквально — ничего.
    expect(countSearchDigests("биткоин")).toBeGreaterThan(0);
    expect(countSearchDigests("би%он")).toBe(0);
    expect(countSearchDigests("биткои_")).toBe(0);
    expect(countSearchDigests("БИ%ОН")).toBe(0);
  });

  test("правка не расширила область поиска на body", () => {
    upsertDigest({
      id: "body-probe",
      title: "Без ключевого слова",
      date: "2026-08-13",
      summary: "тоже без",
      items: [],
      sourceCount: 0,
      body: "уникальноеслововтелестатьи",
    });
    expect(countSearchDigests("уникальноеслововтелестатьи")).toBe(0);
  });
});

describe("лимитер списывает один токен за запрос", () => {
  /** Сколько ответов приходит до первого 429. */
  async function budget(path: string): Promise<number> {
    _resetRateLimiter();
    let n = 0;
    for (let i = 0; i < 120; i++) {
      const res = await fetch(`${base}${path}`);
      await res.arrayBuffer();
      if (res.status === 429) return n;
      n++;
    }
    return n;
  }

  test("у /rss.xml тот же бюджет, что у /robots.txt", async () => {
    const rss = await budget("/rss.xml");
    const robots = await budget("/robots.txt");
    expect(rss).toBeGreaterThan(0);
    expect(rss).toBe(robots);
  });

  test("у /sitemap.xml тот же бюджет, что у /api/health", async () => {
    const sitemap = await budget("/sitemap.xml");
    const api = await budget("/api/health");
    expect(sitemap).toBeGreaterThan(0);
    expect(sitemap).toBe(api);
  });
});

describe("HEAD принимается там же, где GET", () => {
  for (const path of ["/api/health", "/api/stats", "/rss.xml"]) {
    test(path, async () => {
      const head = await fetch(`${base}${path}`, { method: "HEAD" });
      await head.arrayBuffer();
      const get = await fetch(`${base}${path}`);
      await get.arrayBuffer();
      expect(head.status).toBe(get.status);
      expect(head.status).toBe(200);
    });
  }

  test("непредусмотренный метод по-прежнему 405", async () => {
    const res = await fetch(`${base}/api/health`, { method: "DELETE" });
    expect(res.status).toBe(405);
  });
});

describe("сервер не слушает публичный интерфейс", () => {
  test("Bun.serve вызывается с явным hostname", () => {
    const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const serveCall = src.slice(src.indexOf("Bun.serve({"));
    expect(serveCall).toContain("hostname:");
    // Умолчание — петля. Публичный адрес возможен только явной переменной.
    expect(serveCall).toMatch(/hostname:[^\n]*"127\.0\.0\.1"/);
  });
});
