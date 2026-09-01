/**
 * Аудит 2026-08-21: повтор по 429 достался только отправке текста.
 *
 * Аудит 2026-08-20 завёл `withTelegramRateLimitRetry` (lib/telegram-retry.ts) и
 * подключил его в ОДНОМ месте — внутри `sendWithHtml`. Через него ходят
 * SEND_MESSAGE и EDIT_MESSAGE, и только они. Все остальные вызовы Bot API в
 * lib/telegram-actions.ts дёргают telegraf напрямую, то есть 429 для них
 * по-прежнему «действие провалилось».
 *
 * Замер на заглушке, отдающей один 429 с `retry_after: 0`, дальше успех:
 *
 *   tgSendMessage    доставлено,  попыток 2
 *   tgCreatePoll     ПОТЕРЯНО,    попыток 1
 *   tgPinMessage     ПОТЕРЯНО,    попыток 1
 *   tgDeleteMessage  ПОТЕРЯНО,    попыток 1
 *   tgForwardMessage ПОТЕРЯНО,    попыток 1
 *   tgSetReaction    ПОТЕРЯНО,    попыток 1
 *
 * Разница видна не в том, что вызов упал, а в том, ЧТО происходит дальше:
 * отказ уходит модели, и повторять его решает она — иногда через секунду, то
 * есть в тот же самый лимит. Telegram при этом прислал точное число секунд.
 *
 * Правило после фикса простое и без исключений: каждый одиночный вызов Bot API
 * в этом модуле идёт через повтор по 429. Именно исключения и были дефектом.
 *
 * Границу аудита 2026-08-20 не двигаем: повтор строго и только на распознанном
 * 429 (отказ ДО обработки, сообщение не создано). Таймаут и любая другая
 * ошибка летят наверх с первой попытки — иначе вернулись бы дубли, которые
 * чинил аудит 2026-08-04.
 *
 * Ветки sendPhoto/sendDocument без подписи — тот же разрыв, но их чинит
 * отдельный PR #577, здесь они намеренно не тронуты.
 */
import { describe, test, expect } from "bun:test";
import type { Telegram } from "telegraf";
import {
  tgCreatePoll,
  tgPinMessage,
  tgDeleteMessage,
  tgForwardMessage,
  tgSetReaction,
} from "../lib/telegram-actions.ts";

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

interface Case {
  name: string;
  /** Имя метода telegraf, который дёргает обёртка. */
  method: string;
  /** Что метод возвращает при успехе. */
  ok: unknown;
  run: (tg: Telegram) => Promise<unknown>;
  /** Ожидаемый результат обёртки после удачного повтора. */
  expected: unknown;
}

const CASES: Case[] = [
  {
    name: "tgCreatePoll",
    method: "sendPoll",
    ok: { message_id: 11 },
    run: (tg) => tgCreatePoll(tg, { chatId: 1, question: "q", options: ["a", "b"] }),
    expected: { ok: true, messageId: 11 },
  },
  {
    name: "tgPinMessage",
    method: "pinChatMessage",
    ok: true,
    run: (tg) => tgPinMessage(tg, { chatId: 1, messageId: 2 }),
    expected: { ok: true },
  },
  {
    name: "tgDeleteMessage",
    method: "deleteMessage",
    ok: true,
    run: (tg) => tgDeleteMessage(tg, { chatId: 1, messageId: 2 }),
    expected: { ok: true },
  },
  {
    name: "tgForwardMessage",
    method: "forwardMessage",
    ok: { message_id: 12 },
    run: (tg) => tgForwardMessage(tg, { chatId: 1, fromChatId: 2, messageId: 3 }),
    expected: { ok: true, messageId: 12 },
  },
  {
    name: "tgSetReaction",
    method: "callApi",
    ok: true,
    run: (tg) => tgSetReaction(tg, { chatId: 1, messageId: 2, emoji: "\u{1F44D}" }),
    expected: { ok: true },
  },
];

/**
 * Заглушка одного метода telegraf: первые `failures` вызовов бросают `err`,
 * дальше отдают `ok`. `retry_after: 0` — чтобы тест не спал по-настоящему.
 */
function stub(method: string, ok: unknown, err: unknown, failures: number) {
  const state = { calls: 0 };
  const tg = {
    [method]: (..._a: unknown[]) => {
      state.calls += 1;
      if (state.calls <= failures) return Promise.reject(err);
      return Promise.resolve(ok);
    },
  } as unknown as Telegram;
  return { tg, state };
}

describe("одиночные вызовы Bot API переживают 429", () => {
  for (const c of CASES) {
    test(`${c.name}: 429 с retry_after — повтор, а не потеря`, async () => {
      const { tg, state } = stub(c.method, c.ok, tgError(0), 1);
      expect(await c.run(tg)).toEqual(c.expected);
      expect(state.calls).toBe(2);
    });
  }
});

describe("граница повтора не расширена", () => {
  for (const c of CASES) {
    test(`${c.name}: не-429 летит наверх с первой попытки`, async () => {
      // Таймаут значит «запрос мог дойти, потерялся ответ» — повтор дал бы
      // второй экземпляр. Повторяем только то, про что Telegram сам сказал
      // «не принято».
      const boom = new Error("ETIMEDOUT");
      const { tg, state } = stub(c.method, c.ok, boom, 1);
      await expect(c.run(tg)).rejects.toThrow("ETIMEDOUT");
      expect(state.calls).toBe(1);
    });
  }

  test("429 с ожиданием дольше минуты — это блокировка, а не пауза", async () => {
    // Держать действие в воздухе час нельзя: отдаём ошибку наверх, там она
    // станет видимым отказом (MAX_RETRY_AFTER_SECONDS в telegram-retry.ts).
    const { tg, state } = stub("sendPoll", { message_id: 11 }, tgError(3600), 1);
    await expect(
      tgCreatePoll(tg, { chatId: 1, question: "q", options: ["a", "b"] }),
    ).rejects.toThrow(/429/);
    expect(state.calls).toBe(1);
  });
});
