/**
 * Аудит 2026-08-12: путь голосового сообщения содержал два fetch без потолка.
 *
 *   const response = await fetch(fileUrl);            // orchestrator/voice-handler.ts
 *   const res = await fetch(OPENAI_TRANSCRIPTION_URL, { … });  // lib/openai-whisper.ts
 *
 * Ни у одного не было `signal`. Соседний lib/openai-image.ts ограничен с
 * самого начала («SEC-audit: bound the request» + 60s), здесь ограничения не
 * появилось никогда.
 *
 * Почему это не «просто медленно»: оба вызова стоят ПОСЛЕ
 * `sendChatAction("typing")`. Зависший сокет — это промис хендлера, который не
 * завершится никогда: ветка catch не сработает, извинения пользователь не
 * увидит, в лог не попадёт ни строки. Наблюдаемо это неотличимо от сломанного
 * токена, из-за которого голосовые молчали месяцами (шапка
 * tests/voice-handler-token.test.ts) — и чинилось бы столько же.
 *
 * Инвариант: у обоих запросов есть AbortSignal с конечным потолком, а срабатывание
 * потолка — это обычная ошибка, то есть пользователь получает ответ.
 */
import { describe, test, expect, beforeEach, afterEach, afterAll, spyOn } from "bun:test";
import type { Telegraf } from "telegraf";
import {
  registerVoiceHandler,
  MAX_VOICE_BYTES,
  readResponseBodyWithLimit,
  VOICE_FILE_TIMEOUT_MS,
} from "../orchestrator/voice-handler.ts";
import {
  transcribeVoice,
  OPENAI_WHISPER_TIMEOUT_MS,
} from "../lib/openai-whisper.ts";
import { CHARACTERS } from "../characters/index.ts";
import type { RunningBot } from "../lib/types.ts";
import { cleanupChat } from "./_helpers.ts";

const TEST_CHAT = 999_314_007;
const ORCH = CHARACTERS.find((c) => c.key === "orchestrator")!;
const REAL_TOKEN = "111:orchestrator-token";
const ALLOWED = [String(TEST_CHAT)];

const running: RunningBot = {
  def: ORCH,
  bot: {} as Telegraf,
  username: "lead_bot",
  id: 4242,
};

function handlerFor(): (ctx: any) => Promise<void> {
  let captured: ((ctx: any) => Promise<void>) | undefined;
  const bot = {
    on: (event: string, fn: (ctx: any) => Promise<void>) => {
      if (event === "voice") captured = fn;
    },
  } as unknown as Telegraf;
  registerVoiceHandler(bot, ORCH, running, ALLOWED);
  return captured!;
}

const replies: string[] = [];

function makeCtx() {
  return {
    chat: { id: TEST_CHAT },
    from: { id: 777, username: "owner" },
    message: { voice: { file_id: "VOICE-FILE-ID" }, message_id: 5151 },
    telegram: { getFile: async () => ({ file_path: "voice/file_1.oga" }) },
    sendChatAction: async () => {},
    reply: async (t: string) => {
      replies.push(t);
    },
  };
}

const mockFetch = spyOn(globalThis, "fetch");
/** Что именно ушло в fetch: URL и init каждого вызова. */
let calls: { url: string; init: RequestInit | undefined }[] = [];

let savedBotToken: string | undefined;
let savedOpenai: string | undefined;

beforeEach(() => {
  replies.length = 0;
  calls = [];
  savedBotToken = process.env[ORCH.envToken];
  savedOpenai = process.env.OPENAI_API_KEY;
  process.env[ORCH.envToken] = REAL_TOKEN;
  process.env.OPENAI_API_KEY = "test-key";

  mockFetch.mockImplementation((async (input: any, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
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
  if (savedOpenai === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedOpenai;
  cleanupChat(TEST_CHAT);
});

afterAll(() => {
  mockFetch.mockRestore();
});

describe("оба запроса ограничены по времени", () => {
  test("загрузка голосового ограничена размером до и во время чтения", async () => {
    await expect(
      readResponseBodyWithLimit(
        new Response(new Uint8Array(5), {
          headers: { "content-length": String(MAX_VOICE_BYTES + 1) },
        }),
        MAX_VOICE_BYTES,
      ),
    ).rejects.toThrow("слишком большое");

    await expect(
      readResponseBodyWithLimit(
        new Response(new Uint8Array([1, 2, 3, 4, 5])),
        4,
      ),
    ).rejects.toThrow("слишком большое");
  });

  test("скачивание ogg несёт живой AbortSignal", async () => {
    await handlerFor()(makeCtx());

    const call = calls.find((c) => c.url.includes("api.telegram.org"));
    expect(call).toBeDefined();
    expect(call!.init?.signal).toBeInstanceOf(AbortSignal);
    // Именно потолок, а не уже сгоревший сигнал: аборт до запроса означал бы,
    // что скачивание не работает вовсе.
    expect(call!.init!.signal!.aborted).toBe(false);
  });

  test("запрос к Whisper несёт живой AbortSignal", async () => {
    await transcribeVoice(Buffer.from([1, 2, 3]), "voice.ogg");

    const call = calls.find((c) => c.url.includes("api.openai.com"));
    expect(call).toBeDefined();
    expect(call!.init?.signal).toBeInstanceOf(AbortSignal);
    expect(call!.init!.signal!.aborted).toBe(false);
  });

  test("потолки конечные и в разумных пределах", () => {
    for (const ms of [VOICE_FILE_TIMEOUT_MS, OPENAI_WHISPER_TIMEOUT_MS]) {
      expect(Number.isFinite(ms)).toBe(true);
      expect(ms).toBeGreaterThan(0);
      // Верхняя граница — чтобы «потолок» не подняли до значения, при котором
      // он снова перестаёт отличаться от его отсутствия.
      expect(ms).toBeLessThanOrEqual(120_000);
    }
  });
});

describe("срабатывание потолка доходит до пользователя", () => {
  test("обрыв скачивания ogg — извинение, а не вечное «печатает…»", async () => {
    mockFetch.mockImplementation((async (input: any) => {
      const url = String(input);
      if (url.includes("api.telegram.org")) {
        throw new DOMException("The operation timed out.", "TimeoutError");
      }
      return new Response(JSON.stringify({ text: "x" }), { status: 200 });
    }) as unknown as typeof fetch);

    await handlerFor()(makeCtx());
    expect(replies.join("\n")).toContain("не удалось распознать");
  });

  test("обрыв запроса к Whisper — тоже извинение", async () => {
    mockFetch.mockImplementation((async (input: any) => {
      const url = String(input);
      if (url.includes("api.telegram.org")) {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }
      throw new DOMException("The operation timed out.", "TimeoutError");
    }) as unknown as typeof fetch);

    await handlerFor()(makeCtx());
    expect(replies.join("\n")).toContain("не удалось распознать");
  });
});
