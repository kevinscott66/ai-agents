/**
 * Аудит 2026-08-12: делегат работал по слову «[image]» вместо самой картинки.
 *
 * Когда владелец бросает в чат картинку без подписи, в историю ложится строка
 * «[image]» (orchestrator/message-handler.ts:219); текстовый документ ложится
 * строкой «[файл: имя]». Сами байты уходят в `inputImages` / `inputDocuments`
 * и подмешиваются блоками в последнее user-сообщение — но только тому агенту,
 * которого позвали первым.
 *
 * Дальше оркестратор делегирует, и делегат собирает свой запрос из истории.
 * Замер того, что видит дизайнер:
 *
 *   user | [Егор] [image]
 *   user | [orchestrator] Понял, передаю дизайнеру.
 *   user | [orchestrator] (handoff) DELEGATE: свёрстай баннер по картинке
 *
 *   inputImages в handoff.ts: 0
 *   inputImages в action-dispatch.ts: 0
 *   inputImages в tools-schema.ts (ExecCtx): 0
 *
 * Картинки не было ни в одном слое. При этом «производящим» ролям ставится
 * forceFirstTool: делегат ОБЯЗАН сразу вызвать инструмент — имея на входе
 * слово «[image]». Он и вызывал, рисуя из головы то, что владелец уже прислал.
 *
 * Инвариант: вложения хода доезжают до делегата тем же маршрутом, что и
 * счётчик handoff-вызовов, и попадают в его запрос настоящими блоками.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { dispatchAction } from "../lib/action-dispatch.ts";
import { respondAs, buildDelegateMessages } from "../lib/handoff.ts";
import type { HandoffDeps, RespondAsOpts } from "../lib/handoff.ts";
import type { RunningBot } from "../lib/types.ts";
import { _resetRateLimits } from "../lib/rate-limits.ts";
import { cleanupChat, saveAutonomy, restoreAutonomy } from "./_helpers.ts";

const TEST_CHAT = -1_000_919;
const PNG = "iVBORw0KGgoAAAANSUhEUg==";
const IMAGES = [{ mediaType: "image/png", base64: PNG }];
const DOCS = [{ filename: "spec.md", text: "## Требования\nкнопка синяя" }];

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

function fakeBot(key: string): RunningBot {
  return {
    def: { key: key as never, name: key, envToken: "", system: "" } as never,
    bot: {
      telegram: {
        sendChatAction: async () => {},
        sendMessage: async () => ({ message_id: 1, date: 0 }),
      },
    } as never,
    username: `${key}_bot`,
    id: 100,
  };
}

/** Клиент, который записывает запрос делегата и отвечает пустым текстом. */
function capturingDeps(captured: any[]): HandoffDeps {
  return {
    anthropic: {
      messages: {
        create: async (req: any) => {
          captured.push(req);
          return {
            id: "m",
            type: "message",
            role: "assistant",
            model: "t",
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
            content: [{ type: "text", text: "готово" }],
          } as unknown as Anthropic.Message;
        },
      },
    },
    model: "t",
    historyLimit: 5,
    bots: [],
  } as never;
}

/**
 * Последнее user-сообщение запроса. Именно в него подмешиваются блоки вложений.
 * Брать просто хвост нельзя: tool-loop дописывает в тот же массив ответ модели
 * уже после вызова, а мы держим запрос по ссылке.
 */
function lastUserMessage(req: any): any {
  const msgs = req.messages as any[];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "user") return msgs[i];
  }
  throw new Error("в запросе делегата нет ни одного user-сообщения");
}

describe("замер из шапки", () => {
  test("история делегата содержит только слово [image]", () => {
    const msgs = buildDelegateMessages(
      [
        { is_bot: 0, agent_key: null, from_name: "Егор", text: "[image]" },
        { is_bot: 1, agent_key: "orchestrator", text: "Передаю дизайнеру." },
      ] as never,
      "design",
      "orchestrator",
      "[from:orchestrator] DELEGATE: свёрстай баннер по картинке",
    );
    const flat = msgs.map((m) => String(m.content)).join("\n");
    expect(flat).toContain("[image]");
    expect(flat).not.toContain(PNG);
  });
});

describe("вложения доезжают до делегата", () => {
  test("dispatch передаёт inputImages/inputDocuments в opts respondAs", async () => {
    const seen: RespondAsOpts[] = [];
    const stub = mock(async (o: RespondAsOpts) => {
      seen.push(o);
      return "ok";
    });
    await dispatchAction(
      "DELEGATE_TO_ROLE",
      { role: "design", task: "свёрстай баннер по картинке" },
      {
        agentKey: "orchestrator",
        chatId: TEST_CHAT,
        resolveAgent: (k) => fakeBot(k),
        handoffDeps: capturingDeps([]),
        respondAsImpl: stub as never,
        delegationChain: ["orchestrator"],
        inputImages: IMAGES,
        inputDocuments: DOCS,
      },
    );
    expect(seen[0].inputImages).toEqual(IMAGES);
    expect(seen[0].inputDocuments).toEqual(DOCS);
  });

  test("в запросе делегата картинка идёт блоком, а не строкой", async () => {
    const captured: any[] = [];
    await respondAs(
      {
        target: fakeBot("design"),
        chatId: String(TEST_CHAT),
        triggerText: "[from:orchestrator] DELEGATE: свёрстай баннер по картинке",
        triggerAgentKey: "orchestrator",
        depth: 1,
        visited: new Set(["orchestrator", "design"]),
        inputImages: IMAGES,
        inputDocuments: DOCS,
      },
      capturingDeps(captured),
    );
    expect(captured).toHaveLength(1);
    const last = lastUserMessage(captured[0]);
    expect(Array.isArray(last.content)).toBe(true);
    const img = last.content.find((b: any) => b.type === "image");
    expect(img?.source?.data).toBe(PNG);
    // Документ — тоже блок, а не «[файл: spec.md]».
    const doc = last.content.find(
      (b: any) => b.type === "text" && String(b.text).includes("кнопка синяя"),
    );
    expect(doc).toBeDefined();
  });

  test("без вложений запрос делегата остаётся текстовым", async () => {
    const captured: any[] = [];
    await respondAs(
      {
        target: fakeBot("design"),
        chatId: String(TEST_CHAT),
        triggerText: "[from:orchestrator] DELEGATE: придумай слоган",
        triggerAgentKey: "orchestrator",
        depth: 1,
        visited: new Set(["orchestrator", "design"]),
      },
      capturingDeps(captured),
    );
    expect(typeof lastUserMessage(captured[0]).content).toBe("string");
  });
});
