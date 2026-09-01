/**
 * Аудит 2026-08-28, raw-путь tool-loop: четыре места, где ход врал о том,
 * что он сделал.
 *
 *  F1. `callAnthropic` — единственный незащищённый await в теле цикла. Он
 *      бросает штатно (checkBudget зовётся на каждой итерации), то есть потолок
 *      ловится ПОСРЕДИ хода — уже после того, как инструмент отработал. Голая
 *      BudgetExceededError приводила к ответу «лимит исчерпан», по которому
 *      человек шёл повторять руками то, что бот уже сделал. На SDK-пути это
 *      починили 2026-08-21; raw-путь — который включается ИМЕННО когда
 *      SDK-путь упал — остался голым.
 *  F2. `pending_approval` и `rate_limited` — это НЕ ошибки инструмента, а
 *      управляющие статусы (карточка approval уже заведена, у rate_limited
 *      есть retryInMs). Пометка is_error:true заставляла модель повторять
 *      вызов, и на один запрос человека копилось до восьми одинаковых
 *      карточек — MAX_CALLS_PER_TOOL_PER_RESPONSE не спасает, в одном ответе
 *      вызов один.
 *  F3. `stop_reason: "tool_use"` без единого КЛИЕНТСКОГО tool_use-блока
 *      отдавал пустой lastText, а message-handler на `if (!reply) return`
 *      ронял ход вообще без сообщения.
 *  F4. Пустой список инструментов и «списка нет» — одно состояние; `tools: []`
 *      уходило в API и утягивало за собой серверный web_search.
 */
// Аудит 2026-08-28: раньше здесь стоял GET_METRICS. Инструмент сузили до
// aieng/orchestrator (телеметрия прода — см. ROLE_EXPOSED_TOOLS), а этому
// файлу нужна просто инлайновая read-only тулза, доступная роли ниже.
import { describe, test, expect, afterEach } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { runWithTools } from "../lib/tool-loop.ts";
import { BudgetExceededError } from "../lib/token-budget.ts";
import { cleanupChat } from "./_helpers.ts";

const TEST_CHAT = -1_000_828;
const TEST_AGENT = "qa";

afterEach(() => cleanupChat(TEST_CHAT));

const base = {
  model: "t",
  system: [{ type: "text" as const, text: "s" }],
  messages: [{ role: "user" as const, content: "сделай" }],
  agentKey: TEST_AGENT,
  chatId: TEST_CHAT,
};

function msg(over: Partial<Anthropic.Message>): Anthropic.Message {
  return {
    id: "m",
    type: "message",
    role: "assistant",
    model: "t",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
    content: [],
    stop_reason: "end_turn",
    ...over,
  } as unknown as Anthropic.Message;
}

/** Ответ «текст + вызов инструмента». */
function toolUseStep(
  name: string,
  input: Record<string, unknown>,
  text = "",
): Anthropic.Message {
  const content: unknown[] = [];
  if (text) content.push({ type: "text", text });
  content.push({ type: "tool_use", id: "tu_1", name, input });
  return msg({
    stop_reason: "tool_use",
    content: content as Anthropic.Message["content"],
  });
}

/**
 * Модель, отдающая заранее заданную последовательность шагов. Шаг-функция
 * может бросить — так проверяется падение вызова модели посреди хода.
 */
function scripted(
  steps: Array<Anthropic.Message | (() => never)>,
  captured: unknown[],
): Anthropic {
  let i = 0;
  return {
    messages: {
      create: async (req: unknown) => {
        captured.push(req);
        const s = steps[Math.min(i++, steps.length - 1)];
        if (typeof s === "function") s();
        return s as Anthropic.Message;
      },
    },
  } as unknown as Anthropic;
}

/** Telegram-заглушка: до её методов ход в этих тестах доходить не должен. */
function fakeTelegram() {
  const calls: string[] = [];
  const rec = (m: string) => () => {
    calls.push(m);
    return Promise.resolve(true);
  };
  return {
    calls,
    tg: {
      callApi: rec("callApi"),
      sendMessage: () => {
        calls.push("sendMessage");
        return Promise.resolve({ message_id: 1 });
      },
      deleteMessage: rec("deleteMessage"),
      editMessageText: rec("editMessageText"),
      pinChatMessage: rec("pinChatMessage"),
      forwardMessage: () => {
        calls.push("forwardMessage");
        return Promise.resolve({ message_id: 1 });
      },
      sendPoll: () => {
        calls.push("sendPoll");
        return Promise.resolve({ message_id: 1 });
      },
    },
  };
}

/**
 * Все tool_result из истории запроса — то, что мы отдали модели.
 *
 * Смотреть только на последнее сообщение нельзя: цикл кладёт ответ модели в
 * ту же историю ДО проверки stop_reason, так что после финальной итерации
 * последним лежит assistant-текст, а не наши результаты.
 */
function toolResultsOf(req: unknown): Anthropic.ToolResultBlockParam[] {
  const messages = (req as { messages: Anthropic.MessageParam[] }).messages;
  const out: Anthropic.ToolResultBlockParam[] = [];
  for (const m of messages) {
    const content = m.content as unknown;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if ((b as { type?: string }).type === "tool_result") {
        out.push(b as Anthropic.ToolResultBlockParam);
      }
    }
  }
  return out;
}

describe("F1: падение вызова модели после выполненных инструментов", () => {
  test("BudgetExceededError доносит sideEffects и накопленный текст", async () => {
    const cap: unknown[] = [];
    const anthropic = scripted(
      [
        toolUseStep("GET_LOGS", {}, "смотрю метрики"),
        () => {
          throw new BudgetExceededError(TEST_AGENT, 10, 5);
        },
      ],
      cap,
    );
    let caught: unknown = null;
    try {
      await runWithTools({ ...base, anthropic });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BudgetExceededError);
    const err = caught as BudgetExceededError;
    // Без этого message-handler отвечает «лимит исчерпан», то есть «я ничего
    // не сделал» — и человек повторяет уже сделанное руками.
    expect(err.sideEffects).toBe(true);
    expect(err.partialText).toBe("смотрю метрики");
    // Поля исходной ошибки не теряются при переупаковке.
    expect(err.agentKey).toBe(TEST_AGENT);
    expect(err.used).toBe(10);
    expect(err.budget).toBe(5);
  });

  test("обычный отказ API после инструмента → отдаём накопленный текст", async () => {
    const cap: unknown[] = [];
    const anthropic = scripted(
      [
        toolUseStep("GET_LOGS", {}, "начал"),
        () => {
          throw new Error("boom");
        },
      ],
      cap,
    );
    const out = await runWithTools({ ...base, anthropic });
    expect(out).toBe("начал");
  });

  test("отказ API после инструмента и без текста → явная реплика, не throw", async () => {
    const cap: unknown[] = [];
    const anthropic = scripted(
      [
        toolUseStep("GET_LOGS", {}),
        () => {
          throw new Error("boom");
        },
      ],
      cap,
    );
    const out = await runWithTools({ ...base, anthropic });
    expect(out).toMatch(/часть действий уже выполнена/);
  });

  test("отказ API ДО единого инструмента остаётся ошибкой", async () => {
    // Ход ничем не наследил — глотать отказ значило бы врать в другую сторону.
    const cap: unknown[] = [];
    const anthropic = scripted(
      [
        () => {
          throw new Error("boom");
        },
      ],
      cap,
    );
    await expect(runWithTools({ ...base, anthropic })).rejects.toThrow("boom");
  });
});

describe("F2: управляющие статусы инструмента — не ошибка", () => {
  test("pending_approval уходит модели без is_error", async () => {
    const cap: unknown[] = [];
    const { tg, calls } = fakeTelegram();
    const anthropic = scripted(
      [
        toolUseStep("PIN_MESSAGE", { messageId: 42 }),
        msg({ content: [{ type: "text", text: "ок" }] as Anthropic.Message["content"] }),
      ],
      cap,
    );
    const out = await runWithTools({
      ...base,
      anthropic,
      telegram: tg as unknown as import("telegraf").Telegram,
      triggerMessageId: 42,
    });
    expect(out).toBe("ок");
    // Карточка approval заведена, само действие не выполнено.
    expect(calls).not.toContain("pinChatMessage");
    const results = toolResultsOf(cap[1]);
    expect(results.length).toBe(1);
    const body = JSON.parse(String(results[0].content)) as {
      ok: boolean;
      status?: string;
    };
    expect(body.ok).toBe(false);
    expect(body.status).toBe("pending_approval");
    // Ровно это заставляло модель дублировать вызов и плодить карточки.
    expect(results[0].is_error).not.toBe(true);
  });

  test("настоящая ошибка инструмента по-прежнему is_error:true", async () => {
    const cap: unknown[] = [];
    const anthropic = scripted(
      [
        // Без telegram-контекста PIN_MESSAGE отбивается ДО гейта — это отказ,
        // а не управляющий статус: у него нет поля status.
        toolUseStep("PIN_MESSAGE", { messageId: 42 }),
        msg({ content: [{ type: "text", text: "ок" }] as Anthropic.Message["content"] }),
      ],
      cap,
    );
    await runWithTools({ ...base, anthropic });
    const results = toolResultsOf(cap[1]);
    expect(results.length).toBe(1);
    const body = JSON.parse(String(results[0].content)) as {
      ok: boolean;
      status?: string;
    };
    expect(body.ok).toBe(false);
    expect(body.status).toBeUndefined();
    expect(results[0].is_error).toBe(true);
  });
});

describe("F3: tool_use без клиентских блоков", () => {
  test("пустой набор tool_use → объяснение, а не пустая строка", async () => {
    const cap: unknown[] = [];
    const anthropic = scripted([msg({ stop_reason: "tool_use", content: [] })], cap);
    const out = await runWithTools({ ...base, anthropic });
    expect(out.length).toBeGreaterThan(0);
    expect(out).toMatch(/tool_use/);
  });

  test("текст предыдущих итераций не выбрасывается", async () => {
    const cap: unknown[] = [];
    const anthropic = scripted(
      [
        toolUseStep("GET_LOGS", {}, "первое"),
        msg({ stop_reason: "tool_use", content: [] }),
      ],
      cap,
    );
    const out = await runWithTools({ ...base, anthropic });
    expect(out).toBe("первое");
  });
});

describe("F4: пустой список инструментов не уезжает в API", () => {
  test("allowedTools из одних серверных имён → tools отсутствует", async () => {
    // Список из одних серверных имён — тот же исход, что и явный [], который
    // передаёт message-handler.ts на анти-дуп ходу: ни одного из этих имён в
    // TOOLS нет, фильтр даёт ровно [].
    const cap: unknown[] = [];
    const anthropic = scripted([msg({ content: [{ type: "text", text: "ок" }] as Anthropic.Message["content"] })], cap);
    await runWithTools({
      ...base,
      anthropic,
      allowedTools: ["WebSearch", "WebFetch"],
    });
    expect((cap[0] as { tools?: unknown[] }).tools).toBeUndefined();
  });

  test("непустой allowedTools по-прежнему доезжает", async () => {
    const cap: unknown[] = [];
    const anthropic = scripted([msg({ content: [{ type: "text", text: "ок" }] as Anthropic.Message["content"] })], cap);
    await runWithTools({ ...base, anthropic, allowedTools: ["GET_LOGS"] });
    const tools = (cap[0] as { tools?: { name: string }[] }).tools;
    expect(Array.isArray(tools)).toBe(true);
    expect(tools!.some((t) => t.name === "GET_LOGS")).toBe(true);
  });
});
