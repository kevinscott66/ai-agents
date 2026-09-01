/**
 * Аудит 2026-08-10: голосовые сообщения не распознавались вообще.
 *
 * Хендлер скачивал ogg по `process.env.TELEGRAM_TOKEN` — переменной, которой в
 * проекте нет: у каждого бота своё имя в `def.envToken`, у оркестратора это
 * `TELEGRAM_BOT_TOKEN` (см. characters/index.ts и .env.example). Дальше — тихий
 * `return` после `sendChatAction("typing")`: пользователь видел «печатает…» и
 * больше ничего. Ни ответа, ни ошибки, ни строчки в чат — поэтому фича могла
 * лежать сломанной сколько угодно.
 *
 * Тесты покрывали только `transcribeVoice` (t109), сам хендлер — ни одного, что
 * и позволило имени разойтись с реальностью. Здесь — хендлер целиком: Telegraf
 * подменяем объектом с `on`, ctx собираем руками, fetch разводим по URL.
 */
import { describe, test, expect, beforeEach, afterEach, afterAll, spyOn } from "bun:test";
import type { Telegraf } from "telegraf";
import { registerVoiceHandler } from "../orchestrator/voice-handler.ts";
import { CHARACTERS } from "../characters/index.ts";
import type { RunningBot } from "../lib/types.ts";
import { db } from "../lib/db.ts";
import { cleanupChat } from "./_helpers.ts";

const TEST_CHAT = 999_314_003;
const ORCH = CHARACTERS.find((c) => c.key === "orchestrator")!;
const REAL_TOKEN = "111:orchestrator-token";
/** Allow-list fail-closed (lib/allowlist.ts): пустой список запрещает всех. */
const ALLOWED = [String(TEST_CHAT)];

const running: RunningBot = {
  def: ORCH,
  bot: {} as Telegraf,
  username: "lead_bot",
  id: 4242,
};

/** Регистрирует хендлер на фейковом Telegraf и отдаёт саму функцию. */
function handlerFor(def = ORCH): (ctx: any) => Promise<void> {
  let captured: ((ctx: any) => Promise<void>) | undefined;
  const bot = {
    on: (event: string, fn: (ctx: any) => Promise<void>) => {
      if (event === "voice") captured = fn;
    },
  } as unknown as Telegraf;
  registerVoiceHandler(bot, def, running, ALLOWED);
  expect(captured).toBeDefined();
  return captured!;
}

const replies: string[] = [];

function makeCtx(over: Record<string, unknown> = {}) {
  return {
    chat: { id: TEST_CHAT },
    from: { id: 777, username: "owner" },
    message: { voice: { file_id: "VOICE-FILE-ID" }, message_id: 5150 },
    telegram: { getFile: async () => ({ file_path: "voice/file_1.oga" }) },
    sendChatAction: async () => {},
    reply: async (t: string) => {
      replies.push(t);
    },
    ...over,
  };
}

const mockFetch = spyOn(globalThis, "fetch");
/** URL'ы, по которым хендлер реально ходил. */
let fetched: string[] = [];

let savedBotToken: string | undefined;
let savedStrayToken: string | undefined;
let savedOpenai: string | undefined;

beforeEach(() => {
  replies.length = 0;
  fetched = [];
  savedBotToken = process.env[ORCH.envToken];
  savedStrayToken = process.env.TELEGRAM_TOKEN;
  savedOpenai = process.env.OPENAI_API_KEY;
  process.env[ORCH.envToken] = REAL_TOKEN;
  // Имя, на которое хендлер смотрел раньше, в окружении отсутствует — как и в
  // проде. Именно поэтому голосовые молчали.
  delete process.env.TELEGRAM_TOKEN;
  process.env.OPENAI_API_KEY = "test-key";

  mockFetch.mockImplementation((async (input: any) => {
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
  if (savedBotToken === undefined) delete process.env[ORCH.envToken];
  else process.env[ORCH.envToken] = savedBotToken;
  if (savedStrayToken === undefined) delete process.env.TELEGRAM_TOKEN;
  else process.env.TELEGRAM_TOKEN = savedStrayToken;
  if (savedOpenai === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedOpenai;
  cleanupChat(TEST_CHAT);
});

afterAll(() => {
  mockFetch.mockRestore();
});

describe("голосовое доходит до Whisper", () => {
  test("файл качается токеном своего бота, а не выдуманной переменной", async () => {
    await handlerFor()(makeCtx());

    const fileUrl = fetched.find((u) => u.includes("api.telegram.org"));
    expect(fileUrl).toBeDefined();
    expect(fileUrl).toContain(`/bot${REAL_TOKEN}/`);
    expect(fileUrl).toContain("voice/file_1.oga");
  });

  test("расшифровка уходит пользователю", async () => {
    await handlerFor()(makeCtx());

    expect(fetched.some((u) => u.includes("api.openai.com"))).toBe(true);
    expect(replies.join("\n")).toContain("создай задачу");
  });

  test("расшифровка ложится в историю чата", async () => {
    await handlerFor()(makeCtx());

    const row = db
      .prepare(`SELECT text FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1`)
      .get(String(TEST_CHAT)) as { text: string } | undefined;
    expect(row?.text).toBe("[Voice] создай задачу");
  });
});

describe("молчание вместо ответа — тоже поломка", () => {
  test("без токена пользователь узнаёт об этом, а не смотрит в пустоту", async () => {
    delete process.env[ORCH.envToken];

    await handlerFor()(makeCtx());

    // Раньше здесь был голый `return` после «печатает…».
    expect(replies.length).toBeGreaterThan(0);
    expect(fetched.some((u) => u.includes("api.telegram.org"))).toBe(false);
  });

  test("без file_id — тоже ответ, а не тишина", async () => {
    await handlerFor()(makeCtx({ message: { voice: {}, message_id: 5151 } }));

    expect(replies.length).toBeGreaterThan(0);
  });
});

describe("прежнее поведение сохранено", () => {
  test("роль-боты голос не трогают — расшифровка одна на чат", async () => {
    const pm = CHARACTERS.find((c) => c.key === "pm")!;
    await handlerFor(pm)(makeCtx());

    expect(fetched).toEqual([]);
    expect(replies).toEqual([]);
  });

  test("своё же эхо не расшифровываем", async () => {
    await handlerFor()(makeCtx({ from: { id: running.id, username: "lead_bot" } }));

    expect(fetched).toEqual([]);
  });

  test("чат вне allowlist игнорируется", async () => {
    let captured: ((ctx: any) => Promise<void>) | undefined;
    const bot = {
      on: (event: string, fn: (ctx: any) => Promise<void>) => {
        if (event === "voice") captured = fn;
      },
    } as unknown as Telegraf;
    registerVoiceHandler(bot, ORCH, running, ["-100999"]);

    await captured!(makeCtx());

    expect(fetched).toEqual([]);
    expect(replies).toEqual([]);
  });
});
