/**
 * Аудит 2026-08-28: дешёвая мерка размера читала не те числа.
 *
 * `SIDE_ATTR` брал только `123` и `12.5`. Но `1e5`, `1E5`, `+100000` и `.5e6` —
 * такие же простые абсолютные пиксели, и парсер внутри resvg читает их
 * буквально. `declaredRasterSize` на них возвращал `null`, дешёвая мерка
 * пропускалась целиком, и документ доезжал до `new Resvg(...)` — того самого
 * конструктора, который при тексте стоит ~1.5 с замороженного event-loop'а на
 * все 12 ботов сразу. Ровно класс `stroke-width` (#717) и `data-x="a>b"` (#789),
 * только записанный в самом числе.
 *
 * В обратную сторону — `\s*` внутри кавычек: пробел вокруг длины resvg НЕ
 * принимает, а мерка на нём заявляла размер и отвергала документ, который
 * отрисовался бы в 100x100. Докблок мерки требует обратного: «ложный отказ
 * здесь дороже пропуска».
 *
 * Заодно: пустой `href=""` возвращался как «внешняя ссылка», и модель получала
 * совет, к которому нечего применить.
 */
import { describe, expect, test } from "bun:test";
import { Resvg } from "@resvg/resvg-js";
import {
  declaredRasterSize,
  findExternalHref,
  renderSvgToPng,
} from "../lib/svg-render.ts";

function doc(attrs: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}><rect width="1" height="1"/></svg>`;
}

/** Размер документа глазами самого resvg — без render(), буфер не выделяется. */
function resvgSize(svg: string): { width: number; height: number } {
  const r = new Resvg(svg, { font: { loadSystemFonts: false } });
  return { width: r.width, height: r.height };
}

const HUGE = ['width="1e5" height="1e5"', 'width="1E5" height="1E5"', 'width="+100000" height="+100000"'];

describe("предпосылки: resvg читает эти записи как размер", () => {
  test("экспонента и знак — обычные абсолютные пиксели", () => {
    for (const a of HUGE) expect(resvgSize(doc(a))).toEqual({ width: 100000, height: 100000 });
  });

  test("длина без целой части тоже читается", () => {
    expect(resvgSize(doc('width=".5e6" height=".5e6"'))).toEqual({
      width: 500000,
      height: 500000,
    });
  });

  test("а вот пробел вокруг длины resvg не принимает — падает на viewBox", () => {
    const svg = doc('width=" 5000 " height=" 5000 " viewBox="0 0 100 100"');
    expect(resvgSize(svg)).toEqual({ width: 100, height: 100 });
  });
});

describe("declaredRasterSize согласован с resvg", () => {
  test("экспонента, знак и ведущая точка больше не дают null", () => {
    for (const a of [...HUGE, 'width=".5e6" height=".5e6"']) {
      const d = declaredRasterSize(doc(a), undefined);
      expect(d).not.toBeNull();
      expect(d).toEqual(resvgSize(doc(a)));
    }
  });

  test("простая запись и px читаются как раньше", () => {
    expect(declaredRasterSize(doc('width="800" height="600"'), undefined)).toEqual({
      width: 800,
      height: 600,
    });
    expect(declaredRasterSize(doc('width="800px" height="600px"'), undefined)).toEqual({
      width: 800,
      height: 600,
    });
    expect(declaredRasterSize(doc('width="12.5" height="12.5"'), undefined)).toEqual({
      width: 12.5,
      height: 12.5,
    });
  });

  test("пробел внутри кавычек мерку больше не запускает", () => {
    expect(
      declaredRasterSize(doc('width=" 5000 " height=" 5000 " viewBox="0 0 100 100"'), undefined),
    ).toBeNull();
  });

  test("не-пиксельные записи по-прежнему отдаём авторитетной проверке", () => {
    for (const a of ['width="100%" height="100%"', 'width="10em" height="10em"', 'viewBox="0 0 10 10"']) {
      expect(declaredRasterSize(doc(a), undefined)).toBeNull();
    }
  });

  test("отрицательный размер — не размер", () => {
    expect(declaredRasterSize(doc('width="-100" height="-100"'), undefined)).toBeNull();
  });

  test("соседний stroke-width всё так же не подменяет width", () => {
    expect(
      declaredRasterSize(doc('stroke-width="2" width="1e5" height="1e5"'), undefined),
    ).toEqual({ width: 100000, height: 100000 });
  });
});

describe("renderSvgToPng", () => {
  test("огромный растр в экспоненциальной записи отвергается до рендера", async () => {
    for (const a of HUGE) {
      await expect(renderSvgToPng(doc(a))).rejects.toThrow(/слишком большой растр/);
    }
  });

  test("документ, который resvg рисует крошечным, больше не отвергается", async () => {
    const svg = doc('width=" 5000 " height=" 5000 " viewBox="0 0 100 100"');
    const png = await renderSvgToPng(svg);
    expect(png.length).toBeGreaterThan(0);
  });
});

describe("пустая ссылка", () => {
  test("href=\"\" и href=\"   \" ссылкой не считаются", () => {
    expect(findExternalHref('<svg><a href=""><rect/></a></svg>')).toBeNull();
    expect(findExternalHref("<svg><a href='   '><rect/></a></svg>")).toBeNull();
  });

  test("настоящая внешняя ссылка по-прежнему ловится", () => {
    expect(findExternalHref('<svg><image href="http://example.test/a.png"/></svg>')).toBe(
      "http://example.test/a.png",
    );
  });

  test("документ с пустым href рендерится", async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' +
      '<a href=""><rect width="10" height="10" fill="#123"/></a></svg>';
    const png = await renderSvgToPng(svg);
    expect(png.length).toBeGreaterThan(0);
  });
});
