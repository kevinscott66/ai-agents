/**
 * Аудит 2026-08-28: дешёвая мерка растра читала соседний атрибут.
 *
 * `SIDE_ATTR` строила `\bwidth\s*=…`, а `\b` срабатывает и после дефиса: в
 * `stroke-width="2"` граница слова стоит ровно перед `width`. `.exec` берёт
 * ПЕРВОЕ совпадение в теге, поэтому `<svg stroke-width="2" width="100000">`
 * измерялся как двухпиксельный. То же с любым `data-width`/`data-height`,
 * которые модель ставит охотно.
 *
 * Мерка существует затем, чтобы не платить за враждебный документ: конструктор
 * Resvg синхронный и нативный, с `loadSystemFonts` это ~2 с замороженного
 * event-loop, а на VPS все 12 ботов живут в одном процессе. Обход означал, что
 * `GENERATE_SVG_IMAGE` — дешёвое, без апрува, с SVG от модели, читающей
 * недоверенный вход, — снова стоил эти две секунды на каждую попытку.
 *
 * Обратная сторона того же промаха: с заданным `opts.width` подставной
 * `stroke-width` мог и НАОБОРОТ раздуть замер и отвергнуть законный документ.
 */
import { describe, expect, test } from "bun:test";
import { declaredRasterSize, MAX_RENDER_SIDE } from "../lib/svg-render.ts";

const over = MAX_RENDER_SIDE * 25;

describe("атрибут с дефисным префиксом не считается размером", () => {
  test("stroke-width не подменяет width", () => {
    const svg = `<svg stroke-width="2" width="${over}" height="${over}" xmlns="http://www.w3.org/2000/svg"></svg>`;
    expect(declaredRasterSize(svg)).toEqual({ width: over, height: over });
  });

  test("data-width и data-height не подменяют обе стороны", () => {
    const svg = `<svg data-width="8" data-height="8" width="${over}" height="${over}"></svg>`;
    expect(declaredRasterSize(svg)).toEqual({ width: over, height: over });
  });

  test("замер остаётся выше предела — документ отвергается до конструктора", () => {
    const svg = `<svg data-height="1" height="${over}" width="10"></svg>`;
    const d = declaredRasterSize(svg)!;
    expect(Math.max(d.width, d.height)).toBeGreaterThan(MAX_RENDER_SIDE);
  });

  test("пространство имён тоже не считается: svg:width", () => {
    const svg = `<svg svg:width="4" width="${over}" height="${over}"></svg>`;
    expect(declaredRasterSize(svg)).toMatchObject({ width: over });
  });

  test("подставной атрибут с заданным fitTo не раздувает замер", () => {
    // Обратная ошибка того же промаха: 100x100 измерялся бы как 1x100 и после
    // mode:"width" превращался в 2048x204800 — отказ законному документу.
    const svg = `<svg stroke-width="1" width="100" height="100"></svg>`;
    expect(declaredRasterSize(svg, 2048)).toEqual({ width: 2048, height: 2048 });
  });
});

describe("прежнее чтение размеров не изменилось", () => {
  test("обычный тег читается как раньше", () => {
    expect(declaredRasterSize(`<svg width="800" height="600"></svg>`)).toEqual({
      width: 800,
      height: 600,
    });
  });

  test("px, дробные и пробелы вокруг знака равенства", () => {
    expect(declaredRasterSize(`<svg  width = '12.5px' height="8px"></svg>`)).toEqual({
      width: 12.5,
      height: 8,
    });
  });

  test("а пробелы ВНУТРИ кавычек больше не проглатываются", () => {
    // Аудит 2026-08-28 (третий заход): здесь ожидалось 12.5, но resvg такую
    // запись не принимает — замер `<svg width=" 5000 " viewBox="0 0 100 100">`
    // даёт документ 100x100. Мерка заявляла 5000x5000 и отвергала документ,
    // который отрисовался бы крошечным, то есть ровно тот ложный отказ, о
    // котором её докблок говорит «дороже пропуска».
    expect(declaredRasterSize(`<svg  width = ' 12.5px ' height="8px"></svg>`)).toBeNull();
  });

  test("порядок атрибутов не важен", () => {
    expect(declaredRasterSize(`<svg height="600" width="800"></svg>`)).toEqual({
      width: 800,
      height: 600,
    });
  });

  test("только viewBox — не наш случай, размер считает resvg", () => {
    expect(declaredRasterSize(`<svg viewBox="0 0 100 100"></svg>`)).toBeNull();
  });

  test("проценты и единицы пропускаем дальше", () => {
    expect(declaredRasterSize(`<svg width="100%" height="100%"></svg>`)).toBeNull();
    expect(declaredRasterSize(`<svg width="10em" height="10em"></svg>`)).toBeNull();
  });

  test("нулевая и отрицательная сторона — не размер", () => {
    expect(declaredRasterSize(`<svg width="0" height="10"></svg>`)).toBeNull();
    expect(declaredRasterSize(`<svg width="-5" height="10"></svg>`)).toBeNull();
  });

  test("без тега svg — null", () => {
    expect(declaredRasterSize(`<div width="10" height="10"></div>`)).toBeNull();
  });

  test("размеры берутся только из корневого тега, не из вложенных", () => {
    const svg = `<svg width="100" height="100"><rect width="${over}" height="${over}"/></svg>`;
    expect(declaredRasterSize(svg)).toEqual({ width: 100, height: 100 });
  });
});
