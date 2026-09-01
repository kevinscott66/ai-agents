/**
 * Аудит 2026-08-28: нижняя граница окна событий не могла сработать.
 *
 * В parseEmissions рядом с верхней границей (`nowSec + 20 лет`) жила нижняя,
 * `nowSec - 365 * 24 * 3600`, и проверялись они одной строкой. Но отбор
 * событий берёт только строго будущие (`ts <= nowSec` — continue), а «год
 * назад» меньше, чем «сейчас»: до сравнения с нижней границей не доходило ни
 * одно значение, которое она отсекла бы.
 *
 * Читалась она при этом как защита от прошлого — и следующая правка отбора
 * оперлась бы на неё. Граница убрана; тесты ниже пиняют, чем прошлое
 * отсекается на самом деле, чтобы удаление не осталось необъяснённым.
 */
import { describe, expect, test } from "bun:test";
import { parseEmissions } from "./unlocks.ts";

const NOW = Date.UTC(2026, 7, 28);
const sec = NOW / 1000;
const YEAR = 365 * 24 * 3600;

function project(events: unknown[], over: Record<string, unknown> = {}) {
  return {
    name: "Acme",
    token: "coingecko:acme",
    maxSupply: 1_000_000,
    events,
    ...over,
  };
}
const parse = (events: unknown[]) => parseEmissions({ data: [project(events)] }, NOW);

describe("прошлое отсекает проверка «строго будущее»", () => {
  test("событие годовой давности не попадает в выборку", () => {
    expect(parse([{ timestamp: sec - YEAR, noOfTokens: [10_000] }])).toEqual([]);
  });

  test("событие старше года — тоже", () => {
    // Раньше сюда целилась нижняя граница; она была недостижима.
    expect(parse([{ timestamp: sec - 5 * YEAR, noOfTokens: [10_000] }])).toEqual([]);
  });

  test("секунда назад и ровно сейчас — уже прошлое", () => {
    expect(parse([{ timestamp: sec - 1, noOfTokens: [10_000] }])).toEqual([]);
    expect(parse([{ timestamp: sec, noOfTokens: [10_000] }])).toEqual([]);
  });

  test("прошлое событие не заслоняет будущее у того же проекта", () => {
    const out = parse([
      { timestamp: sec - 2 * YEAR, noOfTokens: [999_999] },
      { timestamp: sec + 86_400, noOfTokens: [10_000] },
    ]);
    expect(out.length).toBe(1);
    expect(out[0]!.pctOfSupply).toBeCloseTo(1, 6);
  });
});

describe("верхняя граница осталась на месте", () => {
  test("отметка в миллисекундах не проходит", () => {
    expect(parse([{ timestamp: (sec + 86_400) * 1000, noOfTokens: [10_000] }])).toEqual([]);
  });

  test("двадцать лет с лишним — не проходит", () => {
    expect(parse([{ timestamp: sec + 21 * YEAR, noOfTokens: [10_000] }])).toEqual([]);
  });

  test("ближайшее будущее внутри окна проходит", () => {
    const out = parse([{ timestamp: sec + 10 * 86_400, noOfTokens: [10_000] }]);
    expect(out.length).toBe(1);
  });
});
