// Deterministic fixture mirroring the real DefiLlama emissionsIndex shape
// (https://defillama-datasets.llama.fi/emissionsIndex). Timestamps are chosen
// relative to FIXTURE_NOW_MS so tests are stable as real time passes.

export const FIXTURE_NOW_MS = 1_700_000_000_000; // 2023-11-14T22:13:20Z

const NOW_SEC = FIXTURE_NOW_MS / 1000;
const DAY = 86_400;

export const EMISSIONS_FIXTURE = {
  data: [
    {
      // Two future events — nearest (in 10 days) should win; mcap/circ => price.
      name: "Aave",
      token: "coingecko:aave",
      gecko_id: "aave",
      maxSupply: 16_000_000,
      circSupply: 14_000_000,
      mcap: 1_400_000_000, // => unit price $100
      events: [
        {
          description: "later event",
          timestamp: NOW_SEC + 40 * DAY,
          noOfTokens: [500_000],
          category: "insiders",
          unlockType: "cliff",
        },
        {
          description: "nearest future event",
          timestamp: NOW_SEC + 10 * DAY,
          noOfTokens: [80_000, 80_000], // sum 160_000 => 1% of 16M
          category: "publicSale",
          unlockType: "cliff",
        },
      ],
    },
    {
      // tokenPrice as explicit number; symbol from token split.
      name: "Based",
      token: "coingecko:based-one",
      gecko_id: "based-one",
      maxSupply: 1_000_000_000,
      circSupply: 300_000_000,
      tokenPrice: 0.05,
      events: [
        {
          timestamp: NOW_SEC + 5 * DAY,
          noOfTokens: [50_000_000], // 5% of 1B; $2.5M
          category: "airdrop",
          unlockType: "cliff",
        },
      ],
    },
    {
      // No max supply -> must be skipped (can't compute % of supply).
      name: "NoMaxSupply",
      token: "coingecko:nomax",
      events: [
        { timestamp: NOW_SEC + 3 * DAY, noOfTokens: [1000] },
      ],
    },
    {
      // Only past events -> skipped.
      name: "PastOnly",
      token: "coingecko:past",
      maxSupply: 1_000_000,
      mcap: 1_000_000,
      circSupply: 1_000_000,
      events: [
        { timestamp: NOW_SEC - 5 * DAY, noOfTokens: [10_000] },
      ],
    },
    {
      // No price info -> amountUsd should be null but row still emitted.
      name: "NoPrice",
      token: "coingecko:noprice",
      maxSupply: 1_000_000,
      events: [
        { timestamp: NOW_SEC + 2 * DAY, noOfTokens: [100_000] }, // 10%
      ],
    },
    {
      // Garbage row -> skipped without throwing.
      name: "",
      events: "not-an-array",
      maxSupply: "nan",
    },
  ],
};
