/**
 * Аудит 2026-08-14: выделение переписывало символы ВНУТРИ URL.
 *
 * Ссылки подставляются шагом 4 конвертера, а курсив/жирный/зачёркнутый — шагами
 * 5-10. Значит регулярки выделения работали по строке, где URL уже стоял
 * открытым текстом, и правили в нём `_`, `*`, `~`.
 *
 * Две разные беды:
 *
 *  1. Markdown-ссылка. `[док](https://delabs.space/tag/_defi_)` давало
 *     `<a href="https://delabs.space/tag/<i>defi</i>">док</a>` — тег внутри
 *     атрибута, 400 от Telegram, откат на сырой markdown: читатель видит
 *     `[док](…)` буквально.
 *  2. Голая ссылка — хуже. `https://t.me/c/_test_` превращалось в
 *     `https://t.me/c/<i>test</i>`, а это ВАЛИДНЫЙ HTML: ни ошибки, ни
 *     фолбэка. Читателю молча уходит ссылка не туда, и заметить это можно
 *     только по клику.
 *
 * Почему не ловилось: единственная проверка ссылок в tfmt-telegram-format —
 * `mdToTelegramHtml("[t](https://x.com)")`, URL без единого из этих символов.
 * А `_` в URL — норма: слаги статей, ключи в query, ссылки на t.me/c/.
 *
 * Инвариант: URL проходит конвертер дословно. Защита та же, что у кода, —
 * плейсхолдер на время всех шагов разметки.
 */
import { describe, test, expect } from "bun:test";
import { mdToTelegramHtml, plainTelegramLength } from "../lib/telegram-format.ts";

describe("URL проходит конвертер дословно", () => {
  test("подчёркивания в markdown-ссылке не становятся курсивом", () => {
    expect(mdToTelegramHtml("[док](https://delabs.space/tag/_defi_)")).toBe(
      '<a href="https://delabs.space/tag/_defi_">док</a>',
    );
  });

  test("голая ссылка с подчёркиваниями остаётся собой", () => {
    // Самый опасный случай: результат — валидный HTML, фолбэк не сработает.
    expect(mdToTelegramHtml("См. https://t.me/c/_test_ и всё")).toBe(
      "См. https://t.me/c/_test_ и всё",
    );
  });

  test("звёздочки в голой ссылке не становятся жирным", () => {
    expect(mdToTelegramHtml("Гайд: https://delabs.space/a_b_c/x**y**z")).toBe(
      "Гайд: https://delabs.space/a_b_c/x**y**z",
    );
  });

  test("тильды в markdown-ссылке не становятся зачёркиванием", () => {
    expect(mdToTelegramHtml("[t](https://x.com/a~~b~~c)")).toBe(
      '<a href="https://x.com/a~~b~~c">t</a>',
    );
  });

  test("query со служебными символами не трогается", () => {
    const md = "[отчёт](https://delabs.space/r?a=_1_&b=**2**&c=~~3~~)";
    const out = mdToTelegramHtml(md);
    expect(out).toContain("a=_1_");
    expect(out).toContain("b=**2**");
    expect(out).toContain("c=~~3~~");
    expect(out).not.toContain("<i>");
    expect(out).not.toContain("<b>");
    expect(out).not.toContain("<s>");
  });
});

describe("защита URL не сломала остального", () => {
  test("текст ссылки по-прежнему форматируется", () => {
    expect(mdToTelegramHtml("[**жирный** текст](https://x.com/a)")).toBe(
      '<a href="https://x.com/a"><b>жирный</b> текст</a>',
    );
  });

  test("выделение вокруг ссылки работает", () => {
    expect(mdToTelegramHtml("_см._ https://x.com/a_b_ дальше")).toBe(
      "<i>см.</i> https://x.com/a_b_ дальше",
    );
  });

  test("кавычка в URL по-прежнему экранируется", () => {
    expect(mdToTelegramHtml('[t](https://x.com/a"b)')).toBe(
      '<a href="https://x.com/a%22b">t</a>',
    );
  });

  test("ссылка внутри инлайн-кода остаётся кодом", () => {
    expect(mdToTelegramHtml("`https://x.com/a_b_`")).toBe(
      "<code>https://x.com/a_b_</code>",
    );
  });

  test("ссылка внутри блока кода остаётся блоком", () => {
    expect(mdToTelegramHtml("```\nhttps://x.com/a_b_\n```")).toBe(
      "<pre>https://x.com/a_b_</pre>",
    );
  });

  test("плейсхолдер не течёт наружу ни в одном виде", () => {
    const out = mdToTelegramHtml(
      "Список:\n- [a](https://x.com/_1_)\n- b https://y.com/_2_\n\n> цитата https://z.com/_3_",
    );
    expect(out).not.toContain("\u0000");
    expect(out).not.toMatch(/U\d/);
    expect(out).toContain("https://x.com/_1_");
    expect(out).toContain("https://y.com/_2_");
    expect(out).toContain("https://z.com/_3_");
  });

  test("мерка длины не поехала: ссылка весит как её текст", () => {
    // От этого счёта зависит, дробить ли пост, — см. telegram-actions.
    expect(plainTelegramLength("[док](https://delabs.space/tag/_defi_)")).toBe(3);
  });

  test("голая ссылка весит собой", () => {
    const url = "https://t.me/c/_test_";
    expect(plainTelegramLength(url)).toBe(url.length);
  });

  test("несколько ссылок в строке восстанавливаются по своим местам", () => {
    const out = mdToTelegramHtml(
      "[один](https://a.test/_1_) и [два](https://b.test/_2_)",
    );
    expect(out).toBe(
      '<a href="https://a.test/_1_">один</a> и <a href="https://b.test/_2_">два</a>',
    );
  });
});
