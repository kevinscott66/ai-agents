/**
 * Аудит 2026-08-28, две дыры в одной цепочке гардов renderSvgToPng.
 *
 * 1. `SVG_TAG` был `/<svg\b[^>]*>/i`, а `>` внутри значения атрибута — законный
 *    XML (запрещён там только `<`). `<svg data-x="a>b" width="100000"
 *    height="100000">` обрезался до `<svg data-x="a>`, width/height не
 *    находились, `declaredRasterSize` возвращал null — и дешёвая мерка
 *    пропускала ровно тот документ, ради которого написана. Замеры на этой
 *    машине: resvg такой тег разбирает нормально (100000x100000), а
 *    конструктор с системными шрифтами стоит ~1484 мс синхронно, то есть
 *    замороженный event-loop на все 12 ботов сразу.
 *
 * 2. Отвергнутая внешняя ссылка печаталась в текст ошибки целиком. Её длина —
 *    длина атрибута, до 200 КБ (гард размера меряет весь документ). Замер: href
 *    в 150 018 символов доезжал как есть. Дальше строка идёт модели в
 *    tool_result и в `agent_actions.error` (handleGenerateSvgImage ошибку не
 *    ловит, audit.ts:195 пишет без обрезки).
 */
import { describe, expect, test } from "bun:test";
import { Resvg } from "@resvg/resvg-js";
import { clipForError, declaredRasterSize, renderSvgToPng } from "../lib/svg-render.ts";

const NS = 'xmlns="http://www.w3.org/2000/svg"';
const HUGE = 'width="100000" height="100000"';

describe("предпосылки", () => {
  test("resvg принимает > внутри значения атрибута", () => {
    // Если бы не принимал, обход был бы безвредным.
    const r = new Resvg(`<svg ${NS} data-x="a>b" ${HUGE}><rect width="1" height="1"/></svg>`, {
      font: { loadSystemFonts: false },
    });
    expect(r.width).toBe(100000);
    expect(r.height).toBe(100000);
  });
});

describe("declaredRasterSize видит размер за кавычками", () => {
  test("> внутри двойных кавычек больше не обрывает тег", () => {
    const size = declaredRasterSize(`<svg ${NS} data-x="a>b" ${HUGE}><rect/></svg>`);
    expect(size).toEqual({ width: 100000, height: 100000 });
  });

  test("то же для одинарных кавычек и для нескольких > подряд", () => {
    for (const attrs of [`data-x='a>b'`, `data-x="a>b>c" data-y='d>e'`, `data-x=">"`]) {
      const size = declaredRasterSize(`<svg ${NS} ${attrs} ${HUGE}><rect/></svg>`);
      expect(size).toEqual({ width: 100000, height: 100000 });
    }
  });

  test("честный тег читается как раньше", () => {
    expect(declaredRasterSize(`<svg ${NS} width="64" height="32"><rect/></svg>`)).toEqual({
      width: 64,
      height: 32,
    });
  });

  test("документ без размеров по-прежнему null — решает мерка после конструктора", () => {
    expect(declaredRasterSize(`<svg ${NS} viewBox="0 0 10 10"><rect/></svg>`)).toBeNull();
  });

  test("незакрытая кавычка не вешает разбор и просто не даёт совпадения", () => {
    const started = Bun.nanoseconds();
    expect(declaredRasterSize(`<svg ${NS} data-x="${"a".repeat(50_000)}`)).toBeNull();
    expect((Bun.nanoseconds() - started) / 1e6).toBeLessThan(500);
  });

  test("документ отвергается — и до правки, и после", async () => {
    // Честно: этот тест зелен в обе стороны. Авторитетная мерка ПОСЛЕ
    // конструктора ловила такой документ и раньше, поэтому меняется не исход, а
    // цена: до правки за него платили ~1484 мс синхронного конструктора с
    // системными шрифтами (замер), после — 0. Различающее свидетельство — два
    // теста выше, где declaredRasterSize до правки возвращал null.
    await expect(
      renderSvgToPng(`<svg ${NS} data-x="a>b" ${HUGE}><rect width="1" height="1"/></svg>`),
    ).rejects.toThrow(/слишком большой растр/);
  });
});

describe("clipForError", () => {
  test("короткая строка не трогается", () => {
    expect(clipForError("https://evil.test/a")).toBe("https://evil.test/a");
  });

  test("на границе не режется", () => {
    const exact = "x".repeat(120);
    expect(clipForError(exact)).toBe(exact);
  });

  test("длинная режется и подписывается остатком", () => {
    const out = clipForError("x".repeat(150_018));
    expect(out.length).toBeLessThan(160);
    expect(out).toContain("+149898 симв.");
  });
});

describe("текст отказа больше не тащит чужую строку целиком", () => {
  test("150 КБ href не доезжают до сообщения", async () => {
    const href = `https://evil.test/${"a".repeat(150_000)}`;
    const svg = `<svg ${NS}><image href="${href}"/></svg>`;
    // Документ заведомо больше 200 КБ не делаем: гард размера сработал бы раньше.
    expect(Buffer.byteLength(svg, "utf8")).toBeLessThan(200 * 1024);
    let message = "";
    try {
      await renderSvgToPng(svg);
    } catch (e) {
      message = String((e as Error).message);
    }
    expect(message).toContain("внешняя ссылка запрещена");
    expect(message.length).toBeLessThan(400);
    // Понять, что именно отвергли, всё ещё можно.
    expect(message).toContain("https://evil.test/aaaa");
    expect(message).toContain("симв.");
  });

  test("обычная ссылка печатается целиком", async () => {
    let message = "";
    try {
      await renderSvgToPng(`<svg ${NS}><image href="https://evil.test/logo.png"/></svg>`);
    } catch (e) {
      message = String((e as Error).message);
    }
    expect(message).toContain('href="https://evil.test/logo.png"');
    expect(message).not.toContain("симв.");
  });
});
