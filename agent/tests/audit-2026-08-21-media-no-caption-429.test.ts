/**
 * Аудит 2026-08-21: 429 выбрасывал уже оплаченную картинку — но только у
 * отправки БЕЗ подписи.
 *
 * `tgSendPhoto`/`tgSendDocument` идут двумя ветками. С подписью — через
 * `sendWithHtml`, а тот внутри обёрнут в `withTelegramRateLimitRetry`
 * (telegram-format.ts). Без подписи вызывался голый `tg.sendPhoto` /
 * `tg.sendDocument`, мимо всякого повтора.
 *
 * Замер до правки (заглушка отдаёт один 429 с retry_after, дальше успех):
 *
 *   фото С подписью     -> ДОСТАВЛЕНО, попыток=2
 *   фото БЕЗ подписи    -> ПОТЕРЯНО (429), попыток=1
 *   документ С подписью -> ДОСТАВЛЕНО, попыток=2
 *   документ БЕЗ подписи-> ПОТЕРЯНО (429), попыток=1
 *
 * Цена ошибки выше, чем у текста: картинка к этому моменту уже сгенерирована
 * через OpenAI image API, то есть оплачена, а 429 — это отказ ДО обработки
 * (`telegram-retry.ts`), повтор безопасен и Telegram сам называет паузу.
 * Вдобавок неудачная попытка съедает слот того же лимита, из-за которого
 * отказ и случился.
 *
 * Тест держит ПАРИТЕТ двух веток, а не число попыток: важно, что наличие
 * подписи не меняет живучесть отправки.
 */
import { describe, test, expect } from "bun:test";
import { tgSendPhoto, tgSendDocument } from "../lib/telegram-actions.ts";

/** Заглушка: первый вызов — 429 с нулевой паузой, дальше успех. */
function limitedOnce() {
  let calls = 0;
  const err = Object.assign(new Error("Too Many Requests: retry after 0"), {
    response: {
      error_code: 429,
      description: "Too Many Requests: retry after 0",
      parameters: { retry_after: 0 },
    },
  });
  const fn = async () => {
    calls += 1;
    if (calls === 1) throw err;
    return { message_id: 777 };
  };
  return { calls: () => calls, tg: { sendPhoto: fn, sendDocument: fn, sendMessage: fn } as never };
}

const PHOTO = { buffer: Buffer.from("x"), filename: "a.png" } as never;

async function delivered(run: () => Promise<{ messageId: number }>): Promise<boolean> {
  try {
    return (await run()).messageId === 777;
  } catch {
    return false;
  }
}

describe("429 не выбрасывает медиа без подписи", () => {
  test("фото без подписи переживает 429", async () => {
    const s = limitedOnce();
    expect(await delivered(() => tgSendPhoto(s.tg, { chatId: 1, photo: PHOTO } as never))).toBe(true);
    expect(s.calls()).toBe(2);
  });

  test("документ без подписи переживает 429", async () => {
    const s = limitedOnce();
    expect(
      await delivered(() =>
        tgSendDocument(s.tg, { chatId: 1, content: "x", filename: "a.txt" } as never),
      ),
    ).toBe(true);
    expect(s.calls()).toBe(2);
  });

  test("паритет: подпись не влияет на живучесть фото", async () => {
    const withCap = limitedOnce();
    const noCap = limitedOnce();
    const a = await delivered(() =>
      tgSendPhoto(withCap.tg, { chatId: 1, photo: PHOTO, caption: "привет" } as never),
    );
    const b = await delivered(() => tgSendPhoto(noCap.tg, { chatId: 1, photo: PHOTO } as never));
    expect({ withCaption: a, withoutCaption: b }).toEqual({ withCaption: true, withoutCaption: true });
  });

  test("паритет: подпись не влияет на живучесть документа", async () => {
    const withCap = limitedOnce();
    const noCap = limitedOnce();
    const a = await delivered(() =>
      tgSendDocument(withCap.tg, { chatId: 1, content: "x", filename: "a.txt", caption: "привет" } as never),
    );
    const b = await delivered(() =>
      tgSendDocument(noCap.tg, { chatId: 1, content: "x", filename: "a.txt" } as never),
    );
    expect({ withCaption: a, withoutCaption: b }).toEqual({ withCaption: true, withoutCaption: true });
  });

  test("не-429 по-прежнему пробрасывается наверх, без повторов", async () => {
    // Граница из telegram-retry.ts: повторяем строго распознанный 429.
    // 400 про сам чат повторять нельзя — это видимый отказ, а не пауза.
    let calls = 0;
    const tg = {
      sendPhoto: async () => {
        calls += 1;
        throw Object.assign(new Error("Bad Request: chat not found"), {
          response: { error_code: 400, description: "Bad Request: chat not found" },
        });
      },
    } as never;
    await expect(tgSendPhoto(tg, { chatId: 1, photo: PHOTO } as never)).rejects.toThrow(
      /chat not found/,
    );
    expect(calls).toBe(1);
  });
});
