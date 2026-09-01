/**
 * T-410: SEND_MESSAGE via_userbot — owner-voice messaging from real account.
 *
 * Tests (fully hermetic — no network, fake userbot injected via ctx.userbot):
 *  - via_userbot:true calls userbot.sendMessage and returns {via:"userbot", message_id}
 *  - via_userbot:true with no userbot (null) → ok:false "userbot not available"
 *  - non-orchestrator caller with via_userbot:true → ok:false "forbidden"
 *  - plain SEND_MESSAGE (no via_userbot) is unaffected for other roles
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { dispatchAction } from "../lib/action-dispatch.ts";
import type { UserbotHandle } from "../lib/userbot.ts";
import { _resetRateLimits } from "../lib/rate-limits.ts";
import { cleanupChat, saveAutonomy, restoreAutonomy } from "./_helpers.ts";

const TEST_CHAT = -1_000_410;

function makeStubHandle(): UserbotHandle & {
  sends: Array<{ chatId: string | number; text: string; opts?: { replyToMessageId?: number } }>;
} {
  const sends: Array<{ chatId: string | number; text: string; opts?: { replyToMessageId?: number } }> = [];
  return {
    isNoop: false,
    sends,
    async setReaction() {},
    async deleteMessage() {},
    async sendMessage(chatId, text, opts) {
      sends.push({ chatId, text, opts });
      return { message_id: 999 };
    },
    // Каналы этот тест не трогает, но контракт UserbotHandle их требует —
    // заглушки падают, чтобы случайный вызов было видно.
    async createTeamChannel(): Promise<never> {
      throw new Error("createTeamChannel не ожидается в этом тесте");
    },
    async publishPost(): Promise<never> {
      throw new Error("publishPost не ожидается в этом тесте");
    },
    async stop() {},
  };
}

let savedGlobal = saveAutonomy();
beforeEach(() => {
  _resetRateLimits();
  cleanupChat(TEST_CHAT);
  savedGlobal = saveAutonomy();
});
afterEach(() => {
  restoreAutonomy(savedGlobal);
  _resetRateLimits();
  cleanupChat(TEST_CHAT);
});

describe("SEND_MESSAGE via_userbot (T-410)", () => {
  test("via_userbot:true routes through userbot.sendMessage and returns message_id", async () => {
    const ub = makeStubHandle();
    const fakeTg = {
      callApi: () => {
        throw new Error("Bot API must not be called for via_userbot path");
      },
    };
    const res = await dispatchAction(
      "SEND_MESSAGE",
      { text: "Official announcement", via_userbot: true },
      {
        agentKey: "orchestrator",
        chatId: TEST_CHAT,
        telegram: fakeTg as never,
        userbot: ub,
      },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      // result у DispatchResult — unknown; форма для этой ветки задана в
      // lib/dispatch/telegram.ts: { via: "userbot", message_id }.
      const sent = res.result as { via: string; message_id: number };
      expect(sent.via).toBe("userbot");
      expect(sent.message_id).toBe(999);
    }
    expect(ub.sends).toHaveLength(1);
    expect(ub.sends[0].chatId).toBe(TEST_CHAT);
    expect(ub.sends[0].text).toBe("Official announcement");
  });

  test("via_userbot:true with replyToMessageId passes it through", async () => {
    const ub = makeStubHandle();
    const res = await dispatchAction(
      "SEND_MESSAGE",
      { text: "Reply as owner", via_userbot: true, replyToMessageId: 42 },
      {
        agentKey: "orchestrator",
        chatId: TEST_CHAT,
        telegram: undefined as never,
        userbot: ub,
      },
    );
    expect(res.ok).toBe(true);
    expect(ub.sends[0].opts?.replyToMessageId).toBe(42);
  });

  test("via_userbot:true with userbot=null → ok:false 'userbot not available'", async () => {
    const res = await dispatchAction(
      "SEND_MESSAGE",
      { text: "Owner message", via_userbot: true },
      {
        agentKey: "orchestrator",
        chatId: TEST_CHAT,
        telegram: undefined as never,
        userbot: null,
      },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not available/);
  });

  test("non-orchestrator caller with via_userbot:true → ok:false forbidden", async () => {
    const ub = makeStubHandle();
    const res = await dispatchAction(
      "SEND_MESSAGE",
      { text: "Trying to impersonate owner", via_userbot: true },
      {
        agentKey: "backend",
        chatId: TEST_CHAT,
        telegram: undefined as never,
        userbot: ub,
      },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/forbidden/);
      expect(res.error).toMatch(/orchestrator/);
    }
    // Userbot must not have been called
    expect(ub.sends).toHaveLength(0);
  });

  test("plain SEND_MESSAGE (no via_userbot) still works for other roles via Bot API", async () => {
    let tgCalled = false;
    const fakeTg = {
      sendMessage: (_chatId: number, _text: string) => {
        tgCalled = true;
        return Promise.resolve({ message_id: 1 });
      },
      callApi: (method: string, _opts: unknown) => {
        if (method === "sendMessage") {
          tgCalled = true;
          return Promise.resolve({ message_id: 1 });
        }
        throw new Error(`unexpected callApi: ${method}`);
      },
    };
    const res = await dispatchAction(
      "SEND_MESSAGE",
      { text: "Normal message" },
      {
        agentKey: "pm",
        chatId: TEST_CHAT,
        telegram: fakeTg as never,
        userbot: null,
      },
    );
    // Gate will decide based on permissions; we only care it didn't hit the
    // userbot path — if it returns ok:true tg must have been called.
    // If gate denies (permission not seeded), that's also fine — just confirm
    // no userbot path was triggered (no via_userbot in payload).
    if (res.ok) {
      expect(tgCalled).toBe(true);
    } else {
      // Отказать может только гейт прав. Любая другая причина — регрессия:
      // именно её тест и обязан ловить, а раньше на этой ветке не было ни
      // одного expect, и падение уходило в зелёный прогон.
      expect(res.error).toMatch(/permission|forbidden|denied|not allowed/i);
      // И раз до отправки не дошло — Bot API дёргать было нечем.
      expect(tgCalled).toBe(false);
    }
  });
});
