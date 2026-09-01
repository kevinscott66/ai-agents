/**
 * Аудит 2026-08-12: подпись к документу мерили как размеченную, а слали сырой.
 *
 * `tgSendDocument` решает, резать ли подпись, по `plainTelegramLength` — то есть
 * по длине ПОСЛЕ Markdown→HTML, где `[Подробнее →](https://…/digest/…)` весит 12
 * символов, а не 60. Но дальше подпись клали прямо в `extra.caption` и звали
 * `tg.sendDocument` без `parse_mode` — значит Telegram считал против лимита 1024
 * сырой markdown вместе с URL'ами.
 *
 * Замер (22 строки вида `• Новость N [Подробнее →](https://delabs.space/digest/…)`):
 *
 *   raw   = 1631   ← столько видит Telegram
 *   plain =  540   ← столько видит наше условие
 *
 * Условие ложно → ничего не режется → 400 «caption is too long». Вызов один,
 * фолбэка нет, так что документ не доезжает ВООБЩЕ — не «без подписи», а никак.
 * Соседний `tgSendPhoto` (тот же файл, ~380) с той же меркой шлёт подпись через
 * `sendWithHtml`, и там `plainTelegramLength` — верная мерка. Здесь её просто
 * забыли подключить, а заодно подпись приезжала звёздочками и скобками, тогда
 * как её собственный хвост (`sendCaptionTail`) рендерился разметкой.
 *
 * Инвариант: чем мерим, тем и шлём.
 */
import { describe, test, expect } from "bun:test";
import { tgSendDocument, TELEGRAM_CAPTION_LIMIT } from "../lib/telegram-actions.ts";
import { plainTelegramLength } from "../lib/telegram-format.ts";

/** Лимит подписи у самого Telegram — наш 1000 это запас под него. */
const TG_HARD_CAPTION_LIMIT = 1024;

function captionOf(text: string) {
  const lines: string[] = [];
  for (let i = 1; i <= 22; i++) {
    lines.push(`• ${text} ${i} [Подробнее →](https://delabs.space/digest/2026-08-12-item-${i})`);
  }
  return lines.join("\n");
}

interface Call {
  caption?: string;
  parseMode?: string;
}

/**
 * Модель Telegram: с `parse_mode=HTML` лимит считается по видимому тексту,
 * без него — по всей строке целиком. Ровно это и делает разницу.
 */
function fakeTg(calls: Call[], sentTail: string[]) {
  return {
    sendDocument: async (_chat: number, _doc: unknown, extra: Record<string, unknown>) => {
      const caption = extra.caption as string | undefined;
      const parseMode = extra.parse_mode as string | undefined;
      calls.push({ caption, parseMode });
      const visible =
        caption === undefined
          ? 0
          : parseMode === "HTML"
            ? caption.replace(/<[^>]+>/g, "").length
            : caption.length;
      if (visible > TG_HARD_CAPTION_LIMIT) {
        throw {
          response: {
            error_code: 400,
            description: "Bad Request: message caption is too long",
          },
        };
      }
      return { message_id: 777 };
    },
    sendMessage: async (_chat: number, text: string) => {
      sentTail.push(text);
      return { message_id: 778 };
    },
  } as never;
}

describe("подпись документа", () => {
  test("длинная размеченная подпись не роняет отправку документа", async () => {
    const caption = captionOf("Новость");
    // Замер из шапки — фиксируем, иначе тест перестанет проверять тот случай.
    expect(caption.length).toBeGreaterThan(TG_HARD_CAPTION_LIMIT);
    expect(plainTelegramLength(caption)).toBeLessThan(TELEGRAM_CAPTION_LIMIT);

    const calls: Call[] = [];
    const tail: string[] = [];
    const r = await tgSendDocument(fakeTg(calls, tail), {
      chatId: -100123,
      content: "digest",
      filename: "digest.md",
      caption,
    });
    expect(r).toEqual({ ok: true, messageId: 777 });
  });

  test("подпись уезжает размеченной, как и её хвост", async () => {
    const calls: Call[] = [];
    const tail: string[] = [];
    await tgSendDocument(fakeTg(calls, tail), {
      chatId: -100123,
      content: "x",
      filename: "a.md",
      caption: "**Итоги** [тут](https://delabs.space/)",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.parseMode).toBe("HTML");
    expect(calls[0]!.caption).toContain("<b>Итоги</b>");
    expect(calls[0]!.caption).not.toContain("**");
  });

  test("подпись, длинная и в plain — режется, хвост отдельными сообщениями", async () => {
    const caption = "я".repeat(1500);
    expect(plainTelegramLength(caption)).toBeGreaterThan(TELEGRAM_CAPTION_LIMIT);
    const calls: Call[] = [];
    const tail: string[] = [];
    const r = await tgSendDocument(fakeTg(calls, tail), {
      chatId: -100123,
      content: "x",
      filename: "a.md",
      caption,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.caption!.replace(/<[^>]+>/g, "").length).toBeLessThanOrEqual(
      TELEGRAM_CAPTION_LIMIT,
    );
    expect(r.captionTailParts).toBeGreaterThan(0);
    expect(tail.length).toBeGreaterThan(0);
  });

  test("без подписи — как было, один вызов без parse_mode", async () => {
    const calls: Call[] = [];
    const tail: string[] = [];
    const r = await tgSendDocument(fakeTg(calls, tail), {
      chatId: -100123,
      content: "x",
      filename: "a.md",
    });
    expect(calls).toEqual([{ caption: undefined, parseMode: undefined }]);
    expect(r).toEqual({ ok: true, messageId: 777 });
  });

  test("reply_parameters сохраняются вместе с подписью", async () => {
    // Аудит 2026-08-28: тут стояло ожидание объекта `{ message_id: 42 }`, и оно
    // давало ложную уверенность. Заглушка получает `extra` ДО сериализатора
    // telegraf, а именно сериализатор и выбрасывал это поле из multipart-тела
    // целиком — тест был зелёным ровно тогда, когда ответ до Telegram не
    // доезжал. Теперь на multipart-пути поле уходит JSON-строкой (нужная для
    // form-data форма), и проверка совпадает с тем, что реально уходит в
    // провод; сам провод проверяет
    // audit-2026-08-28-reply-parameters-multipart.test.ts на живом telegraf.
    const calls: Array<Record<string, unknown>> = [];
    const tg = {
      sendDocument: async (_c: number, _d: unknown, extra: Record<string, unknown>) => {
        calls.push(extra);
        return { message_id: 5 };
      },
    } as never;
    await tgSendDocument(tg, {
      chatId: -100123,
      content: "x",
      filename: "a.md",
      caption: "привет",
      replyToMessageId: 42,
    });
    expect(calls[0]!.reply_parameters).toBe('{"message_id":42}');
    expect(calls[0]!.caption).toBe("привет");
  });

  test("битая разметка стоит форматирования, а не документа", async () => {
    // Тот же фолбэк, что у фото: 400 «can't parse entities» → повтор плейном.
    const attempts: Array<string | undefined> = [];
    const tg = {
      sendDocument: async (_c: number, _d: unknown, extra: Record<string, unknown>) => {
        attempts.push(extra.parse_mode as string | undefined);
        if (extra.parse_mode === "HTML") {
          throw {
            response: {
              error_code: 400,
              description: "Bad Request: can't parse entities: unclosed start tag",
            },
          };
        }
        return { message_id: 9 };
      },
    } as never;
    const r = await tgSendDocument(tg, {
      chatId: -100123,
      content: "x",
      filename: "a.md",
      caption: "<b>кривая",
    });
    expect(attempts).toEqual(["HTML", undefined]);
    expect(r).toEqual({ ok: true, messageId: 9 });
  });
});
