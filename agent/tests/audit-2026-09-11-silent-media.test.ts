/**
 * Аудит 2026-09-11: ход без подписи исчезал из короткой памяти.
 *
 * `orchestrator/message-handler.ts` собирал текст хода так: подпись, иначе
 * «[image]», иначе «[файл: имя]», иначе — выход. Выход стоял ДО записи в
 * короткую память, поэтому кружок, видео, стикер, гифка, аудио и любой
 * документ, который не картинка и не текст, не оставляли в истории вообще
 * ничего. Для модели это неотличимо от молчания: на «посмотри» после кружка
 * она отвечает «ты ничего не присылал».
 *
 * Голосовые сюда не относятся — `bot.on("voice")` зарегистрирован раньше
 * `bot.on("message")` и терминален (см. `voice-handler.ts`), так что второй
 * записи не будет.
 *
 * Инвариант: немой носитель оставляет в истории ровно одну строку-пометку и
 * НЕ поднимает платный ход модели.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { registerMessageHandler } from "../orchestrator/message-handler.ts";
import { mediaNote, MEDIA_MARKER_INNER } from "../lib/media-markers.ts";
import { defuseSpeakerLabels } from "../lib/agent-prompts.ts";
import { CHARACTERS } from "../characters/index.ts";
import { db } from "../lib/db.ts";

const CHAT = -1009111;
const CHAT_S = String(CHAT);
const ORCH = CHARACTERS.find((c) => c.key === "orchestrator")!;
const ORCH_USER = "delabs_lead_bot";

let nextMessageId = 5001;

beforeEach(() => {
  db.prepare(`DELETE FROM messages WHERE chat_id = ?`).run(CHAT_S);
  db.prepare(`DELETE FROM processed_triggers WHERE chat_id = ?`).run(CHAT_S);
});

/** Прогнать апдейт через настоящий хендлер; вернуть историю и счётчик ходов. */
async function deliver(
  message: Record<string, unknown>,
): Promise<{ history: string[]; llmCalls: number }> {
  let handler: ((ctx: any) => Promise<void>) | null = null;
  let llmCalls = 0;
  const anthropic = {
    messages: {
      create: async () => {
        llmCalls++;
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

  const lead: any = {
    on: (_ev: string, h: any) => {
      handler = h;
    },
    telegram: {
      sendChatAction: async () => {},
      getFileLink: async () => new URL("http://127.0.0.1:0/file.bin"),
    },
  };
  const running: any = { def: ORCH, bot: lead, username: ORCH_USER, id: 41 };

  registerMessageHandler(lead, ORCH, running, {
    bots: [running],
    allowed: [CHAT_S],
    historyLimit: 30,
    anthropic,
    model: "test-model",
    handoffDeps: { anthropic, model: "test-model", historyLimit: 30, bots: [running] } as any,
    respondAsImpl: (async () => null) as never,
  });

  await handler!({
    chat: { id: CHAT },
    from: { id: 777, username: "petya", is_bot: false },
    message: { message_id: nextMessageId++, ...message },
    sendChatAction: async () => {},
    reply: async () => ({ message_id: 9002, date: Math.floor(Date.now() / 1000) }),
  });

  const history = db
    .prepare(`SELECT text FROM messages WHERE chat_id = ? ORDER BY id`)
    .all(CHAT_S)
    .map((r: any) => r.text as string);
  return { history, llmCalls };
}

describe("пометка носителя: словарь", () => {
  test("каждый носитель получает свою пометку", () => {
    expect(mediaNote({ video_note: { file_id: "a" } })).toBe("[кружок]");
    expect(mediaNote({ animation: { file_id: "a" } })).toBe("[гифка]");
    expect(mediaNote({ sticker: { file_id: "a" } })).toBe("[стикер]");
    expect(mediaNote({ video: { file_id: "a" } })).toBe("[видео]");
    expect(mediaNote({ audio: { file_id: "a" } })).toBe("[аудио]");
    expect(mediaNote({ document: { file_name: "смета.xlsx" } })).toBe(
      "[файл: смета.xlsx]",
    );
  });

  test("кружок и гифка узнаются раньше, чем video и document", () => {
    // Telegram кладёт кружок как video_note + video, гифку — как animation +
    // document. Порядок проверок в mediaNote — это и есть контракт.
    expect(mediaNote({ video_note: { file_id: "a" }, video: { file_id: "b" } })).toBe(
      "[кружок]",
    );
    expect(
      mediaNote({ animation: { file_id: "a" }, document: { file_name: "g.mp4" } }),
    ).toBe("[гифка]");
  });

  test("документ без имени не даёт «[файл: undefined]»", () => {
    expect(mediaNote({ document: {} })).toBe("[файл: document]");
    expect(mediaNote({ document: { file_name: 42 } })).toBe("[файл: document]");
  });

  test("не-носители пометки не получают", () => {
    for (const msg of [
      {},
      { text: "привет" },
      { poll: { id: "1" } },
      { location: { latitude: 1, longitude: 2 } },
      { contact: { phone_number: "1" } },
      { new_chat_members: [] },
    ]) {
      expect(mediaNote(msg)).toBeNull();
    }
  });

  test("всякая пометка переживает обезвреживание подписей", () => {
    // Второй читатель словаря — defuseSpeakerLabels. Если список разъедется,
    // «[кружок]» в истории превратится в «(кружок)».
    const notes = [
      mediaNote({ video_note: {} })!,
      mediaNote({ animation: {} })!,
      mediaNote({ sticker: {} })!,
      mediaNote({ video: {} })!,
      mediaNote({ audio: {} })!,
      mediaNote({ document: { file_name: "смета.xlsx" } })!,
      "[image]",
    ];
    for (const n of notes) {
      expect(MEDIA_MARKER_INNER.test(n.slice(1, -1))).toBe(true);
      expect(defuseSpeakerLabels(n)).toBe(n);
    }
  });
});

describe("немой носитель доходит до короткой памяти", () => {
  test("кружок без подписи оставляет строку и НЕ поднимает ход модели", async () => {
    const { history, llmCalls } = await deliver({ video_note: { file_id: "F1" } });
    expect(history).toEqual(["[кружок]"]);
    expect(llmCalls).toBe(0);
  });

  test("стикер, видео, гифка, аудио — то же самое", async () => {
    for (const [msg, want] of [
      [{ sticker: { file_id: "F" } }, "[стикер]"],
      [{ video: { file_id: "F" } }, "[видео]"],
      [{ animation: { file_id: "F" } }, "[гифка]"],
      [{ audio: { file_id: "F" } }, "[аудио]"],
    ] as const) {
      db.prepare(`DELETE FROM messages WHERE chat_id = ?`).run(CHAT_S);
      const { history, llmCalls } = await deliver(msg as Record<string, unknown>);
      expect(history).toEqual([want]);
      expect(llmCalls).toBe(0);
    }
  });

  test("документ произвольного типа записывается по имени файла", async () => {
    const { history } = await deliver({
      document: { file_id: "F", file_name: "смета.xlsx", mime_type: "application/vnd.ms-excel" },
    });
    expect(history).toEqual(["[файл: смета.xlsx]"]);
  });

  test("подпись под носителем остаётся текстом хода, пометка не подменяет её", async () => {
    const { history, llmCalls } = await deliver({
      video: { file_id: "F" },
      caption: "вот запись созвона",
    });
    // Подписанный ход — обычный ход: он и в историю ложится подписью, и
    // поднимает модель. Ответ Дирижёра пишется в ту же историю следом.
    expect(history[0]).toBe("вот запись созвона");
    expect(llmCalls).toBe(1);
  });

  test("сообщение без носителя и без текста по-прежнему не пишется", async () => {
    const { history, llmCalls } = await deliver({ poll: { id: "1", question: "?" } });
    expect(history).toEqual([]);
    expect(llmCalls).toBe(0);
  });
});
