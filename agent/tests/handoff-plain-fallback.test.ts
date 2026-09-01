/**
 * Плейн-фолбэк ответа делегата падал TypeError'ом вместо того, чтобы сработать.
 *
 * `sendWithHtml(send, text, plainFallbackFits?)` третьим аргументом принимает
 * МЕРКУ — `(text: string) => boolean`. В `handoff.ts` туда передавали сам
 * числовой лимит `TELEGRAM_MESSAGE_HARD_LIMIT`. Пока Telegram принимал HTML,
 * этот аргумент не трогали вовсе, поэтому дефект и дожил до аудита. Но ровно на
 * ошибке разметки — то есть в единственный момент, ради которого фолбэк
 * существует, — `sendWithHtml` делает `plainFallbackFits(rawText)`, а `4096`
 * вызвать нельзя: внутри `catch (e)` летит «is not a function», и наружу вместо
 * доставленного plain-текста выходит TypeError.
 *
 * Цена: ответ делегата, у которого разметка не понравилась Telegram, пропадал
 * целиком. Вызывающий видел `{status:"failed"}` — то есть «делегат сломался», —
 * хотя делегат отработал и текст у нас на руках. Тот же ход дальше закрывал
 * строку доски как `failed`.
 *
 * Тесты держат два инварианта: (1) на ошибке разметки уходит plain-текст,
 * (2) слишком длинный plain обрезается, а не роняет вторую 400 «too long».
 */
import { describe, test, expect } from "bun:test";
import { sendWithHtml } from "../lib/telegram-format.ts";
import {
  messagePlainFits,
  TELEGRAM_MESSAGE_HARD_LIMIT,
} from "../lib/telegram-chunking.ts";

/** Та самая 400, которую Telegram отдаёт на сломанной разметке. */
const parseError = () => {
  const e = new Error(
    "400: Bad Request: can't parse entities: Unsupported start tag",
  ) as Error & { description: string };
  e.description = "Bad Request: can't parse entities: Unsupported start tag";
  return e;
};

/** Отправитель, который отвергает HTML и принимает всё остальное. */
function htmlHatingSender() {
  const calls: { text: string; pm?: string }[] = [];
  const send = async (text: string, pm?: "HTML") => {
    calls.push({ text, pm });
    if (pm === "HTML") throw parseError();
    return { message_id: 1 };
  };
  return { send, calls };
}

describe("handoff: плейн-фолбэк ответа делегата", () => {
  test("на ошибке разметки уходит plain-текст, а не TypeError", async () => {
    const { send, calls } = htmlHatingSender();
    // Тот же вызов, что в handoff.ts: короткий ответ делегата со сломанной
    // разметкой. До правки этот await отклонялся с «is not a function».
    await sendWithHtml(send, "ответ <не закрытый тег", messagePlainFits);
    expect(calls.map((c) => c.pm)).toEqual(["HTML", undefined]);
    expect(calls[1]!.text).toBe("ответ <не закрытый тег");
  });

  test("числовой лимит вместо мерки — именно тот дефект, что чинили", async () => {
    // Закрепляем причину, а не только следствие: если кто-то снова передаст
    // сюда число, тест напомнит, чем это кончается в проде.
    const { send } = htmlHatingSender();
    await expect(
      sendWithHtml(
        send,
        "ответ <не закрытый тег",
        TELEGRAM_MESSAGE_HARD_LIMIT as unknown as (t: string) => boolean,
      ),
    ).rejects.toThrow(/not a function/);
  });

  test("слишком длинный plain обрезается, а не роняет вторую 400", async () => {
    // Фолбэк шлёт СЫРОЙ markdown, а он длиннее видимого: ссылка весит целиком.
    // Без мерки обрезки не будет, и на месте ошибки разметки встанет «too long».
    const link = "[тут](https://delabs.space/очень/длинный/путь/для/веса)";
    const raw = link.repeat(120);
    expect(raw.length).toBeGreaterThan(TELEGRAM_MESSAGE_HARD_LIMIT);
    const { send, calls } = htmlHatingSender();
    await sendWithHtml(send, raw, messagePlainFits);
    expect(calls).toHaveLength(2);
    expect(messagePlainFits(calls[1]!.text)).toBe(true);
  });

  test("влезающий plain уходит целиком, без обрезки", async () => {
    const { send, calls } = htmlHatingSender();
    const raw = "к".repeat(TELEGRAM_MESSAGE_HARD_LIMIT);
    await sendWithHtml(send, raw, messagePlainFits);
    expect(calls[1]!.text).toBe(raw);
  });
});

describe("messagePlainFits: мерка одна на все места", () => {
  test("граница ровно по жёсткому лимиту Telegram", () => {
    expect(messagePlainFits("к".repeat(TELEGRAM_MESSAGE_HARD_LIMIT))).toBe(true);
    expect(messagePlainFits("к".repeat(TELEGRAM_MESSAGE_HARD_LIMIT + 1))).toBe(
      false,
    );
  });

  test("меряется СЫРАЯ длина, а не видимая", () => {
    // На плейн-пути Telegram считает символы как есть: markdown-ссылка весит
    // здесь всю себя, и мерить `plainTelegramLength` было бы ошибкой в ту же
    // сторону — «влезает», а Telegram отвечает «too long».
    const raw = `[к](${"u".repeat(TELEGRAM_MESSAGE_HARD_LIMIT)})`;
    expect(messagePlainFits(raw)).toBe(false);
  });
});
