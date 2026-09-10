/**
 * Аудит 2026-09-10: 405 на неверный метод оставался бесплатным везде, кроме
 * веток внутреннего ингеста.
 *
 * Аудит 2026-08-29 нашёл ровно эту дыру и закрыл её — но только для
 * `/api/internal/*`. Соседняя ветка той же функции (`routeApi`, общий гейт
 * метода) и ветка не-API путей сохранили прежний порядок: сначала ответить,
 * потом — уже некому — считать. То есть `POST /api/health` и `POST /что-угодно`
 * отвечали 405 сколько угодно раз подряд, не тронув ведро.
 *
 * Цена не в стоимости самого ответа — 405 не ходит ни в БД, ни на диск, — а в
 * том, что канал проб не учитывается вовсе: у адреса, отстучавшего тысячу
 * таких запросов, честные 60 чтений в минуту оставались нетронутыми, и в
 * счётчиках он выглядел молчащим.
 *
 * Preflight (OPTIONS) по-прежнему вне лимита — это решение, а не недосмотр,
 * закреплено тестом от 2026-08-29 и повторено здесь для не-API путей.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "web3puls-405-probe-"));
process.env.SITE_DB_PATH = join(TMP, "probe.db");

const { makeFetchHandler, _resetRateLimiter } = await import("./index.ts");

let server: ReturnType<typeof Bun.serve>;
let base: string;
let prevLoopbackCap: string | undefined;

/** Ёмкость ведра по умолчанию (RL_CAPACITY в index.ts). */
const CAPACITY = 60;

beforeAll(() => {
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

async function burst(n: number, send: () => Promise<Response>): Promise<number[]> {
  const codes: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = await send();
    codes.push(r.status);
    await r.text();
  }
  return codes;
}

describe("405 под /api/ считается ведром", () => {
  test("POST /api/health: сначала 405, потом 429", async () => {
    const codes = await burst(CAPACITY + 10, () =>
      fetch(`${base}/api/health`, { method: "POST" }),
    );
    expect(codes.slice(0, CAPACITY).every((c) => c === 405)).toBe(true);
    // Ведро подтекает, поэтому точную границу не фиксируем — важно, что за
    // пределом ёмкости появляется отказ, а раньше его не было ни одного.
    expect(codes.slice(CAPACITY).some((c) => c === 429)).toBe(true);
  });

  test("исчерпав ведро отказами, тот же адрес не читает и по GET", async () => {
    await burst(CAPACITY + 5, () => fetch(`${base}/api/health`, { method: "DELETE" }));
    const r = await fetch(`${base}/api/health`);
    await r.text();
    expect(r.status).toBe(429);
  });

  test("405 не съедает 429: ответ на переполнении — именно про лимит", async () => {
    const codes = await burst(CAPACITY + 10, () =>
      fetch(`${base}/api/stats`, { method: "PUT" }),
    );
    expect(codes.includes(429)).toBe(true);
  });

  test("штатное чтение по-прежнему проходит и остаётся 200", async () => {
    const r = await fetch(`${base}/api/health`);
    expect(r.status).toBe(200);
    await r.text();
  });
});

describe("405 на не-API пути считается ведром", () => {
  test("POST по произвольному пути упирается в лимит", async () => {
    const codes = await burst(CAPACITY + 10, () =>
      fetch(`${base}/какой-угодно-путь`, { method: "POST" }),
    );
    expect(codes.slice(0, CAPACITY).every((c) => c === 405)).toBe(true);
    expect(codes.slice(CAPACITY).some((c) => c === 429)).toBe(true);
  });

  test("двойного списания на /rss.xml нет: ведро уже посчитало путь выше", async () => {
    // POST /rss.xml проходит через `rateLimitedNonApi` (там токен уже снят) и
    // только потом попадает в общий 405. Если бы 405 списывал второй раз,
    // ёмкости хватило бы вдвое меньше, чем на произвольном пути.
    const codes = await burst(CAPACITY - 2, () =>
      fetch(`${base}/rss.xml`, { method: "POST" }),
    );
    expect(codes.every((c) => c === 405)).toBe(true);
  });

  test("OPTIONS вне /api/ — такой же платный 405, и это граница намеренная", async () => {
    // Освобождение preflight'а от лимита обосновано тем, что OPTIONS — это
    // приставка к запросу, который ведро и так посчитает (routeApi, аудит
    // 2026-08-29). Вне /api/ такого запроса не будет: сам OPTIONS отвечает
    // здесь 405, то есть preflight и так не проходит. Бесплатный OPTIONS
    // означал бы ровно ту же дыру бесплатных проб, только под другим методом.
    const codes = await burst(CAPACITY + 10, () =>
      fetch(`${base}/какой-угодно-путь`, { method: "OPTIONS" }),
    );
    expect(codes.slice(0, CAPACITY).every((c) => c === 405)).toBe(true);
    expect(codes.slice(CAPACITY).some((c) => c === 429)).toBe(true);
  });
});
