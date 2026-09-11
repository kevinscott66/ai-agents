/**
 * Аудит 2026-09-11: модель не знала, какое сегодня число.
 *
 * SCHEDULE_POST требует `scheduledAt` — Unix-время в миллисекундах, — а в
 * system-блоках хода не было ни даты, ни времени, ни часового пояса. «Запланируй
 * пост на завтра в 10» посчитать было не от чего: модель брала опору из
 * обучения, то есть промахивалась на месяцы. На карточке апрува это видно как
 * «когда: не указано» (санити-диапазон в approvals.ts) — симптом, а не починка.
 *
 * Блок ставится ПОСЛЕДНИМ и БЕЗ cache_control намеренно. Кэш промпта режется по
 * последней точке cache_control: всё до неё остаётся в кэше, а хвост читается
 * заново каждый ход. Поэтому минутная точность здесь ничего не стоит — а вот
 * тот же текст, поставленный среди кэшируемых блоков, обнулял бы кэш каждую
 * минуту.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { nowSystemText } from "../lib/agent-prompts.ts";
import { respondAs } from "../lib/handoff.ts";
import { registerMessageHandler } from "../orchestrator/message-handler.ts";
import { CHARACTERS } from "../characters/index.ts";
import { db } from "../lib/db.ts";
import { _resetRateLimits } from "../lib/rate-limits.ts";
import { cleanupChat } from "./_helpers.ts";

const CHAT = -1_009_012;
const CHAT_S = String(CHAT);
const ORCH = CHARACTERS.find((c) => c.key === "orchestrator")!;
const DESIGN = CHARACTERS.find((c) => c.key === "design")!;

let nextMessageId = 6001;

beforeEach(() => {
  _resetRateLimits();
  cleanupChat(CHAT);
  db.prepare(`DELETE FROM messages WHERE chat_id = ?`).run(CHAT_S);
  db.prepare(`DELETE FROM processed_triggers WHERE chat_id = ?`).run(CHAT_S);
});

afterEach(() => {
  _resetRateLimits();
  cleanupChat(CHAT);
});

/** Клиент, который ничего не отвечает, но запоминает system-блоки хода. */
function capturingAnthropic(box: { system?: Anthropic.TextBlockParam[] }) {
  return {
    messages: {
      create: async (args: { system?: Anthropic.TextBlockParam[] }) => {
        box.system = args.system;
        return {
          id: "m",
          type: "message",
          role: "assistant",
          model: "t",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
          content: [{ type: "text", text: "ок" }],
        } as unknown as Anthropic.Message;
      },
    },
  } as unknown as Anthropic;
}

function fakeBot(def: (typeof CHARACTERS)[number], username: string, id: number) {
  return {
    def,
    bot: {
      on: () => {},
      telegram: {
        sendChatAction: async () => {},
        sendMessage: async () => ({ message_id: 1, date: 0 }),
      },
    } as never,
    username,
    id,
  };
}

/** Последний блок должен быть «сейчас», и он же — единственный некэшируемый хвост. */
function expectNowLast(system: Anthropic.TextBlockParam[] | undefined) {
  expect(system).toBeDefined();
  const blocks = system!;
  const last = blocks[blocks.length - 1];
  expect(last.text).toContain("Сейчас:");
  expect(last.cache_control).toBeUndefined();
  // Кэшируемая часть должна остаться слева: хотя бы одна точка кэша есть, и
  // она не на последнем блоке — иначе хвост попал бы в кэшируемый префикс.
  const cached = blocks.filter((b) => b.cache_control !== undefined);
  expect(cached.length).toBeGreaterThan(0);
  expect(cached).not.toContain(last);
}

describe("nowSystemText: дата, время, день недели, пояс", () => {
  test("формат зафиксирован на известном моменте", () => {
    const s = nowSystemText(new Date(Date.UTC(2026, 8, 11, 7, 5)));
    expect(s).toContain("11.09.2026 10:05 (Europe/Moscow)");
    expect(s).toContain("пятница");
  });

  test("в тексте сказано, от чего считать относительные сроки", () => {
    const s = nowSystemText(new Date(Date.UTC(2026, 8, 11, 7, 5)));
    expect(s).toMatch(/миллисекунд/i);
  });
});

describe("блок «сейчас» доезжает до модели обоими входами", () => {
  test("ход делегата (handoff.ts)", async () => {
    const box: { system?: Anthropic.TextBlockParam[] } = {};
    const bots = [fakeBot(DESIGN, "delabs_design_bot", 42)];
    await respondAs(
      {
        target: bots[0] as never,
        chatId: CHAT_S,
        triggerText: "запланируй пост на завтра",
        triggerAgentKey: "orchestrator",
        depth: 1,
        visited: new Set(["orchestrator", "design"]),
      },
      {
        anthropic: capturingAnthropic(box),
        model: "t",
        historyLimit: 5,
        bots: bots as never,
      } as never,
    );
    expectNowLast(box.system);
  });

  test("ход по упоминанию (orchestrator/message-handler.ts)", async () => {
    const box: { system?: Anthropic.TextBlockParam[] } = {};
    let handler: ((ctx: any) => Promise<void>) | null = null;
    const lead: any = {
      on: (_e: string, h: any) => {
        handler = h;
      },
      telegram: {
        sendChatAction: async () => {},
        sendMessage: async () => ({ message_id: 1, date: 0 }),
      },
    };
    const running: any = { def: ORCH, bot: lead, username: "delabs_lead_bot", id: 41 };
    const bots = [running];
    const anthropic = capturingAnthropic(box);
    registerMessageHandler(lead, ORCH, running, {
      bots,
      allowed: [CHAT_S],
      historyLimit: 5,
      anthropic,
      model: "test-model",
      handoffDeps: { anthropic, model: "t", historyLimit: 5, bots } as never,
    });
    await handler!({
      chat: { id: CHAT },
      from: { id: 778, username: "petya", is_bot: false },
      message: {
        message_id: nextMessageId++,
        text: "@delabs_lead_bot запланируй пост на завтра в 10",
        entities: [{ type: "mention", offset: 0, length: "delabs_lead_bot".length + 1 }],
      },
      sendChatAction: async () => {},
      reply: async () => ({ message_id: 9101, date: Math.floor(Date.now() / 1000) }),
    });
    expectNowLast(box.system);
  });
});
