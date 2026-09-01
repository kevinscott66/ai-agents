/** Distinct client IPs must not turn the in-memory limiter into an OOM path,
 * and the cap itself must not become a denial of service for later visitors. */
import { afterEach, expect, test } from "bun:test";
import {
  _rateLimitOk,
  _rateLimiterSize,
  _resetRateLimiter,
  RATE_LIMIT_MAX_BUCKETS,
} from "./index.ts";

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
