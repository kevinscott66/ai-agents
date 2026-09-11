/**
 * Аудит 2026-08-13: отказ на середине многочастной отправки репортился как
 * полный провал.
 *
 * Длинный ответ уходит N сообщениями (`sendChunked`). Если падала вторая часть,
 * исключение улетало наверх как обычная ошибка, и действие возвращало
 * `{ok:false}` — хотя часть «(1/3)…» уже висела в чате. Модель по такому
 * результату повторяет отправку, а Telegram транзакций не знает и
 * идемпотентности здесь нет ни на одном уровне: доставленные части
 * дублируются.
 *
 * Причина не редкая: у отправки от лица владельца FLOOD_WAIT-гвард висит на
 * КАЖДУЮ часть (см. комментарий в dispatch/telegram.ts), то есть длинный ответ —
 * это N отдельных шансов упасть на середине.
 *
 * Форма та же, что у осиротевшего баннера в PUBLISH_TO_CHANNEL: половина
 * side-effect'а состоялась, и об этом надо сказать словами. Компенсации
 * удалением здесь сознательно нет — сносить отправленное с аккаунта владельца
 * необратимо, и такую неявную дверь у DELETE_MESSAGE уже закрыли 2026-08-11.
 */
import { describe, test, expect } from "bun:test";
import { handleSendMessage } from "../lib/dispatch/telegram.ts";
import {
  sendChunked,
  splitForTelegram,
  PartialSendError,
} from "../lib/telegram-chunking.ts";
import { _resetFloodCooldowns } from "../lib/userbot-flood.ts";

/** Текст, гарантированно разбиваемый на 3+ части. */
const LONG = Array.from({ length: 12 }, (_, i) => `Абзац ${i + 1}. ${"текст ".repeat(200)}`).join(
  "\n\n",
);

const CTX = { agentKey: "orchestrator", chatId: -4242 };

describe("sendChunked: частичная доставка отличима от полного провала", () => {
  test("падение на второй части даёт PartialSendError со счётом", async () => {
    expect(splitForTelegram(LONG).length).toBeGreaterThan(2); // предпосылка
    let n = 0;
    const err = await sendChunked(async () => {
      n += 1;
      if (n === 2) throw new Error("FLOOD_WAIT_31");
      return { message_id: n };
    }, LONG).catch((e) => e);

    expect(err).toBeInstanceOf(PartialSendError);
    expect(err.partsSent).toBe(1);
    expect(err.partsTotal).toBe(splitForTelegram(LONG).length);
    // Исходная причина не теряется — по ней разбираются вызывающие и человек.
    expect((err.cause as Error).message).toBe("FLOOD_WAIT_31");
  });

  test("падение на ПЕРВОЙ части пробрасывается как есть", async () => {
    // Ничего не доставлено — это обычный провал. Оборачивать его нельзя:
    // isCaptionTooLong / isPhotoRejected и прочие смотрят на исходное исключение.
    const boom = new Error("RPCError 403: CHAT_WRITE_FORBIDDEN");
    const err = await sendChunked(async () => {
      throw boom;
    }, LONG).catch((e) => e);

    expect(err).toBe(boom);
    expect(err).not.toBeInstanceOf(PartialSendError);
  });

  test("успешная отправка возвращает последнее сообщение, как и раньше", async () => {
    let n = 0;
    const last = await sendChunked(async () => ({ message_id: ++n }), LONG);
    expect(last.message_id).toBe(splitForTelegram(LONG).length);
  });
});

describe("SEND_MESSAGE репортит частичную доставку, а не провал", () => {
  test("Bot API: результат называет доставленные части и запрещает слепой повтор", async () => {
    let n = 0;
    const out: any = await handleSendMessage({ text: LONG } as any, {
      ...CTX,
      telegram: {
        async sendMessage() {
          n += 1;
          if (n === 2) throw new Error("429: Too Many Requests");
          return { message_id: n };
        },
      } as any,
    } as any);

    expect(out.ok).toBe(false);
    expect(out.error).toContain("частичная доставка");
    expect(out.error).toContain("1 из"); // сколько именно ушло
    expect(out.error).toContain("продублирует"); // и что повтор сделает
    expect(out.error).toContain("429"); // исходная причина на месте
  });

  test("юзербот от лица владельца: то же самое", async () => {
    _resetFloodCooldowns();
    let n = 0;
    const out: any = await handleSendMessage(
      { text: LONG, via_userbot: true } as any,
      {
        ...CTX,
        userbot: {
          isNoop: false,
          async sendMessage() {
            n += 1;
            // Не FLOOD_WAIT: на него у гварда свой бэкофф на 31 секунду, и тест
            // мерил бы его, а не отчёт о частичной доставке.
            if (n === 2) throw new Error("RPCError 400: MSG_ID_INVALID");
            return { message_id: n };
          },
        } as any,
      } as any,
    );

    expect(out.ok).toBe(false);
    expect(out.error).toContain("частичная доставка");
    expect(out.error).toContain("MSG_ID_INVALID");
  });
});

describe("здоровые пути не тронуты", () => {
  test("Bot API: успех возвращает прежнюю форму {ok, result}", async () => {
    const out: any = await handleSendMessage({ text: "коротко" } as any, {
      ...CTX,
      telegram: {
        async sendMessage() {
          return { message_id: 5 };
        },
      } as any,
    } as any);

    // Регресс, который тут и ловится: tgSendMessage сам возвращает
    // `{ok: true, messageId}`, поэтому «есть ли поле ok» — негодный признак
    // частичной доставки. Разбирать надо тип исключения.
    expect(out.ok).toBe(true);
    expect(out.result).toBeDefined();
    expect(out.result.messageId ?? out.result.message_id).toBe(5);
  });

  test("Bot API: провал с первой части остаётся обычной ошибкой", async () => {
    const out = await handleSendMessage({ text: "коротко" } as any, {
      ...CTX,
      telegram: {
        async sendMessage() {
          throw new Error("400: chat not found");
        },
      } as any,
    } as any).catch((e) => e);

    // Пробрасывается наружу нетронутым — разбор ошибок у вызывающих не меняется.
    expect(out).toBeInstanceOf(Error);
    expect((out as Error).message).toContain("chat not found");
  });

  test("юзербот: успех возвращает via и message_id последней части", async () => {
    _resetFloodCooldowns();
    let n = 0;
    const out: any = await handleSendMessage(
      { text: LONG, via_userbot: true } as any,
      {
        ...CTX,
        userbot: {
          isNoop: false,
          async sendMessage() {
            return { message_id: ++n };
          },
        } as any,
      } as any,
    );

    expect(out.ok).toBe(true);
    expect(out.result.via).toBe("userbot");
    expect(out.result.message_id).toBe(splitForTelegram(LONG).length);
  });
});
