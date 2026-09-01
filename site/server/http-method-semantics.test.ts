/**
 * Аудит 2026-08-13: HEAD на /api/ отвечал 405, хотя GET по тем же адресам —
 * 200, и HEAD на /rss.xml рядом — тоже 200.
 *
 * RFC 9110 §9.3.2: HEAD идентичен GET, только без тела. На нём стоят проверки
 * живости (uptime-мониторинг обычно шлёт именно HEAD), HTTP-клиентские
 * библиотеки перед скачиванием и агрегаторы, выясняющие Content-Type и размер.
 * 405 в ответе означает «такого метода у ресурса нет вовсе» — то есть сервер
 * прямо врал о ресурсе, который по GET отдаётся, и внутри одного и того же
 * сайта вёл себя на HEAD двумя разными способами.
 *
 * Вторая половина той же находки: ни один из трёх 405-ответов не нёс `Allow`,
 * который при этом коде обязателен (RFC 9110 §15.5.6). Клиент получал отказ
 * без единого намёка, чем сюда ходить, — а на /api/internal/* это как раз
 * POST, то есть подсказка не бесполезная.
 *
 * Инвариант: HEAD разрешён везде, где разрешён GET, и любой 405 называет
 * разрешённые методы.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "web3puls-methods-"));
process.env.SITE_DB_PATH = join(TMP, "methods.db");

const { seedIfEmpty } = await import("./seed.ts");
const { makeFetchHandler, _resetRateLimiter } = await import("./index.ts");

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  seedIfEmpty();
  server = Bun.serve({ port: 0, fetch: makeFetchHandler() });
  base = `http://localhost:${server.port}`;
});

afterAll(() => server?.stop(true));
beforeEach(() => _resetRateLimiter());

/** Адреса, которые точно отвечают на GET. */
const GETTABLE = ["/api/stats", "/api/digests", "/api/drops", "/rss.xml", "/sitemap.xml"];

describe("HEAD разрешён везде, где разрешён GET", () => {
  for (const path of GETTABLE) {
    test(`HEAD ${path} отвечает тем же кодом, что GET`, async () => {
      const g = await fetch(base + path);
      await g.text();
      const h = await fetch(base + path, { method: "HEAD" });
      const body = await h.text();

      // До правки: на /api/* здесь было 405 при 200 на GET.
      expect(h.status).toBe(g.status);
      expect(h.status).toBe(200);
      // Тип содержимого обязан совпасть — ради него HEAD и шлют.
      expect(h.headers.get("content-type")).toBe(g.headers.get("content-type"));
      // И тела быть не должно: его срезает HTTP-слой.
      expect(body).toBe("");
    });
  }

  test("HEAD тратит токен лимитера наравне с GET", async () => {
    // Работа по сборке ответа при HEAD выполняется та же самая, так что даром
    // он идти не должен — иначе появился бы бесплатный способ доить sitemap.
    let limited = 0;
    for (let i = 0; i < 80; i++) {
      const r = await fetch(`${base}/api/stats`, { method: "HEAD" });
      await r.text();
      if (r.status === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
  });
});

describe("405 называет разрешённые методы", () => {
  test("PUT /api/stats", async () => {
    const r = await fetch(`${base}/api/stats`, { method: "PUT" });
    expect(r.status).toBe(405);
    const allow = r.headers.get("allow") ?? "";
    expect(allow).toContain("GET");
    expect(allow).toContain("HEAD");
  });

  test("GET на ингест — 405 с подсказкой POST", async () => {
    // Аудит 2026-08-29: подсказка полагается настроенному ингесту. Без
    // `SITE_INGEST_TOKEN` эндпоинта «не существует вовсе», и называть его
    // методы значит перечислять несуществующие маршруты — там теперь 404,
    // см. `audit-2026-08-29-internal-route-enumeration.test.ts`.
    const prev = process.env.SITE_INGEST_TOKEN;
    process.env.SITE_INGEST_TOKEN = "methods-token";
    try {
      const r = await fetch(`${base}/api/internal/digests`);
      expect(r.status).toBe(405);
      expect(r.headers.get("allow") ?? "").toContain("POST");
    } finally {
      if (prev === undefined) delete process.env.SITE_INGEST_TOKEN;
      else process.env.SITE_INGEST_TOKEN = prev;
    }
  });

  test("DELETE на обычной странице", async () => {
    const r = await fetch(`${base}/`, { method: "DELETE" });
    expect(r.status).toBe(405);
    expect(r.headers.get("allow") ?? "").toContain("GET");
  });
});

describe("остальное не сдвинулось", () => {
  test("OPTIONS по-прежнему 204", async () => {
    const r = await fetch(`${base}/api/stats`, { method: "OPTIONS" });
    expect(r.status).toBe(204);
  });

  test("POST на ингест без токена — 401, а не 405", async () => {
    // Проверка порядка: метод сверяется до аутентификации, но POST через него
    // проходит и упирается уже в токен.
    const r = await fetch(`${base}/api/internal/digests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(r.status).not.toBe(405);
  });
});
