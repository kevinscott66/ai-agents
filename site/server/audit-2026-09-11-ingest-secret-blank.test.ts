/**
 * Аудит 2026-09-11 (круг 15): `SITE_INGEST_TOKEN` из одних пробелов включал
 * мост, и ключом к нему становился пробел.
 *
 * Значение читалось в трёх местах тремя мерками: `!expected ||
 * expected.length === 0` в `tokenMatches`, `!process.env.SITE_INGEST_TOKEN`
 * в `authedJsonBody` и `!!process.env.SITE_INGEST_TOKEN` в 404-гейте
 * `routeApi`. Все три считают `" "` заданным значением. В env-файле такое
 * появляется не от злого умысла, а от описки (`SITE_INGEST_TOKEN= ` с
 * хвостовым пробелом, значение подставлено пустой переменной), и результат
 * — включённый приём публикаций с угадываемым секретом.
 *
 * Мерка теперь одна, `ingestSecret()`. Сам токен не подрезается: подрезка
 * меняла бы то, с чем сверяется запрос. Здесь решается только «задан или нет».
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";

const PREV = process.env.SITE_INGEST_TOKEN;
const { makeFetchHandler, _resetRateLimiter } = await import("./index.ts");
const handle = makeFetchHandler();

function post(token: string | null, ip: string): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-for": ip,
  };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return handle(
    new Request("http://x/api/internal/digests", {
      method: "POST",
      headers,
      body: JSON.stringify({ id: "x", title: "x" }),
    }),
  );
}

afterAll(() => {
  if (PREV === undefined) delete process.env.SITE_INGEST_TOKEN;
  else process.env.SITE_INGEST_TOKEN = PREV;
  _resetRateLimiter();
});

beforeEach(() => _resetRateLimiter());

describe("пробельный секрет — это выключённый мост", () => {
  test("токен из пробелов: 404, а не 401 и не приём", async () => {
    process.env.SITE_INGEST_TOKEN = "   ";
    // Тем же пробелом, что и в env: раньше это была бы удачная авторизация.
    const res = await post("   ", "10.2.0.1");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  test("перевод строки и табуляция — то же самое", async () => {
    for (const [i, v] of ["\n", "\t", " \t\n "].entries()) {
      process.env.SITE_INGEST_TOKEN = v;
      // Сам заголовок шлём обычным: в HTTP-заголовок перевод строки не
      // положишь, а проверяем мы env, не запрос.
      expect((await post("whatever", `10.2.1.${i}`)).status).toBe(404);
    }
  });

  test("переменная не задана вовсе — прежние 404", async () => {
    delete process.env.SITE_INGEST_TOKEN;
    expect((await post("whatever", "10.2.0.2")).status).toBe(404);
  });

  test("настоящий секрет по-прежнему включает мост: чужой токен — 401", async () => {
    process.env.SITE_INGEST_TOKEN = "real-secret-for-this-test-only";
    const res = await post("wrong-token", "10.2.0.3");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  test("секрет с краевыми пробелами не подрезается: сверка идёт как есть", async () => {
    process.env.SITE_INGEST_TOKEN = " padded-secret ";
    // Подрезанный вариант — чужой токен, а не тот же самый.
    expect((await post("padded-secret", "10.2.0.4")).status).toBe(401);
  });
});
