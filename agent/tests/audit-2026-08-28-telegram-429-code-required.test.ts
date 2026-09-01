/**
 * Аудит 2026-08-28: 429 определялся по словам в чужом тексте.
 *
 * Докстрока `parseRetryAfterSeconds` обещает прямым текстом: «код 429 требуем
 * обязательно: без него "retry after" в тексте могло бы прилететь из чужого
 * сообщения об ошибке и превратить обычный отказ в молчаливое ожидание». Код
 * же делал `code === 429 || /too many requests/i.test(desc)` — то есть кода не
 * требовал вовсе, текста хватало.
 *
 * Тест 2026-08-20 «код 429 обязателен» эту ветку не трогал: он проверял строку
 * без слов «too many requests», на которой условие ложно по любой версии.
 *
 * Чем это плохо именно здесь: весь довод модуля в пользу повтора — «429 это
 * отказ ДО обработки, сообщение не доставлено». Промежуточный прокси (nginx,
 * Cloudflare) отдаёт 5xx со страницей, где есть и «Too Many Requests», и
 * «retry after N», — а такой запрос до Telegram дойти мог. Повтор по нему
 * доставляет второй экземпляр сообщения в канал, ровно то, от чего докстрока
 * `sendWithHtml` отговаривает.
 */
import { describe, expect, test } from "bun:test";
import {
  isRateLimitError,
  parseRetryAfterSeconds,
  withTelegramRateLimitRetry,
} from "../lib/telegram-retry.ts";

describe("явный не-429 код важнее слов в описании", () => {
  test("5xx со страницы прокси не считается лимитом", () => {
    const err = { code: 503, description: "Too Many Requests: retry after 30" };
    expect(parseRetryAfterSeconds(err)).toBeUndefined();
    expect(isRateLimitError(err)).toBe(false);
  });

  test("не-429 код не спасает даже настоящий parameters.retry_after", () => {
    expect(
      parseRetryAfterSeconds({
        error_code: 400,
        description: "Too Many Requests",
        parameters: { retry_after: 5 },
      }),
    ).toBeUndefined();
  });

  test("код из вложенного response тоже перевешивает текст", () => {
    expect(
      parseRetryAfterSeconds({
        response: { error_code: 502, description: "Too Many Requests: retry after 9" },
      }),
    ).toBeUndefined();
  });

  test("повтора по такой ошибке нет: вызов один, ошибка уходит наверх", async () => {
    let calls = 0;
    const err = { code: 503, description: "Too Many Requests: retry after 1" };
    await expect(
      withTelegramRateLimitRetry(
        async () => {
          calls++;
          throw err;
        },
        { sleep: async () => {}, label: "test" },
      ),
    ).rejects.toBe(err);
    expect(calls).toBe(1);
  });
});

describe("самая бедная форма по-прежнему распознаётся", () => {
  test("кода нет вовсе — секунды берём из текста", () => {
    expect(parseRetryAfterSeconds(new Error("Too Many Requests: retry after 4"))).toBe(4);
    expect(
      parseRetryAfterSeconds({ description: "Too Many Requests: retry after 11" }),
    ).toBe(11);
  });
});

describe("настоящий 429 не сломан", () => {
  test("код 429 плюс текст", () => {
    expect(parseRetryAfterSeconds({ code: 429, description: "Too Many Requests: retry after 3" })).toBe(3);
  });

  test("код 429 плюс parameters во вложенном response", () => {
    expect(
      parseRetryAfterSeconds({
        response: { error_code: 429, parameters: { retry_after: 8 } },
      }),
    ).toBe(8);
  });

  test("код 429 плоским error_code", () => {
    expect(parseRetryAfterSeconds({ error_code: 429, parameters: { retry_after: 7 } })).toBe(7);
  });
});
