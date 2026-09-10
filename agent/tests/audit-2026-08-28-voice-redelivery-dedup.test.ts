/**
 * Аудит 2026-08-28: голосовой путь остался без дедупа по ложной причине.
 *
 * В voice-handler.ts стояло: «shouldProcessTrigger здесь СОЗНАТЕЛЬНО нет: он
 * потребляет message_id, а тот же апдейт видит и bot.on("message"); две точки
 * на один id — гонка». Гонки нет. Голосовой хендлер регистрируется РАНЬШЕ
 * текстового (orchestrator-team.ts) и терминален — `next` он не берёт и не
 * зовёт, а telegraf собирает хендлеры в koa-цепочку. Замер на настоящем
 * Telegraf — в блоке «предпосылки» ниже.
 *
 * Зато существовал повтор. Telegram передоставляет неподтверждённый апдейт
 * после рестарта; на текстовом пути его гасит shouldProcessTrigger, на
 * голосовом не гасило ничто. Цена повтора здесь выше: второе скачивание файла
 * с CDN, вторая ПЛАТНАЯ расшифровка у Whisper, вторая строка `[Voice]` в
 * истории и второе «🎤 Распознано» в чат.
 *
 * Наблюдаемая граница та же, что у соседних гейтов (tests/voice-gates.ts):
 * `sendChatAction("typing")` и фактические походы в сеть.
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
import { readFileSync } from "node:fs";
import { Telegraf } from "telegraf";
import { registerVoiceHandler } from "../orchestrator/voice-handler.ts";
import { CHARACTERS } from "../characters/index.ts";
import type { RunningBot } from "../lib/types.ts";
import { db } from "../lib/db.ts";
import { _resetRateLimits } from "../lib/rate-limits.ts";
import { cleanupChat } from "./_helpers.ts";

const TEST_CHAT = 999_314_028;
const ORCH = CHARACTERS.find((c) => c.key === "orchestrator")!;

/**
 * P2bis (nightly, 2026-09-10): `cleanupChat` историю НЕ чистит, а у `messages`
 * есть частичный UNIQUE по (chat_id, tg_message_id) — idx_messages_dedup,
 * миграция 030. Под `--rerun-each=5` второй повтор писал `[Voice]` тем же
 * message_id, что и первый, попадал в ON CONFLICT, а его `DO UPDATE` стоит под
 * `WHERE messages.text = ''` и потому не срабатывал: строк ноль, дельта ноль,
 * `expect(1)` красный. Дедуп при этом работал верно — в логе видно, что первый
 * вызов расшифрован, второй пропущен.
 *
 * Чат принадлежит только этому файлу, так что чистка ничего чужого не заденет.
 */
function cleanupVoiceHistory(): void {
  db.prepare(`DELETE FROM messages WHERE chat_id = ?`).run(String(TEST_CHAT));
}
const ALLOWED = [String(TEST_CHAT)];
const USER = 778;

const running: RunningBot = {
  def: ORCH,
  bot: {} as Telegraf,
  username: "lead_bot",
  id: 4243,
};

const typing = mock(async () => {});
const replies: string[] = [];
let fetched: string[] = [];

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

function makeCtx(messageId: number, userId = USER) {
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

beforeEach(() => {
  typing.mockClear();
  replies.length = 0;
  fetched = [];
  _resetRateLimits();
  savedToken = process.env[ORCH.envToken];
  savedOpenai = process.env.OPENAI_API_KEY;
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
  cleanupChat(TEST_CHAT);
  cleanupVoiceHistory();
});

afterEach(() => {
  // CLAUDE.md §3.8 п.7: env восстанавливаем всегда.
  if (savedToken === undefined) delete process.env[ORCH.envToken];
  else process.env[ORCH.envToken] = savedToken;
  if (savedOpenai === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedOpenai;
  _resetRateLimits();
  cleanupChat(TEST_CHAT);
  cleanupVoiceHistory();
});

afterAll(() => {
  mockFetch.mockRestore();
});

describe("предпосылки: голосовой апдейт видит ровно один хендлер", () => {
  function pair(): { bot: Telegraf; seen: string[] } {
    const bot = new Telegraf("111:test-token-not-used");
    // botInfo руками: иначе handleUpdate пойдёт за getMe в сеть.
    (bot as unknown as { botInfo: unknown }).botInfo = {
      id: 1,
      is_bot: true,
      username: "b",
      first_name: "b",
      can_join_groups: true,
      can_read_all_group_messages: true,
      supports_inline_queries: false,
    };
    const seen: string[] = [];
    // Порядок регистрации — как в orchestrator-team.ts: голос, затем текст.
    bot.on("voice" as never, async () => {
      seen.push("voice");
    });
    bot.on("message" as never, async () => {
      seen.push("message");
    });
    return { bot, seen };
  }

  const base = { date: 1, chat: { id: 1, type: "group" }, from: { id: 2 } };

  test("голосовой апдейт до bot.on(\"message\") не доходит", async () => {
    const { bot, seen } = pair();
    await bot.handleUpdate({
      update_id: 1,
      message: { ...base, message_id: 5, voice: { file_id: "f", duration: 1 } },
    } as never);
    expect(seen).toEqual(["voice"]);
  });

  test("текстовый апдейт по-прежнему уходит в message", async () => {
    const { bot, seen } = pair();
    await bot.handleUpdate({
      update_id: 2,
      message: { ...base, message_id: 6, text: "hi" },
    } as never);
    expect(seen).toEqual(["message"]);
  });
});

describe("передоставленный апдейт обрабатывается один раз", () => {
  test("повтор того же message_id не качает файл и не платит Whisper", async () => {
    const h = handlerFor();
    await h(makeCtx(9001));
    expect(replies).toHaveLength(1);
    expect(fetched.some((u) => u.includes("api.telegram.org"))).toBe(true);

    typing.mockClear();
    replies.length = 0;
    fetched = [];
    await h(makeCtx(9001));
    expect(typing).not.toHaveBeenCalled();
    expect(fetched).toEqual([]);
    expect(replies).toEqual([]);
  });

  test("повтор не пишет второй [Voice] в историю", async () => {
    // Счёт дельтой: bun гоняет каталог одним процессом, а cleanupChat строки
    // из `messages` не удаляет — абсолютное число здесь ничего не значит.
    const voiceRows = () =>
      (
        db
          .prepare(`SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND text LIKE '[Voice]%'`)
          .get(String(TEST_CHAT)) as { n: number }
      ).n;
    const before = voiceRows();
    const h = handlerFor();
    await h(makeCtx(9002));
    await h(makeCtx(9002));
    expect(voiceRows() - before).toBe(1);
  });

  test("другой message_id — обычная работа", async () => {
    const h = handlerFor();
    await h(makeCtx(9003));
    await h(makeCtx(9004));
    expect(replies).toHaveLength(2);
  });

  test("повтор не тратит чужой счётчик: дедуп стоит до лимита", async () => {
    const saved = process.env.INGEST_RATE_MAX_PER_WINDOW;
    process.env.INGEST_RATE_MAX_PER_WINDOW = "2";
    try {
      _resetRateLimits();
      const h = handlerFor();
      await h(makeCtx(9005));
      for (let i = 0; i < 5; i++) await h(makeCtx(9005)); // повторы
      replies.length = 0;
      await h(makeCtx(9006)); // второй настоящий — лимит ещё не выбран
      expect(replies).toHaveLength(1);
    } finally {
      if (saved === undefined) delete process.env.INGEST_RATE_MAX_PER_WINDOW;
      else process.env.INGEST_RATE_MAX_PER_WINDOW = saved;
      _resetRateLimits();
    }
  });
});

describe("отправитель в логе", () => {
  test("id и имя больше не смешиваются в один редактор", () => {
    const src = readFileSync(new URL("../orchestrator/voice-handler.ts", import.meta.url), "utf-8");
    const code = src.split("\n").filter((l) => {
      const t = l.trimStart();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    });
    expect(code.filter((l) => l.includes("ctx.from?.id ?? ctx.from?.username"))).toEqual([]);
    expect(code.some((l) => l.includes("redactSender(ctx.from?.id, ctx.from?.username)"))).toBe(
      true,
    );
  });
});
