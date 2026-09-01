/**
 * Аудит 2026-08-08: длина подписи к медиа не проверялась нигде.
 *
 * Лимит подписи у Telegram — 1024, а не 4096 как у сообщения; при превышении
 * sendPhoto/sendDocument падают с 400 и медиа в чат не попадает вовсе. Для
 * GENERATE_IMAGE это прямые деньги: растр у OpenAI уже куплен ДО отправки, а
 * слот часового лимита за него намеренно не возвращается — модель повторяет
 * попытку с той же подписью, пока не упрётся в лимит.
 * buildGenerateImagePayload режет prompt на 4000 символов, а caption пропускал
 * без единой проверки.
 *
 * Заодно EDIT_MESSAGE: правка длиннее 4096 пропадала целиком, а разметка в ней
 * не рендерилась — агент писал `**жирный**`, в чате появлялись звёздочки.
 */
import { test, expect, describe } from "bun:test";
import {
  tgSendPhoto,
  tgSendDocument,
  tgEditMessage,
  TELEGRAM_CAPTION_LIMIT,
} from "../lib/telegram-actions.ts";

/** Телеграм-заглушка: пишет вызовы и роняет слишком длинную подпись, как API. */
function fakeTg() {
  const calls: Array<{ api: string; text: string; parseMode?: string }> = [];
  let nextId = 100;
  const capGuard = (caption: unknown, api: string) => {
    const c = typeof caption === "string" ? caption : "";
    // Точная граница настоящего Bot API — 1024 символа подписи.
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
    async sendMessage(_chatId: number, text: string, extra: any) {
      calls.push({ api: "sendMessage", text, parseMode: extra?.parse_mode });
      return { message_id: nextId++ };
    },
    async editMessageText(
      _chatId: number,
      _msgId: number,
      _inline: undefined,
      text: string,
      extra: any,
    ) {
      if (text.length > 4096) {
        const err: any = new Error("400: MESSAGE_TOO_LONG");
        err.response = { error_code: 400, description: "message is too long" };
        throw err;
      }
      calls.push({ api: "editMessageText", text, parseMode: extra?.parse_mode });
      return { message_id: _msgId };
    },
  } as any;
}

describe("подпись к медиа: длинная не роняет отправку", () => {
  test("подпись в 3000 символов — фото уходит, хвост доезжает следующими", async () => {
    const tg = fakeTg();
    const caption = "абзац ".repeat(500); // 3000 символов
    const res = await tgSendPhoto(tg, {
      chatId: -1,
      photo: { url: "https://example.invalid/x.png" },
      caption,
    });

    expect(res.ok).toBe(true);
    // Главное: картинка в чате. До фикса вызов падал целиком.
    const photo = tg.calls.filter((c: any) => c.api === "sendPhoto");
    expect(photo).toHaveLength(1);
    expect(photo[0].text.length).toBeLessThanOrEqual(TELEGRAM_CAPTION_LIMIT);

    // Хвост не потерян и привязан к самому фото.
    expect(res.captionTailParts).toBeGreaterThan(0);
    const tails = tg.calls.filter((c: any) => c.api === "sendMessage");
    expect(tails.length).toBe(res.captionTailParts);
    const delivered =
      photo[0].text.length + tails.reduce((n: number, c: any) => n + c.text.length, 0);
    // Символы не выброшены: расхождение только на склейках абзацев.
    expect(delivered).toBeGreaterThan(caption.length * 0.95);
  });

  test("короткая подпись идёт ровно как раньше — без лишних сообщений", async () => {
    const tg = fakeTg();
    const res = await tgSendPhoto(tg, {
      chatId: -1,
      photo: { url: "https://example.invalid/x.png" },
      caption: "коротко",
    });
    expect(res.captionTailParts).toBeUndefined();
    expect(tg.calls).toHaveLength(1);
    expect(tg.calls[0].api).toBe("sendPhoto");
  });

  test("подпись ровно на границе лимита проходит одним куском", async () => {
    const tg = fakeTg();
    const res = await tgSendPhoto(tg, {
      chatId: -1,
      photo: { url: "https://example.invalid/x.png" },
      caption: "я".repeat(TELEGRAM_CAPTION_LIMIT),
    });
    expect(res.captionTailParts).toBeUndefined();
    expect(tg.calls.filter((c: any) => c.api === "sendMessage")).toHaveLength(0);
  });

  test("упавший хвост не превращает отправку в ошибку", async () => {
    // Медиа уже в чате. Объявить действие неудачным — значит спровоцировать
    // повторную генерацию за деньги.
    const tg = fakeTg();
    tg.sendMessage = async () => {
      throw new Error("network");
    };
    const res = await tgSendPhoto(tg, {
      chatId: -1,
      photo: { url: "https://example.invalid/x.png" },
      caption: "текст ".repeat(400),
    });
    expect(res.ok).toBe(true);
    expect(res.captionTailParts).toBe(0);
  });

  test("документ с длинной подписью тоже доезжает", async () => {
    const tg = fakeTg();
    const res = await tgSendDocument(tg, {
      chatId: -1,
      content: "hello",
      filename: "a.txt",
      caption: "строка ".repeat(400),
    });
    expect(res.ok).toBe(true);
    expect(tg.calls.filter((c: any) => c.api === "sendDocument")).toHaveLength(1);
    expect(res.captionTailParts).toBeGreaterThan(0);
  });
});

describe("EDIT_MESSAGE: лимит и разметка", () => {
  test("правка длиннее лимита обрезается с маркером, а не пропадает", async () => {
    const tg = fakeTg();
    const res = await tgEditMessage(tg, {
      chatId: -1,
      messageId: 7,
      text: "я".repeat(9000),
    });
    expect(res.truncated).toBe(true);
    const edit = tg.calls.find((c: any) => c.api === "editMessageText");
    expect(edit).toBeDefined();
    expect(edit!.text.length).toBeLessThanOrEqual(4096);
    // Обрезка видна в чате, а не только в результате.
    expect(edit!.text.endsWith("…")).toBe(true);
  });

  test("короткая правка не помечается обрезанной", async () => {
    const tg = fakeTg();
    const res = await tgEditMessage(tg, { chatId: -1, messageId: 7, text: "ок" });
    expect(res.truncated).toBeUndefined();
  });

  test("разметка рендерится, а не показывается звёздочками", async () => {
    const tg = fakeTg();
    await tgEditMessage(tg, { chatId: -1, messageId: 7, text: "**жирный**" });
    const edit = tg.calls.find((c: any) => c.api === "editMessageText")!;
    expect(edit.parseMode).toBe("HTML");
    expect(edit.text).toContain("<b>жирный</b>");
  });

  test("битая разметка откатывается на плейн-текст, а не роняет правку", async () => {
    const tg = fakeTg();
    let first = true;
    const orig = tg.editMessageText;
    tg.editMessageText = async (...a: any[]) => {
      if (first) {
        first = false;
        const err: any = new Error("400");
        err.response = { error_code: 400, description: "can't parse entities" };
        throw err;
      }
      return orig(...(a as [any, any, any, any, any]));
    };
    const res = await tgEditMessage(tg, {
      chatId: -1,
      messageId: 7,
      text: "<b>кривая",
    });
    expect(res.ok).toBe(true);
    const edit = tg.calls.find((c: any) => c.api === "editMessageText")!;
    expect(edit.parseMode).toBeUndefined();
  });
});
