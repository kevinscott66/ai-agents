/**
 * Аудит 2026-09-11, путь отправки в Telegram — три дыры и один указатель
 * не туда.
 *
 * 1. `tgSendPhoto` терял подпись молча. Первую часть снимали
 *    деструктуризацией с ложным non-null (`head!`), а у `splitForTelegram`
 *    есть ранний выход `if (!text.trim()) return []`: на подписи из одних
 *    пробелов длиннее лимита частей ноль, `head === undefined`, и в
 *    `tg.sendPhoto` уезжало `caption: undefined, parse_mode: "HTML"`
 *    (`mdToTelegramHtml` на undefined не падает). Фото без подписи, `tail`
 *    пуст, ответ — `ok: true` без `captionTailIncomplete`: ни 400, ни лога,
 *    ни признака для модели. Соседний `tgSendDocument` этот случай знает и
 *    проверяет `parts.length === 0` явно.
 *
 * 2. Докстрока `HTML_MESSAGE_FITS` утверждала, что у юзербота «сырая длина и
 *    есть та, что считает Telegram». В самом `userbot.ts` написано обратное:
 *    gramjs применяет `MarkdownParser` клиента, потому тот же метод и
 *    регистрирует РАЗОБРАННЫЙ текст. Юзерботный путь мерил сырую длину и
 *    дробил ответ там, где он уезжал одним сообщением, — плюс лишний слот из
 *    флуд-ведра владельца.
 *
 * 3. `isHtmlParseError` считал отказом разметки любую БЕСКОДОВУЮ ошибку со
 *    словом `entities` в тексте — голая альтернатива в регулярке. Ответ на
 *    такую ошибку один: повторная отправка плейном, то есть ВТОРОЙ экземпляр
 *    сообщения в чате, если запрос до Telegram дошёл.
 *
 * 4. Комментарий в `tgSetReaction` слал за обоснованием к докстроке `tgRetry`
 *    «ниже», а она выше по файлу.
 *
 * Чего этот файл НЕ покрывает: живого gramjs-клиента здесь нет, разбор
 * markdown проверяется тем же `MarkdownParser`, что грузит `userbot.ts`, а не
 * ответом Telegram.
 */
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { dispatchAction } from "../lib/action-dispatch.ts";
import { _resetRateLimits } from "../lib/rate-limits.ts";
import { setAutonomy } from "../lib/permissions.ts";
import { cleanupChat, saveAutonomy, restoreAutonomy } from "./_helpers.ts";
import { tgSendPhoto } from "../lib/telegram-actions.ts";
import { isHtmlParseError } from "../lib/telegram-format.ts";
import { splitForTelegram, userbotPartFits } from "../lib/telegram-chunking.ts";
import { loadUserbotTextParser } from "../lib/userbot.ts";

const ACTIONS = readFileSync(
  new URL("../lib/telegram-actions.ts", import.meta.url).pathname,
  "utf8",
);
const CHUNKING = readFileSync(
  new URL("../lib/telegram-chunking.ts", import.meta.url).pathname,
  "utf8",
);

/** Многострочный `//`-комментарий склеивается: фраза может переноситься. */
const flat = (s: string) => s.replace(/\n\s*\/\/ ?/g, " ").replace(/\s+/g, " ");

type PhotoCall = { caption?: string; parseMode?: string };

const fakeTg = () => {
  const photos: PhotoCall[] = [];
  const messages: string[] = [];
  return {
    photos,
    messages,
    tg: {
      sendPhoto: (
        _chatId: number,
        _photo: unknown,
        extra?: { caption?: string; parse_mode?: string },
      ) => {
        photos.push({ caption: extra?.caption, parseMode: extra?.parse_mode });
        return Promise.resolve({ message_id: 7 });
      },
      sendMessage: (_chatId: number, text: string) => {
        messages.push(text);
        return Promise.resolve({ message_id: 8 });
      },
    } as any,
  };
};

describe("tgSendPhoto: подпись, от которой после резки ничего не осталось", () => {
  test("в Bot API не уходит caption: undefined с parse_mode", async () => {
    const f = fakeTg();
    const res = await tgSendPhoto(f.tg, {
      chatId: -1,
      photo: { url: "https://example.invalid/a.png" },
      caption: " ".repeat(1500),
    });
    expect(res.ok).toBe(true);
    expect(f.photos).toHaveLength(1);
    // До правки: { caption: undefined, parseMode: "HTML" }.
    expect(f.photos[0]!.caption).toBeUndefined();
    expect(f.photos[0]!.parseMode).toBeUndefined();
  });

  test("хвост подписи при этом не досылается отдельными сообщениями", async () => {
    const f = fakeTg();
    await tgSendPhoto(f.tg, {
      chatId: -1,
      photo: { url: "https://example.invalid/a.png" },
      caption: "\n\n   \t  \n".repeat(400),
    });
    expect(f.messages).toHaveLength(0);
  });

  test("обычная подпись по-прежнему доезжает разметкой", async () => {
    const f = fakeTg();
    await tgSendPhoto(f.tg, {
      chatId: -1,
      photo: { url: "https://example.invalid/a.png" },
      caption: "**жирный** заголовок",
    });
    expect(f.photos[0]!.parseMode).toBe("HTML");
    expect(f.photos[0]!.caption).toContain("<b>жирный</b>");
  });

  test("отсутствие подписи ведёт себя как раньше", async () => {
    const f = fakeTg();
    const res = await tgSendPhoto(f.tg, {
      chatId: -1,
      photo: { url: "https://example.invalid/a.png" },
    });
    expect(res).toEqual({ ok: true, messageId: 7 });
    expect(f.photos[0]!.caption).toBeUndefined();
  });

  test("ложного non-null на первой части в файле не осталось", () => {
    expect(ACTIONS).not.toContain("      head!,");
  });
});

describe("isHtmlParseError: догадка только при подтверждённом 400", () => {
  test("бескодовая ошибка со словом entities — не отказ разметки", () => {
    // Такая ошибка приходит и тогда, когда запрос ДОШЁЛ, а сообщение
    // опубликовано: повтор плейном положил бы в чат второй экземпляр.
    expect(
      isHtmlParseError(
        new Error("TypeError: cannot read properties of undefined (reading 'entities')"),
      ),
    ).toBe(false);
    expect(isHtmlParseError({ message: "socket hang up while reading entities" })).toBe(false);
  });

  test("та же формулировка с кодом 400 — отказ разметки", () => {
    expect(
      isHtmlParseError({
        response: { error_code: 400, description: "Bad Request: bad entities somewhere" },
      }),
    ).toBe(true);
  });

  test("фразы самого Telegram распознаются и без кода", () => {
    // telegraf не всегда доносит error_code отдельным полем.
    expect(isHtmlParseError(new Error("can't parse entities"))).toBe(true);
    expect(
      isHtmlParseError(new Error("400: Bad Request: can't parse entities: Unmatched end tag")),
    ).toBe(true);
    expect(isHtmlParseError(new Error("unsupported start tag \"z\""))).toBe(true);
    expect(isHtmlParseError(new Error("unclosed start tag"))).toBe(true);
    expect(isHtmlParseError(new Error("can't find end tag"))).toBe(true);
  });

  test("всё прочее по-прежнему не отказ разметки", () => {
    expect(isHtmlParseError(new Error("fetch failed: ETIMEDOUT"))).toBe(false);
    expect(
      isHtmlParseError({
        response: { error_code: 429, description: "Too Many Requests: retry after 30" },
      }),
    ).toBe(false);
    expect(
      isHtmlParseError({ response: { error_code: 500, description: "can't parse entities" } }),
    ).toBe(false);
  });
});

describe("юзерботная мерка: длина после разбора markdown", () => {
  test("парсер gramjs снимает разметку — сырая длина завышена", async () => {
    const plain = await loadUserbotTextParser();
    expect(plain("a **b** c")).toBe("a b c");
  });

  test("ответ, влезающий после разбора, уезжает одной частью", async () => {
    const body = Array.from(
      { length: 90 },
      (_, i) => `**Пункт ${i}** — короткое пояснение про статус`,
    ).join("\n");
    const plain = await loadUserbotTextParser();
    // Замер: сырых 4039 против разобранных 3679 при пределе 4000.
    expect(body.length).toBeGreaterThan(4000);
    expect(plain(body).length).toBeLessThanOrEqual(4000);
    // До правки здесь было 2 — и два слота из флуд-ведра владельца.
    expect(splitForTelegram(body, undefined, userbotPartFits(plain))).toHaveLength(1);
  });

  test("то, что не влезает и после разбора, по-прежнему дробится", async () => {
    const plain = await loadUserbotTextParser();
    const body = "я".repeat(9000);
    expect(
      splitForTelegram(body, undefined, userbotPartFits(plain)).length,
    ).toBeGreaterThan(1);
  });

  test("падение разбора части не роняет резку, а возвращает к сырой длине", () => {
    const boom = () => {
      throw new Error("parse failed");
    };
    const fits = userbotPartFits(boom);
    expect(fits("x".repeat(10))).toBe(true);
    expect(fits("x".repeat(9000))).toBe(false);
  });
});

describe("докстроки и указатели", () => {
  test("HTML_MESSAGE_FITS больше не приписывает юзерботу сырую мерку", () => {
    const doc = CHUNKING.slice(
      CHUNKING.indexOf("Мерка части для отправителей с `parse_mode"),
      CHUNKING.indexOf("export const HTML_MESSAGE_FITS"),
    );
    expect(doc.length).toBeGreaterThan(0);
    expect(doc).not.toContain("там сырая\n * длина и есть та, что считает Telegram");
    expect(doc).toContain("userbotPartFits");
  });

  test("tgSetReaction больше не шлёт за tgRetry вниз по файлу", () => {
    const body = ACTIONS.slice(
      ACTIONS.indexOf("export async function tgSetReaction"),
      ACTIONS.indexOf("export interface TgEditMessageArgs"),
    );
    expect(body.length).toBeGreaterThan(0);
    expect(flat(body)).not.toContain("докстроку у tgRetry ниже");
    // tgRetry действительно объявлен раньше — иначе указатель снова солжёт.
    expect(ACTIONS.indexOf("function tgRetry<T>")).toBeLessThan(
      ACTIONS.indexOf("export async function tgSetReaction"),
    );
  });

  test("знание о парс-моде gramjs лежит в одном месте", () => {
    const UB = readFileSync(
      new URL("../lib/userbot.ts", import.meta.url).pathname,
      "utf8",
    );
    expect(UB.match(/extensions\/markdown\.js/g) ?? []).toHaveLength(1);
  });
});

describe("юзерботный путь диспетчера мерит то же, что Telegram", () => {
  const CHAT = -1_000_911;
  const prevAutonomy = saveAutonomy();

  beforeEach(() => {
    _resetRateLimits();
    cleanupChat(CHAT, "orchestrator");
    setAutonomy("chat", String(CHAT), "auto");
  });
  afterAll(() => {
    cleanupChat(CHAT, "orchestrator");
    restoreAutonomy(prevAutonomy);
  });

  const fakeUb = () => {
    const calls: string[] = [];
    return {
      calls,
      ub: {
        isNoop: false,
        async sendMessage(_c: number, t: string) {
          calls.push(t);
          return { message_id: calls.length };
        },
      } as never,
    };
  };

  test("ответ, влезающий после разбора markdown, уходит одним сообщением", async () => {
    const body = Array.from(
      { length: 90 },
      (_, i) => `**Пункт ${i}** — короткое пояснение про статус`,
    ).join("\n");
    expect(body.length).toBeGreaterThan(4000); // сырых 4039

    const { ub, calls } = fakeUb();
    const res = await dispatchAction(
      "SEND_MESSAGE",
      { text: body, via_userbot: true } as never,
      { agentKey: "orchestrator", chatId: CHAT, userbot: ub, telegram: undefined } as never,
    );
    expect(res.ok).toBe(true);
    // До правки: две части с префиксами «(1/2) » и «(2/2) », и два слота
    // из флуд-ведра владельца вместо одного.
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toMatch(/^\(\d+\/\d+\) /);
    expect(calls[0]).toBe(body);
  });

  test("то, что не влезает и после разбора, по-прежнему дробится", async () => {
    const { ub, calls } = fakeUb();
    const res = await dispatchAction(
      "SEND_MESSAGE",
      { text: "я".repeat(9000), via_userbot: true } as never,
      { agentKey: "orchestrator", chatId: CHAT, userbot: ub, telegram: undefined } as never,
    );
    expect(res.ok).toBe(true);
    expect(calls.length).toBeGreaterThan(1);
    expect(calls[0]).toMatch(/^\(1\/\d+\) /);
  });
});
