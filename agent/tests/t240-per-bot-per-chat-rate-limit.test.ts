/**
 * T-240: per-bot per-chat rate limiting tests.
 * 
 * Verifies that per-bot-per-chat rate limiting works as an additional dimension
 * on top of existing per-chat and per-agent rate limiting.
 * 
 * Scenarios:
 *  1) Same bot in multiple chats: rate limits are independent per chat
 *  2) Different bots in same chat: rate limits are independent per bot
 *  3) Same bot same chat: rate limit enforced (burst > limit → 429 in audit)
 *  4) Missing botId or chatId: bypassed gracefully
 */
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import {
  checkPerBotPerChatRateLimit,
  commitPerBotPerChatRateLimit,
  _resetRateLimits,
} from "../lib/rate-limits.ts";

const ENV_KEY = "RATE_LIMIT_PER_CHAT_PER_MIN";
const savedEnv = process.env[ENV_KEY];

beforeEach(() => {
  process.env[ENV_KEY] = "5"; // Set limit to 5 for testing
  _resetRateLimits();
});

afterAll(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  _resetRateLimits();
});

/**
 * Helper to perform check + commit in one call, similar to actual usage.
 */
function attemptPerBotPerChat(
  botId: number,
  chatId: number,
  action: string,
): { ok: boolean; reason?: string } {
  const r = checkPerBotPerChatRateLimit(botId, chatId, action);
  if (r.ok) {
    commitPerBotPerChatRateLimit(botId, chatId, action);
  }
  return { ok: r.ok, reason: r.reason };
}

describe("T-240: per-bot per-chat rate limiting", () => {
  test("same bot, multiple chats → rate limits are independent per chat", () => {
    const botId = 12345;
    const action = "SEND_MESSAGE";
    
    // Bot sends 5 messages in chat A (fills the bucket)
    let successA = 0;
    for (let i = 0; i < 5; i++) {
      if (attemptPerBotPerChat(botId, -1001, action).ok) successA++;
    }
    expect(successA).toBe(5);
    
    // 6th message in chat A should be denied
    expect(attemptPerBotPerChat(botId, -1001, action).ok).toBe(false);
    
    // But bot can still send 5 messages in chat B (independent bucket)
    let successB = 0;
    for (let i = 0; i < 5; i++) {
      if (attemptPerBotPerChat(botId, -1002, action).ok) successB++;
    }
    expect(successB).toBe(5);
  });

  test("different bots, same chat → rate limits are independent per bot", () => {
    const chatId = -1003;
    const action = "SEND_MESSAGE";
    
    // Bot A sends 5 messages in the chat (fills its bucket)
    let successBotA = 0;
    for (let i = 0; i < 5; i++) {
      if (attemptPerBotPerChat(11111, chatId, action).ok) successBotA++;
    }
    expect(successBotA).toBe(5);
    
    // Bot A is now rate limited
    expect(attemptPerBotPerChat(11111, chatId, action).ok).toBe(false);
    
    // But Bot B can still send 5 messages in the same chat (independent bucket)
    let successBotB = 0;
    for (let i = 0; i < 5; i++) {
      if (attemptPerBotPerChat(22222, chatId, action).ok) successBotB++;
    }
    expect(successBotB).toBe(5);
  });

  test("same bot same chat → rate limit enforced (burst > limit → denial)", () => {
    const botId = 33333;
    const chatId = -1004;
    const action = "SET_REACTION";
    
    let ok = 0;
    let denied = 0;
    let denialReasons: string[] = [];
    
    // Attempt 10 actions when limit is 5
    for (let i = 0; i < 10; i++) {
      const r = attemptPerBotPerChat(botId, chatId, action);
      if (r.ok) {
        ok++;
      } else {
        denied++;
        if (r.reason) denialReasons.push(r.reason);
      }
    }
    
    expect(ok).toBe(5);
    expect(denied).toBe(5);
    
    // All denials should mention "per bot per chat"
    expect(denialReasons.every(r => r.includes("per bot per chat"))).toBe(true);
  });

  test("missing botId → bypassed gracefully", () => {
    const chatId = -1005;
    const action = "SEND_MESSAGE";
    
    // When botId is undefined, should always return ok
    for (let i = 0; i < 10; i++) {
      const r = checkPerBotPerChatRateLimit(undefined, chatId, action);
      expect(r.ok).toBe(true);
    }
  });

  test("missing chatId → bypassed gracefully", () => {
    const botId = 44444;
    const action = "SEND_MESSAGE";
    
    // When chatId is undefined, should always return ok
    for (let i = 0; i < 10; i++) {
      const r = checkPerBotPerChatRateLimit(botId, undefined, action);
      expect(r.ok).toBe(true);
    }
  });

  test("string botId and chatId work correctly", () => {
    const botId = "str_bot_123";
    const chatId = "str_chat_456";
    const action = "DELETE_MESSAGE";
    
    let ok = 0;
    for (let i = 0; i < 7; i++) {
      if (attemptPerBotPerChat(botId as any, chatId as any, action).ok) ok++;
    }
    
    // Should allow exactly 5 (the configured limit)
    expect(ok).toBe(5);
  });

  test("retryInMs is provided on rate limit hit", () => {
    const botId = 55555;
    const chatId = -1006;
    const action = "FORWARD_MESSAGE";
    
    // Fill the bucket
    for (let i = 0; i < 5; i++) {
      attemptPerBotPerChat(botId, chatId, action);
    }
    
    // 6th attempt should be denied with retryInMs
    const r = checkPerBotPerChatRateLimit(botId, chatId, action);
    expect(r.ok).toBe(false);
    expect(r.retryInMs).toBeGreaterThan(0);
  });
});