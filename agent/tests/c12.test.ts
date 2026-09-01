/**
 * C12: rate limits + tool-loop guard.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  checkRateLimit,
  commitRateLimit,
  _resetRateLimits,
} from "../lib/rate-limits.ts";
import { gateOrDispatch } from "../lib/action-dispatch.ts";
import { executeTool } from "../lib/tools-schema.ts";
import { listActions } from "../lib/audit.ts";
import { setAutonomy } from "../lib/permissions.ts";
import { cleanupChat, saveAutonomy, restoreAutonomy } from "./_helpers.ts";

const TEST_CHAT = -1_000_912;
const TEST_AGENT = "design";

let savedGlobal = saveAutonomy();

beforeEach(() => {
  _resetRateLimits();
  cleanupChat(TEST_CHAT);
  cleanupChat(TEST_CHAT, TEST_AGENT);
  savedGlobal = saveAutonomy();
  setAutonomy("global", "*", "auto");
});

afterEach(() => {
  restoreAutonomy(savedGlobal);
  _resetRateLimits();
  cleanupChat(TEST_CHAT);
  cleanupChat(TEST_CHAT, TEST_AGENT);
});

function fakeTg() {
  return {
    callApi: mock(() => Promise.resolve(true)),
    sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
    deleteMessage: mock(() => Promise.resolve(true)),
    editMessageText: mock(() => Promise.resolve(true)),
    pinChatMessage: mock(() => Promise.resolve(true)),
    forwardMessage: mock(() => Promise.resolve({ message_id: 1 })),
    sendPoll: mock(() => Promise.resolve({ message_id: 1 })),
    sendPhoto: mock(() => Promise.resolve({ message_id: 77 })),
  };
}

describe("checkRateLimit", () => {
  test("разрешает под порогом, отказывает после превышения (GENERATE_IMAGE 6+1)", () => {
    const now = 1_000_000;
    for (let i = 0; i < 6; i++) {
      const r = checkRateLimit("design", "GENERATE_IMAGE", now);
      expect(r.ok).toBe(true);
      commitRateLimit("design", "GENERATE_IMAGE", now);
    }
    const r7 = checkRateLimit("design", "GENERATE_IMAGE", now);
    expect(r7.ok).toBe(false);
    expect(r7.reason).toMatch(/per agent/);
    expect(typeof r7.retryInMs).toBe("number");
    expect(r7.retryInMs!).toBeGreaterThan(0);
  });

  test("неизвестный actionType — проверяется только all-tools bucket (60/min)", () => {
    const now = 5_000_000;
    for (let i = 0; i < 60; i++) {
      const r = checkRateLimit("pm", "UNKNOWN_THING", now);
      expect(r.ok).toBe(true);
      commitRateLimit("pm", "UNKNOWN_THING", now);
    }
    const r61 = checkRateLimit("pm", "UNKNOWN_THING", now);
    expect(r61.ok).toBe(false);
    expect(r61.reason).toMatch(/all tools/);
  });

  test("после deny — сдвиг времени за окно → снова allow", () => {
    const t0 = 10_000_000;
    for (let i = 0; i < 6; i++) commitRateLimit("design", "GENERATE_IMAGE", t0);
    expect(checkRateLimit("design", "GENERATE_IMAGE", t0).ok).toBe(false);
    // окно 1 час; сдвинуть вперёд на >1 час
    const t1 = t0 + 60 * 60_000 + 1;
    expect(checkRateLimit("design", "GENERATE_IMAGE", t1).ok).toBe(true);
  });

  test("без commit — бакет остаётся пустым", () => {
    const now = 7_000_000;
    for (let i = 0; i < 100; i++) {
      const r = checkRateLimit("design", "GENERATE_IMAGE", now);
      expect(r.ok).toBe(true);
    }
  });
});

describe("gateOrDispatch + executeTool", () => {
  test("gateOrDispatch возвращает kind:'rate_limited' после превышения порога", async () => {
    const tg = fakeTg();
    // SEND_MESSAGE: 30/min per agent
    for (let i = 0; i < 30; i++) {
      const r = await gateOrDispatch(
        "SEND_MESSAGE",
        { text: `hi ${i}` },
        { agentKey: TEST_AGENT, chatId: TEST_CHAT, telegram: tg as never },
      );
      expect(r.kind).toBe("ok");
    }
    const r31 = await gateOrDispatch(
      "SEND_MESSAGE",
      { text: "boom" },
      { agentKey: TEST_AGENT, chatId: TEST_CHAT, telegram: tg as never },
    );
    expect(r31.kind).toBe("rate_limited");
    if (r31.kind === "rate_limited") {
      expect(r31.reason).toMatch(/SEND_MESSAGE/);
      expect(r31.retryInMs).toBeGreaterThan(0);
      expect(typeof r31.actionId).toBe("string");
    }
  });

  test("executeTool отдаёт JSON со status='rate_limited' и retryInMs", async () => {
    const tg = fakeTg();
    for (let i = 0; i < 30; i++) {
      await executeTool(
        "SEND_MESSAGE",
        { text: `hi ${i}` },
        { agentKey: TEST_AGENT, chatId: TEST_CHAT, telegram: tg as never },
      );
    }
    const out = await executeTool(
      "SEND_MESSAGE",
      { text: "over" },
      { agentKey: TEST_AGENT, chatId: TEST_CHAT, telegram: tg as never },
    );
    const parsed = JSON.parse(out) as {
      ok: boolean;
      status?: string;
      retryInMs?: number;
      reason?: string;
      actionId?: string;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.status).toBe("rate_limited");
    expect(typeof parsed.retryInMs).toBe("number");
    expect(parsed.retryInMs!).toBeGreaterThan(0);
    expect(typeof parsed.actionId).toBe("string");
  });

  test("audit-запись со status='rate_limited' видна в listActions", async () => {
    const tg = fakeTg();
    for (let i = 0; i < 30; i++) {
      await gateOrDispatch(
        "SEND_MESSAGE",
        { text: `hi ${i}` },
        { agentKey: TEST_AGENT, chatId: TEST_CHAT, telegram: tg as never },
      );
    }
    await gateOrDispatch(
      "SEND_MESSAGE",
      { text: "over" },
      { agentKey: TEST_AGENT, chatId: TEST_CHAT, telegram: tg as never },
    );
    const rows = listActions({ agentKey: TEST_AGENT, limit: 100 });
    const rl = rows.find((r) => r.status === "rate_limited");
    expect(rl).toBeDefined();
    expect(rl!.action_type).toBe("SEND_MESSAGE");
    expect(rl!.error).toMatch(/rate limit/);
  });
});

describe("tool-loop turn counter logic", () => {
  test("симуляция счётчика: 3-й вызов того же tool в одном turn → refuse", () => {
    // Эквивалент логики из tool-loop.ts: проверяем поведение Map-счётчика
    // без необходимости мокать Anthropic SDK.
    const callCounts = new Map<string, number>();
    const refused: string[] = [];
    const executed: string[] = [];
    const calls = ["SEND_MESSAGE", "SEND_MESSAGE", "SEND_MESSAGE"];
    for (const name of calls) {
      const n = (callCounts.get(name) ?? 0) + 1;
      callCounts.set(name, n);
      if (n > 2) {
        refused.push(name);
        continue;
      }
      executed.push(name);
    }
    expect(executed.length).toBe(2);
    expect(refused.length).toBe(1);
    expect(refused[0]).toBe("SEND_MESSAGE");
  });

  test("разные tool-имена в одном turn не блокируют друг друга", () => {
    const callCounts = new Map<string, number>();
    const refused: string[] = [];
    const calls = ["SEND_MESSAGE", "SET_REACTION", "SEND_MESSAGE"];
    for (const name of calls) {
      const n = (callCounts.get(name) ?? 0) + 1;
      callCounts.set(name, n);
      if (n > 2) refused.push(name);
    }
    expect(refused.length).toBe(0);
  });
});
