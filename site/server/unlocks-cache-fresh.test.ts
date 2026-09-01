/**
 * Аудит 2026-08-20: у свежести кэша не было нижней границы.
 *
 * `Date.now() - ms < TTL_MS` истинно и для отметки из БУДУЩЕГО. Скачок часов на
 * VPS вперёд (плохой NTP, ручная установка) — и метка, записанная в тот момент,
 * держит кэш «свежим», пока настоящее время её не догонит: календарь замирает
 * на дни, часовой цикл выходит нулём сразу, в логах при этом тихо.
 *
 * Проверяем саму cacheFresh, а не refreshUnlocks: у второй за «протухло» стоит
 * поход в сеть, а тесты в сеть не ходят.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "web3puls-cachefresh-"));
process.env.SITE_DB_PATH = join(TMP, "cache.db");

const { getDb, setMeta } = await import("./db.ts");
const { cacheFresh } = await import("./unlocks.ts");

const HOUR = 3600_000;

beforeEach(() => {
  getDb();
});

describe("cacheFresh", () => {
  test("отметки нет — не свежо", () => {
    expect(cacheFresh()).toBe(false);
  });

  test("минуту назад — свежо", () => {
    setMeta("unlocks_fetched_at", String(Date.now() - 60_000));
    expect(cacheFresh()).toBe(true);
  });

  test("сутки назад — протухло", () => {
    setMeta("unlocks_fetched_at", String(Date.now() - 24 * HOUR));
    expect(cacheFresh()).toBe(false);
  });

  test("отметка из будущего — протухло, а не свежо навсегда", () => {
    setMeta("unlocks_fetched_at", String(Date.now() + 48 * HOUR));
    expect(cacheFresh()).toBe(false);
  });

  test("мусор вместо числа — не свежо", () => {
    setMeta("unlocks_fetched_at", "позавчера");
    expect(cacheFresh()).toBe(false);
  });
});
