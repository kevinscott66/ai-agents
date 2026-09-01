/**
 * T-527: persistent per-agent budget overrides.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import {
  setBudget,
  getBudget,
  getAllBudgetSettings,
} from "../lib/token-budget.ts";

const AGENT = "t527_agent";
const ENV_KEY = `TOKEN_BUDGET_${AGENT.toUpperCase()}`;

function cleanup(): void {
  db.prepare(`DELETE FROM budget_settings WHERE agent_key LIKE 't527_%'`).run();
  delete process.env[ENV_KEY];
  delete process.env.TOKEN_BUDGET_DEFAULT;
}

beforeEach(cleanup);
afterEach(cleanup);

describe("T-527 budget_settings", () => {
  test("setBudget writes a row, getBudget reads it", () => {
    setBudget(AGENT, 12345, "tester");
    expect(getBudget(AGENT)).toBe(12345);
  });

  test("DB override beats TOKEN_BUDGET_<KEY> env", () => {
    process.env[ENV_KEY] = "999";
    expect(getBudget(AGENT)).toBe(999);
    setBudget(AGENT, 50000, "tester");
    expect(getBudget(AGENT)).toBe(50000);
  });

  test("setBudget(null) clears override → falls back to env", () => {
    process.env[ENV_KEY] = "777";
    setBudget(AGENT, 11111, "tester");
    expect(getBudget(AGENT)).toBe(11111);
    setBudget(AGENT, null, "tester");
    expect(getBudget(AGENT)).toBe(777);
  });

  test("getAllBudgetSettings returns rows sorted by agent_key", () => {
    setBudget("t527_zeta", 100, "a");
    setBudget("t527_alpha", 200, "b");
    const all = getAllBudgetSettings().filter((s) =>
      s.agentKey.startsWith("t527_"),
    );
    expect(all.map((s) => s.agentKey)).toEqual(["t527_alpha", "t527_zeta"]);
    expect(all[0]?.dailyInputTokens).toBe(200);
    expect(all[0]?.updatedBy).toBe("b");
    expect(typeof all[0]?.updatedAt).toBe("number");
  });

  test("setBudget rejects non-positive values", () => {
    expect(() => setBudget(AGENT, 0)).toThrow();
    expect(() => setBudget(AGENT, -5)).toThrow();
    expect(() => setBudget(AGENT, NaN)).toThrow();
  });

  test("setBudget upsert updates existing row", () => {
    setBudget(AGENT, 1000, "first");
    setBudget(AGENT, 2000, "second");
    const row = getAllBudgetSettings().find((s) => s.agentKey === AGENT);
    expect(row?.dailyInputTokens).toBe(2000);
    expect(row?.updatedBy).toBe("second");
  });
});
