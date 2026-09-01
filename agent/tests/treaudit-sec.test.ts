// Re-audit (2026-06-07) hardening: caller-restrict MAC_RUN_CLAUDE and require
// approval / orchestrator-only for owner-account (via_userbot) reactions+deletes.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { evaluateGate, setAutonomy } from "../lib/permissions.ts";
import { saveAutonomy, restoreAutonomy } from "./_helpers.ts";
import { handleSetReaction, handleDeleteMessage } from "../lib/dispatch/telegram.ts";

let saved: ReturnType<typeof saveAutonomy>;
beforeEach(() => {
  saved = saveAutonomy();
  setAutonomy("global", "*", "auto");
});
afterEach(() => restoreAutonomy(saved));

describe("re-audit H1: MAC_RUN_CLAUDE is code-level orchestrator-only", () => {
  test("a non-orchestrator caller is denied at the gate", () => {
    const g = evaluateGate({ agentKey: "backend", actionType: "MAC_RUN_CLAUDE" });
    expect(g.decision).toBe("deny");
    expect(g.decision === "deny" && /caller/.test(g.reason)).toBe(true);
  });
  test("the same hard gate applies to MAC_STOP", () => {
    const g = evaluateGate({ agentKey: "qa", actionType: "MAC_STOP" });
    expect(g.decision).toBe("deny");
  });
});

describe("re-audit SEC-4: via_userbot reactions/deletes are orchestrator-only", () => {
  const ctx = (agentKey: string) =>
    ({ agentKey, chatId: -100, telegram: undefined, userbot: null }) as any;

  test("SET_REACTION via_userbot from a non-orchestrator is forbidden", async () => {
    const r = await handleSetReaction(
      { chatId: -999, messageId: 1, emoji: "👍", via_userbot: true } as any,
      ctx("backend"),
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && /orchestrator/.test(r.error)).toBe(true);
  });

  test("DELETE_MESSAGE via_userbot from a non-orchestrator is forbidden", async () => {
    const r = await handleDeleteMessage(
      { chatId: -999, messageId: 1, via_userbot: true } as any,
      ctx("backend"),
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && /orchestrator/.test(r.error)).toBe(true);
  });

  test("gate forces approval for a via_userbot SET_REACTION (forceApproval)", () => {
    const g = evaluateGate({
      agentKey: "orchestrator",
      actionType: "SET_REACTION",
      forceApproval: true,
    });
    expect(g.decision).toBe("approval");
  });
});
