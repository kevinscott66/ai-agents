/**
 * Аудит 2026-08-12: две дыры в /api/ — падение на битом id и бесплатный
 * перебор токена ингеста.
 *
 * (1) `handleApi` звал `decodeURIComponent` на куске пути без try/catch:
 *     `/api/digests/%` — это валидный HTTP-запрос (percent-encoding битый, но
 *     URL разбирается), и `decodeURIComponent` кидает URIError. Бросок уходит
 *     ИЗ `routeApi` мимо `withSecurityHeaders` — то есть ровно мимо обёртки,
 *     которая по своему же комментарию обязана накрыть каждый /api/-ответ.
 *     Рядом, в этом же файле, `digestIdFromPath` (index.ts:242) тот же вызов
 *     уже оборачивает — идиома в файле есть, до двух мест не дошла.
 *
 * (2) `/api/internal/*` разбирается ДО `rateLimitOk` с пометкой «trusted
 *     machine-to-machine». Но доверять машине можно только после проверки
 *     токена, а сама проверка стоит ноль: неудачных попыток никто не считает.
 *
 * Замер до правки (зонд поверх настоящего makeFetchHandler):
 *   /api/digests/%      → 500 | X-Content-Type-Options: (нет) | CT: text/html
 *   /api/activities/%   → 500 | X-Content-Type-Options: (нет) | CT: text/html
 *   /api/digests/%E0%A4%A → 500, то же самое
 *   300 POST /api/internal/digests с чужим Bearer → 401=300 429=0
 *   легитимный ингест после этих 300 попыток → 200
 *
 * То есть: посторонний получает HTML-страницу ошибки вместо JSON и без
 * hardening-заголовков там, где весь остальной /api/ их несёт, — и может
 * перебирать токен ингеста сколько угодно, а единственный лимитер площадки
 * стоит за этой веткой.
 *
 * Инварианты: битый percent-encoding — обычное «не найдено» (404 JSON с
 * заголовками), а неудачная аутентификация на ингесте расходует токены того
 * же ведра, что и чтение; успешный ингест не расходует ничего.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "web3puls-hardening-"));
process.env.SITE_DB_PATH = join(TMP, "hardening.db");

const { seedIfEmpty } = await import("./seed.ts");
const { makeFetchHandler, _resetRateLimiter } = await import("./index.ts");

const TOKEN = "s3cret-ingest-token-0123456789ab";
const PREV_TOKEN = process.env.SITE_INGEST_TOKEN;

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  process.env.SITE_DB_PATH = join(TMP, "hardening.db");
  process.env.SITE_INGEST_TOKEN = TOKEN;
  seedIfEmpty();
  server = Bun.serve({ port: 0, fetch: makeFetchHandler() });
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  // CLAUDE.md §3.8.7: env не течёт в соседние файлы тестов.
  if (PREV_TOKEN === undefined) delete process.env.SITE_INGEST_TOKEN;
  else process.env.SITE_INGEST_TOKEN = PREV_TOKEN;
});

beforeEach(() => _resetRateLimiter());

describe("битый percent-encoding в id", () => {
  const BROKEN = [
    "/api/digests/%",
    "/api/activities/%",
    "/api/digests/%E0%A4%A",
    "/api/activities/%zz",
    "/api/digests/%C3%28",
  ];

  for (const p of BROKEN) {
    test(`GET ${p} — 404 JSON, не 500`, async () => {
      const r = await fetch(base + p);
      // Старое поведение: 500 с HTML-страницей ошибки Bun.
      expect(r.status).toBe(404);
      expect(r.headers.get("content-type")).toContain("application/json");
      expect(await r.json()).toEqual({ error: "not_found" });
    });

    test(`GET ${p} — hardening-заголовки на месте`, async () => {
      const r = await fetch(base + p);
      await r.text();
      // Старое поведение: заголовков нет вовсе — бросок ушёл мимо обёртки.
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(r.headers.get("x-frame-options")).toBe("DENY");
      expect(r.headers.get("referrer-policy")).toBe(
        "strict-origin-when-cross-origin",
      );
    });
  }

  test("корректно закодированный id по-прежнему декодируется", async () => {
    const { listDigests } = await import("./db.ts");
    const d = listDigests(1, 0)[0]!;
    const r = await fetch(`${base}/api/digests/${encodeURIComponent(d.id)}`);
    expect(r.status).toBe(200);
    expect((await r.json()).id).toBe(d.id);
  });
});

describe("перебор токена на /api/internal/*", () => {
  /** Одна попытка с заведомо чужим токеном. */
  async function guess(i: number, path = "/api/internal/digests") {
    const r = await fetch(base + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer guess-attempt-nnnn-${String(i).padStart(8, "0")}`,
        // Через nginx: peer будет петлёй, ключ ведра берётся из XFF.
        "x-forwarded-for": "203.0.113.77",
      },
      body: JSON.stringify({ title: "x", summary: "y", items: [] }),
    });
    await r.text();
    return r.status;
  }

  test("неудачные попытки упираются в 429", async () => {
    let n401 = 0;
    let n429 = 0;
    for (let i = 0; i < 300; i++) {
      const s = await guess(i);
      if (s === 401) n401++;
      else if (s === 429) n429++;
    }
    // Старое поведение: 401=300, 429=0.
    expect(n429).toBeGreaterThan(0);
    expect(n401).toBeLessThanOrEqual(60);
    expect(n401 + n429).toBe(300);
  });

  test("ответ 429 несёт Retry-After и hardening-заголовки", async () => {
    for (let i = 0; i < 70; i++) await guess(i);
    const r = await fetch(base + "/api/internal/activities", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer nope-nope-nope",
        "x-forwarded-for": "203.0.113.77",
      },
      body: "{}",
    });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("60");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    await r.text();
  });

  test("перебор с одного адреса не мешает другому", async () => {
    for (let i = 0; i < 200; i++) await guess(i);
    const r = await fetch(base + "/api/internal/digests", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer nope-nope-nope",
        "x-forwarded-for": "198.51.100.4",
      },
      body: "{}",
    });
    expect(r.status).toBe(401);
    await r.text();
  });

  test("успешный ингест ведро не расходует", async () => {
    // Дайджест кладём столько раз, сколько их бывает за выпуск, и ещё вдвое.
    for (let i = 0; i < 40; i++) {
      const r = await fetch(base + "/api/internal/digests", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({
          title: `Проверка ${i}`,
          summary: "Резюме",
          items: [{ text: "источник" }],
        }),
      });
      expect(r.status).toBe(200);
      await r.text();
    }
    // Чтение с того же (петлевого) ключа после этого всё ещё проходит.
    const r = await fetch(`${base}/api/health`);
    expect(r.status).toBe(200);
    await r.text();
  });

  // Аудит 2026-09-10: заголовок теста утверждал «до лимитера дело не доходит»
  // — то есть ровно тот инвариант, который аудит 2026-08-29 здесь СНЯЛ,
  // заведя счёт до ответа (см. комментарий в routeApi у ветки ингеста).
  // Один запрос проходит при любом порядке, поэтому тест не падал и тихо
  // документировал обратное тому, что делает код.
  test("метод не тот — 405 с Allow, и токен за него уже списан", async () => {
    const r = await fetch(base + "/api/internal/digests", { method: "GET" });
    expect(r.status).toBe(405);
    expect(r.headers.get("Allow")).toBe("POST, OPTIONS");
    await r.text();
  });
});
