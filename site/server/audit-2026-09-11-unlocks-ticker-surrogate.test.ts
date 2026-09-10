/**
 * Аудит 2026-09-11: `cleanTicker` резала тикер по единицам UTF-16.
 *
 * Соседка по файлу, `symbolFromName`, ушла на кодовые точки ещё 2026-08-29 —
 * именно потому, что одинокий суррогат не кодируется в UTF-8 и доезжает до
 * читателя как U+FFFD. Правку не разнесли на второй путь, хотя комментарий
 * внутри `cleanTicker` объявляет обе функции приведёнными к общему поведению.
 *
 * Путь до бага никакого злого умысла не требует: тикер берётся из фида
 * DefiLlama — `symbol`, `gecko_id` или хвост `token` после двоеточия, все три
 * идут в `cleanTicker` через `deriveSymbol`, — а эмодзи в названиях фид
 * приносит регулярно. Достаточно, чтобы десятая единица UTF-16 пришлась на
 * середину суррогатной пары: девять букв + `\uD83D`. Дальше строка уходит в
 * `replaceUpcomingUnlocks` → SQLite, тот меняет непарный суррогат на U+FFFD,
 * и в БД оказывается не то, что вернула функция, а на карточке `/api/unlocks`
 * вместо тикера стоит битый символ.
 */
import { describe, expect, test } from "bun:test";
import { parseEmissions } from "./unlocks.ts";

const NOW_MS = 1_700_000_000_000;
const FUTURE = NOW_MS / 1000 + 10 * 86_400;

const mk = (extra: Record<string, unknown>) => ({
  data: [
    {
      name: "Salty.IO",
      maxSupply: 1_000_000,
      events: [{ timestamp: FUTURE, noOfTokens: [100_000] }],
      ...extra,
    },
  ],
});

const symbolOf = (extra: Record<string, unknown>): string =>
  parseEmissions(mk(extra), NOW_MS)[0]!.symbol;

/** Есть ли в строке непарный суррогат — то, что SQLite превратит в U+FFFD. */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe("обрезка тикера идёт по кодовым точкам", () => {
  test("пара на десятой единице не рвётся пополам", () => {
    // Девять ASCII, затем эмодзи: индексы 9 и 10 — половинки одной пары.
    const out = symbolOf({ symbol: "ABCDEFGHI\u{1F680}X" });
    expect(hasLoneSurrogate(out)).toBe(false);
    // Десятая КОДОВАЯ ТОЧКА — сам эмодзи, он и входит целиком; отваливается
    // только "X" за потолком. До правки на его месте была половинка пары.
    expect(out).toBe("ABCDEFGHI\u{1F680}");
  });

  test("тот же счёт на пути gecko_id", () => {
    expect(hasLoneSurrogate(symbolOf({ gecko_id: "abcdefghi\u{1F680}z" }))).toBe(
      false,
    );
  });

  test("тот же счёт на пути token", () => {
    expect(
      hasLoneSurrogate(symbolOf({ token: "coingecko:abcdefghi\u{1F680}z" })),
    ).toBe(false);
  });

  test("тикер из одних эмодзи не даёт обрубка", () => {
    const out = symbolOf({ symbol: "\u{1F680}".repeat(12) });
    expect(hasLoneSurrogate(out)).toBe(false);
    // Десять кодовых точек, а не десять единиц UTF-16.
    expect(Array.from(out)).toHaveLength(10);
  });

  test("латинский тикер обрезается ровно как прежде", () => {
    expect(symbolOf({ symbol: "ABCDEFGHIJKLMN" })).toBe("ABCDEFGHIJ");
  });

  test("отбраковка hex-хвоста от правки не пострадала", () => {
    expect(symbolOf({ symbol: "0xabc1234567890def_v2" })).toBe("SALTYIO");
  });
});
