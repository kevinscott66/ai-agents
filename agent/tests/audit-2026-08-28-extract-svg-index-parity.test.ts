/**
 * Аудит 2026-08-28: индексы считались по одной строке, а рез шёл по другой.
 *
 * `extractSvg` строит `low = text.toLowerCase()`, ищет границы в нём, а режет
 * `text.slice(start, end)`. Это верно ровно до тех пор, пока приведение
 * регистра сохраняет длину, а оно её не сохраняет: `"İ".toLowerCase()` — это
 * `i` плюс комбинирующая точка, два символа вместо одного (U+0130, турецкая
 * I с точкой; в юникоде такой случай не единственный).
 *
 * Дальше индексы разъезжаются на число таких символов ДО тега, и рез уходит
 * вправо: у документа отгрызается `<`, `<s`, `<sv`… Вызывающий код считает
 * непустую строку успехом, так что наружу это выходит не понятной ошибкой, а
 * поломанным SVG — ровно тот класс, ради которого разбор и переписывали
 * 2026-08-20.
 *
 * Сканеру от нижнего регистра нужен только ASCII (`<svg`, `</svg`, `<![cdata[`),
 * поэтому регистр теперь сбрасывается только у A-Z — длина сохраняется по
 * построению.
 */
import { describe, expect, test } from "bun:test";
import { extractSvg } from "../lib/svg-fallback.ts";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect/></svg>';

describe("символы, меняющие длину при toLowerCase", () => {
  test("İ в преамбуле не сдвигает рез", () => {
    expect(extractSvg(`İstanbul, рисунок ниже:\n${SVG}`)).toBe(SVG);
  });

  test("несколько таких символов — сдвиг накапливался", () => {
    expect(extractSvg(`İİİİİ\n${SVG}`)).toBe(SVG);
  });

  test("İ внутри самого документа тоже безопасен", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>İzmir</text></svg>';
    expect(extractSvg(`вот:\n${svg}\nготово`)).toBe(svg);
  });

  test("предпосылка: toLowerCase действительно меняет длину", () => {
    // Если это когда-нибудь перестанет быть правдой, тесты выше станут
    // бессмысленными молча — пусть лучше упадёт этот.
    expect("İ".toLowerCase().length).toBe(2);
  });
});

describe("прежний разбор не изменился", () => {
  test("чистый документ", () => {
    expect(extractSvg(SVG)).toBe(SVG);
  });

  test("markdown-фенс и проза вокруг", () => {
    expect(extractSvg("Вот картинка:\n```svg\n" + SVG + "\n```\nГотово.")).toBe(SVG);
  });

  test("верхний регистр в теге", () => {
    const s = "<SVG xmlns=\"http://www.w3.org/2000/svg\"><rect/></SVG>";
    expect(extractSvg(`текст ${s}`)).toBe(s);
  });

  test("упоминание тега в прозе пропускается ради настоящего", () => {
    expect(extractSvg(`сейчас будет <svg> на 1200x630\n${SVG}`)).toBe(SVG);
  });

  test("два рисунка — берётся первый целиком", () => {
    const out = extractSvg(`${SVG}\nи ещё\n${SVG}`);
    expect(out).toBe(SVG);
  });

  test("вложенный svg считается по глубине", () => {
    const nested = '<svg xmlns="http://www.w3.org/2000/svg"><svg><rect/></svg></svg>';
    expect(extractSvg(`x ${nested} y`)).toBe(nested);
  });

  test("без пары — null", () => {
    expect(extractSvg("<svg><rect/>")).toBeNull();
    expect(extractSvg("просто текст")).toBeNull();
    expect(extractSvg("")).toBeNull();
  });
});
