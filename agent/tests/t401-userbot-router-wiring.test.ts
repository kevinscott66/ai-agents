/**
 * T-401 — Userbot router wiring: character → session config resolution and
 * multi-session routing.
 *
 * Complements t541-userbot-router (which covers the UserbotRouter class). Here
 * we test the bits T-401 adds on top of T-541:
 *   - resolveCharacterUserbotConfig: declarative field vs env override vs none
 *   - buildUserbotRouter: returns null when nothing is configured (singleton
 *     fallback stays untouched), registers only configured characters
 *   - two characters acting in parallel route through their OWN session handle
 *     (per-actor isolation — the basis for correct audit-log actor_id)
 */

import { describe, it, expect, afterEach } from "bun:test";
import {
  UserbotRouter,
  buildUserbotRouter,
  resolveCharacterUserbotConfig,
  type UserbotConfigurableCharacter,
} from "../lib/userbot-router.ts";
import type { UserbotHandle } from "../lib/userbot.ts";

const DEFAULT_CHATS = [111, 222];

function restoreEnv(key: string, prev: string | undefined): void {
  if (prev === undefined) delete process.env[key];
  else process.env[key] = prev;
}

describe("T-401 resolveCharacterUserbotConfig", () => {
  it("uses the declarative character.userbot field when present", () => {
    const char: UserbotConfigurableCharacter = {
      key: "copy",
      userbot: { sessionFile: "/tmp/copy.session", allowedChatIds: [999] },
    };
    const cfg = resolveCharacterUserbotConfig(char, DEFAULT_CHATS);
    expect(cfg).not.toBeNull();
    expect(cfg!.sessionFile).toBe("/tmp/copy.session");
    expect(cfg!.allowedChatIds).toEqual([999]);
  });

  it("falls back to default chats when declarative allowedChatIds is empty", () => {
    const char: UserbotConfigurableCharacter = {
      key: "copy",
      userbot: { sessionFile: "/tmp/copy.session", allowedChatIds: [] },
    };
    const cfg = resolveCharacterUserbotConfig(char, DEFAULT_CHATS);
    expect(cfg!.allowedChatIds).toEqual(DEFAULT_CHATS);
  });

  it("reads env override USERBOT_SESSION_<KEY> + CSV allowed chats", () => {
    const prevSession = process.env.USERBOT_SESSION_SMM;
    const prevChats = process.env.USERBOT_ALLOWED_CHATS_SMM;
    process.env.USERBOT_SESSION_SMM = "  /tmp/smm.session  ";
    process.env.USERBOT_ALLOWED_CHATS_SMM = " 5, 6 ,7 ";
    try {
      const cfg = resolveCharacterUserbotConfig({ key: "smm" }, DEFAULT_CHATS);
      expect(cfg).not.toBeNull();
      expect(cfg!.sessionFile).toBe("/tmp/smm.session"); // trimmed
      expect(cfg!.allowedChatIds).toEqual(["5", "6", "7"]); // parsed + trimmed
    } finally {
      restoreEnv("USERBOT_SESSION_SMM", prevSession);
      restoreEnv("USERBOT_ALLOWED_CHATS_SMM", prevChats);
    }
  });

  it("env override without CSV uses default chats", () => {
    const prevSession = process.env.USERBOT_SESSION_QA;
    const prevChats = process.env.USERBOT_ALLOWED_CHATS_QA;
    process.env.USERBOT_SESSION_QA = "/tmp/qa.session";
    delete process.env.USERBOT_ALLOWED_CHATS_QA;
    try {
      const cfg = resolveCharacterUserbotConfig({ key: "qa" }, DEFAULT_CHATS);
      expect(cfg!.allowedChatIds).toEqual(DEFAULT_CHATS);
    } finally {
      restoreEnv("USERBOT_SESSION_QA", prevSession);
      restoreEnv("USERBOT_ALLOWED_CHATS_QA", prevChats);
    }
  });

  it("declarative field wins over env override", () => {
    const prevSession = process.env.USERBOT_SESSION_PM;
    process.env.USERBOT_SESSION_PM = "/tmp/env-pm.session";
    try {
      const cfg = resolveCharacterUserbotConfig(
        { key: "pm", userbot: { sessionFile: "/tmp/decl-pm.session", allowedChatIds: [1] } },
        DEFAULT_CHATS,
      );
      expect(cfg!.sessionFile).toBe("/tmp/decl-pm.session");
    } finally {
      restoreEnv("USERBOT_SESSION_PM", prevSession);
    }
  });

  it("returns null when neither declarative nor env config is present", () => {
    const cfg = resolveCharacterUserbotConfig({ key: "backend" }, DEFAULT_CHATS);
    expect(cfg).toBeNull();
  });
});

describe("T-401 buildUserbotRouter", () => {
  it("returns null when no character is configured (singleton-only)", () => {
    const chars: UserbotConfigurableCharacter[] = [
      { key: "orchestrator" },
      { key: "backend" },
    ];
    const router = buildUserbotRouter(chars, {
      onMessage: () => {},
      defaultAllowedChatIds: DEFAULT_CHATS,
    });
    expect(router).toBeNull();
  });

  it("registers only the characters that have userbot config", () => {
    const chars: UserbotConfigurableCharacter[] = [
      { key: "orchestrator" }, // none → skipped
      { key: "copy", userbot: { sessionFile: "/tmp/copy.session", allowedChatIds: [1] } },
      { key: "smm", userbot: { sessionFile: "/tmp/smm.session", allowedChatIds: [2] } },
    ];
    const router = buildUserbotRouter(chars, {
      onMessage: () => {},
      defaultAllowedChatIds: DEFAULT_CHATS,
    });
    expect(router).not.toBeNull();
    const configs = router!.getAllConfigs();
    expect(configs.size).toBe(2);
    expect(configs.has("copy")).toBe(true);
    expect(configs.has("smm")).toBe(true);
    expect(configs.has("orchestrator")).toBe(false);
  });
});

describe("T-401 parallel multi-actor routing isolation", () => {
  it("routes two characters' SET_REACTION through their own sessions concurrently", async () => {
    const router = new UserbotRouter({
      onMessage: () => {},
      defaultAllowedChatIds: DEFAULT_CHATS,
    });

    // Record which emoji each agent's dedicated handle received.
    const calls: Record<string, Array<{ chatId: number | string; msgId: number; emoji: string }>> = {
      copy: [],
      smm: [],
    };
    const makeHandle = (agentKey: string): UserbotHandle => ({
      async setReaction(chatId, msgId, emoji) {
        calls[agentKey].push({ chatId, msgId, emoji });
      },
      async deleteMessage() {},
      // Исходящие методы хендла тест не использует — если роутер вдруг дёрнет
      // их, пусть это будет громким падением, а не молчаливым no-op.
      async sendMessage(): Promise<never> {
        throw new Error(`sendMessage не ожидается в этом тесте (${agentKey})`);
      },
      async createTeamChannel(): Promise<never> {
        throw new Error(`createTeamChannel не ожидается в этом тесте (${agentKey})`);
      },
      async publishPost(): Promise<never> {
        throw new Error(`publishPost не ожидается в этом тесте (${agentKey})`);
      },
      async stop() {},
      isNoop: false,
    });
    const handles: Record<string, UserbotHandle> = {
      copy: makeHandle("copy"),
      smm: makeHandle("smm"),
    };

    // Stub per-agent handle resolution (avoids real MTProto startup).
    router.getAgentHandle = async (agentKey: string) => handles[agentKey] ?? null;

    // Both actors fire concurrently.
    await Promise.all([
      router.setReaction("copy", 555, 1, "👍"),
      router.setReaction("smm", 666, 2, "🔥"),
    ]);

    // Each reaction landed on its OWN session only — no cross-talk. This is the
    // per-actor isolation that lets dispatch record the correct actor_id.
    expect(calls.copy).toEqual([{ chatId: 555, msgId: 1, emoji: "👍" }]);
    expect(calls.smm).toEqual([{ chatId: 666, msgId: 2, emoji: "🔥" }]);
  });
});
