/**
 * Аудит 2026-08-11: SVG ограничивали по весу исходника, а не по размеру растра.
 *
 * `renderSvgToPng` резал вход на 200 КБ — то есть считал опасным ДЛИННЫЙ SVG.
 * Но стоимость рендера задаёт не длина текста, а объявленные ширина/высота:
 * `<svg width="100000" height="100000">` весит 90 байт и просит у resvg
 * 100000×100000×4 = 40 ГБ под пиксельный буфер. Замер до фикса:
 *
 *   declared   1024×1024   → resvg   1024×1024     0.00 GB
 *   declared  20000×20000  → resvg  20000×20000    1.60 GB
 *   declared 100000×100000 → resvg 100000×100000  40.00 GB
 *
 * Конструктор `new Resvg()` буфер не выделяет — выделяет `render()`. На VPS это
 * не исключение в одном действии, а OOM-kill юнита `agent-team`, то есть все 12
 * ботов разом.
 *
 * SVG сюда приходит ОТ МОДЕЛИ: `GENERATE_SVG_IMAGE` берёт его из аргументов
 * тула, а svg-фолбэк — из ответа Claude на промпт. Значит достаточно инъекции в
 * любой недоверенный вход дизайнера (вложение, результат web_search, сообщение в
 * чате), чтобы уронить процесс. Апрува у GENERATE_SVG_IMAGE нет — действие
 * дешёвое.
 *
 * Инвариант: ограничение стоит на ИТОГОВОМ растре, после fitTo, и до render().
 */
import { describe, test, expect } from "bun:test";
import {
  renderSvgToPng,
  declaredRasterSize,
  svgHasText,
} from "../lib/svg-render.ts";

function svgOf(w: number, h: number): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<rect width="10" height="10" fill="red"/></svg>`
  );
}

describe("растр ограничен по сторонам, а не только по весу исходника", () => {
  test("умеренно-огромный холст отбивается (до фикса — рендерился, ~576 МБ)", async () => {
    await expect(renderSvgToPng(svgOf(12000, 12000))).rejects.toThrow(
      /слишком большой растр/,
    );
  });

  test("обычный холст рендерится как раньше", async () => {
    const buf = await renderSvgToPng(svgOf(512, 256));
    expect(buf.length).toBeGreaterThan(0);
    // PNG-сигнатура — проверяем, что вернулся именно растр.
    expect(buf.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  test("баннерный размер из cover-banner остаётся легальным", async () => {
    const buf = await renderSvgToPng(svgOf(1536, 1024));
    expect(buf.length).toBeGreaterThan(0);
  });

  test("40-гигабайтный холст отбивается мгновенно, а не аллокацией", async () => {
    // До фикса такой вход шёл прямо в render(). Гонять его в тестах было
    // нельзя — поэтому проверка появилась только вместе с гардом.
    const started = performance.now();
    await expect(renderSvgToPng(svgOf(100_000, 100_000))).rejects.toThrow(
      /слишком большой растр/,
    );
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("раздутие через fitTo тоже ловится (проверяем растр, не объявленное)", async () => {
    // width=2048 к <svg width="100" height="100000"> даёт 2048×2048000:
    // объявленная ширина мизерная, итоговый растр — 16 гигапикселей.
    await expect(
      renderSvgToPng(svgOf(100, 100_000), { width: 2048 }),
    ).rejects.toThrow(/слишком большой растр/);
  });

  test("дешёвая мерка не отбивает то, что размера ещё не имеет", () => {
    // Граница мерки ДО конструктора: она обязана молчать всюду, где размер
    // считает resvg. Ложный отказ здесь — это отвергнутая законная картинка,
    // и заметить его по логу нечем: сообщение то же, что у настоящего предела.
    expect(declaredRasterSize('<svg viewBox="0 0 1024 1024">')).toBeNull();
    expect(
      declaredRasterSize('<svg width="100%" height="100%" viewBox="0 0 8 8">'),
    ).toBeNull();
    expect(declaredRasterSize('<svg width="10cm" height="10cm">')).toBeNull();
    expect(declaredRasterSize("<rect/>")).toBeNull();
    expect(declaredRasterSize('<svg width="0" height="0">')).toBeNull();
    // А там, где размер объявлен прямо, — считает, и с тем же пересчётом fitTo.
    expect(declaredRasterSize('<svg width="512" height="256">')).toEqual({
      width: 512,
      height: 256,
    });
    expect(declaredRasterSize('<svg width="100" height="100000">', 2048)).toEqual(
      { width: 2048, height: 2_048_000 },
    );
    // Огромное объявленное, ужатое fitTo, законно: 8000x4000 → 2048x1024.
    expect(declaredRasterSize('<svg width="8000" height="4000">', 2048)).toEqual({
      width: 2048,
      height: 1024,
    });
  });

  test("ужатый fitTo холст по-прежнему рендерится, а не режется меркой", async () => {
    // Пара к предыдущему на живом рендере: объявленные 8000 больше предела,
    // но итоговый растр — 2048x1024. Мерка не имеет права его тронуть.
    const buf = await renderSvgToPng(svgOf(8000, 4000), { width: 2048 });
    expect(buf.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  }, 30_000);

  test("размер из viewBox видит только авторитетная мерка — и считает растр", async () => {
    // Здесь дешёвая мерка обязана молчать (width/height не объявлены), а
    // решение принимает проверка после конструктора. Пара случаев на одном
    // документе показывает, что она меряет именно РАСТР: без fitTo 12000x12000
    // отвергается, с fitTo width=2048 тот же документ рендерится в 2048x2048.
    //
    // Второе — регресс, который здесь и чинился: `resvg.width` отдаёт размер
    // ДОКУМЕНТА, а не растра, и мерка на нём отказывала любому законному
    // уменьшению.
    const vb =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12000 12000">' +
      '<rect width="10" height="10" fill="red"/></svg>';
    expect(declaredRasterSize(vb)).toBeNull();
    await expect(renderSvgToPng(vb)).rejects.toThrow(/слишком большой растр/);
    const buf = await renderSvgToPng(vb, { width: 2048 });
    expect(buf.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  }, 30_000);

  test("вес исходника по-прежнему ограничен отдельно", async () => {
    // Два предела независимы: короткий SVG может быть огромным растром,
    // а длинный — крошечным.
    const fat =
      `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">` +
      `<!--${"x".repeat(210 * 1024)}--></svg>`;
    await expect(renderSvgToPng(fat)).rejects.toThrow(/too large/);
  });
});

/**
 * Замер оттуда же: `new Resvg()` грузит все системные шрифты и стоит ~2000 мс
 * при `render()` в 8-30. Вызов синхронный и нативный, то есть держит
 * event-loop, а на VPS в одном процессе живут все 12 ботов. Грузим шрифты
 * только когда в документе есть текст — но тогда обязаны грузить наверняка,
 * иначе надпись пропадёт МОЛЧА, без единой ошибки.
 */
describe("системные шрифты грузятся только ради текста", () => {
  test("любой намёк на текст или гарнитуру считается за «нужны»", () => {
    for (const svg of [
      '<svg><text x="1" y="2">привет</text></svg>',
      "<svg><TEXT>верхний регистр тоже</TEXT></svg>",
      '<svg><tspan>кусок</tspan></svg>',
      '<svg><textPath href="#p">по кривой</textPath></svg>',
      '<svg><rect font-family="Inter"/></svg>',
      "<svg><style>text{font-family:Inter}</style></svg>",
      "<svg><defs><style>@font-face{src:url(#x)}</style></defs></svg>",
    ]) {
      expect(svgHasText(svg)).toBe(true);
    }
  });

  test("документ без текста шрифтов не просит", () => {
    expect(svgHasText(svgOf(512, 256))).toBe(false);
    expect(
      svgHasText('<svg><circle cx="1" cy="1" r="1" fill="#123"/></svg>'),
    ).toBe(false);
  });

  test("текст всё ещё РИСУЕТСЯ, а не пропадает молча", async () => {
    // Соль проверки: сравниваем с тем же документом без надписи. Если бы
    // шрифты не загрузились, resvg вернул бы PNG без ошибки — просто пустой,
    // и «рендер прошёл» ничего бы не доказывало.
    const wrap = (inner: string) =>
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80">' +
      `<rect width="200" height="80" fill="#fff"/>${inner}</svg>`;
    const blank = await renderSvgToPng(wrap(""));
    const withText = await renderSvgToPng(
      wrap('<text x="10" y="40" font-size="24" fill="#000">Привет</text>'),
    );
    expect(withText.length).toBeGreaterThan(blank.length * 2);
  }, 30_000);
});
