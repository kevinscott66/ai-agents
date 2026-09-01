/**
 * Одноразовый воркер для растеризации SVG. Читает
 * {svg, fitToWidth?, loadSystemFonts, maxSide} из stdin, печатает PNG в
 * stdout и умирает.
 *
 * Существует ровно затем, чтобы рендер можно было УБИТЬ. `new Resvg(...)` и
 * `.render()` — синхронные нативные вызовы: внутри основного процесса они
 * держат event-loop, а там живут все 12 ботов, HTTP-сервер Mini App и
 * планировщики. Внутрипроцессный таймаут это принципиально не лечит — он не
 * получит управление, пока нативный вызов не вернётся. Отдельный процесс
 * убивается сигналом снаружи.
 *
 * Почему это не теория. Все прежние гарды меряют РАЗМЕР: байты исходника
 * (200 КБ), объявленную сторону и сторону растра (4096). Стоимость рендера
 * ими не ограничена никак — фильтры делают её огромной при крошечном
 * исходнике. Замер на этой машине через настоящий renderSvgToPng, каждый
 * документ проходит все гарды (меньше 200 КБ, ровно 4096x4096):
 *
 *   1 rect с feGaussianBlur stdDeviation="400",  208 Б ->  2 213 мс
 *   2 такие же rect,                             283 Б ->  5 955 мс
 *   10 таких rect (замер аудита),              1 141 Б -> 35 253 мс
 *
 * Линейно по числу примитивов, то есть 200 КБ исходника — это часы
 * замороженного цикла с одного вызова. GENERATE_SVG_IMAGE апрува не требует,
 * лимит 20/мин на агента, а SVG к нему пишет модель, читающая недоверенный
 * вход.
 *
 * Авторитетная проверка растра переехала сюда же: она требует разобранного
 * документа, то есть конструктора Resvg, а конструктор — это те самые
 * ~1.5 с загрузки системных шрифтов, которым в общем цикле тоже не место.
 * Текстовые гарды (байты, <!ENTITY>, внешние href, объявленный размер)
 * остаются в родителе: это чистая работа со строкой, она дешёвая и должна
 * отсекать мусор ДО запуска процесса.
 */
import { Resvg } from "@resvg/resvg-js";
import { rasterSizeAfterFit } from "./svg-render.ts";

type Input = {
  svg: string;
  fitToWidth?: number;
  loadSystemFonts: boolean;
  maxSide: number;
};

function fail(message: string): never {
  process.stderr.write(JSON.stringify({ error: message }));
  process.exit(3);
}

const input = (await Bun.stdin.json()) as Input;

const fitTo =
  input.fitToWidth !== undefined
    ? ({ mode: "width", value: input.fitToWidth } as const)
    : ({ mode: "original" } as const);

let resvg: Resvg;
try {
  resvg = new Resvg(input.svg, {
    fitTo,
    font: { loadSystemFonts: input.loadSystemFonts },
  });
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}

// Проверка ПОСЛЕ конструктора и ДО render(): конструктор буфер не выделяет,
// выделяет render(). Здесь она авторитетная — размер берётся у разобранного
// документа, а не у регекса, поэтому доходит и то, где размер задан viewBox
// или процентами.
//
// `resvg.width`/`resvg.height` — это размер ДОКУМЕНТА, а не растра: замер на
// 8000x4000 c fitTo width=2048 даёт props 8000x4000 при отрендеренных
// 2048x1024. Комментарий на прежнем месте утверждал обратное, и мерка
// отвергала законное уменьшение.
const raster = rasterSizeAfterFit(resvg.width, resvg.height, input.fitToWidth);
if (raster.width > input.maxSide || raster.height > input.maxSide) {
  fail(
    `svg слишком большой растр: ${Math.round(raster.width)}x` +
      `${Math.round(raster.height)}px (предел ${input.maxSide}px по стороне)`,
  );
}

try {
  process.stdout.write(resvg.render().asPng());
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
