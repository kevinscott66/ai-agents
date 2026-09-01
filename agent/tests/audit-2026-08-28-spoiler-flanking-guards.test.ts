/**
 * Аудит 2026-08-28: две логические дизъюнкции в строке прятали текст под спойлер.
 *
 * Правило шага 10 было `/\|\|([^\n|]+?)\|\|/g` — ни границ слова, ни запрета
 * на пробел вокруг пары. Любые два `||` в одной строке склеивались в спойлер:
 * `"if (a || b || c) return"` уходило как `"if (a <tg-spoiler> b </tg-spoiler>
 * c) return"` — кусок текста в чате и в канале становился СКРЫТЫМ под тап, а
 * сами `||` пропадали.
 *
 * Зеркало дефекта, который этот файл чинил дважды в обратную сторону (аудит
 * 2026-08-13 и 2026-08-20: помеченное автором как скрытое уходило видимым).
 * Здесь непомеченное уходит невидимым. Ошибки Telegram нет: `<tg-spoiler>` —
 * валидная сущность, значит ни 400, ни плейн-фолбэка.
 *
 * Охраны взяты те же, что у одиночного `_` (аудит 2026-08-27): границы слова
 * с обеих сторон плюс запрет пробела сразу за открывающей парой и перед
 * закрывающей.
 */
import { describe, expect, test } from "bun:test";
import { mdToTelegramHtml } from "../lib/telegram-format.ts";

describe("дизъюнкции не становятся спойлером", () => {
  test("две пары с пробелами вокруг", () => {
    expect(mdToTelegramHtml("if (a || b || c) return")).toBe("if (a || b || c) return");
  });

  test("две пары вплотную к именам", () => {
    expect(mdToTelegramHtml("if (a||b||c) return")).toBe("if (a||b||c) return");
  });

  test("пробел сразу за открывающей парой не открывает", () => {
    expect(mdToTelegramHtml("|| пусто ||")).toBe("|| пусто ||");
  });

  test("одинокая пара остаётся текстом", () => {
    expect(mdToTelegramHtml("a || b")).toBe("a || b");
  });
});

describe("настоящий спойлер по-прежнему прячется", () => {
  test("одно слово", () => {
    expect(mdToTelegramHtml("||секрет||")).toBe("<tg-spoiler>секрет</tg-spoiler>");
  });

  test("спойлер внутри предложения", () => {
    expect(mdToTelegramHtml("текст ||секрет|| хвост")).toBe(
      "текст <tg-spoiler>секрет</tg-spoiler> хвост",
    );
  });

  test("две пары в строке не слипаются", () => {
    expect(mdToTelegramHtml("||a|| и ||b||")).toBe(
      "<tg-spoiler>a</tg-spoiler> и <tg-spoiler>b</tg-spoiler>",
    );
  });

  test("спойлер в скобках", () => {
    expect(mdToTelegramHtml("(||x||)")).toBe("(<tg-spoiler>x</tg-spoiler>)");
  });

  test("спойлер после двоеточия и перед точкой", () => {
    expect(mdToTelegramHtml("ответ:||42||.")).toBe("ответ:<tg-spoiler>42</tg-spoiler>.");
  });

  test("спойлер из нескольких слов", () => {
    expect(mdToTelegramHtml("||два слова||")).toBe("<tg-spoiler>два слова</tg-spoiler>");
  });

  test("спойлер в начале строки после переноса", () => {
    expect(mdToTelegramHtml("первая\n||секрет||")).toBe(
      "первая\n<tg-spoiler>секрет</tg-spoiler>",
    );
  });
});
