/**
 * Аудит 2026-08-29: env-гейт внутреннего ингеста работал только на POST.
 *
 * «If the secret is unset the endpoint does not exist at all» — так написано
 * над `authedJsonBody`, и на POST так и есть: 404, тот же, что у любого
 * несуществующего пути. Но вызывается эта функция изнутри обработчика, а до
 * обработчика доходит только POST: ветка `req.method !== "POST"` в `routeApi`
 * стоит выше и отвечает 405 с заголовком `Allow: POST, OPTIONS`.
 *
 * То есть `GET /api/internal/digests` на сервере с незаданным
 * `SITE_INGEST_TOKEN` отвечал буквально: «такой ресурс есть, и ходят сюда
 * POST'ом», — тогда как `GET /api/nonexistent` рядом отвечает 404. Разница в
 * ответах и есть перечисление: она называет маршруты, которых, по замыслу,
 * не существует.
 *
 * Фикс: пока токен не задан, оба пути ингеста отвечают 404 на любой метод —
 * ровно тем же телом и без `Allow`, что и неизвестный путь. Когда токен задан,
 * поведение прежнее: POST обрабатывается, прочие методы получают 405 с Allow
 * (RFC 9110 §15.5.6), и оба ответа считаются ведром (см.
 * `audit-2026-08-29-api-limiter-bypass.test.ts`).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "web3puls-internal-enum-"));
process.env.SITE_DB_PATH = join(TMP, "internal-enum.db");
process.env.SITE_INGEST_TOKEN = "enum-token";

const { makeFetchHandler, _resetRateLimiter } = await import("./index.ts");

let server: ReturnType<typeof Bun.serve>;
let base: string;

const INGEST_PATHS = ["/api/internal/digests", "/api/internal/activities"];
const METHODS = ["GET", "PUT", "DELETE", "PATCH"];

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: makeFetchHandler() });
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

beforeEach(() => {
  _resetRateLimiter();
});

/** Запустить тело с временно снятым токеном, вернув env как было. */
async function withoutToken<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.SITE_INGEST_TOKEN;
  delete process.env.SITE_INGEST_TOKEN;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.SITE_INGEST_TOKEN;
    else process.env.SITE_INGEST_TOKEN = prev;
  }
}

describe("ненастроенный ингест не отличим от несуществующего пути", () => {
  test("любой метод отвечает 404 без Allow", async () => {
    await withoutToken(async () => {
      for (const path of INGEST_PATHS) {
        for (const method of METHODS) {
          const r = await fetch(`${base}${path}`, { method });
          expect(`${method} ${path} → ${r.status}`).toBe(
            `${method} ${path} → 404`,
          );
          expect(r.headers.get("Allow")).toBeNull();
          expect(await r.json()).toEqual({ error: "not_found" });
        }
      }
    });
  });

  test("ответ совпадает с ответом неизвестного пути", async () => {
    await withoutToken(async () => {
      const unknown = await fetch(`${base}/api/definitely-not-a-route`);
      const gated = await fetch(`${base}/api/internal/digests`);
      expect(gated.status).toBe(unknown.status);
      expect(gated.headers.get("Allow")).toBe(unknown.headers.get("Allow"));
      expect(await gated.json()).toEqual(await unknown.json());
    });
  });

  test("POST по-прежнему 404 — гейт не ослаб", async () => {
    await withoutToken(async () => {
      const r = await fetch(`${base}/api/internal/digests`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "x", title: "t" }),
      });
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ error: "not_found" });
    });
  });

  test("404 гейта считается ведром на любом методе", async () => {
    await withoutToken(async () => {
      const codes: number[] = [];
      for (let i = 0; i < 70; i++) {
        codes.push((await fetch(`${base}/api/internal/digests`)).status);
      }
      expect(codes.slice(0, 60).every((c) => c === 404)).toBe(true);
      expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
    });
  });
});

describe("настроенный ингест отвечает как прежде", () => {
  test("неверный метод — 405 с Allow: POST, OPTIONS", async () => {
    const r = await fetch(`${base}/api/internal/digests`, { method: "GET" });
    expect(r.status).toBe(405);
    expect(r.headers.get("Allow")).toBe("POST, OPTIONS");
    expect(await r.json()).toEqual({ error: "method_not_allowed" });
  });

  test("POST без токена — 401, а не 404", async () => {
    const r = await fetch(`${base}/api/internal/digests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(r.status).toBe(401);
  });
});
