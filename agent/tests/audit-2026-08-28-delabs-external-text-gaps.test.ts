/**
 * Аудит 2026-08-28: три щели во внешних данных на пути в опубликованный пост.
 *
 * 1. `oneLine` чинила одинокий суррогат только СВОЙ, из обрезки: в классе
 *    `[\p{Cc}\p{Cf}]` нет `\p{Cs}`, и половинка, пришедшая из JSON сайта,
 *    проходила насквозь. В UTF-8 она кодируется как EF BF BD — в канале «».
 * 2. `moreLink` не проверяла адрес ничем, кроме `trim()`. Адрес собирается как
 *    `${SITE_BASE}/digest/${id}` из env, и `DELABS_SITE_BASE=delabs.space`
 *    (или пустое значение) давали href без схемы. Telegram на такой отвечает
 *    «unsupported URL protocol» — не уходит ВЕСЬ пост, а не одна ссылка.
 * 3. Заголовок пункта печатался как `**${field(...)}**` без проверки. `field`
 *    умеет вернуть пустоту из непустого входа: `"\u200B\u200B"` переживает
 *    `trim()` (Cf, а не пробел) и вычищается уже внутри `oneLine`. В канал
 *    уходило `🔥 ****`.
 *
 * Плюс мелочь оттуда же: ссылка несла собственный ведущий пробел и при пустом
 * `blurb`/`action` строка пункта начиналась с пробела.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { oneLine } from "../lib/delabs-text.ts";
import { buildActivityRunText, buildWeeklyRecapText } from "../lib/delabs-post-templates.ts";

const WEEK_END = new Date("2026-07-12T12:00:00.000Z");
const LINK = "https://delabs.space/digest/1";
const ZWSP = "\u200B\u200B";

function weekly(news: Parameters<typeof buildWeeklyRecapText>[0]["news"]): string {
  return buildWeeklyRecapText({ news, weekEnd: WEEK_END });
}

describe("одинокий суррогат снаружи", () => {
  test("предпосылки: в UTF-8 это «», и JSON его порождает", () => {
    expect(Buffer.from("a\uD83Db", "utf8").toString("hex")).toBe("61efbfbd62");
    expect(JSON.parse('"\\ud83d"')).toBe("\uD83D");
  });

  test("непарная половинка не доезжает до поста", () => {
    expect(oneLine("a\uD83Db")).toBe("a b");
    expect(oneLine("тест\uD83D")).toBe("тест");
    expect(oneLine("\uDC69начало")).toBe("начало");
  });

  test("целый эмодзи и ZWJ-семья не задеты", () => {
    expect(oneLine("a🔥b")).toBe("a🔥b");
    expect(oneLine("Команда 👨‍💻 работает")).toBe("Команда 👨‍💻 работает");
    expect(oneLine("🇷🇺 флаг")).toBe("🇷🇺 флаг");
  });

  test("в готовом посте половинки тоже нет", () => {
    const text = weekly([{ title: "Дроп\uD83D", blurb: "Коротко\uDC00.", url: LINK }]);
    expect(text).not.toContain("\uD83D");
    expect(text).not.toContain("\uDC00");
  });
});

describe("ссылка пункта", () => {
  test("адрес без схемы ссылкой не становится", () => {
    for (const bad of [
      "delabs.space/digest/1",
      "/digest/1",
      "digest/1",
      "javascript:alert(1)",
      "ftp://delabs.space/x",
      "https://delabs.space/a(b)c",
      "https://delabs.space/a b",
    ]) {
      const text = weekly([{ title: "Дроп", blurb: "Коротко.", url: bad }]);
      expect(text).toContain("Коротко.");
      expect(text).not.toContain("Подробнее");
      expect(text).not.toContain(bad);
    }
  });

  test("http и https проходят как раньше", () => {
    for (const good of [LINK, "http://delabs.space/digest/1", "HTTPS://DELABS.SPACE/1"]) {
      expect(weekly([{ title: "Дроп", blurb: "Коротко.", url: good }])).toContain(
        `[Подробнее →](${good})`,
      );
    }
  });

  test("между текстом и ссылкой ровно один пробел", () => {
    const text = weekly([{ title: "Дроп", blurb: "Коротко.", url: LINK }]);
    expect(text).toContain(`Коротко. [Подробнее →](${LINK})`);
  });

  test("пустой текст пункта не даёт строки с ведущим пробелом", () => {
    const text = weekly([{ title: "Дроп", blurb: "", url: LINK }]);
    expect(text).toContain(`[Подробнее →](${LINK})`);
    for (const line of text.split("\n")) expect(line).not.toMatch(/^\s+\S/);
  });
});

describe("пункт без заголовка", () => {
  test("невидимый заголовок не даёт `****`", () => {
    const text = weekly([
      { title: ZWSP, blurb: "Пропадёт.", url: LINK },
      { title: "Настоящий", blurb: "Останется.", url: LINK },
    ]);
    expect(text).not.toContain("****");
    expect(text).toContain("Настоящий");
    expect(text).not.toContain("Пропадёт.");
  });

  test("если пунктов не осталось — поста нет", () => {
    expect(weekly([{ title: ZWSP, blurb: "Текст.", url: LINK }])).toBe("");
    expect(
      buildWeeklyRecapText({
        activities: [{ project: "\u200B", done: "Сделано.", url: LINK }],
        weekEnd: WEEK_END,
      }),
    ).toBe("");
  });

  test("шапка блока без пунктов не печатается", () => {
    const text = buildWeeklyRecapText({
      news: [{ title: "Живой", blurb: "Текст.", url: LINK }],
      activities: [{ project: ZWSP, done: "Сделано.", url: LINK }],
      weekEnd: WEEK_END,
    });
    expect(text).toContain("📰 **Новости**");
    expect(text).not.toContain("📌 **Активности**");
  });

  test("то же в посте отработки активностей", () => {
    expect(buildActivityRunText([{ project: ZWSP, action: "Сделать." }], WEEK_END)).toBe("");
    const text = buildActivityRunText(
      [
        { project: ZWSP, action: "Пропадёт." },
        { project: "Monad", action: "Останется." },
      ],
      WEEK_END,
    );
    expect(text).not.toContain("****");
    expect(text).toContain("Monad");
    expect(text).not.toContain("Пропадёт.");
  });

  test("обычные пункты не задеты", () => {
    const text = weekly([{ title: "Дроп", blurb: "Коротко.", url: LINK }]);
    expect(text).toContain("**Дроп**");
  });
});

describe("применение", () => {
  const TEXT_SRC = readFileSync(new URL("../lib/delabs-text.ts", import.meta.url), "utf-8");
  const TPL_SRC = readFileSync(
    new URL("../lib/delabs-post-templates.ts", import.meta.url),
    "utf-8",
  );

  test("класс в oneLine включает суррогаты", () => {
    expect(TEXT_SRC).toContain(".replace(/(?!\\u200D)[\\p{Cc}\\p{Cf}\\p{Cs}]/gu, \" \")");
  });

  test("ссылка склеивается через itemBody, а не конкатенацией с пробелом", () => {
    const code = TPL_SRC.split("\n")
      .filter((l) => {
        const t = l.trimStart();
        return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");
    expect(code).toContain('itemBody(endSentence(field(e.action, 200)), e.url, "Гайд")');
    expect(code).toContain('itemBody(endSentence(field(a.done, 200)), a.url, "Гайд")');
    expect(code).toContain('itemBody(endSentence(field(n.blurb, 200)), n.url, "Подробнее")');
    expect(code).not.toContain("} [${label} →]");
    expect(code).toContain("if (!/^https?:\\/\\/[^\\s)]+$/i.test(u)) return \"\";");
  });
});
