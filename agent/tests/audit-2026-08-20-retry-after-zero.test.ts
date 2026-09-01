/**
 * Аудит 2026-08-20 — `retry-after: 0` выключал защиту от 429.
 *
 * `parseRetryAfterMs` пропускал ноль (`n >= 0`) и отдавал 0 мс. В 429-ветке
 * `callAnthropic` это даёт два эффекта разом: `waitMs = 0 + jitter()` — меньше
 * 200 мс — и `ra !== undefined`, из-за чего `backoff429` не удваивается. Шесть
 * попыток укладываются в секунду и упираются в тот же лимит; ход падает.
 *
 * Ноль от сервера, который только что отказал по лимиту, информации не несёт —
 * значит это «заголовка нет», и работает собственный экспоненциальный отступ.
 */
import { describe, expect, it } from "bun:test";
import {
  parseRetryAfterMs,
  MAX_RETRY_AFTER_MS,
  MIN_RETRY_AFTER_MS,
} from "../lib/anthropic-client.ts";

describe("parseRetryAfterMs — бесполезные значения = заголовка нет", () => {
  it("retry-after: 0 не выдаётся за указание сервера", () => {
    expect(parseRetryAfterMs({ headers: { "retry-after": "0" } })).toBeUndefined();
  });

  it("доли секунды — тоже ноль по смыслу", () => {
    expect(parseRetryAfterMs({ headers: { "retry-after": "0.4" } })).toBeUndefined();
  });

  it("ровно секунда уже указание", () => {
    expect(parseRetryAfterMs({ headers: { "retry-after": "1" } })).toBe(MIN_RETRY_AFTER_MS);
  });

  it("обычное значение проходит как раньше", () => {
    expect(parseRetryAfterMs({ headers: { "retry-after": "30" } })).toBe(30_000);
  });

  it("потолок на месте", () => {
    expect(parseRetryAfterMs({ headers: { "retry-after": "86400" } })).toBe(MAX_RETRY_AFTER_MS);
  });

  it("мусор и отрицательное — undefined", () => {
    expect(parseRetryAfterMs({ headers: { "retry-after": "soon" } })).toBeUndefined();
    expect(parseRetryAfterMs({ headers: { "retry-after": "-5" } })).toBeUndefined();
    expect(parseRetryAfterMs({})).toBeUndefined();
  });

  it("HTTP-date в прошлом или на полсекунды вперёд — undefined", () => {
    const past = new Date(Date.now() - 5_000).toUTCString();
    expect(parseRetryAfterMs({ headers: { "retry-after": past } })).toBeUndefined();
    const almostNow = new Date(Date.now() + 400).toUTCString();
    expect(parseRetryAfterMs({ headers: { "retry-after": almostNow } })).toBeUndefined();
  });

  it("HTTP-date в будущем считается", () => {
    const soon = new Date(Date.now() + 20_000).toUTCString();
    const ms = parseRetryAfterMs({ headers: { "retry-after": soon } });
    expect(ms).toBeGreaterThanOrEqual(MIN_RETRY_AFTER_MS);
    expect(ms!).toBeLessThanOrEqual(20_000);
  });
});

describe("readHeader — регистр заголовка", () => {
  it("простой объект с капитализацией находится", () => {
    expect(parseRetryAfterMs({ headers: { "Retry-After": "30" } as any })).toBe(30_000);
  });

  it("вложенный response.headers тоже", () => {
    expect(
      parseRetryAfterMs({ response: { headers: { "RETRY-AFTER": "12" } as any } }),
    ).toBe(12_000);
  });

  it("Headers-подобный объект с .get работает как раньше", () => {
    const h = { get: (k: string) => (k === "retry-after" ? "7" : null) };
    expect(parseRetryAfterMs({ headers: h as any })).toBe(7_000);
  });

  it("верхний заголовок важнее вложенного", () => {
    expect(
      parseRetryAfterMs({
        headers: { "retry-after": "5" },
        response: { headers: { "retry-after": "50" } as any },
      }),
    ).toBe(5_000);
  });

  it("чужие ключи не подхватываются", () => {
    expect(parseRetryAfterMs({ headers: { "x-retry-after-ms": "9000" } as any })).toBeUndefined();
  });
});
