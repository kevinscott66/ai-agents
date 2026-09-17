/**
 * Аудит 2026-09-11: одна роль отрабатывала ход ДВАЖДЫ и дважды за деньги.
 *
 * Делегирование идёт двумя ветками, и они не знали друг о друге:
 *   1) инструмент DELEGATE_TO_ROLE внутри tool-loop — роль отвечает в чат;
 *   2) каскад по @-упоминаниям в ИТОГОВОМ тексте агента
 *      (orchestrator/message-handler.ts, после runWithTools).
 *
 * Хоп внутри handoff.ts от повтора защищён — `visited` (handoff.ts, фильтр
 * `next` перед рекурсией). А ПЕРВЫЙ хоп каскада собирал `visited` заново из
 * двух ключей, и общего между ветками был только счётчик `{n, max}` — число,
 * а не список. Поэтому: оркестратор зовёт backend тулой, backend отвечает,
 * оркестратор пишет «передал @delabs_backend_bot» — и backend прогоняет
 * ВТОРОЙ платный ход на то же сообщение пользователя, вторым сообщением в
 * чате, с повторным выполнением своих инструментов.
 *
 * Починка: общий объект хода теперь помнит не только СКОЛЬКО ролей позвали, но
 * и КАКИЕ (`budget.invoked`), и каскад по упоминаниям пропускает те, что уже
 * отработали. Упоминание роли в итоговом тексте — это ссылка на сделанное, а
 * не новое поручение. Смягчения нет: множество только отсекает вызовы.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { registerMessageHandler } from "../orchestrator/message-handler.ts";
import { dispatchAction } from "../lib/action-dispatch.ts";
import { HANDOFF_MAX_INVOCATIONS } from "../lib/handoff.ts";
import type { HandoffDeps } from "../lib/handoff.ts";
import { CHARACTERS } from "../characters/index.ts";
import { db } from "../lib/db.ts";
import { _resetRateLimits } from "../lib/rate-limits.ts";
import { cleanupChat } from "./_helpers.ts";

const CHAT = -1_009_011;
const CHAT_S = String(CHAT);
const ORCH = CHARACTERS.find((c) => c.key === "orchestrator")!;
const DESIGN = CHARACTERS.find((c) => c.key === "design")!;
const COPY = CHARACTERS.find((c) => c.key === "copy")!;
const DESIGN_USER = "delabs_design_bot";
const COPY_USER = "delabs_copy_bot";

let nextMessageId = 5001;

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

/**
 * Модель оркестратора: сперва делегирует роль тулой, потом пишет итог, в
 * котором ту же роль упоминает. Ровно тот текст, который система и советует
 * писать («координируй текстом»).
 */
function orchestratorDelegatingThenMentioning(mention: string): Anthropic {
  let turn = 0;
  return {
    messages: {
      create: async () => {
        turn += 1;
        const content =
          turn === 1
            ? [
                {
                  type: "tool_use",
                  id: "t1",
                  name: "DELEGATE_TO_ROLE",
                  input: { role: "design", task: "свёрстай баннер" },
                },
              ]
            : [{ type: "text", text: `Передал ${mention}, баннер будет к вечеру.` }];
        return {
          id: "m",
          type: "message",
          role: "assistant",
          model: "t",
          stop_reason: turn === 1 ? "tool_use" : "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
          content,
        } as unknown as Anthropic.Message;
      },
    },
  } as unknown as Anthropic;
}

/**
 * Депсы делегата: считают ходы и роняют их до сети. Счётчик тут и есть предмет
 * проверки — каждый его инкремент это один платный прогон роли.
 */
function countingBrokenDeps(bots: unknown[]) {
  const calls: string[] = [];
  const deps = {
    anthropic: {
      messages: {
        create: async () => {
          calls.push("call");
          throw new Error("сеть в тесте недоступна");
        },
      },
    },
    model: "t",
    historyLimit: 10,
    bots,
  } as unknown as HandoffDeps;
  return { deps, calls };
}

/** Прогнать апдейт через настоящий хендлер оркестратора. */
async function deliver(mention: string): Promise<string[]> {
  let handler: ((ctx: any) => Promise<void>) | null = null;
  const lead: any = {
    on: (_ev: string, h: any) => {
      handler = h;
    },
    telegram: {
      sendChatAction: async () => {},
      sendMessage: async () => ({ message_id: 1, date: 0 }),
    },
  };
  const running: any = { def: ORCH, bot: lead, username: "delabs_lead_bot", id: 41 };
  const bots = [running, fakeBot(DESIGN, DESIGN_USER, 42), fakeBot(COPY, COPY_USER, 43)];
  const { deps, calls } = countingBrokenDeps(bots);

  registerMessageHandler(lead, ORCH, running, {
    bots,
    allowed: [CHAT_S],
    historyLimit: 10,
    anthropic: orchestratorDelegatingThenMentioning(mention),
    model: "test-model",
    handoffDeps: deps,
    // respondAsImpl НЕ подменяем: считать должен настоящий respondAs — стаб
    // спрятал бы ровно тот вызов, ради которого тест написан.
  });

  await handler!({
    chat: { id: CHAT },
    from: { id: 777, username: "petya", is_bot: false },
    message: {
      message_id: nextMessageId++,
      text: "@delabs_lead_bot собери баннер",
      entities: [{ type: "mention", offset: 0, length: "delabs_lead_bot".length + 1 }],
    },
    sendChatAction: async () => {},
    reply: async () => ({ message_id: 9001, date: Math.floor(Date.now() / 1000) }),
  });
  // Каскад уходит через `void respondAs(...)` — ждём микрозадачи и таймеры.
  await new Promise((r) => setTimeout(r, 60));
  return calls;
}

describe("ход пользователя не запускает одну роль дважды", () => {
  test("делегированная тулой роль не вызывается повторно по упоминанию", async () => {
    const calls = await deliver(`@${DESIGN_USER}`);
    expect(calls).toHaveLength(1);
  });

  test("роль, которую ещё не звали, по упоминанию отрабатывает", async () => {
    const calls = await deliver(`@${COPY_USER}`);
    // Один ход у design (тула) + один у copy (каскад) — это не повтор.
    expect(calls).toHaveLength(2);
  });
});

describe("общий объект хода помнит, какие роли уже звали", () => {
  test("настоящий respondAs записывает роль в budget.invoked", async () => {
    const budget = { n: 0, max: HANDOFF_MAX_INVOCATIONS } as {
      n: number;
      max: number;
      invoked?: Set<string>;
    };
    const bots = [fakeBot(DESIGN, DESIGN_USER, 42)];
    const { deps } = countingBrokenDeps(bots);
    await dispatchAction(
      "DELEGATE_TO_ROLE",
      { role: "design", task: "баннер" },
      {
        agentKey: "orchestrator",
        chatId: CHAT,
        resolveAgent: (k) => bots.find((b) => b.def.key === k) as never,
        handoffDeps: deps,
        delegationChain: ["orchestrator"],
        handoffBudget: budget,
      },
    );
    // Счётчик и список — про одно и то же событие, поэтому идут вместе.
    expect(budget.n).toBe(1);
    expect([...(budget.invoked ?? [])]).toEqual(["design"]);
  });
});
