/**
 * Аудит 2026-08-12: каскад по @-упоминаниям ронял контекст хода.
 *
 * Делегирование идёт двумя ветками. Первая — инструмент DELEGATE_TO_ROLE через
 * action-dispatch. Вторая — @-упоминание в ответе агента: message-handler
 * прогоняет ответ через findHandoffTargets и зовёт respondAs напрямую.
 *
 * Ветки эти собирают opts независимо, и вторая знала о ходе меньше первой:
 *
 *   respondAs({ target, chatId, triggerText, triggerAgentKey, depth,
 *               visited, triggerMessageId, maxDepth, budget })
 *
 * Нет `requestId` — того самого correlation id, который заводится на входе
 * (message-handler ~485) специально, чтобы сшить один ход пользователя в
 * audit_logs. Без него делегат заводит себе новый: одно сообщение владельца
 * разваливается на несвязанные ходы, и «оркестратор попросил backend, backend
 * опубликовал» сшивается только по времени. Ровно этот дефект чинили
 * 2026-08-08 — но на хоп ниже, в рекурсивном вызове внутри handoff.ts. Правило
 * записано в типе RespondAsOpts.requestId и выполнялось в одной точке из двух.
 *
 * Нет и вложений хода: та же история, что в delegate-attachments.test.ts —
 * делегат по @-упоминанию получал слово «[image]» вместо картинки.
 *
 * Инвариант: обе ветки делегирования отдают делегату один и тот же контекст
 * хода — id хода, вложения, общий счётчик.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { registerMessageHandler } from "../orchestrator/message-handler.ts";
import type { RespondAsOpts } from "../lib/handoff.ts";
import { CHARACTERS } from "../characters/index.ts";
import { db } from "../lib/db.ts";

const CHAT = -1009002;
const CHAT_S = String(CHAT);
const ORCH = CHARACTERS.find((c) => c.key === "orchestrator")!;
const DESIGN = CHARACTERS.find((c) => c.key === "design")!;
const COPY = CHARACTERS.find((c) => c.key === "copy")!;
const ORCH_USER = "delabs_lead_bot";
const DESIGN_USER = "delabs_design_bot";
const COPY_USER = "delabs_copy_bot";

/** Клиент, который отвечает заданным текстом. В этом тексте и стоят упоминания. */
function fakeAnthropic(reply: string) {
  return {
    messages: {
      create: async () =>
        ({
          id: "m",
          type: "message",
          role: "assistant",
          model: "t",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
          content: [{ type: "text", text: reply }],
        }) as unknown as Anthropic.Message,
    },
  } as unknown as Anthropic;
}

function fakeBot(def: (typeof CHARACTERS)[number], username: string, id: number) {
  const bot: any = { on: () => {}, telegram: { sendChatAction: async () => {} } };
  return { def, bot, username, id };
}

/**
 * Прогнать апдейт через настоящий хендлер оркестратора и вернуть opts, с
 * которыми ушёл каскад по упоминаниям.
 */
async function deliver(
  reply: string,
  message: Record<string, unknown> = {},
): Promise<RespondAsOpts[]> {
  let handler: ((ctx: any) => Promise<void>) | null = null;
  const lead: any = {
    on: (_ev: string, h: any) => {
      handler = h;
    },
    telegram: {
      sendChatAction: async () => {},
      getFileLink: async () => new URL("http://127.0.0.1:0/file.jpg"),
    },
  };
  const running: any = { def: ORCH, bot: lead, username: ORCH_USER, id: 41 };
  const bots = [
    running,
    fakeBot(DESIGN, DESIGN_USER, 42),
    fakeBot(COPY, COPY_USER, 43),
  ];
  const anthropic = fakeAnthropic(reply);
  const seen: RespondAsOpts[] = [];

  registerMessageHandler(lead, ORCH, running, {
    bots,
    allowed: [CHAT_S],
    historyLimit: 30,
    anthropic,
    model: "test-model",
    handoffDeps: { anthropic, model: "test-model", historyLimit: 30, bots } as any,
    respondAsImpl: (async (o: RespondAsOpts) => {
      seen.push(o);
      return null;
    }) as never,
  });

  const text = "@delabs_lead_bot собери баннер и текст";
  const messageId = nextMessageId++;
  await handler!({
    chat: { id: CHAT },
    from: { id: 777, username: "petya", is_bot: false },
    message: {
      message_id: messageId,
      text,
      entities: [{ type: "mention", offset: 0, length: ORCH_USER.length + 1 }],
      ...message,
    },
    sendChatAction: async () => {},
    reply: async () => ({ message_id: 1002, date: Math.floor(Date.now() / 1000) }),
  });
  return seen;
}

/** Анти-дуп триггеров живёт в БД по (chat_id, tg_message_id) — id не переиспользуем. */
let nextMessageId = 1001;

beforeEach(() => {
  db.prepare(`DELETE FROM messages WHERE chat_id = ?`).run(CHAT_S);
  db.prepare(`DELETE FROM processed_triggers WHERE chat_id = ?`).run(CHAT_S);
});

describe("каскад по @-упоминаниям несёт контекст хода", () => {
  test("делегат получает request_id хода, а не заводит свой", async () => {
    const seen = await deliver(`Беру. @${DESIGN_USER} свёрстай баннер.`);
    expect(seen).toHaveLength(1);
    expect(typeof seen[0].requestId).toBe("string");
    expect(seen[0].requestId).toMatch(/^[0-9A-Za-z_-]{12}$/);
  });

  test("две упомянутые роли попадают в ОДИН ход, а не в два", async () => {
    const seen = await deliver(
      `@${DESIGN_USER} баннер, @${COPY_USER} текст.`,
    );
    expect(seen).toHaveLength(2);
    // Один ход пользователя — один request_id на всех делегатов ветки.
    expect(seen[0].requestId).toBeTruthy();
    expect(seen[0].requestId).toBe(seen[1].requestId);
    // Счётчик handoff-вызовов тоже общий — по ссылке, а не по значению.
    expect(seen[0].budget).toBe(seen[1].budget);
  });

  test("делегат по упоминанию получает картинку хода, а не слово «[image]»", async () => {
    const realFetch = globalThis.fetch;
    // `ok`/`status` — не украшение: с 2026-08-20 код скачивания смотрит на
    // статус ответа (fetch не бросает на 4xx/5xx). Стаб без них — это
    // «HTTP undefined», то есть отказ.
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    })) as never;
    try {
      const seen = await deliver(`@${DESIGN_USER} сделай так же.`, {
        photo: [{ file_id: "F1", file_size: 4 }],
      });
      expect(seen).toHaveLength(1);
      expect(seen[0].inputImages).toEqual([
        { mediaType: "image/jpeg", base64: Buffer.from([1, 2, 3, 4]).toString("base64") },
      ]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("без упоминаний каскад не запускается", async () => {
    expect(await deliver("Готово, всё сделал сам.")).toHaveLength(0);
  });
});
