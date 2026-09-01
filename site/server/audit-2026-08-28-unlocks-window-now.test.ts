/**
 * Аудит 2026-08-28: «в одном месте» — это не то же, что «в один момент».
 *
 * Докблок `unlockWindow` обещает: считаем границы окна в одном месте, чтобы
 * выборка и счётчик не разъехались, иначе кнопка «Показать ещё» либо не
 * появится, либо не кончится никогда. Но место одно, а вызовов два, и каждый
 * брал СВОЁ `new Date()`:
 *
 *   const items = listUpcomingUnlocks(limit, offset, q);   // граница A
 *   const total = countUpcomingUnlocks(q);                 // граница B > A
 *
 * Разблокировка, наступившая между A и B, попадает в список и не попадает в
 * счётчик. Окно микроскопическое, но и событий на границе ровно столько же:
 * запросов к `/api/unlocks` много, а «сейчас» пересекает какую-нибудь дату
 * ежедневно. Ответ при этом самопротиворечив — `total` меньше длины `items`.
 *
 * Правка: момент отсчёта передаётся в запросе. Маршрут берёт `Date.now()` один
 * раз, оба обращения меряют от него.
 */
import { afterEach, beforeEach, describe, expect, test, setSystemTime } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "web3puls-window-now-"));
process.env.SITE_DB_PATH = join(TMP, "window.db");

const { listUpcomingUnlocks, countUpcomingUnlocks, upsertUnlocks, getDb } = await import(
  "./db.ts"
);

/** Момент, в котором мы стоим; событие ставим на 50 мс позже. */
const T0 = Date.parse("2026-08-28T12:00:00.000Z");
const AT = new Date(T0 + 50).toISOString();

beforeEach(() => {
  getDb().run("DELETE FROM unlocks");
  setSystemTime(new Date(T0));
});

afterEach(() => {
  // Без сброса подменённое время течёт в соседние файлы прогона.
  setSystemTime();
});

const seed = () =>
  upsertUnlocks([
    { project: "Edge", symbol: "EDG", date: AT, pctOfSupply: 1, amountUsd: null },
    {
      project: "Later",
      symbol: "LTR",
      date: new Date(T0 + 10 * 86_400_000).toISOString(),
      pctOfSupply: 2,
      amountUsd: null,
    },
  ]);

describe("общая метка времени", () => {
  test("выборка и счётчик не расходятся, даже если между ними прошло время", () => {
    seed();
    const q = { now: T0 };
    const items = listUpcomingUnlocks(50, 0, q);
    // Ровно то, что происходит на живом маршруте между двумя строками.
    setSystemTime(new Date(T0 + 100));
    const total = countUpcomingUnlocks(q);
    expect(total).toBe(items.length);
    expect(total).toBe(2);
  });

  test("окно withinDays тоже отсчитывается от переданного момента", () => {
    seed();
    const q = { now: T0, withinDays: 1 };
    const items = listUpcomingUnlocks(50, 0, q);
    setSystemTime(new Date(T0 + 100));
    expect(countUpcomingUnlocks(q)).toBe(items.length);
    expect(items.map((u) => u.project)).toEqual(["Edge"]);
  });

  test("событие ровно на границе видно обоим одинаково", () => {
    seed();
    const q = { now: T0 + 50 };
    expect(listUpcomingUnlocks(50, 0, q).map((u) => u.project)).toEqual(["Edge", "Later"]);
    expect(countUpcomingUnlocks(q)).toBe(2);
  });

  test("прошедшее событие не возвращается ни тем, ни другим", () => {
    seed();
    const q = { now: T0 + 60 };
    expect(listUpcomingUnlocks(50, 0, q).map((u) => u.project)).toEqual(["Later"]);
    expect(countUpcomingUnlocks(q)).toBe(1);
  });
});

describe("поведение без метки не изменилось", () => {
  test("без now отсчёт идёт от текущего времени", () => {
    seed();
    expect(countUpcomingUnlocks()).toBe(2);
    setSystemTime(new Date(T0 + 60));
    expect(countUpcomingUnlocks()).toBe(1);
    expect(listUpcomingUnlocks(50, 0).map((u) => u.project)).toEqual(["Later"]);
  });

  test("withinDays без now по-прежнему считается от «сейчас»", () => {
    seed();
    expect(listUpcomingUnlocks(50, 0, { withinDays: 1 }).map((u) => u.project)).toEqual([
      "Edge",
    ]);
    expect(countUpcomingUnlocks({ withinDays: 1 })).toBe(1);
  });

  test("desc по-прежнему разворачивает список", () => {
    seed();
    expect(listUpcomingUnlocks(50, 0, { now: T0, desc: true }).map((u) => u.project)).toEqual([
      "Later",
      "Edge",
    ]);
  });
});

describe("маршрут берёт момент один раз", () => {
  test("/api/unlocks кладёт now в общий запрос", () => {
    const src = readFileSync(new URL("./index.ts", import.meta.url).pathname, "utf8");
    const at = src.indexOf('const items = listUpcomingUnlocks(limit, offset, q);');
    expect(at).toBeGreaterThan(0);
    // Объявление `q` — ближайшее выше по тексту.
    const decl = src.lastIndexOf("const q = {", at);
    expect(decl).toBeGreaterThan(0);
    expect(src.slice(decl, at)).toContain("now: Date.now()");
  });
});
