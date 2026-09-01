/**
 * Аудит 2026-08-28: hex-адрес всё-таки утекал в тикер — обрезка шла ПОСЛЕ проверки.
 *
 * Докблок `deriveSymbol` обещает: «Guarantees the result is NEVER a hex
 * contract address». Но `looksLikeHexAddress` требует, чтобы hex была ВСЯ
 * строка, а `slice(0, 10)` выполнялся после неё. Любой кандидат с не-hex
 * хвостом проходил фильтр, а обрезка восстанавливала чистый префикс адреса:
 *
 *   "0xabc1234567890def_v2"     -> "0XABC12345"
 *   "0xC02aaA39b223FE8D (WETH)" -> "0XC02AAA39"
 *
 * Существующие кейсы в unlocks.test.ts этого не ловили: там все кандидаты
 * hex целиком, то есть отсекаются ранней проверкой. Достаточно дописать один
 * не-hex символ в конец — и на карточку публичного сайта уезжает обрубок
 * адреса вместо тикера.
 *
 * Путь через имя (`symbolFromName`) сделан правильно с самого начала — там
 * проверка стоит после обрезки. Расходились два соседних пути одной защиты.
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

describe("hex-адрес с не-hex хвостом", () => {
  test("суффикс после подчёркивания больше не даёт обрубок адреса", () => {
    expect(symbolOf({ symbol: "0xabc1234567890def_v2" })).toBe("SALTYIO");
  });

  test("адрес с пояснением в скобках отбраковывается", () => {
    expect(symbolOf({ gecko_id: "0xC02aaA39b223FE8D (WETH)" })).toBe("SALTYIO");
  });

  test("хвост после дефиса в token отбраковывается", () => {
    expect(symbolOf({ token: "ethereum:0x1234abcd-old" })).toBe("SALTYIO");
  });

  test("ни один кандидат такой формы не доезжает до вывода", () => {
    const shapes = [
      { symbol: "0xdeadbeefcafe!" },
      { gecko_id: "0xfeed0000beefZ" },
      { token: "bsc:0x1234567890abcdef v1" },
      { symbol: "0xAAABBBCCCDDD.old", gecko_id: "0xBBBCCCDDDEEE_2" },
    ];
    for (const s of shapes) {
      expect(/^0x/i.test(symbolOf(s))).toBe(false);
    }
  });

  test("перебор кандидатов не прерывается: следующий не-hex кандидат берётся", () => {
    // symbol отбракован обрезкой — значит должен сработать gecko_id, а не имя.
    expect(symbolOf({ symbol: "0xabc1234567890def_v2", gecko_id: "salty-io" })).toBe(
      "SALTYIO",
    );
  });
});

describe("законные тикеры не задеты", () => {
  test("обычные символы проходят как прежде", () => {
    expect(symbolOf({ symbol: "ARB" })).toBe("ARB");
    expect(symbolOf({ token: "coingecko:based-one" })).toBe("BASEDONE");
    expect(symbolOf({ gecko_id: "salty-io" })).toBe("SALTYIO");
  });

  test("тикер длиннее десяти символов по-прежнему обрезается", () => {
    expect(symbolOf({ symbol: "ABCDEFGHIJKLMNOP" })).toBe("ABCDEFGHIJ");
  });

  test("тикер, начинающийся на 0x, но не hex — не адрес и остаётся", () => {
    // `0xygen` не проходит /^0x[0-9a-f]+$/ ни целиком, ни в обрезке.
    expect(symbolOf({ symbol: "0xygen" })).toBe("0XYGEN");
  });
});
