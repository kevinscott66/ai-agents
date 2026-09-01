/**
 * C9: GENERATE_IMAGE via OpenAI gpt-image-1.
 *
 * Тесты не ходят в реальный OpenAI: подменяем globalThis.fetch и OPENAI_API_KEY.
 */
import { describe, test, expect, afterEach, mock } from "bun:test";
import { executeTool } from "../lib/tools-schema.ts";
import { dispatchAction } from "../lib/action-dispatch.ts";
import {
  getPermission,
  evaluateGate,
  setAutonomy,
} from "../lib/permissions.ts";
import { generateImage } from "../lib/openai-image.ts";
import { CHARACTERS } from "../characters/index.ts";
import { cleanupChat, saveAutonomy, restoreAutonomy } from "./_helpers.ts";

const TEST_CHAT = -1_000_909;
const TEST_AGENT = "design";

// 1x1 valid PNG (base64).
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const ORIG_FETCH = globalThis.fetch;
const ORIG_KEY = process.env.OPENAI_API_KEY;

let savedGlobal = saveAutonomy();
afterEach(() => {
  restoreAutonomy(savedGlobal);
  cleanupChat(TEST_CHAT);
  cleanupChat(TEST_CHAT, TEST_AGENT);
  globalThis.fetch = ORIG_FETCH;
  if (ORIG_KEY === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = ORIG_KEY;
  }
});

function mockFetchOk(b64: string = TINY_PNG_B64): void {
  const fake = async (
    _input: RequestInfo | URL,
    _init?: RequestInit,
  ): Promise<Response> =>
    new Response(JSON.stringify({ data: [{ b64_json: b64 }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  // У типа fetch есть ещё статический preconnect() — заглушке он не нужен,
  // но без него подстановка не типизируется, поэтому берём оригинальный.
  globalThis.fetch = Object.assign(fake, {
    preconnect: ORIG_FETCH.preconnect,
  });
}

/**
 * Аргументы, с которыми lib/telegram-actions.ts зовёт tg.sendPhoto:
 * (chatId, url | {source,filename}, extra). Сигнатуру задаём явно — иначе
 * mock.calls типизируется как пустой кортеж и проверки args[N] не работают.
 */
type SendPhotoArgs = [
  chatId: number | string,
  photo: string | { source: Buffer; filename?: string },
  extra?: Record<string, unknown>,
];

function fakeTg() {
  return {
    callApi: mock(() => Promise.resolve(true)),
    sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
    deleteMessage: mock(() => Promise.resolve(true)),
    editMessageText: mock(() => Promise.resolve(true)),
    pinChatMessage: mock(() => Promise.resolve(true)),
    forwardMessage: mock(() => Promise.resolve({ message_id: 1 })),
    sendPoll: mock(() => Promise.resolve({ message_id: 1 })),
    sendPhoto: mock((..._args: SendPhotoArgs) =>
      Promise.resolve({ message_id: 77 }),
    ),
  };
}

describe("migration 010: seed GENERATE_IMAGE permissions", () => {
  test("каждый из 12 агентов имеет allowed=1, requires_approval=0 для GENERATE_IMAGE", () => {
    for (const c of CHARACTERS) {
      const p = getPermission(c.key, "GENERATE_IMAGE");
      expect(p.allowed).toBe(true);
      expect(p.requires_approval).toBe(false);
    }
  });
});

describe("generateImage()", () => {
  test("возвращает Buffer с PNG magic bytes при моке fetch", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    mockFetchOk();
    const buf = await generateImage("a cat");
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.subarray(0, 4).toString("hex")).toBe("89504e47");
  });

  test("пустой промпт → throws", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    mockFetchOk();
    await expect(generateImage("")).rejects.toThrow(/empty/);
  });

  test("слишком длинный промпт → throws", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    mockFetchOk();
    const big = "x".repeat(4001);
    await expect(generateImage(big)).rejects.toThrow(/too long/);
  });

  test("без OPENAI_API_KEY → throws «OPENAI_API_KEY is not set»", async () => {
    delete process.env.OPENAI_API_KEY;
    mockFetchOk();
    await expect(generateImage("hi")).rejects.toThrow(/OPENAI_API_KEY is not set/);
  });
});

describe("dispatchAction: GENERATE_IMAGE", () => {
  test("зовёт fetch + sendPhoto, ok:true", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    mockFetchOk();
    const tg = fakeTg();
    const res = await dispatchAction(
      "GENERATE_IMAGE",
      { prompt: "a sunny street" },
      {
        agentKey: TEST_AGENT,
        chatId: TEST_CHAT,
        telegram: tg as never,
      },
    );
    expect(res.ok).toBe(true);
    expect(tg.sendPhoto).toHaveBeenCalledTimes(1);
    const args = tg.sendPhoto.mock.calls[0];
    expect(args[0]).toBe(TEST_CHAT);
    const photoArg = args[1] as { source: Buffer };
    expect(Buffer.isBuffer(photoArg.source)).toBe(true);
    expect(photoArg.source.subarray(0, 4).toString("hex")).toBe("89504e47");
  });
});

describe("executeTool: GENERATE_IMAGE", () => {
  test("в semi_auto → ok:true (auto-allowed)", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    mockFetchOk();
    savedGlobal = saveAutonomy();
    setAutonomy("global", "*", "semi_auto");
    const tg = fakeTg();
    const out = await executeTool(
      "GENERATE_IMAGE",
      { prompt: "x" },
      {
        agentKey: TEST_AGENT,
        chatId: TEST_CHAT,
        telegram: tg as never,
      },
    );
    const parsed = JSON.parse(out) as { ok: boolean; messageId?: number };
    expect(parsed.ok).toBe(true);
    expect(tg.sendPhoto).toHaveBeenCalledTimes(1);
  });
});

describe("evaluateGate: GENERATE_IMAGE в semi_auto → allow", () => {
  test("auto-allowed в semi_auto (не в SEMI_AUTO_RISKY)", () => {
    savedGlobal = saveAutonomy();
    setAutonomy("global", "*", "semi_auto");
    const g = evaluateGate({
      agentKey: TEST_AGENT,
      actionType: "GENERATE_IMAGE",
    });
    expect(g.decision).toBe("allow");
  });
});
