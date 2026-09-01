/**
 * C16: per-agent daily token budget.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import {
  recordUsage,
  getDailyUsage,
  getBudget,
  checkBudget,
  BudgetExceededError,
  todayUTC,
} from "../lib/token-budget.ts";
import { callAnthropic, __setAnthropicClientForTests } from "../lib/anthropic-client.ts";

const AGENT = "c16_test_agent";
const ENV_KEY = `TOKEN_BUDGET_${AGENT.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;

function cleanup(): void {
  db.prepare(`DELETE FROM agent_token_usage WHERE agent_key LIKE 'c16_%'`).run();
  delete process.env[ENV_KEY];
  delete process.env.TOKEN_BUDGET_DEFAULT;
}

beforeEach(cleanup);
afterEach(() => {
  cleanup();
  __setAnthropicClientForTests(null);
});

function fakeAnthropic(usage: { input_tokens: number; output_tokens: number }) {
  let calls = 0;
  const client = {
    messages: {
      create: async () => {
        calls++;
        return {
          id: "msg",
          type: "message",
          role: "assistant",
          model: "test",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage,
          content: [{ type: "text", text: "ok" }],
        };
      },
    },
  } as any;
  return { client, getCalls: () => calls };
}

describe("C16 token-budget", () => {
  test("recordUsage upserts and accumulates same-day", () => {
    recordUsage(AGENT, 100, 50);
    recordUsage(AGENT, 30, 20);
    const u = getDailyUsage(AGENT);
    expect(u.input).toBe(130);
    expect(u.output).toBe(70);
  });

  test("getDailyUsage returns zeros for unknown agent", () => {
    const u = getDailyUsage("c16_nobody");
    expect(u).toEqual({ input: 0, output: 0 });
  });

  test("recordUsage isolates by date", () => {
    recordUsage(AGENT, 100, 10, "2024-01-01");
    recordUsage(AGENT, 5, 1, "2024-01-02");
    expect(getDailyUsage(AGENT, "2024-01-01").input).toBe(100);
    expect(getDailyUsage(AGENT, "2024-01-02").input).toBe(5);
    expect(getDailyUsage(AGENT).input).toBe(0);
  });

  test("getBudget reads per-agent env, fallback DEFAULT, then Infinity", () => {
    expect(getBudget(AGENT)).toBe(Infinity);
    process.env.TOKEN_BUDGET_DEFAULT = "1000";
    expect(getBudget(AGENT)).toBe(1000);
    process.env[ENV_KEY] = "5000";
    expect(getBudget(AGENT)).toBe(5000);
  });

  test("checkBudget passes under limit, throws at/over", () => {
    process.env[ENV_KEY] = "100";
    expect(() => checkBudget(AGENT)).not.toThrow();
    recordUsage(AGENT, 50, 0);
    expect(() => checkBudget(AGENT)).not.toThrow();
    recordUsage(AGENT, 50, 0); // now at limit
    expect(() => checkBudget(AGENT)).toThrow(BudgetExceededError);
  });

  test("checkBudget no-op when budget is Infinity", () => {
    recordUsage(AGENT, 1_000_000, 0);
    expect(() => checkBudget(AGENT)).not.toThrow();
  });

  test("checkBudget no-op for falsy agentKey", () => {
    process.env.TOKEN_BUDGET_DEFAULT = "1";
    recordUsage("x", 1000, 0);
    expect(() => checkBudget("")).not.toThrow();
    expect(() => checkBudget(undefined as any)).not.toThrow();
  });

  test("callAnthropic blocks when budget exceeded", async () => {
    process.env[ENV_KEY] = "100";
    recordUsage(AGENT, 100, 0);
    const { client, getCalls } = fakeAnthropic({ input_tokens: 1, output_tokens: 1 });
    await expect(
      callAnthropic(
        {
          model: "test",
          max_tokens: 10,
          messages: [{ role: "user", content: "hi" }],
        },
        client,
        AGENT,
      ),
    ).rejects.toThrow(BudgetExceededError);
    expect(getCalls()).toBe(0);
  });

  test("callAnthropic records usage after success", async () => {
    const { client } = fakeAnthropic({ input_tokens: 42, output_tokens: 17 });
    await callAnthropic(
      {
        model: "test",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      },
      client,
      AGENT,
    );
    const u = getDailyUsage(AGENT);
    expect(u.input).toBe(42);
    expect(u.output).toBe(17);
  });

  test("callAnthropic without agentKey skips budget logic", async () => {
    process.env.TOKEN_BUDGET_DEFAULT = "1";
    const { client } = fakeAnthropic({ input_tokens: 999, output_tokens: 1 });
    const resp = await callAnthropic(
      {
        model: "test",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      },
      client,
    );
    expect(resp).toBeDefined();
    // nothing recorded for any specific test agent
    expect(getDailyUsage(AGENT)).toEqual({ input: 0, output: 0 });
  });

  test("todayUTC matches ISO date prefix", () => {
    const d = todayUTC();
    expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(d).toBe(new Date().toISOString().slice(0, 10));
  });
});
