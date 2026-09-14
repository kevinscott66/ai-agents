/**
 * Аудит 2026-09-14: подпись `SetReactionPayload.via_userbot` обещала, что без
 * флага диспатчер «откатывается на userbot только по ошибке». У оркестратора
 * реакция эмодзи вне белого списка Bot API уходит с аккаунта владельца сразу,
 * без попытки ботом, — и гейт апрув не требует, потому что флага в payload нет.
 *
 * Поведение оставлено (реакция обратима, разбор у `handleDeleteMessage`), а
 * подпись исправлена. Тест держит обе стороны: что фолбэк действительно
 * такой, какой описан, и что остальным ролям он закрыт.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { handleSetReaction } from "../lib/dispatch/telegram.ts";
import { isOwnerVoice } from "../lib/permissions.ts";

const NON_WHITELIST = "🫠";

function ctx(agentKey: string, calls: string[]) {
  return {
    agentKey,
    chatId: -100_914_777,
    telegram: {
      setMessageReaction: async () => {
        calls.push("bot");
        return true;
      },
    },
    userbot: {
      isNoop: false,
      setReaction: async () => {
        calls.push("userbot");
      },
    },
  } as any;
}

describe("SET_REACTION без via_userbot", () => {
  test("гейт не считает это голосом владельца", () => {
    expect(isOwnerVoice("SET_REACTION", { messageId: 1, emoji: NON_WHITELIST })).toBe(false);
  });

  test("оркестратор: эмодзи вне белого списка уходит userbot'ом сразу, ботом не пробуя", async () => {
    const calls: string[] = [];
    const res = await handleSetReaction({ messageId: 1, emoji: NON_WHITELIST } as any, ctx("orchestrator", calls));
    expect(calls).toEqual(["userbot"]);
    expect(res).toEqual({ ok: true, result: { via: "userbot" } });
  });

  test("не оркестратор: отказ, аккаунт владельца не тронут", async () => {
    const calls: string[] = [];
    const res = await handleSetReaction({ messageId: 1, emoji: NON_WHITELIST } as any, ctx("smm", calls));
    expect(calls).toEqual([]);
    expect(res.ok).toBe(false);
  });

  test("подпись payload больше не обещает «только по ошибке»", () => {
    const s = readFileSync(new URL("../lib/action-payload.ts", import.meta.url), "utf8");
    const flat = s.replace(/^\s*\*/gm, "").replace(/\s+/g, " ");
    expect(flat).not.toContain("откатывается на userbot только по ошибке «can't react»");
    expect(flat).toContain("эмодзи вне белого списка Bot API — сразу");
  });
});
