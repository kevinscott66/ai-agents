/**
 * Аудит 2026-08-13: обрыв хвоста подписи докладывался как успех.
 *
 * `sendCaptionTail` шлёт части хвоста ответами на медиа и на ПЕРВОЙ же неудаче
 * делает `break` — остаток текста не доходит. Наверх при этом ехало одно число
 * без знаменателя: `captionTailParts: 1`. Отличить «1 из 1» от «1 из 7»
 * невозможно, а действие остаётся `ok: true`, потому что медиа в чате уже есть
 * (объявлять неудачу нельзя — модель перегенерирует картинку за $0.04, и слот
 * часового лимита за неё не возвращается, см. NO_REFUND_ACTIONS).
 *
 * Итог на проде: пост обрывается посреди списка, в результате действия
 * положительное число, повода дослать остаток у модели нет — она идёт дальше.
 *
 * Инвариант: если хвост доехал не весь, это видно БЕЗ арифметики.
 *
 * Стало заметнее после плейн-фолбэка подписи (та же серия аудита): в режиме
 * деградации через этот путь идёт ещё и голова, то есть частей больше.
 */
import { test, expect, describe } from "bun:test";
import { tgSendPhoto, tgSendDocument } from "../lib/telegram-actions.ts";

/**
 * Телеграм-заглушка. `failMessageAt` — номер вызова sendMessage (1-based),
 * начиная с которого он падает; остальные проходят.
 */
function fakeTg(opts: { failMessageAt?: number } = {}) {
  const calls: Array<{ api: string; text: string }> = [];
  let nextId = 100;
  let msgN = 0;
  const capGuard = (caption: unknown, api: string) => {
    const c = typeof caption === "string" ? caption : "";
    if (c.length > 1024) {
      const err: any = new Error("400: MEDIA_CAPTION_TOO_LONG");
      err.response = { error_code: 400, description: "MEDIA_CAPTION_TOO_LONG" };
      throw err;
    }
    calls.push({ api, text: c });
  };
  return {
    calls,
    async sendPhoto(_chatId: number, _photo: unknown, extra: any) {
      capGuard(extra?.caption, "sendPhoto");
      return { message_id: nextId++ };
    },
    async sendDocument(_chatId: number, _doc: unknown, extra: any) {
      capGuard(extra?.caption, "sendDocument");
      return { message_id: nextId++ };
    },
    async sendMessage(_chatId: number, text: string) {
      msgN++;
      if (opts.failMessageAt !== undefined && msgN >= opts.failMessageAt) {
        throw new Error("network");
      }
      calls.push({ api: "sendMessage", text });
      return { message_id: nextId++ };
    },
  } as any;
}

/** Длинная подпись, гарантированно дающая много частей хвоста. */
const LONG = "абзац ".repeat(1200); // 7200 символов при лимите 1000

const PHOTO = { url: "https://example.invalid/x.png" };

describe("хвост подписи: неполнота видна в результате", () => {
  test("обрыв на второй части — счётчик, знаменатель и флаг", async () => {
    const tg = fakeTg({ failMessageAt: 2 });
    const res = await tgSendPhoto(tg, { chatId: -1, photo: PHOTO, caption: LONG });

    // Медиа в чате — действие успешно, как и было.
    expect(res.ok).toBe(true);
    expect(tg.calls.filter((c: any) => c.api === "sendPhoto")).toHaveLength(1);

    // А вот это до фикса было неотличимо от полного успеха.
    expect(res.captionTailIncomplete).toBe(true);
    expect(res.captionTailParts).toBe(1);
    expect(res.captionTailExpected).toBeGreaterThan(1);
  });

  test("полный хвост флага не выставляет, числа сходятся", async () => {
    const tg = fakeTg();
    const res = await tgSendPhoto(tg, { chatId: -1, photo: PHOTO, caption: LONG });

    expect(res.captionTailIncomplete).toBeUndefined();
    expect(res.captionTailParts).toBe(res.captionTailExpected);
    // Знаменатель — не выдумка: столько сообщений и ушло.
    expect(tg.calls.filter((c: any) => c.api === "sendMessage")).toHaveLength(
      res.captionTailExpected!,
    );
  });

  test("хвост упал целиком — 0 из N, а не просто 0", async () => {
    // Регресс-якорь к прежнему поведению: ok остаётся true (медиа уже в чате),
    // и captionTailParts по-прежнему 0. Ново здесь только то, что рядом видно,
    // сколько частей потеряно.
    const tg = fakeTg({ failMessageAt: 1 });
    const res = await tgSendPhoto(tg, { chatId: -1, photo: PHOTO, caption: LONG });

    expect(res.ok).toBe(true);
    expect(res.captionTailParts).toBe(0);
    expect(res.captionTailExpected).toBeGreaterThan(0);
    expect(res.captionTailIncomplete).toBe(true);
  });

  test("короткая подпись не обрастает пустыми полями", async () => {
    // Хвоста нет вовсе — знаменателя быть не должно, иначе `0 из 0` в истории
    // действий читается как «что-то не доехало».
    const tg = fakeTg();
    const res = await tgSendPhoto(tg, { chatId: -1, photo: PHOTO, caption: "коротко" });

    expect(res.captionTailParts).toBeUndefined();
    expect(res.captionTailExpected).toBeUndefined();
    expect(res.captionTailIncomplete).toBeUndefined();
  });

  test("документ докладывает обрыв так же, как фото", async () => {
    const tg = fakeTg({ failMessageAt: 2 });
    const res = await tgSendDocument(tg, {
      chatId: -1,
      content: "hello",
      filename: "a.txt",
      caption: LONG,
    });

    expect(res.ok).toBe(true);
    expect(tg.calls.filter((c: any) => c.api === "sendDocument")).toHaveLength(1);
    expect(res.captionTailIncomplete).toBe(true);
    expect(res.captionTailParts).toBe(1);
    expect(res.captionTailExpected).toBeGreaterThan(1);
  });

  test("документ с полным хвостом — флага нет", async () => {
    const tg = fakeTg();
    const res = await tgSendDocument(tg, {
      chatId: -1,
      content: "hello",
      filename: "a.txt",
      caption: LONG,
    });
    expect(res.captionTailIncomplete).toBeUndefined();
    expect(res.captionTailParts).toBe(res.captionTailExpected);
  });

  test("потеряно ровно столько текста, сколько говорит знаменатель", async () => {
    // Проверка, что `expected` — это части, а не что-нибудь ещё: полный прогон
    // и оборванный на той же подписи должны отличаться на (expected − sent)
    // сообщений.
    const full = fakeTg();
    const rFull = await tgSendPhoto(full, { chatId: -1, photo: PHOTO, caption: LONG });
    const cut = fakeTg({ failMessageAt: 3 });
    const rCut = await tgSendPhoto(cut, { chatId: -1, photo: PHOTO, caption: LONG });

    expect(rCut.captionTailExpected).toBe(rFull.captionTailExpected);
    const lost = rCut.captionTailExpected! - rCut.captionTailParts!;
    const fullMsgs = full.calls.filter((c: any) => c.api === "sendMessage").length;
    const cutMsgs = cut.calls.filter((c: any) => c.api === "sendMessage").length;
    expect(fullMsgs - cutMsgs).toBe(lost);
  });
});
