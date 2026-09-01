/**
 * T-315 / T-300 MED #8: per-chat rate-limit bucket.
 *
 * Verifies that the per-chat bucket is a separate, additive dimension on top
 * of the existing per-agent bucket. Three scenarios:
 *  1) Single agent + single chat, 10 calls, per-chat=5 → 5 ok / 5 denied.
 *  2) 5 different agents in the same chat, 1 call each → 5 ok (saturates chat),
 *     6th call from any agent in same chat denied.
 *  3) 1 agent across 5 different chats, 2 calls each (10 total) → all 10 ok
 *     (per-agent SEND_MESSAGE limit is 30/min, well above 10).
 */
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import {
  checkRateLimit,
  commitRateLimit,
  checkPerChatRateLimit,
  commitPerChatRateLimit,
  _resetRateLimits,
} from "../lib/rate-limits.ts";

const ENV_KEY = "RATE_LIMIT_PER_CHAT_PER_MIN";
const savedEnv = process.env[ENV_KEY];

beforeEach(() => {
  process.env[ENV_KEY] = "5";
  _resetRateLimits();
});

afterAll(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  _resetRateLimits();
});

/**
 * Replays the gate logic: per-chat check first, fall back to per-agent only
 * if chat ok. Mirrors gateOrDispatch wiring. Commits both on ok.
 */
function attempt(
  agent: string,
  chat: number,
  action: string,
): { ok: boolean; reason?: string } {
  const c = checkPerChatRateLimit(chat, action);
  if (!c.ok) return { ok: false, reason: c.reason };
  const a = checkRateLimit(agent, action);
  if (!a.ok) return { ok: false, reason: a.reason };
  commitRateLimit(agent, action);
  commitPerChatRateLimit(chat, action);
  return { ok: true };
}

describe("T-315: per-chat rate-limit bucket", () => {
  test("1 agent, 1 chat, 10 calls → 5 ok / 5 rate_limited (per-chat=5)", () => {
    const action = "SEND_MESSAGE";
    let ok = 0;
    let denied = 0;
    let deniedReasons: string[] = [];
    for (let i = 0; i < 10; i++) {
      const r = attempt("pm", -1001, action);
      if (r.ok) ok++;
      else {
        denied++;
        if (r.reason) deniedReasons.push(r.reason);
      }
    }
    expect(ok).toBe(5);
    expect(denied).toBe(5);
    // The denials must come from the per-chat bucket, not per-agent
    // (SEND_MESSAGE per-agent limit is 30/min, would not trigger at 10 calls).
    expect(deniedReasons.every((r) => r.includes("per chat"))).toBe(true);
  });

  test("5 agents, 1 chat, 1 call each → 5 ok; 6th from any agent denied (per-chat applies across agents)", () => {
    const action = "SEND_MESSAGE";
    const chat = -2002;
    const agents = ["pm", "product", "backend", "frontend", "qa"];
    let ok = 0;
    for (const a of agents) {
      if (attempt(a, chat, action).ok) ok++;
    }
    expect(ok).toBe(5);
    // 6th from a brand-new agent in same chat must be denied by per-chat.
    const sixth = attempt("smm", chat, action);
    expect(sixth.ok).toBe(false);
    expect(sixth.reason).toContain("per chat");
  });

  test("1 agent, 5 chats, 2 calls per chat (10 total) → all 10 ok (chat is independent dimension)", () => {
    const action = "SEND_MESSAGE";
    let ok = 0;
    for (let chat = -3001; chat >= -3005; chat--) {
      for (let i = 0; i < 2; i++) {
        if (attempt("pm", chat, action).ok) ok++;
      }
    }
    expect(ok).toBe(10);
  });

  test("missing chatId bypasses per-chat (only per-agent applies)", () => {
    const action = "SEND_MESSAGE";
    // Without chat context, per-chat must not deny.
    for (let i = 0; i < 5; i++) {
      const c = checkPerChatRateLimit(undefined, action);
      expect(c.ok).toBe(true);
    }
  });
});
