/**
 * Аудит 2026-08-20 — один запрещённый символ убивал весь документ.
 *
 * Проверяем не «строка почистилась», а то, ради чего чистка нужна: Resvg
 * действительно принимает документ. Конструктор Resvg — то самое место, где
 * раньше всё и падало.
 */
import { describe, test, expect } from "bun:test";
import { Resvg } from "@resvg/resvg-js";
import { escapeXml } from "../lib/svg-render.ts";
import { buildIllustratedBannerSvg, buildBannerSvg } from "../lib/cover-banner.ts";

const BELL = String.fromCharCode(7);
const ESC = String.fromCharCode(27);
const NUL = String.fromCharCode(0);
const VT = String.fromCharCode(11);
const LONE_HIGH = String.fromCharCode(0xd83d);
const LONE_LOW = String.fromCharCode(0xde00);
const NONCHAR = String.fromCharCode(0xffff);
const EMOJI = "\u{1F680}"; // целая пара

const accepts = (svg: string): boolean => {
  try {
    new Resvg(svg);
    return true;
  } catch {
    return false;
  }
};

const doc = (text: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><text x="1" y="15">${text}</text></svg>`;

describe("escapeXml вычищает символы, запрещённые в XML 1.0", () => {
  const cases: Array<[string, string]> = [
    ["bell", BELL],
    ["esc", ESC],
    ["nul", NUL],
    ["vertical tab", VT],
    ["одинокий верхний суррогат", LONE_HIGH],
    ["одинокий нижний суррогат", LONE_LOW],
    ["U+FFFF", NONCHAR],
  ];

  for (const [name, ch] of cases) {
    test(`${name}: документ принимается парсером`, () => {
      // До правки каждый из этих символов давал отказ прямо в конструкторе.
      expect(accepts(doc(`a${escapeXml(ch)}b`))).toBe(true);
    });
  }

  test("сырой символ без экранирования документ действительно ломает", () => {
    // Без этого проверки выше прошли бы и на пустой реализации.
    expect(accepts(doc(`a${BELL}b`))).toBe(false);
    expect(accepts(doc(`a${LONE_HIGH}b`))).toBe(false);
  });

  test("законные символы остаются на месте", () => {
    expect(escapeXml(`\tстрока\nдруг${EMOJI}`)).toBe(`\tстрока\nдруг${EMOJI}`);
  });

  test("угловые скобки экранируются как раньше", () => {
    expect(escapeXml(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&apos;");
  });
});

describe("баннер переживает мусорный заголовок", () => {
  const dirty = `Аирдропы${BELL} недели${LONE_HIGH}: что забрать${NUL}`;

  test("иллюстрированный баннер собирается и принимается парсером", () => {
    const svg = buildIllustratedBannerSvg({ title: dirty });
    expect(svg).not.toBeNull();
    expect(accepts(svg!)).toBe(true);
  });

  test("чистый баннер тоже", () => {
    expect(accepts(buildBannerSvg({ title: dirty, tag: `тег${ESC}` }))).toBe(true);
  });

  test("длинное слово с эмодзи режется по кодовым точкам", () => {
    // Жёсткий перенос включается только для слова шире строки на минимальном
    // кегле. Ведущая «a» сдвигает границу так, что при резке по единицам UTF-16
    // она попадает В СЕРЕДИНУ пары — ровно то, что и ломалось.
    const word = `a${EMOJI.repeat(40)}`;
    const svg = buildIllustratedBannerSvg({ title: word });
    expect(svg).not.toBeNull();
    expect(accepts(svg!)).toBe(true);

    // Строки заголовка, склеенные обратно, обязаны быть началом исходного
    // слова. При резке по UTF-16 половинки пар вычищает escapeXml — документ
    // остаётся валидным, но из текста молча пропадают целые эмодзи.
    const runs = [...svg!.matchAll(
      /<text[^>]*font-weight="800"[^>]*letter-spacing="-[^"]*"[^>]*>([^<]*)<\/text>/g,
    )].map((m) => m[1]!);
    expect(runs.length).toBeGreaterThan(1);
    const joined = runs.join("");
    expect(joined.endsWith("\u2026")).toBe(false);
    expect(word.startsWith(joined)).toBe(true);
    expect(joined).toBe(word);
  });
});
