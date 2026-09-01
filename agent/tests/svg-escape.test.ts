/**
 * Аудит 2026-08-11: текст подставлялся в SVG двумя способами, экранировал один.
 *
 * `lib/cover-banner.ts` заводил локальный `esc()` и звал его на каждой строке,
 * которая едет в `<text>`. `lib/designer/svg-templates.ts` подставлял значения
 * в `{{PLACEHOLDER}}` голым `.replace()` — без экранирования вообще. Разница
 * важна: плейсхолдеры в шаблонах стоят и внутри АТРИБУТОВ
 * (`fill="{{STATUS_1_COLOR}}"` в status-dashboard.svg), а `esc()` кавычку не
 * трогал — то есть даже он бы там не спас.
 *
 * Цена в шаблонах: значение с `<` или `&` даёт невалидный XML, и resvg падает —
 * картинка просто не приходит. Значение с `"` или `</text>` дописывает в SVG
 * свои узлы. Значения приходят от модели (`generateSvgFromRequest` кладёт в
 * `CONTENT_LINE_1` сам текст запроса).
 *
 * Второй дефект там же — `String.replace` со строкой-заменой трактует `$&`,
 * `$'` и `` $` `` как шаблон подстановки. `$'` вставляет ВЕСЬ остаток строки,
 * то есть остаток SVG-файла, в место плейсхолдера.
 *
 * Инвариант: экранирование одно на оба пути, покрывает все пять XML-символов, и
 * подстановка не читает `$`-последовательности.
 */
import { describe, test, expect } from "bun:test";
import { escapeXml } from "../lib/svg-render.ts";
import {
  renderTemplate,
  selectTemplate,
  SVG_TEMPLATES,
} from "../lib/designer/svg-templates.ts";

describe("escapeXml", () => {
  test("покрывает все пять символов, включая кавычки для атрибутов", () => {
    expect(escapeXml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&apos;");
  });

  test("амперсанд экранируется первым — иначе &lt; станет &amp;lt;", () => {
    expect(escapeXml("<")).toBe("&lt;");
    expect(escapeXml("&lt;")).toBe("&amp;lt;");
  });

  test("обычный текст не трогает", () => {
    expect(escapeXml("ИИ × Web3 — итоги недели")).toBe("ИИ × Web3 — итоги недели");
  });
});

describe("renderTemplate экранирует подставляемое", () => {
  const template = SVG_TEMPLATES[0];

  test("узлы из значения не попадают в SVG", () => {
    const out = renderTemplate(template, {
      TITLE: `</text><rect width="99999" height="99999" fill="red"/><text>`,
    });
    expect(out).not.toContain("<rect width=\"99999\"");
    expect(out).toContain("&lt;/text&gt;");
  });

  test("кавычка не выходит из атрибута", () => {
    const out = renderTemplate(template, { TITLE: `a" onload="x` });
    expect(out).not.toContain(`a" onload="x`);
    expect(out).toContain("&quot;");
  });

  test("$' в значении не вставляет остаток файла", () => {
    // До фикса `.replace(pattern, value)` трактовал это как шаблон подстановки.
    const out = renderTemplate(template, { TITLE: "цена: $' и $& и $`" });
    expect(out).toContain("цена: $&apos; и $&amp; и $`");
  });

  test("валидный XML остаётся валидным — SVG всё ещё рендерится", async () => {
    const { renderSvgToPng } = await import("../lib/svg-render.ts");
    const out = renderTemplate(template, { TITLE: "Отчёт & итоги <Q3>" });
    const png = await renderSvgToPng(out);
    expect(png.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    // Запас, а не ускорение. Это единственная проверка в файле, которая
    // действительно рендерит, а `new Resvg()` загружает системные шрифты —
    // замер здесь ~2000 мс, под полным прогоном больше. В дефолтные 5000 мс
    // она упиралась: зелёная поодиночке, красная в общем прогоне.
  }, 30_000);
});

describe("selectTemplate", () => {
  test("неизвестный запрос возвращает шаблон по умолчанию", () => {
    expect(selectTemplate("совершенно неизвестный сюжет")).toBe(SVG_TEMPLATES[0]);
  });
});
