/**
 * Аудит 2026-08-14: плейн-фолбэк `sendWithHtml` слал сырой текст без границы.
 *
 * Решение «резать ли подпись» принимается по ВИДИМОЙ длине — и это правильно:
 * Telegram считает подпись после разбора сущностей, `[текст](url)` весит там
 * только «текст», и дайджест из полутора десятков ссылок обязан остаться одним
 * сообщением (это чинил аудит 2026-08-12). Но при 400 «can't parse entities»
 * второй попыткой уходит СЫРОЙ markdown, а у него своя длина.
 *
 * Замер: 22 строки `• Новость N [Подробнее →](https://delabs.space/digest/…)`
 * плюс одна с перекрёстным `**жирный _курсив** хвост_` — raw 1663 / plain 566.
 * Первый вызов падает на сущностях, второй на «caption is too long», и
 * `tgSendDocument` бросает — файл в чат не попадает вовсе. Для фото это ещё и
 * деньги: растр у OpenAI уже куплен, а слот лимита за него не возвращается.
 *
 * Двухграничная мерка на ВХОДЕ здесь не лечит: она дробила бы подписи, которые
 * прекрасно уходят одним сообщением при валидной разметке (обычный случай).
 * Граница нужна ровно на плейн-пути.
 *
 * Инвариант: ошибка разметки стоит форматирования (и, в крайнем случае,
 * хвоста текста), но никогда — самой доставки.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sendWithHtml } from "../lib/telegram-format.ts";
import {
  tgSendDocument,
  tgSendPhoto,
  tgEditMessage,
  TELEGRAM_CAPTION_HARD_LIMIT,
} from "../lib/telegram-actions.ts";

/** 400 «can't parse entities» — ровно то, что распознаёт isHtmlParseError. */
function parseError(): Error {
  const e = new Error(
    "400: Bad Request: can't parse entities: Unmatched end tag at byte offset 12",
  ) as Error & { response: { error_code: number; description: string } };
  e.response = {
    error_code: 400,
    description:
      "Bad Request: can't parse entities: Unmatched end tag at byte offset 12",
  };
  return e;
}

function tooLong(what: "caption" | "message"): Error {
  const desc =
    what === "caption"
      ? "Bad Request: message caption is too long"
      : "Bad Request: message is too long";
  const e = new Error(`400: ${desc}`) as Error & {
    response: { error_code: number; description: string };
  };
  e.response = { error_code: 400, description: desc };
  return e;
}

/**
 * Фейковый Telegram, считающий длину как настоящий: с parse_mode — после
 * разбора сущностей (здесь просто «HTML отдали — разметка битая, 400»), без
 * parse_mode — сырые символы против лимита.
 */
function fakeTg(limit: number, kind: "caption" | "message") {
  const calls: { pm?: string; len: number }[] = [];
  const send = async (text: string, pm?: string) => {
    calls.push({ pm, len: text.length });
    if (pm === "HTML") throw parseError();
    if (text.length > limit) throw tooLong(kind);
    return { message_id: 1 };
  };
  return { calls, send };
}

/** Подпись из находки: видимая короткая, сырая — вдвое длиннее лимита. */
function linkHeavyCaption(lines: number): string {
  const items = Array.from(
    { length: lines },
    (_, i) =>
      `• Новость ${i + 1} [Подробнее →](https://delabs.space/digest/2026-08-12-item-${i + 1})`,
  );
  // Перекрёстное выделение — источник самой ошибки разметки.
  items.push("**Итого _за неделю** 22 пункта_");
  return items.join("\n");
}

describe("плейн-фолбэк не превышает лимит Telegram", () => {
  test("замер из находки: видимая длина мала, сырая — вдвое больше лимита", () => {
    const cap = linkHeavyCaption(22);
    expect(cap.length).toBeGreaterThan(TELEGRAM_CAPTION_HARD_LIMIT);
    // Именно поэтому вход не режется: видимая длина укладывается с запасом.
    expect(cap.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").length).toBeLessThan(1000);
  });

  test("sendWithHtml без мерки шлёт сырой текст целиком (исходное поведение)", async () => {
    const tg = fakeTg(TELEGRAM_CAPTION_HARD_LIMIT, "caption");
    const cap = linkHeavyCaption(22);
    await expect(sendWithHtml(tg.send, cap)).rejects.toThrow(
      "caption is too long",
    );
    expect(tg.calls).toHaveLength(2);
    expect(tg.calls[1]!.len).toBe(cap.length);
  });

  test("с меркой фолбэк обрезается и доставка проходит", async () => {
    const tg = fakeTg(TELEGRAM_CAPTION_HARD_LIMIT, "caption");
    const cap = linkHeavyCaption(22);
    const res = await sendWithHtml(
      tg.send,
      cap,
      (t) => t.length <= TELEGRAM_CAPTION_HARD_LIMIT,
    );
    expect(res).toEqual({ message_id: 1 });
    expect(tg.calls).toHaveLength(2);
    expect(tg.calls[1]!.pm).toBeUndefined();
    expect(tg.calls[1]!.len).toBeLessThanOrEqual(TELEGRAM_CAPTION_HARD_LIMIT);
  });

  test("короткий текст мерка не трогает — обрезки быть не должно", async () => {
    const tg = fakeTg(TELEGRAM_CAPTION_HARD_LIMIT, "caption");
    const res = await sendWithHtml(
      tg.send,
      "**битая _разметка**",
      (t) => t.length <= TELEGRAM_CAPTION_HARD_LIMIT,
    );
    expect(res).toEqual({ message_id: 1 });
    expect(tg.calls[1]!.len).toBe("**битая _разметка**".length);
  });

  test("не-разметочные ошибки мерка не перехватывает", async () => {
    const boom = new Error("socket hang up");
    const send = async () => {
      throw boom;
    };
    await expect(
      sendWithHtml(send, linkHeavyCaption(22), () => false),
    ).rejects.toThrow("socket hang up");
  });
});

describe("действия доставляют медиа при битой разметке длинной подписи", () => {
  test("SEND_DOCUMENT: файл доезжает, подпись урезана", async () => {
    const tg = fakeTg(TELEGRAM_CAPTION_HARD_LIMIT, "caption");
    const seen: number[] = [];
    const fake = {
      sendDocument: async (
        _chat: number,
        _doc: unknown,
        extra: { caption?: string; parse_mode?: string },
      ) => {
        seen.push((extra.caption ?? "").length);
        if (extra.parse_mode === "HTML") throw parseError();
        if ((extra.caption ?? "").length > TELEGRAM_CAPTION_HARD_LIMIT)
          throw tooLong("caption");
        return { message_id: 7 };
      },
      sendMessage: async () => ({ message_id: 8 }),
    } as never;
    const res = await tgSendDocument(fake, {
      chatId: -100,
      content: "отчёт",
      filename: "report.md",
      caption: linkHeavyCaption(22),
    });
    expect(res).toEqual({ ok: true, messageId: 7 });
    expect(seen[seen.length - 1]!).toBeLessThanOrEqual(
      TELEGRAM_CAPTION_HARD_LIMIT,
    );
  });

  test("SEND_PHOTO: картинка доезжает, подпись урезана", async () => {
    const seen: number[] = [];
    const fake = {
      sendPhoto: async (
        _chat: number,
        _photo: unknown,
        extra: { caption?: string; parse_mode?: string },
      ) => {
        seen.push((extra.caption ?? "").length);
        if (extra.parse_mode === "HTML") throw parseError();
        if ((extra.caption ?? "").length > TELEGRAM_CAPTION_HARD_LIMIT)
          throw tooLong("caption");
        return { message_id: 9 };
      },
      sendMessage: async () => ({ message_id: 10 }),
    } as never;
    const res = await tgSendPhoto(fake, {
      chatId: -100,
      photo: { url: "https://example.test/a.png" },
      caption: linkHeavyCaption(22),
    });
    expect(res).toEqual({ ok: true, messageId: 9 });
    expect(seen[seen.length - 1]!).toBeLessThanOrEqual(
      TELEGRAM_CAPTION_HARD_LIMIT,
    );
  });

  test("EDIT_MESSAGE: правка доезжает, когда сырой текст длиннее 4096", async () => {
    const seen: number[] = [];
    const fake = {
      editMessageText: async (
        _chat: number,
        _msg: number,
        _inline: undefined,
        text: string,
        extra?: { parse_mode?: string },
      ) => {
        seen.push(text.length);
        if (extra?.parse_mode === "HTML") throw parseError();
        if (text.length > 4096) throw tooLong("message");
        return { message_id: 11 };
      },
    } as never;
    // raw ~4700 / plain ~1300 — вход не режется, фолбэк обязан влезть.
    const res = await tgEditMessage(fake, {
      chatId: -100,
      messageId: 11,
      text: linkHeavyCaption(64),
    });
    expect(res).toEqual({ ok: true });
    expect(seen[seen.length - 1]!).toBeLessThanOrEqual(4096);
  });
});

describe("форма исправления", () => {
  const FMT = readFileSync(
    join(import.meta.dir, "..", "lib", "telegram-format.ts"),
    "utf8",
  );
  const ACT = readFileSync(
    join(import.meta.dir, "..", "lib", "telegram-actions.ts"),
    "utf8",
  );
  // Мерка СООБЩЕНИЯ с тех пор переехала в telegram-chunking.ts — рядом с
  // лимитом, который она меряет. Переезд был не косметикой: четвёртый
  // отправитель, `handoff.ts`, обойтись без общей мерки пытался и передавал
  // третьим аргументом само ЧИСЛО. `sendWithHtml` зовёт третий аргумент как
  // функцию, так что плейн-путь падал `TypeError: not a function` ровно в тот
  // момент, ради которого существует, — и ответ делегата пропадал целиком.
  const CHUNK = readFileSync(
    join(import.meta.dir, "..", "lib", "telegram-chunking.ts"),
    "utf8",
  );
  const HANDOFF = readFileSync(
    join(import.meta.dir, "..", "lib", "handoff.ts"),
    "utf8",
  );
  // Блок импортов отрезаем: имя мерки встречается и там, а считать мы хотим
  // места ВЫЗОВА.
  const ACT_BODY = ACT.slice(
    ACT.indexOf("export const TELEGRAM_CAPTION_HARD_LIMIT"),
  );

  test("мерка стоит только на плейн-ветке, а не перед HTML-попыткой", () => {
    const htmlSend = FMT.indexOf("send(mdToTelegramHtml(rawText)");
    const guard = FMT.indexOf("plainFallbackFits && !plainFallbackFits(rawText)");
    expect(htmlSend).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(htmlSend);
  });

  test("все четыре отправителя передают мерку", () => {
    expect(ACT_BODY.match(/CAPTION_PLAIN_FITS,/g)?.length).toBe(2);
    expect(ACT_BODY.match(/messagePlainFits,/g)?.length).toBe(3);
    expect(HANDOFF).toMatch(/^ +messagePlainFits,$/m);
  });

  test("мерка плейн-пути считает сырую длину, а не видимую", () => {
    expect(ACT).toContain("t.length <= TELEGRAM_CAPTION_HARD_LIMIT");
    expect(CHUNK).toContain("t.length <= TELEGRAM_MESSAGE_HARD_LIMIT");
  });

  test("обрезка фолбэка попадает в лог — молчаливой потери текста нет", () => {
    expect(FMT).toContain(
      "[tg] плейн-фолбэк не влезал в лимит — подпись обрезана",
    );
  });

  test("вход по-прежнему меряется видимой длиной (регресс 2026-08-12)", () => {
    expect(ACT).toContain("plainTelegramLength(args.caption) > TELEGRAM_CAPTION_LIMIT");
  });
});
