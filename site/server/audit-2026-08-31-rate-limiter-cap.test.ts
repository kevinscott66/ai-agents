/** Distinct client IPs must not turn the in-memory limiter into an OOM path,
 * and the cap itself must not become a denial of service for later visitors. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  _rateLimitOk,
  _rateLimiterSize,
  _resetRateLimiter,
  RATE_LIMIT_MAX_BUCKETS,
} from "./index.ts";

/**
 * Чистка симметричная: и до, и после.
 *
 * P5 (гонка тестов сайта, 2026-09-10): ведро лимитера — состояние процесса, и
 * соседние файлы (тот же `audit-2026-08-20-activity-shell`) шлют десятки
 * запросов, оставляя в карте свои ключи. Тест ниже добивает её ровно до
 * `RATE_LIMIT_MAX_BUCKETS` своими — но с чужим хвостом порог переходится
 * ВНУТРИ цикла, срабатывает вытеснение холодных (10 % = 5000), и вместо
 * 50 000 в карте остаётся 45 001. Чистить только за собой мало: убирать надо и
 * то, что осталось от предыдущего файла.
 */
beforeEach(() => _resetRateLimiter());
afterEach(() => _resetRateLimiter());

test("a flood of unique keys is bounded without evicting live clients", () => {
  for (let i = 0; i < RATE_LIMIT_MAX_BUCKETS; i++) {
    expect(_rateLimitOk(`ip:2001:db8::${i}`)).toBe(true);
  }
  expect(_rateLimiterSize()).toBe(RATE_LIMIT_MAX_BUCKETS);

  // Живой клиент: обращался последним, значит `last` у него самый свежий.
  const live = "ip:2001:db8::0";
  expect(_rateLimitOk(live)).toBe(true);
  const liveSize = _rateLimiterSize();

  // Новый посетитель приходит в полную карту — и всё равно обслуживается.
  expect(_rateLimitOk("ip:2001:db8::overflow")).toBe(true);
  expect(_rateLimiterSize()).toBeLessThanOrEqual(liveSize);

  // Вытеснили холодные вёдра, а не активного клиента — он всё ещё обслужен.
  expect(_rateLimitOk(live)).toBe(true);
});
