/**
 * Аудит 2026-08-28: частичный снимок фида молча стирал календарь.
 *
 * Докблок `refreshUnlocks` обещает «leaves existing rows intact on failure»,
 * но единственной защитой был `parsed.length === 0`. Любой ненулевой, но
 * деградировавший разбор проходил дальше, а `replaceUpcomingUnlocks` сносит
 * ВСЕ будущие строки одним `DELETE FROM unlocks WHERE date >= ?`.
 *
 * Сценарий: апстрим отдал усечённый JSON или переименовал поле, которое режет
 * часть проектов на проверке `maxSupply` — из четырёхсот разобралось три.
 * Календарь на публичном сайте схлопывается с 400 строк до 3. Хуже того,
 * следом выставлялся маркер свежести, то есть `cacheFresh()` сутки отвечал
 * «свежо» и часовой цикл даже не пытался починить.
 *
 * Правка: снимок меньше половины текущего календаря считается
 * деградировавшим, а не уменьшившимся, — строки остаются, маркер не
 * выставляется, следующий тик пробует снова. Чтобы охрана не заморозила
 * календарь навсегда при настоящем сжатии фида, у неё есть срок: данные
 * старше COLLAPSE_OVERRIDE_MS хуже маленького, но свежего снимка.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "web3puls-collapse-"));
process.env.SITE_DB_PATH = join(TMP, "collapse.db");

const { countUpcomingUnlocks, getMeta, setMeta, getDb } = await import("./db.ts");
const { refreshUnlocks, MIN_SNAPSHOT_RATIO, COLLAPSE_OVERRIDE_MS } = await import(
  "./unlocks.ts"
);

const CACHE_KEY = "unlocks_fetched_at";
const HOUR = 3_600_000;
const realFetch = globalThis.fetch;

/** Снимок фида из `n` проектов: у каждого одно будущее событие. */
function feed(n: number): unknown {
  const future = Date.now() / 1000 + 30 * 86_400;
  return {
    data: Array.from({ length: n }, (_, i) => ({
      name: `Proj${i}`,
      token: `coingecko:proj-${i}`,
      maxSupply: 1_000_000,
      events: [{ timestamp: future + i * 60, noOfTokens: [10_000] }],
    })),
  };
}

/** Подменяем сеть: EMISSIONS_URL наружу не набирается ни разу. */
function serve(payload: unknown): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(payload), {
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

/** Сколько времени назад «приехал» текущий снимок. */
function ageCacheBy(ms: number): void {
  setMeta(CACHE_KEY, String(Date.now() - ms));
}

beforeEach(async () => {
  getDb().query("DELETE FROM unlocks").run();
  setMeta(CACHE_KEY, "");
  serve(feed(40));
  await refreshUnlocks(true);
  expect(countUpcomingUnlocks()).toBe(40);
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("схлопнувшийся снимок", () => {
  test("три проекта вместо сорока не стирают календарь", async () => {
    ageCacheBy(25 * HOUR);
    serve(feed(3));
    const written = await refreshUnlocks(false);
    expect(written).toBe(0);
    expect(countUpcomingUnlocks()).toBe(40);
  });

  test("маркер свежести не выставляется — следующий тик попробует снова", async () => {
    ageCacheBy(25 * HOUR);
    const before = getMeta(CACHE_KEY);
    serve(feed(3));
    await refreshUnlocks(false);
    expect(getMeta(CACHE_KEY)).toBe(before);
  });

  test("отказ повторяем: второй тик тоже не стирает", async () => {
    ageCacheBy(25 * HOUR);
    serve(feed(3));
    await refreshUnlocks(false);
    await refreshUnlocks(false);
    expect(countUpcomingUnlocks()).toBe(40);
  });
});

describe("нормальные снимки проходят", () => {
  test("небольшая усадка — это данные, а не поломка", async () => {
    ageCacheBy(25 * HOUR);
    serve(feed(35));
    expect(await refreshUnlocks(false)).toBe(35);
    expect(countUpcomingUnlocks()).toBe(35);
  });

  test("ровно на границе доли снимок принимается", async () => {
    ageCacheBy(25 * HOUR);
    const edge = Math.ceil(40 * MIN_SNAPSHOT_RATIO);
    serve(feed(edge));
    expect(await refreshUnlocks(false)).toBe(edge);
  });

  test("рост календаря охрану не задевает", async () => {
    ageCacheBy(25 * HOUR);
    serve(feed(90));
    expect(await refreshUnlocks(false)).toBe(90);
  });

  test("пустой календарь принимает снимок любого размера", async () => {
    getDb().query("DELETE FROM unlocks").run();
    ageCacheBy(25 * HOUR);
    serve(feed(2));
    expect(await refreshUnlocks(false)).toBe(2);
  });
});

describe("границы охраны", () => {
  test("force обходит охрану — это ручное решение владельца", async () => {
    serve(feed(3));
    expect(await refreshUnlocks(true)).toBe(3);
    expect(countUpcomingUnlocks()).toBe(3);
  });

  test("данные старше срока охраны: маленький снимок лучше древнего", async () => {
    ageCacheBy(COLLAPSE_OVERRIDE_MS + HOUR);
    serve(feed(3));
    expect(await refreshUnlocks(false)).toBe(3);
    expect(countUpcomingUnlocks()).toBe(3);
  });

  test("отметки о загрузке нет вовсе — считаем данные несвежими и принимаем", async () => {
    setMeta(CACHE_KEY, "");
    serve(feed(3));
    expect(await refreshUnlocks(false)).toBe(3);
  });
});

describe("прежнее поведение сохранено", () => {
  test("пустой разбор по-прежнему ничего не трогает", async () => {
    ageCacheBy(25 * HOUR);
    serve({ data: [] });
    expect(await refreshUnlocks(false)).toBe(0);
    expect(countUpcomingUnlocks()).toBe(40);
  });
});
