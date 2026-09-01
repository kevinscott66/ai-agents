/**
 * Аудит 2026-08-20 — две молчаливые потери в баннере.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildBannerSvg, buildIllustratedBannerSvg, fontFiles } from "../lib/cover-banner.ts";

const IW = 1536;
const PADX = 140;
const TITLE_SHIFT_X = 34;
const SUB_SIZE = 40;
const SUB_CHAR_W = 0.56;

const subOf = (svg: string): string | null => {
  const m = svg.match(
    new RegExp(`<text[^>]*font-size="${SUB_SIZE}" font-weight="600"[^>]*>([^<]*)</text>`),
  );
  return m ? m[1]! : null;
};

describe("бренд-шрифты находятся по настоящему пути", () => {
  const files = fontFiles();

  test("список не пуст", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test("каждый путь читается с диска", () => {
    for (const f of files) {
      expect(() => readFileSync(f)).not.toThrow();
    }
  });

  test("в путях нет процентной кодировки", () => {
    // Пробел в каталоге репозитория давал «/Users/…/ai%20agents/…» — файл по
    // такому имени не открывается, а catch в fontFiles это глотал.
    for (const f of files) {
      expect(f).not.toContain("%");
    }
  });

  test("модуль больше не превращает file:-URL в путь через .pathname", () => {
    // Каталог этого репозитория пробелов не содержит, поэтому проверки выше
    // прошли бы и на старой реализации. Пиним само место, где ломалось.
    const src = readFileSync(
      fileURLToPath(new URL("../lib/cover-banner.ts", import.meta.url)),
      "utf8",
    );
    expect(src).not.toMatch(/import\.meta\.url\)\.pathname/);
    expect(src).not.toMatch(/new URL\([^)]*\)\.pathname/);
    expect(src).toContain("fileURLToPath");
  });

  test("пробел в пути к репозиторию действительно ломал .pathname", () => {
    // Проверяем сам механизм, а не наш каталог: у него пробелов нет, и тест
    // выше прошёл бы даже на старой реализации.
    const url = new URL("file:///tmp/ai%20agents/f.ttf");
    expect(url.pathname).toContain("%20");
    expect(fileURLToPath(url)).toBe("/tmp/ai agents/f.ttf");
  });
});

describe("подзаголовок на иллюстрированном баннере", () => {
  test("рисуется, а не пропадает молча", () => {
    const svg = buildIllustratedBannerSvg({
      title: "Аирдропы недели",
      subtitle: "Что забрать прямо сейчас",
    })!;
    expect(subOf(svg)).toBe("Что забрать прямо сейчас");
  });

  test("без подзаголовка лишней строки нет", () => {
    const svg = buildIllustratedBannerSvg({ title: "Аирдропы недели" })!;
    expect(subOf(svg)).toBeNull();
  });

  test("не налезает на дату", () => {
    const svg = buildIllustratedBannerSvg({
      title: "Аирдропы недели",
      subtitle: "Что забрать",
      date: "20 августа",
    })!;
    const subY = Number(svg.match(/y="(\d+)"[^>]*font-size="40" font-weight="600"/)![1]);
    const dateY = Number(svg.match(/y="(\d+)"[^>]*fill="#16e0c8"/)![1]);
    // Подзаголовок выше даты и не вплотную к ней.
    expect(dateY - subY).toBeGreaterThan(SUB_SIZE);
  });
});

describe("подзаголовок обрезается по ширине", () => {
  const LONG = "а".repeat(160); // ровно столько пропускает build-payload

  test("иллюстрированный: строка укладывается в холст", () => {
    const svg = buildIllustratedBannerSvg({ title: "т", subtitle: LONG })!;
    const s = subOf(svg)!;
    expect(s.length).toBeLessThan(LONG.length);
    expect(s.endsWith("…")).toBe(true);
    const right = PADX + TITLE_SHIFT_X + s.length * SUB_SIZE * SUB_CHAR_W;
    expect(right).toBeLessThanOrEqual(IW);
  });

  test("чистый: то же самое", () => {
    const svg = buildBannerSvg({ title: "т", subtitle: LONG });
    const s = subOf(svg)!;
    expect(s.endsWith("…")).toBe(true);
    expect(PADX + s.length * SUB_SIZE * SUB_CHAR_W).toBeLessThanOrEqual(1920);
  });

  test("короткий подзаголовок не трогается", () => {
    const svg = buildBannerSvg({ title: "т", subtitle: "Коротко и ясно" });
    expect(subOf(svg)).toBe("Коротко и ясно");
  });
});
