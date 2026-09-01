/**
 * T-813: перекрёстная разметка (`**жирный _кур** сив_`) давала невалидный HTML
 * — `<b>жирный <i>кур</b> сив</i>`. Telegram отвечал 400 «can't parse entities:
 * Unmatched end tag», sendWithHtml откатывался на plain text, и пост уходил
 * вообще без форматирования.
 *
 * Проверяем ровно два свойства: (1) на выходе теги строго вложены, (2) текст
 * не теряется — снимается только разметка перекрёстного куска.
 */
import { describe, expect, test } from "bun:test";
import { balanceHtmlTags, mdToTelegramHtml } from "../lib/telegram-format.ts";

const TAG_RE = /<(\/?)([a-z][a-z0-9-]*)(?:\s[^>]*)?>/gi;

/** Строго ли вложены теги: тот же стек, что применяет парсер Telegram. */
function isWellNested(html: string): boolean {
  const stack: string[] = [];
  for (const m of html.matchAll(TAG_RE)) {
    const name = m[2]!.toLowerCase();
    if (m[1] === "/") {
      if (stack.pop() !== name) return false;
    } else {
      stack.push(name);
    }
  }
  return stack.length === 0;
}

/** Видимый текст без тегов — он обязан пережить лечение целиком. */
function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

describe("T-813 — перекрёстное выделение", () => {
  test("жирный, перекрещенный курсивом, даёт валидный HTML", () => {
    const out = mdToTelegramHtml("**bold _it** alic_");
    expect(isWellNested(out)).toBe(true);
    expect(stripTags(out)).toBe("bold it alic");
    // Пара, чей закрывающий тег перекрестился, снимается целиком;
    // вложенный курсив остаётся.
    expect(out).toBe("bold <i>it alic</i>");
  });

  test("зачёркнутый, перекрещенный жирным, даёт валидный HTML", () => {
    const out = mdToTelegramHtml("~~strike **bold~~ tail**");
    expect(isWellNested(out)).toBe(true);
    expect(stripTags(out)).toBe("strike bold tail");
    expect(out).toBe("strike <b>bold tail</b>");
  });

  test("корректная вложенность не трогается", () => {
    // Три обычных случая: вложенный курсив, ссылка внутри жирного и спойлер.
    expect(mdToTelegramHtml("**bold _it_ tail**")).toBe(
      "<b>bold <i>it</i> tail</b>",
    );
    expect(mdToTelegramHtml("**[link](https://a.io) tail**")).toBe(
      '<b><a href="https://a.io">link</a> tail</b>',
    );
    expect(mdToTelegramHtml("||spoiler **b**||")).toBe(
      "<tg-spoiler>spoiler <b>b</b></tg-spoiler>",
    );
  });

  test("код и текст с угловыми скобками не задеты", () => {
    // Плейсхолдеры кода восстанавливаются ПОСЛЕ балансировщика, а `<` в тексте
    // экранирован ещё на шаге 3 — значит балансировщик видит только наши теги.
    const out = mdToTelegramHtml("`a < b` и **x _y** z_");
    expect(out).toContain("<code>a &lt; b</code>");
    expect(isWellNested(out)).toBe(true);
    expect(mdToTelegramHtml("2 < 3 и **ok**")).toBe("2 &lt; 3 и <b>ok</b>");
  });

  test("непарные теги снимаются с обеих сторон", () => {
    expect(balanceHtmlTags("<b>висит открытый")).toBe("висит открытый");
    expect(balanceHtmlTags("висит закрытый</i>")).toBe("висит закрытый");
    expect(balanceHtmlTags("чистый <b>текст</b>")).toBe("чистый <b>текст</b>");
  });

  test("тройной перехлёст сводится к валидному HTML", () => {
    const out = balanceHtmlTags("<b>1<i>2<s>3</i>4</b>5</s>6");
    expect(isWellNested(out)).toBe(true);
    expect(stripTags(out)).toBe("123456");
  });

  test("текст без тегов проходит насквозь", () => {
    const plain = "просто текст без разметки";
    expect(balanceHtmlTags(plain)).toBe(plain);
    expect(balanceHtmlTags("")).toBe("");
  });
});
