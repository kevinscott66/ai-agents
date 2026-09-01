/**
 * Аудит 2026-08-29: два ответа `/api/*` уходили мимо лимитера.
 *
 * Лимит на IP стоит в самом конце `routeApi` — до него доходит только GET/HEAD
 * по публичным путям. Ветки внутреннего ингеста возвращались раньше:
 *
 *  1. `GET|PUT|DELETE /api/internal/*` → 405, без токена и без счёта. Замер до
 *     фикса: 200 запросов подряд, 405=200, 429=0.
 *  2. `POST /api/internal/*` при незаданном `SITE_INGEST_TOKEN` → 404 от
 *     env-гейта. Ретро-счёт стоял ниже с условием `=== 401`, то есть зонд по
 *     ненастроенному серверу тоже был бесплатным.
 *
 * Своего ингеста это не касается: он ходит POST'ом с токеном и отвечает 200 —
 * такой ответ ведро не трогает и не должен.
 *
 * Preflight (OPTIONS) остаётся вне лимита сознательно — он не самостоятельный
 * запрос, а приставка браузера к тому, который считается; см. комментарий в
 * `routeApi`. Здесь это зафиксировано тестом, чтобы решение не перепутали с
 * недосмотром.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "web3puls-rl-bypass-"));
process.env.SITE_DB_PATH = join(TMP, "rl-bypass.db");
process.env.SITE_INGEST_TOKEN = "rl-bypass-token";

const { makeFetchHandler, _resetRateLimiter } = await import("./index.ts");

let server: ReturnType<typeof Bun.serve>;
let base: string;
let prevLoopbackCap: string | undefined;

/** Ёмкость ведра по умолчанию (RL_CAPACITY в index.ts). */
const CAPACITY = 60;

beforeAll(() => {
  // Запросы идут с петли, а её ёмкость настраивается env'ом: без сброса
  // тест зависел бы от окружения, в котором его запустили.
  prevLoopbackCap = process.env.SITE_LOOPBACK_RL_CAPACITY;
  delete process.env.SITE_LOOPBACK_RL_CAPACITY;
  server = Bun.serve({ port: 0, fetch: makeFetchHandler() });
  base = `http://localhost:${server.port}`;
});
afterAll(() => {
  if (prevLoopbackCap === undefined) delete process.env.SITE_LOOPBACK_RL_CAPACITY;
  else process.env.SITE_LOOPBACK_RL_CAPACITY = prevLoopbackCap;
  server.stop(true);
});
beforeEach(() => _resetRateLimiter());

/** N запросов подряд; возвращает коды в порядке отправки. */
async function burst(n: number, send: () => Promise<Response>): Promise<number[]> {
  const codes: number[] = [];
  for (let i = 0; i < n; i++) codes.push((await send()).status);
  return codes;
}

const getInternal = () => fetch(`${base}/api/internal/digests`);

describe("ветки /api/internal больше не бесплатные", () => {
  test("405 на неверный метод считается ведром", async () => {
    const codes = await burst(CAPACITY + 10, getInternal);

    // Первые CAPACITY запросов — штатный 405 с Allow.
    expect(codes.slice(0, CAPACITY).every((c) => c === 405)).toBe(true);
    // Дальше ведро обязано отказать. Точную границу не фиксируем: ведро
    // подтекает (полная ёмкость за минуту), и на медленной машине один-два
    // токена успевают вернуться.
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
  });

  test("429 приходит с Retry-After и не теряет CORS", async () => {
    await burst(CAPACITY, getInternal);
    let last = await getInternal();
    for (let i = 0; i < 5 && last.status !== 429; i++) last = await getInternal();

    expect(last.status).toBe(429);
    expect(last.headers.get("Retry-After")).toBe("60");
    expect(await last.json()).toEqual({ error: "rate_limited" });
  });

  test("405 всё ещё отвечает по RFC, пока токены есть", async () => {
    const r = await getInternal();
    expect(r.status).toBe(405);
    expect(r.headers.get("Allow")).toBe("POST, OPTIONS");
    expect(await r.json()).toEqual({ error: "method_not_allowed" });
  });

  test("404 ненастроенного ингеста тоже считается", async () => {
    const prev = process.env.SITE_INGEST_TOKEN;
    delete process.env.SITE_INGEST_TOKEN;
    try {
      const codes = await burst(CAPACITY + 10, () =>
        fetch(`${base}/api/internal/digests`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      );
      expect(codes.slice(0, CAPACITY).every((c) => c === 404)).toBe(true);
      expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
    } finally {
      if (prev === undefined) delete process.env.SITE_INGEST_TOKEN;
      else process.env.SITE_INGEST_TOKEN = prev;
    }
  });

  test("перебор Bearer'а по-прежнему упирается в ведро", async () => {
    const codes = await burst(CAPACITY + 10, () =>
      fetch(`${base}/api/internal/digests`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer wrong",
        },
        body: "{}",
      }),
    );
    expect(codes.slice(0, CAPACITY).every((c) => c === 401)).toBe(true);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
  });
});

describe("свой трафик не задет", () => {
  test("успешный ингест токенов не тратит", async () => {
    const codes: number[] = [];
    for (let i = 0; i < CAPACITY + 10; i++) {
      const r = await fetch(`${base}/api/internal/digests`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer rl-bypass-token",
        },
        body: JSON.stringify({
          id: `rl-ok-${i}`,
          title: `Выпуск ${i}`,
          summary: "Проверка того, что успешный ингест не расходует ведро.",
          items: [],
        }),
      });
      codes.push(r.status);
    }
    expect(codes.every((c) => c === 200)).toBe(true);
    // Ведро нетронуто — следующий чужой запрос получает штатный 405.
    expect((await getInternal()).status).toBe(405);
  });

  test("preflight вне лимита — это решение, а не недосмотр", async () => {
    const codes = await burst(CAPACITY + 40, () =>
      fetch(`${base}/api/internal/digests`, { method: "OPTIONS" }),
    );
    expect(codes.every((c) => c === 204)).toBe(true);
    // Токены целы: считать preflight значило бы вдвое урезать бюджет
    // кросс-доменного клиента ради ответа без тела.
    expect((await getInternal()).status).toBe(405);
  });
});
