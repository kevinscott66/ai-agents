/**
 * Серверный аудит 2026-08-20. `/activity/<id>` жил вне серверной обработки.
 *
 * Спец-обработка была только у `/digest/`: `digestIdFromPath` →
 * `digestShellResponse` → `digestNotFoundResponse`. Путь `/activity/<id>`
 * проваливался в `serveStatic`, файла там нет, расширения тоже — и SPA-фолбэк
 * отдавал `index.html` со статусом **200**. Отсюда три следствия:
 *
 *  1. Удалённый или никогда не существовавший гайд отвечал 200. Это ровно
 *     дефект, который 2026-08-13 починили для дайджестов («удаление данных
 *     обязано выражаться в статусе», T-743), не перенесённый на вторую
 *     половину карты сайта — при том, что `buildSitemapXml` эти адреса
 *     публикует поисковикам.
 *  2. Мета-данных гайд не получал: все ссылки на гайды разворачивались в
 *     одинаковую карточку «DeLabs — крипта и AI без шума» с og:url на корень.
 *     Аудит 2026-08-12 чинил это же для дайджестов.
 *  3. `/activity/` не входил в `rateLimitedNonApi` — единственный контентный
 *     маршрут мимо ведра, при том что он читает БД на каждый запрос.
 *
 * Все три до правки красные.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "web3puls-activity-shell-"));
const DIST = join(TMP, "dist");
mkdirSync(DIST, { recursive: true });
// Оболочка нужна настоящая: без dist сервер намеренно оставляет прежнее
// поведение («фронт не собран»), и проверять было бы нечего.
writeFileSync(
  join(DIST, "index.html"),
  `<!doctype html><html><head><title>DeLabs — крипта и AI без шума</title>` +
    `<meta property="og:title" content="DeLabs" />` +
    `<meta property="og:url" content="https://delabs.space/" />` +
    `</head><body><div id="app"></div></body></html>`,
);

process.env.SITE_DB_PATH = join(TMP, "audit.db");
process.env.SITE_WEB_DIST = DIST;

const { seedIfEmpty } = await import("./seed.ts");
const { makeFetchHandler, _resetRateLimiter, activityIdFromPath, injectActivityMeta } =
  await import("./index.ts");
import type { Activity } from "./types.ts";

/** Настоящая оболочка сайта — там мета-теги разнесены по строкам. */
const SHELL = readFileSync(join(import.meta.dir, "..", "web", "index.html"), "utf8");

const TOKEN = "s3cret-ingest-token-0123456789ab";
const PREV_TOKEN = process.env.SITE_INGEST_TOKEN;
const PREV_DIST = process.env.SITE_WEB_DIST;

const PROBE_ID = "activity-shell-probe";
const PROBE_TITLE = "Гайд по «Проекту» с кавычками & амперсандом";
const PROBE_INTRO = "Короткое вступление зонда про награды.";

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(async () => {
  process.env.SITE_INGEST_TOKEN = TOKEN;
  seedIfEmpty();
  server = Bun.serve({ port: 0, fetch: makeFetchHandler() });
  base = `http://localhost:${server.port}`;
  const res = await fetch(`${base}/api/internal/activities`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      id: PROBE_ID,
      project: "Проект",
      title: PROBE_TITLE,
      intro: PROBE_INTRO,
      whatIs: "что это такое",
      steps: ["шаг один", "шаг два"],
      url: "https://example.com/project",
    }),
  });
  expect(res.status).toBe(200);
});

afterAll(() => {
  server.stop(true);
  // CLAUDE.md §3.8.7: env не течёт в соседние файлы тестов.
  if (PREV_TOKEN === undefined) delete process.env.SITE_INGEST_TOKEN;
  else process.env.SITE_INGEST_TOKEN = PREV_TOKEN;
  if (PREV_DIST === undefined) delete process.env.SITE_WEB_DIST;
  else process.env.SITE_WEB_DIST = PREV_DIST;
  // Ведро лимитера — тоже состояние процесса, и течёт оно так же, как env:
  // bun гоняет все файлы набора в одном процессе, а `beforeEach` чистит ведро
  // только СВОИМ тестам. Этот файл шлёт десятки запросов и оставлял ведро
  // выбранным — следующий файл получал 429 на первом же обращении. Пара
  // «activity-shell + sitemap» падала шестью тестами и без этой строки, просто
  // в полном наборе между ними случайно оказывался файл, который ведро сбрасывал.
  _resetRateLimiter();
});

beforeEach(() => _resetRateLimiter());

describe("activityIdFromPath", () => {
  test("разбирает путь гайда так же, как дайджеста", () => {
    expect(activityIdFromPath("/activity/abc-123")).toBe("abc-123");
    expect(activityIdFromPath("/activity/abc-123/")).toBe("abc-123");
    expect(activityIdFromPath("/activity/a%20b")).toBe("a b");
  });

  test("чужие пути — null", () => {
    expect(activityIdFromPath("/")).toBeNull();
    expect(activityIdFromPath("/activity")).toBeNull();
    expect(activityIdFromPath("/activity/")).toBeNull();
    expect(activityIdFromPath("/activity/a/b")).toBeNull();
    expect(activityIdFromPath("/api/activities/abc")).toBeNull();
    expect(activityIdFromPath("/digest/abc")).toBeNull();
  });

  test("битый percent-encoding не роняет разбор", () => {
    expect(activityIdFromPath("/activity/%")).toBe("%");
  });
});

describe("/activity/<id> — оболочка с мета-данными гайда", () => {
  test("существующий гайд: 200 и его собственные og-теги", async () => {
    const res = await fetch(`${base}/activity/${PROBE_ID}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    // Заголовок подставлен и экранирован — intro/title приходят от модели.
    expect(html).toContain("&amp;");
    expect(html).toContain("og:title");
    expect(html).toContain(`https://delabs.space/activity/${PROBE_ID}`);
    expect(html).toContain(PROBE_INTRO);
    // Карточка больше не общая для всех гайдов.
    expect(html).not.toContain("<title>DeLabs — крипта и AI без шума</title>");
  });

  test("описание режется по потолку, а не уезжает целиком", () => {
    // Проверяем чистую функцию, а не ответ сервера. Причина: `WEB_DIST`
    // читается на импорте модуля, и в общем прогоне его выигрывает тот файл
    // тестов, который импортировал `index.ts` первым, — то есть оболочкой
    // может оказаться настоящий `site/web/index.html`, где мета-теги разнесены
    // по строкам. Регулярка на `name="description" content="…"` с одним
    // пробелом такое не ловит: изолированно тест был зелёным, в общем прогоне
    // падал, и оба раза не из-за кода.
    const long = "очень длинное вступление ".repeat(200);
    const out = injectActivityMeta(SHELL, {
      id: "activity-long-intro",
      project: "Проект",
      title: "Длинное вступление",
      intro: long,
      whatIs: "x",
      steps: ["шаг"],
      url: "https://example.com/long",
    } as Activity);
    const m = out.match(/name="description"\s+content="([^"]*)"/);
    expect(m).not.toBeNull();
    expect(m![1]!.length).toBeLessThanOrEqual(300);
    // Обрезано именно по потолку, а не по случайности длины.
    expect(m![1]!.endsWith("…")).toBe(true);
  });

  test("короткое описание не трогаем", () => {
    const out = injectActivityMeta(SHELL, {
      id: "activity-short-intro",
      project: "Проект",
      title: "Короткое",
      intro: "Три слова тут.",
      whatIs: "x",
      steps: ["шаг"],
      url: "https://example.com/short",
    } as Activity);
    const m = out.match(/name="description"\s+content="([^"]*)"/);
    expect(m![1]).toBe("Три слова тут.");
  });

  test("несуществующий гайд: 404 и noindex, а не 200", async () => {
    const res = await fetch(`${base}/activity/no-such-guide-at-all`);
    expect(res.status).toBe(404);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    // Оболочку всё равно отдаём: клиентский роутер покажет своё «не найдено».
    expect(await res.text()).toContain('<div id="app">');
  });

  test("дайджесты не задеты: чужой id гайда не подменяет статью", async () => {
    const res = await fetch(`${base}/digest/no-such-digest`);
    expect(res.status).toBe(404);
  });
});

describe("/activity/ учитывается лимитером", () => {
  test("серия запросов упирается в 429", async () => {
    _resetRateLimiter();
    let limited = false;
    for (let i = 0; i < 120; i++) {
      const res = await fetch(`${base}/activity/${PROBE_ID}`);
      if (res.status === 429) {
        limited = true;
        expect(res.headers.get("retry-after")).toBe("60");
        break;
      }
      await res.text();
    }
    expect(limited).toBe(true);
  });
});
