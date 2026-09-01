/**
 * Аудит 2026-08-13, слой отправки в Telegram. Четыре места, где сообщение
 * уходит не таким, каким его написали, — или не уходит вовсе.
 *
 * Общее у них: ни одно не видно из логов действия. Первые два дают 400 от
 * Telegram уже ПОСЛЕ того, как ресурс потрачен (растр куплен у OpenAI, пост
 * одобрен владельцем); третье не даёт вообще ничего — сообщение уходит
 * успешно, просто скрытый текст в нём открыт; четвёртое портит не прод, а
 * расследования: файл был нечитаем для grep.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { Api } from "telegram";
import { HTMLParser } from "telegram/extensions/html.js";
import {
  mdToTelegramHtml,
  mdToUserbotHtml,
  plainTelegramLength,
} from "../lib/telegram-format.ts";
import { TELEGRAM_MESSAGE_HARD_LIMIT } from "../lib/telegram-chunking.ts";
import {
  tgSendPhoto,
  tgSendDocument,
  tgEditMessage,
  TELEGRAM_CAPTION_LIMIT,
  TELEGRAM_CAPTION_HARD_LIMIT,
} from "../lib/telegram-actions.ts";
import { buildCustomEmojiEntities } from "../lib/custom-emoji-map.ts";

/**
 * Заглушка Telegram, которая ведёт себя как настоящий Bot API в ДВУХ шагах —
 * именно их расхождение и стоило сообщений.
 *
 * 1. С `parse_mode=HTML` разметка разбирается. Кривое вложение (`<b>…<s>…</b>…
 *    </s>`) — 400 «can't parse entities». Длина при этом считается по видимому
 *    тексту.
 * 2. Без `parse_mode` (плейн-фолбэк `sendWithHtml`) считается длина СЫРОЙ
 *    строки. 1024 для подписи, 4096 для сообщения.
 *
 * Заглушки в соседних тестах меряют только сырую длину — поэтому расхождение
 * шага 1 и шага 2 они и не ловили.
 */
function fakeTg(opts: { entitiesTooLong?: boolean } = {}) {
  const calls: Array<{ api: string; text: string; html: boolean }> = [];
  let nextId = 500;
  let htmlAttempts = 0;

  const visibleLength = (html: string) =>
    html
      .replace(/<[^>]+>/g, "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&").length;

  /** Стековая проверка вложенности — ровно то, на чём Telegram отвечает 400. */
  const wellNested = (html: string): boolean => {
    const stack: string[] = [];
    for (const m of html.matchAll(/<(\/?)([a-z][a-z0-9-]*)[^>]*>/g)) {
      if (m[1]) {
        if (stack.pop() !== m[2]) return false;
      } else {
        stack.push(m[2]!);
      }
    }
    return stack.length === 0;
  };

  const fail = (desc: string) => {
    const err: any = new Error(`400: ${desc}`);
    err.response = { error_code: 400, description: desc };
    throw err;
  };

  const accept = (api: string, text: string, pm: string | undefined, hard: number) => {
    if (pm === "HTML") {
      htmlAttempts += 1;
      // ENTITIES_TOO_LONG приходит на ссылконасыщенном тексте — то есть ровно
      // там, где сырая длина втрое больше видимой. Разметка при этом
      // безупречна, так что балансировщик T-813 этот путь не закрывает.
      if (opts.entitiesTooLong && htmlAttempts === 1) fail("ENTITIES_TOO_LONG");
      if (!wellNested(text)) fail("can't parse entities: unmatched tag");
      if (visibleLength(text) > hard) fail("caption is too long");
    } else if (text.length > hard) {
      fail(hard === TELEGRAM_CAPTION_HARD_LIMIT ? "caption is too long" : "message is too long");
    }
    calls.push({ api, text, html: pm === "HTML" });
    return { message_id: nextId++ };
  };

  return {
    calls,
    async sendPhoto(_c: number, _p: unknown, extra: any) {
      return accept("sendPhoto", extra?.caption ?? "", extra?.parse_mode, TELEGRAM_CAPTION_HARD_LIMIT);
    },
    async sendDocument(_c: number, _d: unknown, extra: any) {
      return accept("sendDocument", extra?.caption ?? "", extra?.parse_mode, TELEGRAM_CAPTION_HARD_LIMIT);
    },
    async sendMessage(_c: number, text: string, extra: any) {
      return accept("sendMessage", text, extra?.parse_mode, TELEGRAM_MESSAGE_HARD_LIMIT);
    },
    async editMessageText(_c: number, _m: number, _i: undefined, text: string, extra: any) {
      return accept("editMessageText", text, extra?.parse_mode, TELEGRAM_MESSAGE_HARD_LIMIT);
    },
  };
}

/** Дайджест ссылками: видимая длина маленькая, сырая — втрое больше. */
const linky = (n: number) =>
  Array.from(
    { length: n },
    (_, i) =>
      `• **Пункт ${i + 1}** [Подробнее →](https://delabs.space/digest/9f3c2a1b7c${i})`,
  ).join("\n");

/**
 * Чем теперь вызывается плейн-фолбэк.
 *
 * Раньше здесь стояла перекрёстная разметка `**жирный ~~зачёркнутый** хвост~~`:
 * шаги 5-10 конвертера давали `<b>…<s>…</b>…</s>`, Telegram отвечал 400 «can't
 * parse entities», и фолбэк включался. После T-813 (`balanceHtmlTags`) этот
 * путь закрыт в корне — конвертер больше не выпускает наружу невложенный HTML,
 * и фикстура перестала вызывать то, ради чего стояла.
 *
 * Проверяемое утверждение при этом никуда не делось: фолбэк шлёт СЫРОЙ текст, и
 * тот обязан укладываться в жёсткий лимит транспорта. Включает фолбэк любая
 * ошибка разметки, а не только перекрёстная, — берём ENTITIES_TOO_LONG
 * (`fakeTg({ entitiesTooLong: true })`). Он приходит на длинных ссылочных
 * простынях, то есть на тех же текстах, где raw ≫ plain: совпадение не
 * случайное, а причинное.
 */

describe("подпись к медиа: плейн-фолбэк знает свою границу", () => {
  test("замер: plain влезает, raw — нет", () => {
    const caption = linky(18);
    // Фиксируем ровно тот случай, который старое условие пропускало целиком.
    expect(plainTelegramLength(caption)).toBeLessThanOrEqual(TELEGRAM_CAPTION_LIMIT);
    expect(caption.length).toBeGreaterThan(TELEGRAM_CAPTION_HARD_LIMIT);
  });

  test("фотография доезжает, хотя сырая подпись длиннее жёсткого лимита", async () => {
    const tg = fakeTg({ entitiesTooLong: true });
    const caption = linky(18);
    // Было: подпись уходит целиком (и правильно — plain 559 влезает) → 400
    // ENTITIES_TOO_LONG → плейн-фолбэк шлёт СЫРЫЕ 1800+ против 1024 →
    // второе 400 → фотографии в чате нет, а растр уже куплен у OpenAI.
    const r = await tgSendPhoto(tg as never, {
      chatId: -100,
      photo: { buffer: Buffer.from("x") },
      caption,
    });
    expect(r.ok).toBe(true);
    // Один вызов, а не два: подпись НЕ дробится — дробить её было бы неверно.
    expect(tg.calls).toHaveLength(1);
    expect(tg.calls[0]!.api).toBe("sendPhoto");
    // Фолбэк, то есть без разметки — и уже в пределах сырого лимита.
    expect(tg.calls[0]!.html).toBe(false);
    expect(tg.calls[0]!.text.length).toBeLessThanOrEqual(TELEGRAM_CAPTION_HARD_LIMIT);
    // Обрезка видимая, а не молчаливая.
    expect(tg.calls[0]!.text.endsWith("…")).toBe(true);
  });

  test("документ — тот же путь и тот же исход", async () => {
    const tg = fakeTg({ entitiesTooLong: true });
    const r = await tgSendDocument(tg as never, {
      chatId: -100,
      filename: "digest.md",
      content: "тело",
      caption: linky(18),
    });
    expect(r.ok).toBe(true);
    expect(tg.calls[0]!.api).toBe("sendDocument");
    expect(tg.calls[0]!.text.length).toBeLessThanOrEqual(TELEGRAM_CAPTION_HARD_LIMIT);
  });

  test("подпись, влезающая по обеим границам, остаётся одним сообщением", async () => {
    // Страховка от «починили и стали резать всё подряд».
    const tg = fakeTg();
    const caption = linky(6);
    expect(caption.length).toBeLessThanOrEqual(TELEGRAM_CAPTION_HARD_LIMIT);
    const r = await tgSendPhoto(tg as never, {
      chatId: -100,
      photo: { buffer: Buffer.from("x") },
      caption,
    });
    expect(r.captionTailParts).toBeUndefined();
    expect(tg.calls).toHaveLength(1);
    expect(tg.calls[0]!.html).toBe(true);
  });
});

describe("правка сообщения: тот же фолбэк, та же граница", () => {
  const editable = (n: number) =>
    Array.from(
      { length: n },
      (_, i) =>
        `Пункт ${i + 1}: [подробности](https://github.com/kevinscott66/ai-agents/pull/${i + 100})`,
    ).join("\n");

  test("правка доезжает, хотя plain < 4000, а raw > 4096", async () => {
    const tg = fakeTg({ entitiesTooLong: true });
    const text = editable(60);
    expect(plainTelegramLength(text)).toBeLessThanOrEqual(4000);
    expect(text.length).toBeGreaterThan(TELEGRAM_MESSAGE_HARD_LIMIT);

    // Было: «влезает» по видимой длине → шлём целиком (и правильно) → 400 на
    // разметке (сегодня — ENTITIES_TOO_LONG) → плейн-фолбэк упирается в 4096 вторым 400 → правки нет вовсе.
    const r = await tgEditMessage(tg as never, { chatId: -100, messageId: 7, text });
    expect(r.ok).toBe(true);
    // `truncated` не выставлен: решение «резать ли» видит plain и говорит
    // «влезает» — оно и не должно ничего резать. Режет фолбэк, и только себя.
    expect(r.truncated).toBeUndefined();
    expect(tg.calls.at(-1)!.html).toBe(false);
    expect(tg.calls.at(-1)!.text.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_HARD_LIMIT);
  });

  test("обычная правка не режется", async () => {
    const tg = fakeTg();
    const r = await tgEditMessage(tg as never, {
      chatId: -100,
      messageId: 7,
      text: "**Готово:** собрал и выкатил, [PR](https://github.com/x/y/pull/1)",
    });
    expect(r.truncated).toBeUndefined();
    expect(tg.calls[0]!.html).toBe(true);
  });
});

describe("кастом-эмодзи не заходят в блоки кода", () => {
  const parse = (md: string) => HTMLParser.parse(mdToUserbotHtml(md));

  test("эмодзи внутри ``` не получает сущности", () => {
    const [plain, fmt] = parse("Смотри:\n```\nstatus: ✅ ok\n```\nвсё");
    const ents = buildCustomEmojiEntities(plain, fmt);
    expect(ents).toHaveLength(0);
  });

  test("эмодзи внутри inline-`code` тоже", () => {
    const [plain, fmt] = parse("значение `flag = 🔥` в конфиге");
    expect(buildCustomEmojiEntities(plain, fmt)).toHaveLength(0);
  });

  test("эмодзи вне кода по-прежнему оживает", () => {
    const [plain, fmt] = parse("Итог 🔥\n```\nplain code\n```");
    const ents = buildCustomEmojiEntities(plain, fmt);
    expect(ents).toHaveLength(1);
    expect(plain.slice((ents[0] as any).offset, (ents[0] as any).offset + (ents[0] as any).length)).toBe("🔥");
  });

  test("смешанный текст: оживает только то, что снаружи", () => {
    const [plain, fmt] = parse("✅ сделано\n```\n✅ в коде\n```\n✅ и снова");
    const ents = buildCustomEmojiEntities(plain, fmt);
    expect(ents).toHaveLength(2);
    // Ни одна сущность не пересекает <pre>.
    const pre = fmt.filter((e: any) => e instanceof Api.MessageEntityPre) as any[];
    expect(pre.length).toBeGreaterThan(0);
    for (const e of ents as any[]) {
      for (const p of pre) {
        expect(e.offset < p.offset + p.length && e.offset + e.length > p.offset).toBe(
          false,
        );
      }
    }
  });

  test("без списка разметки поведение прежнее — вызовы не ломаются", () => {
    // Обратная совместимость: второй аргумент необязателен.
    expect(buildCustomEmojiEntities("✅ ok")).toHaveLength(1);
  });
});

describe("спойлер доезжает до юзербота", () => {
  test("HTMLParser gramjs понимает <spoiler>, но не <tg-spoiler>", () => {
    const md = "это ||секрет|| тут";
    // Bot API — свой тег, он остаётся прежним.
    expect(mdToTelegramHtml(md)).toContain("<tg-spoiler>");

    const [, botTagEntities] = HTMLParser.parse(mdToTelegramHtml(md));
    // Вот и вся беда: незнакомый тег выброшен, сущности нет, текст открыт.
    expect(
      botTagEntities.some((e: any) => e instanceof Api.MessageEntitySpoiler),
    ).toBe(false);

    const [plain, entities] = HTMLParser.parse(mdToUserbotHtml(md));
    expect(entities.some((e: any) => e instanceof Api.MessageEntitySpoiler)).toBe(true);
    // Текст не изменился — скрывается ровно «секрет».
    expect(plain).toBe("это секрет тут");
    const sp = entities.find((e: any) => e instanceof Api.MessageEntitySpoiler) as any;
    expect(plain.slice(sp.offset, sp.offset + sp.length)).toBe("секрет");
  });

  test("пример разметки внутри блока кода не подменяется", () => {
    // Внутри <pre> содержимое экранировано, так что замена тега его не трогает.
    const html = mdToUserbotHtml("```\n<tg-spoiler>x</tg-spoiler>\n```");
    expect(html).toContain("&lt;tg-spoiler&gt;");
    expect(html).not.toContain("<spoiler>");
  });

  test("остальная разметка не пострадала", () => {
    expect(mdToUserbotHtml("**жирный**")).toBe("<b>жирный</b>");
  });
});

describe("исходники Telegram-слоя читаемы для grep", () => {
  test("в telegram-format.ts нет литеральных NUL", () => {
    // NUL делал файл «бинарным» для grep: он молча пропускался, и аудит
    // дважды заключил «такого кода нет». Escape-запись читается одинаково.
    const buf = readFileSync(new URL("../lib/telegram-format.ts", import.meta.url));
    expect(buf.includes(0)).toBe(false);
  });

  test("плейсхолдеры при этом остаются NUL-обёрнутыми в рантайме", () => {
    // Смысл записи не изменился: плейсхолдер невидим и не сталкивается с
    // текстом сообщения. Проверяем по результату — код восстановлен на месте.
    expect(mdToTelegramHtml("до `x` после")).toBe("до <code>x</code> после");
    expect(mdToTelegramHtml("```\na\n```")).toBe("<pre>a</pre>");
  });
});
