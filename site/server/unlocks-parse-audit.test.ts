/**
 * Аудит 2026-08-20 — числа, которые parseEmissions печатал на главной.
 *
 * Все фикстуры собраны прямо здесь и минимальны: у каждой ровно одно отличие
 * от здоровой формы, чтобы тест падал по той причине, ради которой написан.
 */
import { describe, expect, test } from "bun:test";
import { parseEmissions } from "./unlocks.ts";

const NOW = Date.UTC(2026, 7, 20);
const soon = (days: number) => NOW / 1000 + days * 86_400;

/** Здоровый проект: 160к токенов из 16М, цена $0.42 → $67 200 и 1% предложения. */
function project(over: Record<string, unknown> = {}) {
  return {
    name: "Aave",
    token: "coingecko:aave",
    maxSupply: 16_000_000,
    events: [{ timestamp: soon(10), noOfTokens: [160_000] }],
    ...over,
  };
}
const parse = (p: unknown) => parseEmissions({ data: [p] }, NOW);

describe("аудит 2026-08-20: цена берётся по имени ключа, а не по порядку", () => {
  test("decimals впереди price больше не выдаётся за цену", () => {
    // Раньше: первое положительное число из Object.values → 18 → $2 880 000.
    const out = parse(
      project({
        tokenPrice: {
          decimals: 18,
          symbol: "AAVE",
          price: 0.42,
          confidence: 0.99,
        },
      }),
    );
    expect(out[0]!.amountUsd).toBe(67_200);
  });

  test("timestamp впереди price не проходит даже позиционно", () => {
    const out = parse(
      project({ tokenPrice: { timestamp: 1_786_000_000, usd: 0.42 } }),
    );
    expect(out[0]!.amountUsd).toBe(67_200);
  });

  test("неизвестная форма объекта всё ещё читается позиционно", () => {
    // Форма поля в фиде официально «varies»: молча терять цену хуже, чем
    // перебрать значения. Запасной путь сохранён намеренно.
    const out = parse(project({ tokenPrice: { someNewKey: 0.42 } }));
    expect(out[0]!.amountUsd).toBe(67_200);
  });

  test("абсурдная цена отбраковывается, а не умножается", () => {
    // mcap 1e9 при circSupply 1e-6 давал цену 1e15 и сумму 1.6e20.
    const out = parse(
      project({ mcap: 1e9, circSupply: 1e-6, tokenPrice: undefined }),
    );
    expect(out[0]!.amountUsd).toBeNull();
  });

  test("честная цена мем-монеты не отбраковывается вместе с мусором", () => {
    const out = parse(
      project({ tokenPrice: { price: 1e-9 }, maxSupply: 16_000_000 }),
    );
    expect(out[0]!.amountUsd).toBe(0);
  });
});

describe("аудит 2026-08-20: одна битая строка не убивает прогон", () => {
  test("микросекундная отметка пропускается, соседи выживают", () => {
    // Раньше: RangeError из toISOString вылетал наружу, refreshUnlocks писал
    // «refresh failed» и возвращал 0 — хорошие проекты гибли вместе с плохим.
    const out = parseEmissions(
      {
        data: [
          { ...project({ name: "Bad" }), events: [{ timestamp: 1.786e15, noOfTokens: [1] }] },
          project({ name: "Good" }),
        ],
      },
      NOW,
    );
    expect(out.map((u) => u.project)).toEqual(["Good"]);
  });

  test("миллисекундная отметка не превращается в неудаляемый призрак", () => {
    // Она не бросала — давала дату «+058566-…», невидимую для `date >= now`
    // (лексикографика: "+" < "2") и неудаляемую тем же условием.
    const out = parse(
      project({ events: [{ timestamp: 1.786e12, noOfTokens: [1] }] }),
    );
    expect(out).toEqual([]);
  });

  test("нормальная дальняя разблокировка остаётся", () => {
    const out = parse(project({ events: [{ timestamp: soon(365 * 4), noOfTokens: [160_000] }] }));
    expect(out).toHaveLength(1);
    expect(out[0]!.date.startsWith("2030-")).toBe(true);
  });
});

describe("аудит 2026-08-20: события одной даты складываются", () => {
  test("три категории в один момент дают сумму, а не первую из них", () => {
    const ts = soon(10);
    const out = parse(
      project({
        events: [
          { timestamp: ts, noOfTokens: [10_000], category: "team" },
          { timestamp: ts, noOfTokens: [90_000], category: "insiders" },
          { timestamp: ts, noOfTokens: [60_000], category: "investors" },
        ],
      }),
    );
    expect(out[0]!.pctOfSupply).toBeCloseTo(1, 5);
  });

  test("складывается только ближайшая дата, дальняя не примешивается", () => {
    const near = soon(10);
    const out = parse(
      project({
        events: [
          { timestamp: near, noOfTokens: [10_000] },
          { timestamp: soon(40), noOfTokens: [5_000_000] },
          { timestamp: near, noOfTokens: [6_000] },
        ],
      }),
    );
    expect(out[0]!.pctOfSupply).toBeCloseTo(0.1, 5);
    expect(out[0]!.date).toBe(new Date(near * 1000).toISOString());
  });
});

describe("аудит 2026-08-20: мелкая разблокировка не показывается как ноль", () => {
  test("1000 токенов из миллиарда — не «0% предложения»", () => {
    const out = parse(
      project({ maxSupply: 1e9, events: [{ timestamp: soon(10), noOfTokens: [1000] }] }),
    );
    expect(out[0]!.pctOfSupply).toBeGreaterThan(0);
    expect(out[0]!.pctOfSupply).toBeCloseTo(0.0001, 8);
  });

  test("обычные проценты по-прежнему аккуратные", () => {
    expect(parse(project())[0]!.pctOfSupply).toBe(1);
  });
});
