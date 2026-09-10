/**
 * Аудит 2026-08-20: `retry_after` от Telegram не читал никто.
 *
 * Единственный клиент в проекте, который уважал 429, — `lib/anthropic-client.ts`.
 * У Telegram при 429 в ответе лежит точное число секунд, и оно уходило в
 * никуда: отправка падала, действие репортилось провалившимся, а повторять ли
 * его — решала модель, иногда через секунду и в тот же самый лимит.
 *
 * Граница осторожная: 429 — отказ ДО обработки, сообщение не доставлено,
 * повтор безопасен. Таймаут (запрос мог дойти, потерялся ответ) и любая другая
 * ошибка повтора по-прежнему НЕ получают — иначе вернулись бы дубли, которые
 * чинил аудит 2026-08-04.
 */
import { describe, test, expect } from "bun:test";
import {
  parseRetryAfterSeconds,
  MIN_RETRY_AFTER_SECONDS,
  isRateLimitError,
  withTelegramRateLimitRetry,
  MAX_RETRY_AFTER_SECONDS,
} from "../lib/telegram-retry.ts";
import { sendWithHtml } from "../lib/telegram-format.ts";

/** Форма telegraf: TelegramError с response.parameters. */
function tgError(seconds: number): Error {
  const e = new Error(`429: Too Many Requests: retry after ${seconds}`) as Error & {
    code: number;
    response: unknown;
  };
  e.code = 429;
  e.response = {
    ok: false,
    error_code: 429,
    description: `Too Many Requests: retry after ${seconds}`,
    parameters: { retry_after: seconds },
  };
  return e;
}

describe("parseRetryAfterSeconds: 429 распознаётся во всех формах telegraf", () => {
  test("response.parameters.retry_after", () => {
    expect(parseRetryAfterSeconds(tgError(12))).toBe(12);
    expect(isRateLimitError(tgError(12))).toBe(true);
  });

  test("плоские parameters", () => {
    expect(
      parseRetryAfterSeconds({ error_code: 429, parameters: { retry_after: 7 } }),
    ).toBe(7);
  });

  test("только описание — секунды берём из текста", () => {
    expect(
      parseRetryAfterSeconds({
        code: 429,
        description: "Too Many Requests: retry after 3",
      }),
    ).toBe(3);
  });

  test("код 429 обязателен: 'retry after' в чужой ошибке не считается", () => {
    // Иначе любая 400 с этими словами в тексте молча превращалась бы в
    // ожидание вместо отказа.
    expect(
      parseRetryAfterSeconds(new Error("Bad Request: please retry after fixing entities")),
    ).toBeUndefined();
    expect(parseRetryAfterSeconds(new Error("ETIMEDOUT"))).toBeUndefined();
    expect(parseRetryAfterSeconds(null)).toBeUndefined();
    expect(parseRetryAfterSeconds("429")).toBeUndefined();
    expect(isRateLimitError(new Error("can't parse entities"))).toBe(false);
  });
});

describe("withTelegramRateLimitRetry: ждём ровно столько, сколько просят", () => {
  test("повтор после сна на retry_after секунд", async () => {
    const slept: number[] = [];
    let calls = 0;
    const out = await withTelegramRateLimitRetry(
      async () => {
        calls++;
        if (calls === 1) throw tgError(5);
        return "ok";
      },
      { sleep: async (ms) => void slept.push(ms) },
    );
    expect(out).toBe("ok");
    expect(calls).toBe(2);
    expect(slept).toEqual([5000]);
  });

  test("не-429 пробрасывается сразу и без сна", async () => {
    const slept: number[] = [];
    let calls = 0;
    const boom = new Error("Bad Request: can't parse entities");
    await expect(
      withTelegramRateLimitRetry(
        async () => {
          calls++;
          throw boom;
        },
        { sleep: async (ms) => void slept.push(ms) },
      ),
    ).rejects.toThrow("can't parse entities");
    expect(calls).toBe(1);
    expect(slept).toEqual([]);
  });

  test("длинная блокировка не держит вызов — ошибка наверх", async () => {
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
    ).rejects.toThrow(/Too Many Requests/);
    expect(calls).toBe(1);
    expect(slept).toEqual([]);
  });

  test("попытки конечны: упорный 429 не висит вечно", async () => {
    const slept: number[] = [];
    let calls = 0;
    await expect(
      withTelegramRateLimitRetry(
        async () => {
          calls++;
          throw tgError(1);
        },
        { sleep: async (ms) => void slept.push(ms), maxAttempts: 3 },
      ),
    ).rejects.toThrow(/Too Many Requests/);
    expect(calls).toBe(3);
    expect(slept).toEqual([1000, 1000]);
  });

  test("успех с первой попытки не спит вовсе", async () => {
    const slept: number[] = [];
    const out = await withTelegramRateLimitRetry(async () => 42, {
      sleep: async (ms) => void slept.push(ms),
    });
    expect(out).toBe(42);
    expect(slept).toEqual([]);
  });
});

describe("sendWithHtml: 429 переживается, остальное поведение прежнее", () => {
  test("сообщение доезжает после 429, а не теряется", async () => {
    let calls = 0;
    const seen: Array<string | undefined> = [];
    const slept: number[] = [];
    // Аудит 2026-09-10: раньше здесь стоял `tgError(0)` с комментарием «сна
    // нет» и БЕЗ подмены сна — тест молча опирался на то, что нулевую паузу
    // ждать не надо. Ноль больше не значит «мгновенно» (MIN_RETRY_AFTER_SECONDS),
    // поэтому сон подменён, а пол проверяется явно ниже.
    const out = await sendWithHtml(
      async (text, pm) => {
        calls++;
        seen.push(pm);
        if (calls === 1) throw tgError(0);
        return { message_id: 7, text };
      },
      "**жирный** текст",
      undefined,
      { sleep: async (ms) => void slept.push(ms) },
    );
    expect(calls).toBe(2);
    expect(slept).toEqual([MIN_RETRY_AFTER_SECONDS * 1000]);
    expect(out.message_id).toBe(7);
    // Повтор идёт тем же путём: HTML, а не деградация в плейн.
    expect(seen).toEqual(["HTML", "HTML"]);
    expect(out.text).toContain("<b>жирный</b>");
  });

  test("плейн-фолбэк на ошибке разметки сохранён", async () => {
    const modes: Array<string | undefined> = [];
    let calls = 0;
    const out = await sendWithHtml(async (text, pm) => {
      modes.push(pm);
      if (++calls === 1) throw new Error("Bad Request: can't parse entities");
      return { message_id: 9, text };
    }, "текст с *разметкой*");
    expect(modes).toEqual(["HTML", undefined]);
    expect(out.message_id).toBe(9);
  });

  test("посторонняя ошибка по-прежнему выходит наружу", async () => {
    await expect(
      sendWithHtml(async () => {
        throw new Error("Forbidden: bot was blocked by the user");
      }, "текст"),
    ).rejects.toThrow(/blocked by the user/);
  });
});
