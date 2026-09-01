/**
 * Аудит 2026-08-21: цену разблокировки выбирал порядок полей в JSON.
 *
 * `deriveUnitPrice` для объектной формы `tokenPrice` шёл по `Object.values()`
 * и возвращал ПЕРВОЕ положительное число, не глядя на ключ. Комментарий рядом
 * честно признаёт, что форма варьируется — то есть код верен ровно тогда,
 * когда в объекте один-единственный ключ.
 *
 * Замер до правки на форме price-объекта DefiLlama
 * ({decimals, symbol, price, timestamp, confidence}), 100 000 токенов при
 * ожидаемых $42 000:
 *   decimals-first : amountUsd 1 800 000   (взято decimals: 18)
 *   price-first    : amountUsd    42 000   (случайно верно)
 *   confidence-1st : amountUsd    99 000   (взято confidence: 0.99)
 * С `timestamp` в голове сумма уехала бы на девять порядков.
 *
 * Число публикуется на delabs.space в «Ближайших разблокировках» как сумма в
 * долларах. Поэтому правило: берём цену по осмысленному ключу, а при
 * незнакомой форме НЕ угадываем — падаем на mcap/circSupply, а если и его нет,
 * оставляем `amountUsd: null` (контракт это разрешает, `types.ts`).
 *
 * Файл перенесён из ветки fix/site-unlocks-token-price-object (PR #580,
 * закрыт как дубль этой ветки). Обе чинили один дефект; здесь он идёт в
 * комплекте с четырьмя соседними. Уникальным у #580 было нормализованное
 * сравнение имени ключа — без него `{decimals: 18, priceusd: 0.42}` давал не
 * промах, а цену 18: имя не совпадало по регистру, и срабатывал позиционный
 * перебор. Позиционный путь сохранён, но сужен до объекта из одного поля —
 * см. `deriveUnitPrice`.
 */
import { describe, expect, test } from "bun:test";
import { parseEmissions } from "./unlocks.ts";

const NOW_MS = 1_760_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);
const DAY = 86_400;

function feed(tokenPrice: unknown, extra: Record<string, unknown> = {}) {
  return [
    {
      name: "Acme",
      token: "coingecko:acme",
      maxSupply: 1_000_000,
      tokenPrice,
      ...extra,
      events: [{ timestamp: NOW_SEC + 3 * DAY, noOfTokens: [100_000] }],
    },
  ];
}
const usd = (tokenPrice: unknown, extra?: Record<string, unknown>) =>
  parseEmissions(feed(tokenPrice, extra), NOW_MS)[0]?.amountUsd;

describe("deriveUnitPrice: объектный tokenPrice", () => {
  test("цена берётся по ключу price, а не по порядку полей", () => {
    expect(
      usd({ decimals: 18, symbol: "ACME", price: 0.42, timestamp: 1_700_000_000, confidence: 0.99 }),
    ).toBe(42_000);
  });

  test("порядок ключей не влияет на результат", () => {
    const a = usd({ price: 0.42, decimals: 18, confidence: 0.99 });
    const b = usd({ confidence: 0.99, decimals: 18, price: 0.42 });
    expect({ a, b }).toEqual({ a: 42_000, b: 42_000 });
  });

  test("незнакомая форма не угадывается — падаем на mcap/circSupply", () => {
    // Цена из фолбэка: 2e6 / 1e6 = $2 => 100_000 * 2 = 200_000.
    // Раньше здесь вернулось бы 1_800_000 (decimals: 18).
    expect(usd({ decimals: 18, confidence: 0.99 }, { mcap: 2_000_000, circSupply: 1_000_000 })).toBe(
      200_000,
    );
  });

  test("незнакомая форма без фолбэка — null, а не выдуманная сумма", () => {
    expect(usd({ decimals: 18, timestamp: 1_700_000_000 })).toBeNull();
  });

  test("написание ключа не важно: priceUsd / current_price / USD", () => {
    expect({
      camel: usd({ decimals: 18, priceUsd: 0.42 }),
      snake: usd({ decimals: 18, current_price: 0.42 }),
      upper: usd({ decimals: 18, USD: 0.42 }),
    }).toEqual({ camel: 42_000, snake: 42_000, upper: 42_000 });
  });

  test("два незнакомых поля — не угадываем даже одно число", () => {
    // Форма DefiLlama без самой цены. `decimals: 18` проходит проверку на
    // правдоподобность (это законная цена токена), поэтому позиционный перебор
    // вернул бы $18 за штуку и напечатал бы это на главной как факт.
    expect(usd({ decimals: 18, symbol: "ACME" })).toBeNull();
  });

  test("объект из одного поля читается позиционно — угадывать нечего", () => {
    expect(usd({ someNewKey: 0.42 })).toBe(42_000);
  });

  test("числовая форма tokenPrice по-прежнему работает", () => {
    expect(usd(0.42)).toBe(42_000);
  });

  test("ноль и отрицательная цена не считаются ценой", () => {
    expect({
      zero: usd({ price: 0 }, { mcap: 2_000_000, circSupply: 1_000_000 }),
      neg: usd({ price: -1 }, { mcap: 2_000_000, circSupply: 1_000_000 }),
    }).toEqual({ zero: 200_000, neg: 200_000 });
  });
});
