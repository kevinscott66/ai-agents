/**
 * Аудит 2026-08-20: жёсткая резка ставила окно по СЫРОЙ длине и умела только
 * ужиматься.
 *
 * `hardSlice` начинал с `end = i + limit` — то есть отмерял limit СИМВОЛОВ, —
 * а затем в цикле сокращал окно, пока `fits` не согласится. Раздвинуть его,
 * если мерка разрешает больше, было нечем. Когда `fits` меряет ВИДИМУЮ длину
 * (htmlPartFits, путь с parse_mode), а текст полон markdown-ссылок, сырая
 * длина в 2.5 раза больше видимой — и окно в 1000 сырых символов вмещает
 * ~380 видимых при разрешённых 1000.
 *
 * Это зеркало дефекта, найденного аудитом 2026-08-12 этажом выше: там решение
 * «резать ли» принимали по видимой длине, а резали по сырой, и пост дробился
 * зря. Здесь тот же разрыв с обратным знаком — куски выходят втрое короче
 * разрешённого, один абзац превращается в пять сообщений вместо двух.
 *
 * Инварианты, которые фикс НЕ имеет права сломать (их сторожат тесты ниже):
 * ни одна часть не превышает мерку; суррогатные пары не рвутся; markdown-
 * ссылка не рвётся посередине; цикл всегда двигается вперёд.
 */
import { test, expect, describe } from "bun:test";
import {
  splitForTelegram,
  htmlPartFits,
} from "../lib/telegram-chunking.ts";
import { plainTelegramLength } from "../lib/telegram-format.ts";

/** Абзац без переносов из ссылок — сырая длина много больше видимой. */
function linkyParagraph(n: number): string {
  const items: string[] = [];
  for (let k = 0; k < n; k++) {
    items.push(`пункт ${k} [Подробнее →](https://delabs.space/digest/9f3c2a1b7c${k})`);
  }
  return items.join(" ");
}

const CAPTION_LIMIT = 1000;

describe("окно раздвигается до того, что реально влезает по мерке", () => {
  const text = linkyParagraph(100); // plain ~2090 при лимите 1000 — минимум 3 части
  const fits = htmlPartFits(CAPTION_LIMIT);
  const parts = splitForTelegram(text, CAPTION_LIMIT, fits);

  test("сырая длина абзаца существенно больше видимой — иначе тест ничего не мерит", () => {
    expect(text).not.toContain("\n");
    expect(text.length).toBeGreaterThan(plainTelegramLength(text) * 2);
  });

  test("части используют разрешённую видимую длину, а не сырое окно", () => {
    // Все части кроме последней должны быть заметно заполнены. Прежний код
    // давал ~380 при разрешённых 1000.
    const head = parts.slice(0, -1);
    expect(head.length).toBeGreaterThan(0);
    for (const p of head) {
      expect(plainTelegramLength(p)).toBeGreaterThan(CAPTION_LIMIT * 0.6);
    }
  });

  test("число частей близко к теоретическому минимуму", () => {
    const minimum = Math.ceil(plainTelegramLength(text) / CAPTION_LIMIT);
    expect(parts.length).toBeLessThanOrEqual(minimum + 1);
  });
});

describe("инварианты резки не сломаны", () => {
  test("ни одна часть не превышает мерку", () => {
    const fits = htmlPartFits(CAPTION_LIMIT);
    for (const p of splitForTelegram(linkyParagraph(40), CAPTION_LIMIT, fits)) {
      expect(fits(p)).toBe(true);
    }
  });

  test("сырая мерка по умолчанию: части не длиннее лимита", () => {
    const text = "я".repeat(9000);
    for (const p of splitForTelegram(text, 1000)) {
      expect(p.length).toBeLessThanOrEqual(1000);
    }
  });

  test("суррогатная пара не разрывается", () => {
    const text = "🔥".repeat(3000);
    for (const p of splitForTelegram(text, 1000)) {
      expect(p).toBe(
        [...p].join(""), // перебор по code points восстановит только целые пары
      );
      const last = p.charCodeAt(p.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });

  test("markdown-ссылка не рвётся посередине", () => {
    const fits = htmlPartFits(CAPTION_LIMIT);
    for (const p of splitForTelegram(linkyParagraph(100), CAPTION_LIMIT, fits)) {
      const open = p.lastIndexOf("[");
      expect(open > p.lastIndexOf(")")).toBe(false);
    }
  });

  test("ничего не потеряно и не задвоено: склейка частей даёт исходный текст", () => {
    const text = linkyParagraph(100);
    const parts = splitForTelegram(text, CAPTION_LIMIT, htmlPartFits(CAPTION_LIMIT));
    expect(parts.join("")).toBe(text);
  });

  test("текст, влезающий целиком, остаётся одной частью", () => {
    const text = linkyParagraph(3);
    const parts = splitForTelegram(text, CAPTION_LIMIT, htmlPartFits(CAPTION_LIMIT));
    expect(parts).toEqual([text]);
  });

  test("строка из одних пробелов не даёт пустых частей", () => {
    expect(splitForTelegram("x\n\n" + " ".repeat(5000) + "\n\ny", 1000)).toEqual(["x", "y"]);
  });

  test("цикл двигается вперёд даже при мерке, которая почти ничего не пропускает", () => {
    const parts = splitForTelegram("абвгде".repeat(200), 1000, (s) => s.length <= 3);
    expect(parts.length).toBeGreaterThan(0);
    expect(parts.join("")).toBe("абвгде".repeat(200));
  });
});
