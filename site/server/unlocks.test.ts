import { describe, expect, test } from "bun:test";
import { parseEmissions } from "./unlocks.ts";
import { EMISSIONS_FIXTURE, FIXTURE_NOW_MS } from "./unlocks.fixture.ts";
import type { Unlock } from "./types.ts";

describe("parseEmissions (DefiLlama emissionsIndex parser)", () => {
  const out = parseEmissions(EMISSIONS_FIXTURE, FIXTURE_NOW_MS);
  const by = (p: string): Unlock | undefined =>
    out.find((u) => u.project === p);

  test("emits one unlock per project that has a future event + maxSupply", () => {
    const names = out.map((u) => u.project).sort();
    expect(names).toEqual(["Aave", "Based", "NoPrice"]);
  });

  test("picks the NEAREST future event per project", () => {
    const aave = by("Aave")!;
    const expectedDate = new Date(
      FIXTURE_NOW_MS + 10 * 86_400 * 1000,
    ).toISOString();
    expect(aave.date).toBe(expectedDate);
    // 160_000 / 16_000_000 = 1%
    expect(aave.pctOfSupply).toBeCloseTo(1, 5);
  });

  test("computes amountUsd from mcap/circSupply when no tokenPrice", () => {
    // price = 1.4e9 / 14e6 = $100; tokens 160_000 => $16,000,000
    expect(by("Aave")!.amountUsd).toBe(16_000_000);
  });

  test("computes amountUsd from explicit tokenPrice", () => {
    // 50_000_000 * 0.05 = $2,500,000 ; 5% of supply
    const based = by("Based")!;
    expect(based.amountUsd).toBe(2_500_000);
    expect(based.pctOfSupply).toBeCloseTo(5, 5);
    expect(based.symbol).toBe("BASEDONE"); // derived from token slug
  });

  test("amountUsd is null when no price is available", () => {
    const np = by("NoPrice")!;
    expect(np.amountUsd).toBeNull();
    expect(np.pctOfSupply).toBeCloseTo(10, 5);
  });

  test("skips rows without maxSupply, past-only rows, and garbage", () => {
    expect(by("NoMaxSupply")).toBeUndefined();
    expect(by("PastOnly")).toBeUndefined();
    expect(out.some((u) => u.project === "")).toBe(false);
  });

  test("results are sorted soonest-first", () => {
    const dates = out.map((u) => u.date);
    const sorted = [...dates].sort();
    expect(dates).toEqual(sorted);
  });

  test("never throws on malformed input", () => {
    expect(parseEmissions(null)).toEqual([]);
    expect(parseEmissions({})).toEqual([]);
    expect(parseEmissions({ data: "x" })).toEqual([]);
    expect(parseEmissions([{ name: "X" }])).toEqual([]);
  });
});

describe("deriveSymbol — hex-address contracts (no truncated 0x… tickers)", () => {
  const nowMs = 1_700_000_000_000;
  const future = nowMs / 1000 + 10 * 86_400;

  const mk = (extra: Record<string, unknown>) => ({
    data: [
      {
        name: "Salty.IO",
        maxSupply: 1_000_000,
        events: [{ timestamp: future, noOfTokens: [100_000] }],
        ...extra,
      },
    ],
  });

  test("token '<chain>:0xCONTRACT' does NOT yield a hex symbol; uses name", () => {
    const u = parseEmissions(
      mk({ token: "ethereum:0xabc1234567890def" }),
      nowMs,
    )[0];
    expect(u).toBeTruthy();
    expect(/^0x/i.test(u.symbol)).toBe(false);
    // "Salty.IO" -> single word -> "SALTY.IO" stripped of dot -> "SALTYIO".
    expect(u.symbol).toBe("SALTYIO");
  });

  test("falls back to gecko_id when token is a hex address", () => {
    const u = parseEmissions(
      mk({ token: "ethereum:0xDEADBEEF1234", gecko_id: "salty-io" }),
      nowMs,
    )[0];
    expect(/^0x/i.test(u.symbol)).toBe(false);
    expect(u.symbol).toBe("SALTYIO");
  });

  test("normal coingecko slug still works", () => {
    const u = parseEmissions(mk({ token: "coingecko:salty-io" }), nowMs)[0];
    expect(u.symbol).toBe("SALTYIO");
  });

  test("hex address in the `symbol` field is rejected (regression)", () => {
    // The feed sometimes puts a contract address in `symbol` — must NOT show it.
    const u = parseEmissions(
      mk({ symbol: "0x0110b0c3aaaaaaaa", token: "ethereum:0x0110b0c3aaaaaaaa" }),
      nowMs,
    )[0];
    expect(/^0x/i.test(u.symbol)).toBe(false);
    expect(u.symbol).toBe("SALTYIO");
  });

  test("never emits a hex ticker across many shapes", () => {
    const shapes = [
      { symbol: "0xDEADBEEFCAFE" },
      { token: "bsc:0x1234567890abcdef" },
      { gecko_id: "0xfeed0000beef" },
      { symbol: "0xAAA", gecko_id: "0xBBB", token: "eth:0xCCC" },
    ];
    for (const s of shapes) {
      const u = parseEmissions(mk(s), nowMs)[0];
      expect(/^0x/i.test(u.symbol)).toBe(false);
    }
  });
});
