/**
 * Аудит 2026-08-28: «обновлено» публиковало будущее и падало на мусоре.
 *
 * `cacheFresh()` с 2026-08-20 явно отвергает метку из БУДУЩЕГО — скакнули часы
 * на VPS, и она держала бы кэш свежим, пока настоящее время её не догонит.
 * `lastUnlocksRefreshIso()` читает ту же метку и такой границы не имела: тот же
 * скачок публиковал «обновлено 3 января 2027 г.» в `/api/stats.updatedAt` и
 * `/api/unlocks.updatedAt`. Две функции над одним значением расходились в том,
 * что считают правдоподобным.
 *
 * И `Number.isFinite` — не тот фильтр: `1e300` конечен, но
 * `new Date(1e300).toISOString()` бросает RangeError. Диапазон Date — ±8.64e15.
 * Бросок из геттера превращался в 500 на обоих эндпоинтах (его ловит handleApi),
 * то есть одна кривая строка в meta роняла и статистику, и календарь целиком.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "web3puls-updatedat-"));
process.env.SITE_DB_PATH = join(TMP, "updated-at.db");

const { getMeta, setMeta } = await import("./db.ts");
const { lastUnlocksRefreshIso, cacheFresh } = await import("./unlocks.ts");

const KEY = "unlocks_fetched_at";
const HOUR = 3_600_000;

afterEach(() => setMeta(KEY, ""));

describe("метка из будущего", () => {
  test("час вперёд — даты нет, а не даты из будущего", () => {
    setMeta(KEY, String(Date.now() + HOUR));
    expect(lastUnlocksRefreshIso()).toBeNull();
  });

  test("год вперёд — тоже нет", () => {
    setMeta(KEY, String(Date.now() + 365 * 24 * HOUR));
    expect(lastUnlocksRefreshIso()).toBeNull();
  });

  test("та же метка одинаково не устраивает обе функции", () => {
    // Раньше cacheFresh её отвергала, а lastUnlocksRefreshIso публиковала.
    setMeta(KEY, String(Date.now() + HOUR));
    expect(cacheFresh()).toBe(false);
    expect(lastUnlocksRefreshIso()).toBeNull();
  });
});

describe("значение вне диапазона Date", () => {
  test("1e300 конечен, но датой не становится — null вместо RangeError", () => {
    setMeta(KEY, "1e300");
    expect(() => lastUnlocksRefreshIso()).not.toThrow();
    expect(lastUnlocksRefreshIso()).toBeNull();
  });

  test("предел диапазона и шаг за него", () => {
    setMeta(KEY, "-8.64e15");
    expect(lastUnlocksRefreshIso()).toBe(new Date(-8.64e15).toISOString());
    setMeta(KEY, "-8.64e16");
    expect(lastUnlocksRefreshIso()).toBeNull();
  });
});

describe("нормальные значения не задеты", () => {
  test("свежая метка отдаётся как ISO", () => {
    const at = Date.now() - HOUR;
    setMeta(KEY, String(at));
    expect(lastUnlocksRefreshIso()).toBe(new Date(at).toISOString());
  });

  test("старая метка отдаётся тоже — «давно» это не «никогда»", () => {
    const at = Date.now() - 400 * 24 * HOUR;
    setMeta(KEY, String(at));
    expect(lastUnlocksRefreshIso()).toBe(new Date(at).toISOString());
    expect(cacheFresh()).toBe(false);
  });

  test("метки нет вовсе — null", () => {
    expect(getMeta(KEY)).toBeFalsy();
    expect(lastUnlocksRefreshIso()).toBeNull();
  });

  test("не число — null", () => {
    setMeta(KEY, "позавчера");
    expect(lastUnlocksRefreshIso()).toBeNull();
  });
});
