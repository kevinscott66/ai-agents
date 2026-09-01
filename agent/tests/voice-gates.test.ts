/**
 * Аудит 2026-08-13: голосовой путь шёл мимо паузы и мимо лимита ingest.
 *
 * `bot.on("voice")` — отдельный вход, и обе проверки текстового пути в нём
 * отсутствовали:
 *
 *  - **Пауза.** `agentStopReason` затыкает речь агента в message-handler именно
 *    потому, что ответ уходит прямым `ctx.reply` мимо гейта действий. В голосе
 *    ровно то же самое («🎤 Распознано: …»), плюс перед ним платная расшифровка
 *    у Whisper. Поставленный на паузу оркестратор молчал текстом и отвечал
 *    голосом.
 *  - **Лимит ingest (SEC-3 / T-601).** Текстовый хендлер на голосовом апдейте
 *    выходит раньше счётчика (`if (!rawText.trim() && …) return`, строка 230),
 *    значит на этом пути бакет не тратился вовсе. Упёршийся в лимит человек
 *    переключался на голос и продолжал — а минута речи дороже сообщения:
 *    скачивание с CDN плюс Whisper.
 *
 * Наблюдаемая граница у обеих — `sendChatAction("typing")`: до него хендлер
 * ничего не тратит, после — уже качает файл. Поэтому тесты смотрят на него и на
 * фактические походы в сеть.
 */
import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  afterAll,
  spyOn,
  mock,
} from "bun:test";
import type { Telegraf } from "telegraf";
import { registerVoiceHandler } from "../orchestrator/voice-handler.ts";
import { CHARACTERS } from "../characters/index.ts";
import type { RunningBot } from "../lib/types.ts";
import { db } from "../lib/db.ts";
import { _resetRateLimits } from "../lib/rate-limits.ts";
import { cleanupChat } from "./_helpers.ts";

const TEST_CHAT = 999_314_007;
const ORCH = CHARACTERS.find((c) => c.key === "orchestrator")!;
const ALLOWED = [String(TEST_CHAT)];
const USER = 777;

const running: RunningBot = {
  def: ORCH,
  bot: {} as Telegraf,
  username: "lead_bot",
  id: 4242,
};

function setPaused(agentKey: string, paused: 0 | 1) {
  db.prepare(
    `INSERT INTO agent_states(agent_key, paused, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(agent_key) DO UPDATE SET
       paused = excluded.paused,
       updated_at = excluded.updated_at`,
  ).run(agentKey, paused, Date.now());
}

function handlerFor(): (ctx: never) => Promise<void> {
  let captured: ((ctx: never) => Promise<void>) | undefined;
  const bot = {
    on: (event: string, fn: (ctx: never) => Promise<void>) => {
      if (event === "voice") captured = fn;
    },
  } as unknown as Telegraf;
  registerVoiceHandler(bot, ORCH, running, ALLOWED);
  expect(captured).toBeDefined();
  return captured!;
}

const typing = mock(async () => {});
const replies: string[] = [];
let fetched: string[] = [];

function makeCtx(userId = USER, messageId = 5150) {
  return {
    chat: { id: TEST_CHAT },
    from: { id: userId, username: "owner" },
    message: { voice: { file_id: "VOICE-FILE-ID" }, message_id: messageId },
    telegram: { getFile: async () => ({ file_path: "voice/file_1.oga" }) },
    sendChatAction: typing,
    reply: async (t: string) => {
      replies.push(t);
    },
  } as never;
}

const mockFetch = spyOn(globalThis, "fetch");

let savedToken: string | undefined;
let savedOpenai: string | undefined;
let savedMax: string | undefined;

beforeEach(() => {
  typing.mockClear();
  replies.length = 0;
  fetched = [];
  _resetRateLimits();
  setPaused(ORCH.key, 0);
  savedToken = process.env[ORCH.envToken];
  savedOpenai = process.env.OPENAI_API_KEY;
  savedMax = process.env.INGEST_RATE_MAX_PER_WINDOW;
  process.env[ORCH.envToken] = "111:orchestrator-token";
  process.env.OPENAI_API_KEY = "test-key";
  mockFetch.mockImplementation((async (input: unknown) => {
    const url = String(input);
    fetched.push(url);
    if (url.includes("api.telegram.org")) {
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }
    return new Response(JSON.stringify({ text: "создай задачу" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch);
});

afterEach(() => {
  // CLAUDE.md §3.8 п.7: env восстанавливаем всегда, иначе течёт дальше.
  if (savedToken === undefined) delete process.env[ORCH.envToken];
  else process.env[ORCH.envToken] = savedToken;
  if (savedOpenai === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedOpenai;
  if (savedMax === undefined) delete process.env.INGEST_RATE_MAX_PER_WINDOW;
  else process.env.INGEST_RATE_MAX_PER_WINDOW = savedMax;
  setPaused(ORCH.key, 0);
  _resetRateLimits();
  cleanupChat(TEST_CHAT);
});

afterAll(() => {
  mockFetch.mockRestore();
});

describe("пауза затыкает и голос", () => {
  test("на паузе нет ни typing, ни скачивания, ни ответа", async () => {
    setPaused(ORCH.key, 1);
    await handlerFor()(makeCtx());
    expect(typing).not.toHaveBeenCalled();
    // Ни Telegram-CDN, ни Whisper: пауза стоит ДО первой траты.
    expect(fetched).toEqual([]);
    expect(replies).toEqual([]);
  });

  test("снятая пауза возвращает голос в работу", async () => {
    setPaused(ORCH.key, 0);
    await handlerFor()(makeCtx());
    expect(typing).toHaveBeenCalled();
    expect(fetched.some((u) => u.includes("api.telegram.org"))).toBe(true);
    expect(replies[0]).toContain("Распознано");
  });
});

describe("лимит ingest общий с текстом", () => {
  test("сверх лимита голосовое дропается молча", async () => {
    process.env.INGEST_RATE_MAX_PER_WINDOW = "2";
    const h = handlerFor();
    await h(makeCtx(USER, 1));
    await h(makeCtx(USER, 2));
    expect(replies).toHaveLength(2);

    typing.mockClear();
    replies.length = 0;
    fetched = [];
    await h(makeCtx(USER, 3));
    // Тихо: ответ «слишком часто» — сам по себе усилитель (как в тексте).
    expect(typing).not.toHaveBeenCalled();
    expect(fetched).toEqual([]);
    expect(replies).toEqual([]);
  });

  test("лимит считается по человеку, а не по чату целиком", async () => {
    process.env.INGEST_RATE_MAX_PER_WINDOW = "1";
    const h = handlerFor();
    await h(makeCtx(USER, 1));
    await h(makeCtx(USER, 2)); // этот уже сверх лимита

    replies.length = 0;
    await h(makeCtx(USER + 1, 3)); // другой человек — свой бакет
    expect(replies).toHaveLength(1);
  });

  test("в пределах лимита ничего не меняется", async () => {
    process.env.INGEST_RATE_MAX_PER_WINDOW = "5";
    const h = handlerFor();
    for (let i = 0; i < 3; i++) await h(makeCtx(USER, 10 + i));
    expect(replies).toHaveLength(3);
  });
});

describe("порядок проверок", () => {
  test("пауза стоит до лимита: остановленный агент не жжёт чужой счётчик", async () => {
    process.env.INGEST_RATE_MAX_PER_WINDOW = "1";
    setPaused(ORCH.key, 1);
    const h = handlerFor();
    await h(makeCtx(USER, 1)); // на паузе — бакет тратиться не должен

    setPaused(ORCH.key, 0);
    replies.length = 0;
    await h(makeCtx(USER, 2));
    // Если бы пауза потратила слот, здесь был бы дроп и ноль ответов.
    expect(replies).toHaveLength(1);
  });

  test("дедуп передоставки стоит между паузой и лимитом ingest", async () => {
    // Раньше здесь пиналось обратное («shouldProcessTrigger намеренно нет»):
    // считалось, что тот же апдейт видит и bot.on("message"), и две точки на
    // один message_id устроят гонку. Замер на настоящем Telegraf показал, что
    // голосовой апдейт до текстового хендлера не доходит вовсе — голосовой
    // зарегистрирован раньше и терминален. Замер живёт в
    // tests/audit-2026-08-28-voice-redelivery-dedup.test.ts.
    const src = await Bun.file(
      new URL("../orchestrator/voice-handler.ts", import.meta.url).pathname,
    ).text();
    // Только исполняемые строки: в комментариях выше названы все три гейта.
    const lines = src.split("\n").map((l) => {
      const t = l.trimStart();
      return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") ? "" : l;
    });
    const at = (needle: string) => lines.findIndex((l) => l.includes(needle));

    const pause = at("agentStopReason(def.key)");
    const dedup = at("shouldProcessTrigger(chatId");
    const ingest = at("checkAndConsumeIngestLimit(chatId");
    expect(pause).toBeGreaterThan(0);
    expect(dedup).toBeGreaterThan(pause);
    expect(ingest).toBeGreaterThan(dedup);
  });
});
