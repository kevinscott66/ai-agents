/**
 * Аудит 2026-08-13: результат делегирования врал в обе стороны.
 *
 * `respondAs` возвращал `string | null`, и `null` означал сразу пять разных
 * вещей: цель на паузе, исчерпан бюджет вызовов, ход закончился инструментом
 * без текста, падение до отправки, падение ПОСЛЕ отправки. Различить их выше по
 * стеку было нечем, поэтому DELEGATE_TO_ROLE отдавал модели `ok:true` во всех
 * случаях, а доску задач закрывал `failed`. Признак, по которому tool-loop
 * ставит `is_error`, ровно один — `ok === false`, — так что оркестратор шёл
 * дальше по пайплайну и писал в чат «готово» о работе, которой не было.
 *
 * Здесь проверяется, что каждый из пяти исходов теперь называет себя сам.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { respondAs, normalizeHandoffOutcome } from "../lib/handoff.ts";
import type { HandoffDeps } from "../lib/handoff.ts";
import type { RunningBot } from "../lib/types.ts";
import { cleanupChat } from "./_helpers.ts";

const TEST_CHAT = -1_000_813_813;

beforeEach(() => cleanupChat(TEST_CHAT));
afterEach(() => cleanupChat(TEST_CHAT));

/** Клиент, который отвечает ровно одним заданным блоком content. */
function anthropicReturning(
  content: unknown[],
  stopReason = "end_turn",
): Anthropic {
  return {
    messages: {
      create: async () =>
        ({
          id: "m",
          type: "message",
          role: "assistant",
          model: "t",
          stop_reason: stopReason,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
          content,
        }) as unknown as Anthropic.Message,
    },
  } as unknown as Anthropic;
}

function deps(anthropic: Anthropic): HandoffDeps {
  return { anthropic, model: "t", historyLimit: 5, bots: [] } as never;
}

function fakeBot(key: string, overrides: Record<string, unknown> = {}) {
  const sendMessage = mock(async () => ({ message_id: 7, date: 0 }));
  const bot = {
    def: { key, name: key, envToken: "", system: "" },
    bot: {
      telegram: {
        sendChatAction: async () => {},
        sendMessage,
      },
    },
    username: `${key}_bot`,
    id: 100,
    ...overrides,
  } as unknown as RunningBot;
  return { bot, sendMessage };
}

const callOpts = (target: RunningBot) => ({
  target,
  chatId: String(TEST_CHAT),
  triggerText: "нарисуй баннер",
  triggerAgentKey: "orchestrator",
  depth: 1,
  visited: new Set(["orchestrator", target.def.key]),
});

describe("ход, закрытый инструментом, — это успех, а не пустота", () => {
  test("end_turn без текста → acted, а не failed", async () => {
    // Ровно то, чем заканчивается нормальный ход design после GENERATE_IMAGE:
    // картинка уже в чате, говорить больше нечего. `runWithTools` отдаёт "" —
    // всем прочим причинам обрыва `explainEmptyStop` даёт непустое объяснение,
    // и оно уходит в чат обычным ответом.
    const { bot, sendMessage } = fakeBot("design");
    const outcome = await respondAs(
      callOpts(bot),
      deps(anthropicReturning([])),
    );

    expect(outcome.status).toBe("acted");
    // И ничего не отправлено: пустой текст в чат не постим.
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("непустой ответ → answered с тем же текстом, что ушёл в чат", async () => {
    const { bot, sendMessage } = fakeBot("backend");
    const outcome = await respondAs(
      callOpts(bot),
      deps(anthropicReturning([{ type: "text", text: "готово, API поднят" }])),
    );

    expect(outcome.status).toBe("answered");
    if (outcome.status !== "answered") throw new Error("ожидался answered");
    expect(outcome.reply).toBe("готово, API поднят");
    expect(sendMessage).toHaveBeenCalled();
  });
});

describe("падение до отправки и падение после отправки — разные исходы", () => {
  test("сеть недоступна → failed с причиной", async () => {
    const { bot, sendMessage } = fakeBot("backend");
    const broken = {
      messages: {
        create: async () => {
          throw new Error("connect ECONNREFUSED");
        },
      },
    } as unknown as Anthropic;

    const outcome = await respondAs(callOpts(bot), deps(broken));

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("ожидался failed");
    expect(outcome.reason).toContain("ECONNREFUSED");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("ответ доставлен, послесловие упало → всё равно answered", async () => {
    // Точка невозврата — успешный sendChunked. Дальше идёт бухгалтерия: запись
    // в историю, компактор, каскад по упоминаниям. Раньше всё это лежало под
    // одним catch, который возвращал null, — и делегирование помечалось
    // провалом ПОСЛЕ того, как ответ увидели в чате. Вместе с ok:false выше это
    // давало повторный вызов роли: второй платный прогон и второе сообщение
    // подряд в чат.
    //
    // Роняем первую же строку послесловия — `target.id.toString()` в
    // recordMessage. Конкретный источник падения тут не важен (в проде это
    // заблокированная БД или компактор), важна ветка.
    const { bot, sendMessage } = fakeBot("backend", {
      id: {
        toString() {
          throw new Error("послесловие упало");
        },
      },
    });

    const outcome = await respondAs(
      callOpts(bot),
      deps(anthropicReturning([{ type: "text", text: "готово, API поднят" }])),
    );

    expect(sendMessage).toHaveBeenCalled();
    expect(outcome.status).toBe("answered");
    if (outcome.status !== "answered") throw new Error("ожидался answered");
    expect(outcome.reply).toBe("готово, API поднят");
  });
});

describe("normalizeHandoffOutcome — шов для заглушек и легаси-вызовов", () => {
  test("готовый итог пропускается как есть", () => {
    expect(normalizeHandoffOutcome({ status: "acted" })).toEqual({
      status: "acted",
    });
    expect(
      normalizeHandoffOutcome({ status: "skipped", reason: "пауза" }),
    ).toEqual({ status: "skipped", reason: "пауза" });
  });

  test("текст → answered, пустая строка → acted", () => {
    expect(normalizeHandoffOutcome("готово")).toEqual({
      status: "answered",
      reply: "готово",
    });
    expect(normalizeHandoffOutcome("")).toEqual({ status: "acted" });
  });

  test("null и undefined → failed, а не успех", () => {
    // Старый контракт различия не знал: считать неизвестное успехом — ровно та
    // ошибка, которую эта правка чинит.
    expect(normalizeHandoffOutcome(null).status).toBe("failed");
    expect(normalizeHandoffOutcome(undefined).status).toBe("failed");
  });
});
