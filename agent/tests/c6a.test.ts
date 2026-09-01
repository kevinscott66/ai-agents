/**
 * C6A: расширение action types + Telegram-side-effect инструменты.
 *
 * Проверяем:
 *  - миграция 007 засеяла permissions для 7 новых action types
 *  - evaluateGate уважает SEMI_AUTO_RISKY и requires_approval
 *  - executeTool без telegram-контекста — ok:false без gate-обращений
 *  - executeTool с fakeTg вызывает нужный метод и пишет audit('ok')
 *  - DELETE_MESSAGE в semi_auto уходит в pending_approval, fakeTg НЕ дёргается
 */
import { describe, test, expect, afterEach, mock } from "bun:test";
import { db } from "../lib/db.ts";
import { executeTool } from "../lib/tools-schema.ts";
import {
  getPermission,
  evaluateGate,
  setAutonomy,
} from "../lib/permissions.ts";
import { listActions } from "../lib/audit.ts";
import {
  cleanupChat,
  saveAutonomy,
  restoreAutonomy,
} from "./_helpers.ts";

const TEST_CHAT = -1_000_777;
const TEST_AGENT = "qa";

let savedGlobal = saveAutonomy();
afterEach(() => {
  restoreAutonomy(savedGlobal);
  cleanupChat(TEST_CHAT);
});

describe("migration 007: permissions seed", () => {
  test("PIN_MESSAGE для qa: requires_approval=true, allowed=true", () => {
    const p = getPermission("qa", "PIN_MESSAGE");
    expect(p.allowed).toBe(true);
    expect(p.requires_approval).toBe(true);
  });
  test("SET_REACTION для qa: requires_approval=false, allowed=true", () => {
    const p = getPermission("qa", "SET_REACTION");
    expect(p.allowed).toBe(true);
    expect(p.requires_approval).toBe(false);
  });
});

describe("evaluateGate: semi_auto overlay", () => {
  test("SET_REACTION в semi_auto → allow", () => {
    savedGlobal = saveAutonomy();
    setAutonomy("global", "*", "semi_auto");
    const g = evaluateGate({
      agentKey: "qa",
      actionType: "SET_REACTION",
    });
    expect(g.decision).toBe("allow");
  });
  test("DELETE_MESSAGE в semi_auto → approval (SEMI_AUTO_RISKY)", () => {
    savedGlobal = saveAutonomy();
    setAutonomy("global", "*", "semi_auto");
    const g = evaluateGate({
      agentKey: "qa",
      actionType: "DELETE_MESSAGE",
    });
    expect(g.decision).toBe("approval");
  });
});

describe("executeTool: no telegram context", () => {
  test("SET_REACTION без telegram → ok:false с 'no telegram'", async () => {
    const out = await executeTool(
      "SET_REACTION",
      { emoji: "👍" },
      { agentKey: TEST_AGENT, chatId: TEST_CHAT, triggerMessageId: 42 },
    );
    const parsed = JSON.parse(out) as { ok: boolean; error?: string };
    expect(parsed.ok).toBe(false);
    expect(String(parsed.error ?? "")).toContain("no telegram");
  });
});

describe("executeTool: SET_REACTION с fakeTg", () => {
  test("вызов callApi и audit('ok')", async () => {
    savedGlobal = saveAutonomy();
    setAutonomy("global", "*", "semi_auto");
    // Сигнатуру задаём явно: без неё mock.calls типизируется как пустой кортеж
    // и args[0]/args[1] ниже не проверяются.
    const callApi = mock(
      (_method: string, _payload: Record<string, unknown>) =>
        Promise.resolve(true),
    );
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
        triggerMessageId: 42,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        telegram: fakeTg as any,
      },
    );
    const parsed = JSON.parse(out) as { ok: boolean };
    expect(parsed.ok).toBe(true);
    expect(callApi).toHaveBeenCalledTimes(1);
    const args = callApi.mock.calls[0];
    expect(args[0]).toBe("setMessageReaction");
    expect(args[1]).toEqual({
      chat_id: TEST_CHAT,
      message_id: 42,
      reaction: [{ type: "emoji", emoji: "👍" }],
    });
    const acts = listActions({ agentKey: TEST_AGENT }).filter(
      (a) => a.chat_id === TEST_CHAT && a.action_type === "SET_REACTION",
    );
    expect(acts.length).toBeGreaterThan(0);
    expect(acts[0].status).toBe("ok");
  });
});

describe("executeTool: DELETE_MESSAGE → pending_approval", () => {
  test("в semi_auto уходит в approval, deleteMessage НЕ вызван", async () => {
    savedGlobal = saveAutonomy();
    setAutonomy("global", "*", "semi_auto");
    const deleteMessage = mock(() => Promise.resolve(true));
    const fakeTg = {
      callApi: mock(() => Promise.resolve(true)),
      sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
      deleteMessage,
      editMessageText: mock(() => Promise.resolve(true)),
      pinChatMessage: mock(() => Promise.resolve(true)),
      forwardMessage: mock(() => Promise.resolve({ message_id: 1 })),
      sendPoll: mock(() => Promise.resolve({ message_id: 1 })),
    };
    const out = await executeTool(
      "DELETE_MESSAGE",
      { messageId: 42 },
      {
        agentKey: TEST_AGENT,
        chatId: TEST_CHAT,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        telegram: fakeTg as any,
      },
    );
    expect(out).toContain("pending_approval");
    expect(deleteMessage).not.toHaveBeenCalled();
    const approvals = db
      .prepare(
        `SELECT COUNT(*) as n FROM approvals WHERE chat_id = ? AND action_type = 'DELETE_MESSAGE' AND status = 'pending'`,
      )
      .get(TEST_CHAT) as { n: number };
    expect(approvals.n).toBeGreaterThan(0);
  });
});
