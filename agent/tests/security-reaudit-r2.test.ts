/**
 * SEC re-audit round 2 (2026-06-10):
 * HIGH — FORWARD_MESSAGE pins destination + source to ctx.chatId (no cross-chat exfil).
 */
import { describe, test, expect } from "bun:test";
import { handleForwardMessage } from "../lib/dispatch/telegram.ts";

describe("FORWARD_MESSAGE chat pinning (HIGH)", () => {
  test("ignores attacker chatId/fromChatId — pins both to ctx.chatId", async () => {
    const calls: Array<{ chatId: number; fromChatId: number; messageId: number }> = [];
    const fakeTg = {
      forwardMessage: (chatId: number, fromChatId: number, messageId: number) => {
        calls.push({ chatId, fromChatId, messageId });
        return Promise.resolve({ message_id: 1 });
      },
    } as never;
    const out = await handleForwardMessage(
      { chatId: -555 /*attacker dest*/, fromChatId: -777 /*private src*/, messageId: 42 } as never,
      { telegram: fakeTg, agentKey: "smm", chatId: -100 } as never,
    );
    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].chatId).toBe(-100); // pinned to originating, NOT -555
    expect(calls[0].fromChatId).toBe(-100); // pinned, NOT -777
  });
});
