/**
 * Bug fixes:
 *  1) callAnthropic retries on 429 (mocked SDK).
 *  2) SET_REACTION rejects non-whitelisted emoji BEFORE hitting Telegram.
 */
import { describe, test, expect, afterEach, mock } from "bun:test";
import {
  callAnthropic,
  __setAnthropicClientForTests,
  __setSleepForTests,
} from "../lib/anthropic-client.ts";
import { executeTool } from "../lib/tools-schema.ts";
import { setAutonomy } from "../lib/permissions.ts";
import {
  cleanupChat,
  saveAutonomy,
  restoreAutonomy,
} from "./_helpers.ts";

const TEST_CHAT = -1_000_888;
const TEST_AGENT = "qa";

let savedGlobal = saveAutonomy();
afterEach(() => {
  restoreAutonomy(savedGlobal);
  cleanupChat(TEST_CHAT, TEST_AGENT);
  __setAnthropicClientForTests(null);
  __setSleepForTests(null);
});

/**
 * Аудит 2026-08-20: обе фикстуры ниже слали `retry-after: 0` — не ради
 * проверки нуля, а чтобы живой цикл ретраев проходил мгновенно. Ноль теперь
 * значит «заголовка нет» (он разом снимал и паузу, и рост `backoff429`), так
 * что минимальное осмысленное значение — секунда, а скорость возвращает
 * подменяемый сон.
 */
describe("callAnthropic: 429 retry", () => {
  test("retries after 429 with retry-after header and succeeds", async () => {
    __setSleepForTests(async () => {});
    let calls = 0;
    const create = mock(() => {
      calls++;
      if (calls === 1) {
        const err = new Error("rate limit") as Error & {
          status: number;
          headers: Record<string, string>;
        };
        err.status = 429;
        err.headers = { "retry-after": "1" };
        throw err;
      }
      return Promise.resolve({
        id: "msg_x",
        type: "message",
        role: "assistant",
        model: "stub",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: "text", text: "ok" }],
      });
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    __setAnthropicClientForTests({ messages: { create } } as any);

    const resp = await callAnthropic({
      model: "stub",
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(calls).toBe(2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((resp as any).content[0].text).toBe("ok");
  });

  test("gives up after 5 retries on persistent 429", async () => {
    __setSleepForTests(async () => {});
    let calls = 0;
    const create = mock(() => {
      calls++;
      const err = new Error("rate limit") as Error & {
        status: number;
        headers: Record<string, string>;
      };
      err.status = 429;
      err.headers = { "retry-after": "1" };
      throw err;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    __setAnthropicClientForTests({ messages: { create } } as any);

    let threw = false;
    try {
      await callAnthropic({
        model: "stub",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    // 1 initial + 5 retries = 6 attempts
    expect(calls).toBe(6);
  });
});

describe("SET_REACTION whitelist", () => {
  test("rejects non-whitelisted emoji with REACTION_NOT_ALLOWED, no Telegram call", async () => {
    savedGlobal = saveAutonomy();
    setAutonomy("global", "*", "semi_auto");
    const callApi = mock(() => Promise.resolve(true));
    const fakeTg = {
      callApi,
      sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
      deleteMessage: mock(() => Promise.resolve(true)),
      editMessageText: mock(() => Promise.resolve(true)),
      pinChatMessage: mock(() => Promise.resolve(true)),
      forwardMessage: mock(() => Promise.resolve({ message_id: 1 })),
      sendPoll: mock(() => Promise.resolve({ message_id: 1 })),
    };
    const out = await executeTool(
      "SET_REACTION",
      { emoji: "🦖" }, // not in Telegram whitelist
      {
        agentKey: TEST_AGENT,
        chatId: TEST_CHAT,
        triggerMessageId: 99,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        telegram: fakeTg as any,
      },
    );
    const parsed = JSON.parse(out) as { ok: boolean; error?: string };
    expect(parsed.ok).toBe(false);
    expect(String(parsed.error ?? "")).toContain("REACTION_NOT_ALLOWED");
    expect(callApi).not.toHaveBeenCalled();
  });

  test("accepts whitelisted emoji (👍) — Telegram is called", async () => {
    savedGlobal = saveAutonomy();
    setAutonomy("global", "*", "semi_auto");
    const callApi = mock(() => Promise.resolve(true));
    const fakeTg = {
      callApi,
      sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
      deleteMessage: mock(() => Promise.resolve(true)),
      editMessageText: mock(() => Promise.resolve(true)),
      pinChatMessage: mock(() => Promise.resolve(true)),
      forwardMessage: mock(() => Promise.resolve({ message_id: 1 })),
      sendPoll: mock(() => Promise.resolve({ message_id: 1 })),
    };
    const out = await executeTool(
      "SET_REACTION",
      { emoji: "👍" },
      {
        agentKey: TEST_AGENT,
        chatId: TEST_CHAT,
        triggerMessageId: 100,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        telegram: fakeTg as any,
      },
    );
    const parsed = JSON.parse(out) as { ok: boolean };
    expect(parsed.ok).toBe(true);
    expect(callApi).toHaveBeenCalledTimes(1);
  });
});
