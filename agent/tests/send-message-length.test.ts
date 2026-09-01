/**
 * Аудит 2026-08-06: у SEND_MESSAGE не было ограничения длины НИ НА ОДНОМ слое —
 * ни в build-payload.ts, ни в handleSendMessage, ни в tgSendMessage. Ответ
 * агента длиннее 4096 детерминированно падал с 400 «message is too long» и
 * терялся целиком.
 *
 * Выбрано разбиение, а не обрезка: у публикации в канал пост обязан быть одним
 * сообщением (там обрезка правильна), а здесь это разговор, и вывод у
 * технического ответа стоит в конце — обрезка съела бы именно его.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { dispatchAction } from "../lib/action-dispatch.ts";
import type { UserbotHandle } from "../lib/userbot.ts";
import { _resetRateLimits } from "../lib/rate-limits.ts";
import { cleanupChat, saveAutonomy, restoreAutonomy } from "./_helpers.ts";

const TEST_CHAT = -1_000_806;

/** Длинный связный текст: абзацы, чтобы splitForTelegram рвал по ним. */
function longText(paragraphs: number): string {
  return Array.from(
    { length: paragraphs },
    (_, i) => `Абзац ${i + 1}. ${"Технический разбор ситуации. ".repeat(12)}`,
  ).join("\n\n");
}

const fakeTg = () => {
  const sent: Array<{ chatId: number; text: string; extra: any }> = [];
  return {
    sent,
    tg: {
      sendMessage: (chatId: number, text: string, extra: any) => {
        sent.push({ chatId, text, extra });
        return Promise.resolve({ message_id: 100 + sent.length });
      },
    } as any,
  };
};

function stubUserbot(): UserbotHandle & {
  sends: Array<{ text: string; opts?: { replyToMessageId?: number } }>;
} {
  const sends: Array<{ text: string; opts?: { replyToMessageId?: number } }> = [];
  return {
    isNoop: false,
    sends,
    async setReaction() {},
    async deleteMessage() {},
    async sendMessage(_chatId, text, opts) {
      sends.push({ text, opts });
      return { message_id: 500 + sends.length };
    },
    async stop() {},
  } as any;
}

let saved = saveAutonomy();
beforeEach(() => {
  _resetRateLimits();
  cleanupChat(TEST_CHAT);
  saved = saveAutonomy();
});
afterEach(() => {
  restoreAutonomy(saved);
  _resetRateLimits();
  cleanupChat(TEST_CHAT);
});

describe("SEND_MESSAGE: длина", () => {
  test("короткое сообщение уходит одним куском, без префикса", async () => {
    const { tg, sent } = fakeTg();
    const out = await dispatchAction(
      "SEND_MESSAGE",
      { text: "Коротко и по делу." } as any,
      { agentKey: "backend", chatId: TEST_CHAT, telegram: tg } as any,
    );
    expect(out.ok).toBe(true);
    expect(sent.length).toBe(1);
    expect(sent[0].text).toBe("Коротко и по делу.");
    expect(sent[0].text).not.toMatch(/^\(\d+\/\d+\)/);
  });

  test("длинный ответ бьётся на части, каждая укладывается в лимит", async () => {
    const text = longText(30);
    expect(text.length).toBeGreaterThan(4096); // иначе тест ничего не проверяет

    const { tg, sent } = fakeTg();
    const out = await dispatchAction(
      "SEND_MESSAGE",
      { text } as any,
      { agentKey: "backend", chatId: TEST_CHAT, telegram: tg } as any,
    );

    expect(out.ok).toBe(true);
    expect(sent.length).toBeGreaterThan(1);
    for (const m of sent) {
      expect(m.text.length).toBeLessThanOrEqual(4096);
      expect(m.text).toMatch(/^\(\d+\/\d+\) /);
    }
  });

  test("ничего не теряется: хвост доезжает", async () => {
    // Главное свойство разбиения против обрезки — конец сообщения доходит.
    const text = `${longText(30)}\n\nИТОГОВЫЙ ВЫВОД: деплоить нельзя.`;
    const { tg, sent } = fakeTg();
    await dispatchAction(
      "SEND_MESSAGE",
      { text } as any,
      { agentKey: "backend", chatId: TEST_CHAT, telegram: tg } as any,
    );
    const joined = sent.map((m) => m.text).join("\n");
    expect(joined).toContain("ИТОГОВЫЙ ВЫВОД: деплоить нельзя.");
    expect(joined).toContain("Абзац 1.");
  });

  test("reply_to висит только на первой части", async () => {
    const { tg, sent } = fakeTg();
    await dispatchAction(
      "SEND_MESSAGE",
      { text: longText(30), replyToMessageId: 4242 } as any,
      { agentKey: "backend", chatId: TEST_CHAT, telegram: tg } as any,
    );
    expect(sent.length).toBeGreaterThan(1);
    expect(sent[0].extra?.reply_parameters?.message_id).toBe(4242);
    for (const m of sent.slice(1)) {
      expect(m.extra?.reply_parameters).toBeUndefined();
    }
  });

  test("юзерботный путь тоже бьётся, а не падает", async () => {
    const ub = stubUserbot();
    const out = await dispatchAction(
      "SEND_MESSAGE",
      { text: longText(30), via_userbot: true } as any,
      {
        agentKey: "orchestrator",
        chatId: TEST_CHAT,
        telegram: fakeTg().tg,
        userbot: ub,
      } as any,
    );
    expect(out.ok).toBe(true);
    expect(ub.sends.length).toBeGreaterThan(1);
    for (const s of ub.sends) expect(s.text.length).toBeLessThanOrEqual(4096);
    expect(ub.sends[0].opts?.replyToMessageId).toBeUndefined();
  });
});
