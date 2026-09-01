/**
 * Аудит 2026-08-20: `extractSvg` резал ответ модели по `indexOf("<svg")` и
 * `lastIndexOf("</svg>")` — первое вхождение открывающего тега и последнее
 * вхождение закрывающего. Оба конца выбирались независимо от того, парные ли
 * они, поэтому непустой результат ничего не гарантировал.
 *
 * Проверяем не «строка похожа на SVG», а факт, ради которого функция и живёт:
 * что кусок разбирается настоящим resvg. Вызывающий код (`svgFallback`)
 * считает успехом любую непустую строку, так что мусор доезжает до рендера.
 */
import { describe, it, expect } from "bun:test";
import { Resvg } from "@resvg/resvg-js";
import { extractSvg } from "../lib/svg-fallback.ts";

const ONE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#111"/></svg>`;
const TWO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><circle cx="10" cy="10" r="5" fill="#eee"/></svg>`;

function parses(svg: string): boolean {
  try {
    new Resvg(svg);
    return true;
  } catch {
    return false;
  }
}

describe("audit-2026-08-20 / extractSvg — парный закрывающий тег", () => {
  it("resvg действительно отвергает склейку двух рисунков — контроль", () => {
    // Ровно то, что возвращал старый срез: открывающий тег первого рисунка,
    // закрывающий второго, между ними проза и лишний корень.
    const both = `${TWO}\n\nа вот вариант потемнее:\n\n${ONE}`;
    const oldSlice = both.slice(
      both.indexOf("<svg"),
      both.lastIndexOf("</svg>") + 6,
    );
    expect(oldSlice.length).toBeGreaterThan(TWO.length);
    expect(parses(oldSlice)).toBe(false);
  });

  it("из двух рисунков берётся первый целиком", () => {
    const txt = `${TWO}\n\nа вот вариант потемнее:\n\n${ONE}`;
    expect(extractSvg(txt)).toBe(TWO);
    expect(parses(extractSvg(txt)!)).toBe(true);
  });

  it("упоминание тега в преамбуле не сдвигает начало", () => {
    const txt = `Сейчас будет <svg> размером 1200×630:\n\n\`\`\`svg\n${ONE}\n\`\`\``;
    expect(extractSvg(txt)).toBe(ONE);
    expect(parses(extractSvg(txt)!)).toBe(true);
  });

  it("контроль: старый срез на преамбуле с упоминанием тега не разбирается", () => {
    const txt = `Сейчас будет <svg> размером 1200×630:\n\n\`\`\`svg\n${ONE}\n\`\`\``;
    const oldSlice = txt.slice(txt.indexOf("<svg"), txt.lastIndexOf("</svg>") + 6);
    expect(parses(oldSlice)).toBe(false);
  });

  it("послесловие после фенса отбрасывается", () => {
    const txt = `\`\`\`svg\n${ONE}\n\`\`\`\n\nЕсли нужен другой размер — скажи.`;
    expect(extractSvg(txt)).toBe(ONE);
  });

  it("вложенный <svg> внутри рисунка не обрывает разбор раньше времени", () => {
    const nested = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><svg x="5" y="5" width="10" height="10"><rect width="10" height="10" fill="#333"/></svg></svg>`;
    expect(extractSvg(`вот:\n${nested}`)).toBe(nested);
    expect(parses(extractSvg(`вот:\n${nested}`)!)).toBe(true);
  });

  it("`>` внутри значения атрибута не считается концом тега", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" data-note="a>b"><rect width="10" height="10"/></svg>`;
    expect(extractSvg(svg)).toBe(svg);
  });

  it("`>` и `<svg` в соседних атрибутах не сбивают границу тега", () => {
    // Случай натянутый, но это единственная форма, где счётчик глубины сам не
    // выправляет преждевременный конец стартового тега: `>` в первом атрибуте
    // обрывает разбор тега, а `<svg` во втором после этого читается как
    // настоящий вложенный элемент, и парность рушится.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" data-a="a>b" data-b="<svg x>" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>`;
    expect(extractSvg(svg)).toBe(svg);
  });

  it("<svg> в комментарии внутри рисунка не считается вложенным элементом", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><!-- тут был <svg> побольше --><rect width="10" height="10"/></svg>`;
    expect(extractSvg(svg)).toBe(svg);
    expect(parses(extractSvg(svg)!)).toBe(true);
  });

  it("<svg> в комментарии ДО рисунка не сдвигает начало", () => {
    const txt = `<!-- черновик: <svg viewBox="0 0 5 5"> -->\n${ONE}`;
    expect(extractSvg(txt)).toBe(ONE);
  });

  it("незакрытый рисунок по-прежнему null, а не обрезок", () => {
    expect(extractSvg(`<svg viewBox="0 0 10 10"><rect/>`)).toBe(null);
  });

  it("упоминание тега без единого закрытого рисунка → null", () => {
    expect(extractSvg("могу отдать <svg>, скажи размер")).toBe(null);
  });

  it("`<svgfoo` словом не считается открывающим тегом", () => {
    expect(extractSvg("<svgfoo/></svgfoo>")).toBe(null);
  });

  it("самозакрывающийся корень возвращается целиком", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"/>`;
    expect(extractSvg(`вот:\n${svg}\nвсё`)).toBe(svg);
  });

  it("регистр тега не важен", () => {
    const svg = `<SVG xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></SVG>`;
    expect(extractSvg(`тут:\n${svg}`)).toBe(svg);
  });
});
