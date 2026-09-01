/**
 * Аудит 2026-08-29: шесть находок на пути «текст → разметка → канал».
 *
 * Общее у всех: разметка получается формально валидной, поэтому ни 400 от
 * Telegram, ни плейн-фолбэка, ни отката — пост уходит успешно и изменённым.
 * На пути юзербота (публикация в канал) отката нет вовсе.
 *
 *  1. Плейсхолдеры кода утекали ВНУТРЬ href. Шаги 1-2 конвертера подменяют
 *     инлайн-код на `NUL I<n> NUL`, а классы URL на шагах 4 и 4b были
 *     `[^\s)]+` и `[^\s<>"]+` — NUL не пробел и не скобка. Восстановление идёт
 *     последним, уже после balanceHtmlTags, и разворачивало плейсхолдер прямо
 *     в атрибуте: ссылка в опубликованном посте вела в никуда. У юзербота
 *     gramjs делает из этого MessageEntityTextUrl с мусорным адресом — без
 *     ошибки и уже ПОСЛЕ апрува владельца.
 *
 *  2. Вложенный тег с тем же именем. `**` и `__` дают один и тот же `<b>`,
 *     `*` и `_` — один и тот же `<i>`, стек balanceHtmlTags такую вложенность
 *     считал корректной. `HTMLToTelegramParser` в gramjs держит
 *     `_buildingEntities` по ИМЕНИ тега: внутренний затирает внешний, первая
 *     закрывашка его закрывает, второй закрывать уже нечего. Половина
 *     оформления терялась.
 *
 *  3. `cutBlock` резал по любой квадратной скобке: `open > lastIndexOf(")")`
 *     при отсутствии круглых скобок истинно всегда.
 *
 *  4. `plainInline` снимал скобки, бэктики, звёздочки и парные формы, но не
 *     ведущий `>`. Значение из `field()` ставится СВОЕЙ строкой, и «>! Секрет»
 *     публиковался раскрывающейся цитатой. Ровно эту угрозу называет докблок
 *     `itemEmoji`, но охраняет там только поле emoji.
 *
 *  5. `EMOJI_ONLY` — класс из одних модификаторов, поэтому одинокий ZWJ
 *     проходил за маркер пункта. Маркер невидим, пункт начинается с пробела.
 *
 *  6. `bot.catch` ждал `ctx.reply` без потолка. Телеграф зовёт `handleError`
 *     изнутри `await Promise.all(updates.map(handleUpdate))` своего
 *     Polling.loop, у bun-овского `fetch` дефолтного таймаута нет, свой
 *     `signal` телеграф принимает только в конструкторе клиента. Повисшее
 *     соединение вешало поллинг бота навсегда, и `launchWithRestart` его не
 *     перезапускал: отказа-то нет.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { HTMLParser } from "telegram/extensions/html.js";
import { Api } from "telegram";
import { cutBlock, mdToTelegramHtml } from "../lib/telegram-format.ts";
import { itemEmoji, plainInline } from "../lib/delabs-text.ts";
import { buildErrorGuard } from "../lib/bot-error-guard.ts";

/** Код без комментариев: построчно, чтобы блочный комментарий не съел код за ним. */
function stripComments(src: string): string {
  let inBlock = false;
  return src
    .split("\n")
    .map((line) => {
      let out = "";
      for (let i = 0; i < line.length; i++) {
        if (inBlock) {
          if (line.startsWith("*/", i)) {
            inBlock = false;
            i += 1;
          }
          continue;
        }
        if (line.startsWith("/*", i)) {
          inBlock = true;
          i += 1;
          continue;
        }
        if (line.startsWith("//", i)) break;
        out += line[i];
      }
      return out;
    })
    .join("\n");
}

/** Значение атрибута href целиком — то, что реально уедет в MessageEntityTextUrl. */
function hrefs(html: string): string[] {
  return [...html.matchAll(/<a href="([^"]*)"/g)].map((m) => m[1]!);
}

describe("плейсхолдеры кода не попадают в href", () => {
  test("инлайн-код внутри markdown-ссылки не уезжает в адрес", () => {
    const out = mdToTelegramHtml("See [doc](https://x.tld/a`v1`/b) now");
    for (const href of hrefs(out)) {
      expect(href).not.toContain("<code>");
      expect(href).not.toContain("\u0000");
    }
    // Разметка не собралась — и это правильный исход: видимая поломка лучше
    // тихо подменённого адреса. Содержимое при этом на месте целиком.
    expect(out).toContain("v1");
    expect(out).toContain("doc");
  });

  test("блок кода внутри markdown-ссылки не уезжает в адрес", () => {
    const out = mdToTelegramHtml("[doc](https://x.tld/```a```)");
    for (const href of hrefs(out)) expect(href).not.toContain("<pre>");
  });

  test("инлайн-код внутри голой ссылки не уезжает в адрес", () => {
    const out = mdToTelegramHtml("see https://x.tld/`a`b here");
    for (const href of hrefs(out)) expect(href).not.toContain("<code>");
    // Голую ссылку Telegram линкует сам, атрибута тут нет вовсе; важно, что
    // код остался кодом, ссылка оборвалась по границе плейсхолдера, а сам
    // плейсхолдер не уехал читателю.
    expect(out).toBe("see https://x.tld/<code>a</code>b here");
    expect(out).not.toContain("\u0000");
  });

  test("контроль: обычная ссылка по-прежнему собирается", () => {
    const out = mdToTelegramHtml("See [doc](https://x.tld/a/b) now");
    expect(hrefs(out)).toEqual(["https://x.tld/a/b"]);
    expect(out).toContain(">doc</a>");
  });
});

describe("вложенный тег с тем же именем не режет сущность", () => {
  /** Сущности ровно так, как их увидит юзербот при публикации в канал. */
  function entities(html: string): { text: string; ents: Api.TypeMessageEntity[] } {
    const [text, ents] = HTMLParser.parse(html);
    return { text, ents };
  }

  test("одинарный курсив внутри одинарного курсива не обрывается", () => {
    const html = mdToTelegramHtml("*это _очень_ важно*");
    expect(html).toBe("<i>это очень важно</i>");
    const { text, ents } = entities(html);
    expect(text).toBe("это очень важно");
    const italics = ents.filter((e) => e instanceof Api.MessageEntityItalic);
    expect(italics.length).toBe(1);
    expect(italics[0]!.offset).toBe(0);
    expect(italics[0]!.length).toBe(text.length);
  });

  test("жирный внутри жирного не обрывается", () => {
    const html = mdToTelegramHtml("**жирный __важно__ хвост**");
    expect(html).toBe("<b>жирный важно хвост</b>");
    const { text, ents } = entities(html);
    const bolds = ents.filter((e) => e instanceof Api.MessageEntityBold);
    expect(bolds.length).toBe(1);
    expect(bolds[0]!.length).toBe(text.length);
  });

  test("контроль: разные имена вложены и обе сущности сохранены", () => {
    const html = mdToTelegramHtml("**жирный *курсив* хвост**");
    expect(html).toBe("<b>жирный <i>курсив</i> хвост</b>");
    const { ents } = entities(html);
    expect(ents.filter((e) => e instanceof Api.MessageEntityBold).length).toBe(1);
    expect(ents.filter((e) => e instanceof Api.MessageEntityItalic).length).toBe(1);
  });
});

describe("cutBlock не путает скобки прозы с обрывом ссылки", () => {
  const fitsTo = (max: number) => (c: string) => c.length <= max;

  test("текст в квадратных скобках переживает обрезку", () => {
    const block = "Дроп подтверждён [ANNOUNCED] — детали ниже, читайте внимательно.";
    const out = cutBlock(block, fitsTo(40));
    expect(out).toContain("ANNOUNCED");
    expect(out.length).toBeLessThanOrEqual(40);
  });

  test("оборванная ссылка по-прежнему отрезается целиком", () => {
    const block = "Смотри тут [гайд](https://delabs.space/guide/very/long/path) и всё";
    const out = cutBlock(block, fitsTo(30));
    expect(out).not.toContain("https://");
    expect(out).not.toContain("](");
  });

  test("оборванная подпись без закрывающей скобки тоже отрезается", () => {
    const block = "Смотри тут [очень длинная подпись ссылки без закрытия";
    const out = cutBlock(block, fitsTo(30));
    expect(out).not.toContain("[");
  });
});

describe("plainInline снимает построчные маркеры", () => {
  test.each([
    [">! Секрет внутри.", "Секрет внутри."],
    ["> Цитата целиком.", "Цитата целиком."],
    ["# Заголовок пункта", "Заголовок пункта"],
    ["- Пункт списка", "Пункт списка"],
    ["+ Пункт списка", "Пункт списка"],
    ["  > С отступом", "С отступом"],
    ["> # Сложенные маркеры", "Сложенные маркеры"],
  ])("%p -> %p", (input, expected) => {
    expect(plainInline(input)).toBe(expected);
  });

  test("контроль: знак больше в середине строки не трогаем", () => {
    expect(plainInline("Цена > 100 USD")).toBe("Цена > 100 USD");
  });

  test("контроль: длина не растёт", () => {
    for (const s of [">! x", "обычный текст", "a [b] c", "**жир**"]) {
      expect(plainInline(s).length).toBeLessThanOrEqual(s.length);
    }
  });
});

describe("itemEmoji требует рисующийся символ", () => {
  const INVISIBLE = ["\u200D", "\uFE0F", "\uFE0E", "\u200D\uFE0F"];

  test.each(INVISIBLE)("невидимый маркер отвергается (%#)", (raw) => {
    const got = itemEmoji(raw);
    expect(got).not.toBe(raw);
    expect(/[\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(got)).toBe(true);
  });

  test("контроль: настоящий эмодзи проходит", () => {
    expect(itemEmoji("\u{1F525}")).toBe("\u{1F525}");
  });
});

describe("bot.catch не ждёт Telegram вечно", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown): void => {
    unhandled.push(e);
  };
  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
    unhandled.length = 0;
  });

  function ctxWith(reply: () => Promise<unknown>): unknown {
    return { chat: { id: -100999 }, reply };
  }

  test("зависший reply не держит guard дольше потолка", async () => {
    const guard = buildErrorGuard("qa", ["-100999"], 20);
    const started = Bun.nanoseconds();
    // Промис, который не разрешится никогда: ровно чёрная дыра на соединении.
    await guard(new Error("boom"), ctxWith(() => new Promise(() => {})) as never);
    // Верхняя граница щедрая: проверяем конечность ожидания, а не его точность.
    expect((Bun.nanoseconds() - started) / 1e6).toBeLessThan(2_000);
  });

  test("поздний отказ reply не всплывает как unhandledRejection", async () => {
    process.on("unhandledRejection", onUnhandled);
    const guard = buildErrorGuard("qa", ["-100999"], 10);
    await guard(
      new Error("boom"),
      ctxWith(
        () =>
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error("поздний 502")), 40);
          }),
      ) as never,
    );
    await Bun.sleep(90);
    expect(unhandled).toEqual([]);
  });

  test("контроль: успешный reply отрабатывает как раньше", async () => {
    let sent = "";
    const guard = buildErrorGuard("qa", ["-100999"], 500);
    await guard(
      new Error("boom"),
      ctxWith(async () => {
        sent = "ok";
        return {};
      }) as never,
    );
    expect(sent).toBe("ok");
  });

  test("исходник: ожидание reply обёрнуто потолком", () => {
    const src = readFileSync(new URL("../lib/bot-error-guard.ts", import.meta.url), "utf-8");
    // Комментарии снимаем построчно: докблок потолка цитирует прежний вызов
    // дословно, и гард без чистки ловил бы собственное объяснение.
    const offenders = stripComments(src)
      .split("\n")
      .filter((line) => /await\s+ctx\.reply\(/.test(line));
    expect(offenders).toEqual([]);
    expect(src).toContain("withDeadline(");
  });
});
