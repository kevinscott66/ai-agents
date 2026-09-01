/**
 * C30: MTProto userbot — passive observer + on-demand reaction/delete.
 *
 * Tests that do NOT require real network:
 *  - decryptSession roundtrip
 *  - startUserbot returns no-op handle when session file missing
 *  - via_userbot=true routes SET_REACTION through userbot (mocked)
 *  - via_userbot=true routes DELETE_MESSAGE through userbot (mocked)
 *  - non-whitelisted emoji falls back to userbot when available
 *  - via_userbot=true without userbot → ok:false "userbot not available"
 *
 * Real-network tests are gated behind USERBOT_E2E=1 (none currently — slot
 * reserved for future smoke run against a live session).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchAction } from "../lib/action-dispatch.ts";
import { startUserbot, type UserbotHandle } from "../lib/userbot.ts";
import { _resetRateLimits } from "../lib/rate-limits.ts";
import { cleanupChat, saveAutonomy, restoreAutonomy } from "./_helpers.ts";

// Re-import the private encrypt logic by exercising the public decrypt path.
// We replicate the encrypt fn here to test the roundtrip without depending on
// non-exported internals.
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { decryptSession, encryptSession } from "../tools/userbot-login.ts";

function encryptForTest(plain: string, pass: string): string {
  const key = createHash("sha256").update(pass).digest();
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  const tag = c.getAuthTag();
  return ["v1", iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(":");
}

const TEST_CHAT = -1_000_930;

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

describe("decryptSession roundtrip", () => {
  test("decrypts what encrypt produced", () => {
    const plain = "this-is-a-string-session-blob-xyz";
    const pass = "topsecret123";
    const blob = encryptForTest(plain, pass);
    expect(blob.startsWith("v1:")).toBe(true);
    const back = decryptSession(blob, pass);
    expect(back).toBe(plain);
  });

  test("new encryption emits salted v2 and round-trips", () => {
    const plain = "new-session-blob";
    const blob = encryptSession(plain, "topsecret123");
    expect(blob.startsWith("v2:")).toBe(true);
    expect(decryptSession(blob, "topsecret123")).toBe(plain);
  });

  test("plaintext (no encrypted prefix) passes through unchanged", () => {
    const plain = "1AQAOMTQ5LjE1NC4xNjcuOTEBuwAA...";
    expect(decryptSession(plain, "anykey")).toBe(plain);
  });
});

describe("startUserbot — no-op fallbacks", () => {
  test("returns no-op handle when session file is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ub-"));
    try {
      const h = await startUserbot({
        sessionPath: join(dir, "nope.session"),
        allowedChatIds: ["-1001"],
        onMessage: () => {},
        apiId: 12345,
        apiHash: "deadbeef",
      });
      expect(h.isNoop).toBe(true);
      await expect(h.setReaction(1, 1, "👍")).rejects.toThrow(/not available/);
      await expect(h.deleteMessage(1, 1)).rejects.toThrow(/not available/);
      await h.stop(); // no-op stop should not throw
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns no-op when api id/hash missing even if session present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ub-"));
    try {
      const sessPath = join(dir, "userbot.session");
      writeFileSync(sessPath, "raw-session-string");
      const h = await startUserbot({
        sessionPath: sessPath,
        allowedChatIds: [],
        onMessage: () => {},
        // missing apiId / apiHash and we don't set env in test
        apiId: 0,
        apiHash: "",
      });
      expect(h.isNoop).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("via_userbot flag wires through dispatch", () => {
  function makeStubHandle(): UserbotHandle & {
    reactions: Array<[string | number, number, string]>;
    deletes: Array<[string | number, number]>;
  } {
    const reactions: Array<[string | number, number, string]> = [];
    const deletes: Array<[string | number, number]> = [];
    return {
      isNoop: false,
      reactions,
      deletes,
      async setReaction(c, m, e) {
        reactions.push([c, m, e]);
      },
      async deleteMessage(c, m) {
        deletes.push([c, m]);
      },
      // Остальные методы UserbotHandle в этих тестах не участвуют: если
      // dispatch их дёрнет — тест должен упасть, а не молча пройти.
      async sendMessage(): Promise<{ message_id: number }> {
        throw new Error("sendMessage must not be called");
      },
      async createTeamChannel(): Promise<{
        channelId: number;
        title: string;
        added: string[];
        failed: string[];
      }> {
        throw new Error("createTeamChannel must not be called");
      },
      async publishPost(): Promise<{ message_id: number }> {
        throw new Error("publishPost must not be called");
      },
      async stop() {},
    };
  }

  test("SET_REACTION via_userbot=true calls userbot, skips Bot API whitelist", async () => {
    const ub = makeStubHandle();
    const fakeTg = {
      callApi: () => {
        throw new Error("Bot API must not be called");
      },
    };
    const res = await dispatchAction(
      "SET_REACTION",
      { messageId: 42, emoji: "🦖", via_userbot: true }, // not in whitelist
      {
        agentKey: "orchestrator", // SEC-4: via_userbot is orchestrator-only
        chatId: TEST_CHAT,
        telegram: fakeTg as never,
        userbot: ub,
      },
    );
    expect(res.ok).toBe(true);
    expect(ub.reactions).toEqual([[TEST_CHAT, 42, "🦖"]]);
  });

  test("DELETE_MESSAGE via_userbot=true calls userbot.deleteMessage", async () => {
    const ub = makeStubHandle();
    const res = await dispatchAction(
      "DELETE_MESSAGE",
      { messageId: 7, via_userbot: true },
      {
        agentKey: "orchestrator", // SEC-4: via_userbot is orchestrator-only
        chatId: TEST_CHAT,
        telegram: { callApi: () => { throw new Error("nope"); } } as never,
        userbot: ub,
      },
    );
    expect(res.ok).toBe(true);
    expect(ub.deletes).toEqual([[TEST_CHAT, 7]]);
  });

  test("SET_REACTION non-whitelisted emoji falls back to userbot for ORCHESTRATOR (pinned to ctx.chat)", async () => {
    const ub = makeStubHandle();
    const fakeTg = { callApi: () => Promise.resolve(true) };
    const res = await dispatchAction(
      "SET_REACTION",
      { messageId: 99, emoji: "🦖", chatId: -999999 }, // attacker chatId must be ignored
      {
        agentKey: "orchestrator",
        chatId: TEST_CHAT,
        telegram: fakeTg as never,
        userbot: ub,
      },
    );
    expect(res.ok).toBe(true);
    // SEC-4 (re-audit): pinned to ctx.chat (TEST_CHAT), NOT the payload chatId.
    expect(ub.reactions).toEqual([[TEST_CHAT, 99, "🦖"]]);
  });

  test("SET_REACTION non-whitelisted emoji from a NON-orchestrator does NOT escalate to userbot", async () => {
    const ub = makeStubHandle();
    const fakeTg = { callApi: () => Promise.resolve(true) };
    const res = await dispatchAction(
      "SET_REACTION",
      { messageId: 99, emoji: "🦖" }, // non-whitelisted, no via_userbot
      {
        agentKey: "qa",
        chatId: TEST_CHAT,
        telegram: fakeTg as never,
        userbot: ub,
      },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/REACTION_NOT_ALLOWED/);
    expect(ub.reactions).toEqual([]); // owner account never touched
  });

  test("via_userbot=true without an available userbot → ok:false", async () => {
    const res = await dispatchAction(
      "SET_REACTION",
      { messageId: 1, emoji: "❤️", via_userbot: true },
      {
        agentKey: "orchestrator", // SEC-4: via_userbot is orchestrator-only
        chatId: TEST_CHAT,
        telegram: { callApi: () => Promise.resolve(true) } as never,
        userbot: null,
      },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not available/);
  });
});

describe.skipIf(process.env.USERBOT_E2E !== "1")("real network (USERBOT_E2E=1)", () => {
  test("placeholder — wire real-session smoke check here", () => {
    expect(true).toBe(true);
  });
});
