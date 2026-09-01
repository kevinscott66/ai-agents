/**
 * C31: userbot capability is surfaced to agents.
 *
 * Covers:
 *  - LIST_RECENT_MESSAGES returns rows from the local `messages` table
 *  - kinds=["service"] filter — only [service]-prefixed rows
 *  - LIST_RECENT_MESSAGES permission gate denies unauthorized roles
 *  - tool schema exposes via_userbot for SET_REACTION and DELETE_MESSAGE
 *  - tool schema includes LIST_RECENT_MESSAGES
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import { dispatchAction, gateOrDispatch } from "../lib/action-dispatch.ts";
import { TOOLS } from "../lib/tools-schema.ts";
import { _resetRateLimits } from "../lib/rate-limits.ts";
import { cleanupChat, saveAutonomy, restoreAutonomy } from "./_helpers.ts";

const TEST_CHAT = -1_000_931;

function seedMessage(args: {
  chatId: number;
  isBot?: boolean;
  fromUserId?: string;
  fromName?: string | null;
  text: string;
  ts: number;
  agentKey?: string | null;
}) {
  db.prepare(
    `INSERT INTO messages(chat_id, agent_key, is_bot, from_user_id, from_name, text, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    String(args.chatId),
    args.agentKey ?? null,
    args.isBot ? 1 : 0,
    args.fromUserId ?? "u1",
    args.fromName ?? "Alice",
    args.text,
    args.ts,
  );
}

function clearMessages(chatId: number) {
  db.prepare(`DELETE FROM messages WHERE chat_id = ?`).run(String(chatId));
}

let savedGlobal = saveAutonomy();
beforeEach(() => {
  _resetRateLimits();
  cleanupChat(TEST_CHAT);
  clearMessages(TEST_CHAT);
  savedGlobal = saveAutonomy();
});
afterEach(() => {
  restoreAutonomy(savedGlobal);
  _resetRateLimits();
  cleanupChat(TEST_CHAT);
  clearMessages(TEST_CHAT);
});

describe("LIST_RECENT_MESSAGES — dispatch", () => {
  test("returns recent rows from local messages table", async () => {
    const now = Date.now();
    seedMessage({ chatId: TEST_CHAT, text: "[service] user joined", ts: now - 1000 });
    seedMessage({ chatId: TEST_CHAT, text: "hello world", ts: now - 500 });
    seedMessage({ chatId: TEST_CHAT, text: "[service] user left", ts: now - 200 });

    const res = await dispatchAction(
      "LIST_RECENT_MESSAGES",
      { chat_id: TEST_CHAT, kinds: ["all"], limit: 50 },
      { agentKey: "orchestrator", chatId: TEST_CHAT, userbot: null },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const r = res.result as { messages: Array<{ text_preview: string }>; count: number };
    expect(r.count).toBe(3);
    // Sorted ts DESC.
    expect(r.messages[0].text_preview).toContain("user left");
    expect(r.messages[2].text_preview).toContain("user joined");
  });

  test("kinds=['service'] returns only [service]-prefixed entries", async () => {
    const now = Date.now();
    seedMessage({ chatId: TEST_CHAT, text: "[service] joined", ts: now - 300 });
    seedMessage({ chatId: TEST_CHAT, text: "normal chatter", ts: now - 200 });
    seedMessage({ chatId: TEST_CHAT, text: "[service] pin", ts: now - 100 });

    const res = await dispatchAction(
      "LIST_RECENT_MESSAGES",
      { chat_id: TEST_CHAT, kinds: ["service"] },
      { agentKey: "orchestrator", chatId: TEST_CHAT, userbot: null },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const r = res.result as { messages: Array<{ text_preview: string }>; count: number };
    expect(r.count).toBe(2);
    for (const m of r.messages) {
      expect(m.text_preview.startsWith("[service]")).toBe(true);
    }
  });

  test("kinds=['text'] excludes [service] entries", async () => {
    const now = Date.now();
    seedMessage({ chatId: TEST_CHAT, text: "[service] joined", ts: now - 300 });
    seedMessage({ chatId: TEST_CHAT, text: "hi there", ts: now - 200 });

    const res = await dispatchAction(
      "LIST_RECENT_MESSAGES",
      { chat_id: TEST_CHAT, kinds: ["text"] },
      { agentKey: "orchestrator", chatId: TEST_CHAT, userbot: null },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const r = res.result as { messages: Array<{ text_preview: string }>; count: number };
    expect(r.count).toBe(1);
    expect(r.messages[0].text_preview).toBe("hi there");
  });
});

describe("LIST_RECENT_MESSAGES — permission gate", () => {
  test("orchestrator is allowed", async () => {
    const now = Date.now();
    seedMessage({ chatId: TEST_CHAT, text: "[service] joined", ts: now });
    const res = await gateOrDispatch(
      "LIST_RECENT_MESSAGES",
      { chat_id: TEST_CHAT, kinds: ["service"] },
      { agentKey: "orchestrator", chatId: TEST_CHAT, userbot: null },
    );
    expect(res.kind).toBe("ok");
  });

  test("unauthorized role (smm) is denied", async () => {
    const res = await gateOrDispatch(
      "LIST_RECENT_MESSAGES",
      { chat_id: TEST_CHAT, kinds: ["service"] },
      { agentKey: "smm", chatId: TEST_CHAT, userbot: null },
    );
    expect(res.kind).toBe("forbidden");
  });

  test("tgdev and perm are allowed", async () => {
    seedMessage({ chatId: TEST_CHAT, text: "[service] x", ts: Date.now() });
    for (const role of ["tgdev", "perm"]) {
      const res = await gateOrDispatch(
        "LIST_RECENT_MESSAGES",
        { chat_id: TEST_CHAT, kinds: ["service"] },
        { agentKey: role, chatId: TEST_CHAT, userbot: null },
      );
      expect(res.kind).toBe("ok");
    }
  });
});

describe("tool schema — userbot surface", () => {
  test("SET_REACTION schema exposes via_userbot", () => {
    const tool = TOOLS.find((t) => t.name === "SET_REACTION");
    expect(tool).toBeDefined();
    const props = (tool!.input_schema as { properties: Record<string, unknown> })
      .properties;
    expect(props.via_userbot).toBeDefined();
  });

  test("DELETE_MESSAGE schema exposes via_userbot", () => {
    const tool = TOOLS.find((t) => t.name === "DELETE_MESSAGE");
    expect(tool).toBeDefined();
    const props = (tool!.input_schema as { properties: Record<string, unknown> })
      .properties;
    expect(props.via_userbot).toBeDefined();
  });

  test("LIST_RECENT_MESSAGES tool is registered", () => {
    const tool = TOOLS.find((t) => t.name === "LIST_RECENT_MESSAGES");
    expect(tool).toBeDefined();
    const props = (tool!.input_schema as { properties: Record<string, unknown> })
      .properties;
    // Аудит 2026-08-28: chat_id из схемы убран намеренно. Хендлер пиннит чат
    // к чату-источнику, то есть поле было приглашением попросить то, чего
    // инструмент не делает. Инвариант на всю пиннящуюся поверхность —
    // audit-2026-08-28-pinned-chat-schema-honesty.test.ts.
    expect(props.chat_id).toBeUndefined();
    expect(props.kinds).toBeDefined();
  });
});
