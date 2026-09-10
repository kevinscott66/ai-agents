/**
 * Аудит 2026-09-10: пол ожидания перед повтором 429.
 *
 * `withTelegramRateLimitRetry` спал ровно столько, сколько назвал Telegram, а
 * `parseRetryAfterSeconds` принимает любое `retry_after >= 0` и разбирает
 * текстовую форму `retry after 0`. Ноль означал повтор без паузы — то самое
 * поведение, устранять которое модуль и заведён (см. шапку `sendWithHtml`,
 * telegram-format.ts:459).
 *
 * Здесь закреплено ровно три вещи: ноль поднимается до секунды, названное
 * Telegram число больше секунды не трогается, и пол не влияет на решение
 * «ждать или отдать ошибку наверх» — оно принимается по исходному числу.
 */
import { describe, test, expect } from "bun:test";
import {
  withTelegramRateLimitRetry,
  MIN_RETRY_AFTER_SECONDS,
  MAX_RETRY_AFTER_SECONDS,
} from "../lib/telegram-retry.ts";

function tgError(retryAfter: number): Error {
  const e = new Error("Too Many Requests") as Error & Record<string, unknown>;
  e.code = 429;
  e.parameters = { retry_after: retryAfter };
  return e;
}

/** Прогнать один отказ с заданным retry_after и вернуть, сколько спали. */
async function sleptFor(retryAfter: number): Promise<number[]> {
  const slept: number[] = [];
  let calls = 0;
  const out = await withTelegramRateLimitRetry(
    async () => {
      if (++calls === 1) throw tgError(retryAfter);
      return "ok";
    },
    { sleep: async (ms) => void slept.push(ms) },
  );
  expect(out).toBe("ok");
  expect(calls).toBe(2);
  return slept;
}

describe("429 с retry_after: 0 — повтор не мгновенный", () => {
  test("ноль поднимается до пола, а не спит нисколько", async () => {
    expect(await sleptFor(0)).toEqual([MIN_RETRY_AFTER_SECONDS * 1000]);
  });

  test("дробная просьба меньше секунды тоже поднимается", async () => {
    expect(await sleptFor(0.2)).toEqual([MIN_RETRY_AFTER_SECONDS * 1000]);
  });

  test("названное число больше пола не трогаем", async () => {
    expect(await sleptFor(5)).toEqual([5000]);
  });

  test("пол не удлиняет цепочку повторов: попыток по-прежнему MAX_ATTEMPTS", async () => {
    const slept: number[] = [];
    let calls = 0;
    await expect(
      withTelegramRateLimitRetry(
        async () => {
          calls++;
          throw tgError(0);
        },
        { sleep: async (ms) => void slept.push(ms) },
      ),
    ).rejects.toThrow("Too Many Requests");
    expect(calls).toBe(3);
    expect(slept).toEqual([1000, 1000]);
  });
});

describe("пол не вмешивается в решение «ждать или отдать наверх»", () => {
  test("просьба дольше потолка отдаётся наверх без сна", async () => {
    const slept: number[] = [];
    let calls = 0;
    await expect(
      withTelegramRateLimitRetry(
        async () => {
          calls++;
          throw tgError(MAX_RETRY_AFTER_SECONDS + 1);
        },
        { sleep: async (ms) => void slept.push(ms) },
      ),
    ).rejects.toThrow("Too Many Requests");
    expect(calls).toBe(1);
    expect(slept).toEqual([]);
  });

  test("не-429 по-прежнему пробрасывается сразу", async () => {
    const slept: number[] = [];
    let calls = 0;
    await expect(
      withTelegramRateLimitRetry(
        async () => {
          calls++;
          throw new Error("ETIMEDOUT");
        },
        { sleep: async (ms) => void slept.push(ms) },
      ),
    ).rejects.toThrow("ETIMEDOUT");
    expect(calls).toBe(1);
    expect(slept).toEqual([]);
  });
});
