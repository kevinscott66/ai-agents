/**
 * Аудит 2026-08-28: между текстом с сайта и сборщиком постов не было ни одного
 * экранирующего шага.
 *
 * Шаблоны подставляют внешние поля прямо в markdown (`эмодзи **{title}**`,
 * `{blurb} [Подробнее →](url)`), а `toTelegramHtml` разбирает всё, что в этом
 * markdown окажется. Одна причина — четыре следствия, и худшее из них тихое:
 * `title` вида «Дроп [жми сюда](https://evil.tld)» публикуется НАСТОЯЩЕЙ
 * ссылкой на чужой домен, а превью на апруве рендерится тем же конвертером и
 * показывает владельцу только подпись «жми сюда».
 *
 * Отдельно — маркер пункта: `emoji` приходит с сайта как шестнадцать любых
 * символов (`readScalar("emoji", …, 16)`) и стоит первым на строке, то есть
 * ровно там, где разметка Telegram работает построчно.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { itemEmoji, plainInline, ITEM_EMOJI } from "../lib/delabs-text.ts";
import { buildWeeklyRecapText } from "../lib/delabs-post-templates.ts";
import { mdToTelegramHtml } from "../lib/telegram-format.ts";

const DEFAULT = ITEM_EMOJI[0]!;
/**
 * Ссылки-теги в собранном посте. Голые `https://…` сюда НЕ попадают: шаг 4b
 * конвертера их только защищает от разметки, а линкует уже сам Telegram — то
 * есть читатель видит полный URL. Прячет домен ровно `[текст](ссылка)`, и
 * именно она обязана остаться только нашей.
 */
function hrefs(md: string): string[] {
  return [...mdToTelegramHtml(md).matchAll(/<a href="([^"]*)"/g)].map((m) => m[1]!);
}

describe("plainInline", () => {
  test("замаскированная ссылка перестаёт быть ссылкой", () => {
    const out = plainInline("Дроп [жми сюда](https://evil.tld)");
    expect(out).toBe("Дроп (жми сюда)(https://evil.tld)");
    // Ссылки-тега больше нет вовсе, а домен виден читателю целиком — это и
    // был весь смысл: подпись «жми сюда» перестала прятать чужой хост.
    expect(hrefs(out)).toEqual([]);
    expect(mdToTelegramHtml(out)).toContain("https://evil.tld");
  });

  test("обратные кавычки не переживают шаг — склеить два пункта нечем", () => {
    expect(plainInline("код ```py")).toBe("код py");
    expect(plainInline("а `b` в")).toBe("а b в");
  });

  test("звёздочки не уезжают читателю сырыми", () => {
    expect(plainInline("Дроп ** внимание")).toBe("Дроп  внимание");
    expect(mdToTelegramHtml(plainInline("Дроп ** внимание"))).not.toContain("*");
  });

  test("парные _ ~ | схлопываются, одиночные живут", () => {
    expect(plainInline("__жирный__")).toBe("_жирный_");
    expect(plainInline("~~зачёркнуто~~")).toBe("~зачёркнуто~");
    expect(plainInline("a || b")).toBe("a | b");
    // Подчёркивание в имени — обычный текст, курсив его уже не трогает.
    expect(plainInline("mint_pass")).toBe("mint_pass");
    expect(mdToTelegramHtml(plainInline("mint_pass"))).toBe("mint_pass");
  });

  test("длина не растёт — потолок oneLine остаётся потолком", () => {
    for (const s of ["[a](b)", "**x**", "```", "___", "~~~~", "||||", "обычный текст"]) {
      expect(plainInline(s).length).toBeLessThanOrEqual(s.length);
    }
  });

  test("голый URL доходит дословно: его линкует Telegram, и домен виден", () => {
    expect(plainInline("см. https://ok.tld/a")).toBe("см. https://ok.tld/a");
    expect(mdToTelegramHtml(plainInline("см. https://ok.tld/a"))).toBe("см. https://ok.tld/a");
  });

  test("пустое и undefined не ломают", () => {
    expect(plainInline("")).toBe("");
    expect(plainInline(undefined as unknown as string)).toBe("");
  });
});

describe("itemEmoji", () => {
  test("настоящие маркеры проходят", () => {
    for (const e of [...ITEM_EMOJI, "👍🏻", "🇷🇺", "⭐️", "❤"]) {
      expect(itemEmoji(e)).toBe(e);
    }
    expect(itemEmoji(" 🔥 ")).toBe("🔥");
  });

  test("не маркер — берём штатный, а не обрубок", () => {
    for (const bad of [
      ">", // цитата: уносила в blockquote весь заголовок пункта
      "[x](https://evil.tld)",
      "A\nB",
      "**",
      "`",
      "текст",
      "1",
      "",
      "   ",
      undefined,
      "🔥🔥", // два кластера — уже не маркер
      "👨‍👩‍👧‍👦", // один кластер, но одиннадцать единиц UTF-16
    ]) {
      expect(itemEmoji(bad as string | undefined)).toBe(DEFAULT);
    }
  });

  test("маркер укладывается в бюджет подписи: не больше четырёх единиц", () => {
    for (const e of [...ITEM_EMOJI, "👍🏻", "🇷🇺", "⭐️", "x".repeat(16)]) {
      expect(itemEmoji(e).length).toBeLessThanOrEqual(4);
    }
  });
});

describe("собранный пост", () => {
  const evil = {
    title: "Дроп [жми сюда](https://evil.tld)",
    blurb: "Забирайте [тут](https://evil.tld/2)",
    emoji: "[x](https://evil.tld/3)",
    url: "https://delabs.space/digest/1",
  };

  test("чужого домена в ссылках поста нет", () => {
    const md = buildWeeklyRecapText({ news: [evil] });
    const links = hrefs(md);
    expect(links).toEqual(["https://delabs.space/digest/1"]);
    for (const l of links) expect(l).not.toContain("evil.tld");
  });

  test("домен виден в тексте, а не спрятан за подписью", () => {
    const md = buildWeeklyRecapText({ news: [evil] });
    expect(md).toContain("(жми сюда)(https://evil.tld)");
  });

  test("маркер не ломает строку пункта", () => {
    const md = buildWeeklyRecapText({ news: [{ ...evil, emoji: "A\nB" }] });
    const head = md.split("\n").find((l) => l.includes("жми сюда"))!;
    expect(head.startsWith(`${DEFAULT} **`)).toBe(true);
  });

  test("три кавычки в разных пунктах больше не склеивают их в один <pre>", () => {
    const md = buildWeeklyRecapText({
      news: [
        { title: "Первый ```", blurb: "текст", url: "https://delabs.space/1" },
        { title: "Второй ```", blurb: "текст", url: "https://delabs.space/2" },
      ],
    });
    const html = mdToTelegramHtml(md);
    expect(html).not.toContain("<pre>");
    // Обе ссылки на месте: раньше первая тонула внутри блока кода.
    expect(hrefs(md)).toEqual(["https://delabs.space/1", "https://delabs.space/2"]);
  });

  test("обычный текст проходит без изменений", () => {
    const md = buildWeeklyRecapText({
      news: [{ title: "Дроп ANNOUNCED", blurb: "Раздача уже идёт", emoji: "💰" }],
    });
    expect(md).toContain("💰 **Дроп ANNOUNCED**");
    expect(md).toContain("Раздача уже идёт.");
  });
});

describe("применение", () => {
  function code(path: string): string {
    return readFileSync(new URL(path, import.meta.url), "utf8")
      .split("\n")
      .filter((l) => {
        const t = l.trimStart();
        return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");
  }

  test("шаблоны берут внешние поля через field(), а не голым oneLine", () => {
    const src = code("../lib/delabs-post-templates.ts");
    for (const f of [
      "field(n.title, 90)",
      "field(n.blurb, 200)",
      "field(a.project, 80)",
      "field(a.done, 200)",
      "field(e.project, 80)",
      "field(e.action, 200)",
      'field(args.ahead ?? "", 200)',
    ]) {
      expect(src).toContain(f);
    }
    expect(src).toContain("plainInline(oneLine(s ?? \"\", max))");
  });

  test("живой путь публикации закрыт тем же шагом", () => {
    // buildChannelText из approve-poll.ts — то, что реально уходит в канал.
    const ap = code("../tools/approve-poll.ts");
    expect(ap).toContain("**${plainInline(a.title)}**");
    expect(ap).toContain('endSentence(plainInline(a.blurb ?? ""))');
    // Превью черновика обязано показывать ровно то же.
    const dd = code("../tools/daily-draft.ts");
    expect(dd).toContain("**${plainInline(a.title)}**");
    expect(dd).toContain('endSentence(plainInline(a.blurb ?? ""))');
  });
});
