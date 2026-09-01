/**
 * Аудит 2026-08-27: userbot-контур — остановка, allowlist и откат реестра
 * собственных отправок.
 *
 * Четыре независимых места, каждое из которых ломалось молча:
 *
 *  1. `stopAll()` зовут из `orchestrator/services.ts` БЕЗ await, параллельно с
 *     живым диспатчем. Пока он гасил сессии, соседний `getAgentHandle` спокойно
 *     поднимал новую — она переживала остановку процесса-владельца и её никто
 *     уже не останавливал.
 *  2. `defaultAllowedChatIds` документирован как «applied to all agents unless
 *     overridden», но класс это поле не читал: `registerAgent` с пустым
 *     allowlist поднимал сессию, которая не ингестит НИ ОДНОГО сообщения.
 *  3. `USERBOT_ALLOWED_CHATS_<KEY>=","` — то же самое через env: непустой CSV,
 *     пустой результат разбора.
 *  4. Реестр `userbot-self-sends` помечал отправку ДО сетевого вызова и не
 *     откатывал пометку при ошибке. Провалившаяся отправка оставляла запись,
 *     которая съедала следующее НАСТОЯЩЕЕ сообщение владельца с тем же текстом.
 *
 * Плюс два свойства, проверяемые по исходнику: приватные `startSession`,
 * `sendMessage` и `publishPost` в тестах либо подменяются целиком, либо требуют
 * живого gramjs, поэтому правило внутри них иначе непроверяемо.
 */
import { test, expect, describe } from "bun:test";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  UserbotRouter,
  effectiveAllowedChatIds,
  resolveCharacterUserbotConfig,
} from "../lib/userbot-router.ts";
import { markSelfSend, unmarkSelfSend, consumeSelfSend } from "../lib/userbot-self-sends.ts";
import { makeUserbotRecorder } from "../lib/userbot-ingest.ts";
import { requireTelegramApiCredentials } from "../lib/telegram-credentials.ts";
import { log } from "../lib/log.ts";

const DEFAULTS: Array<string | number> = [-1001, -1002];

function sessionFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "ubshut-"));
  const f = join(dir, "agent.session");
  writeFileSync(f, "stub");
  return f;
}

function fakeHandle(tag: string) {
  return {
    isNoop: false,
    tag,
    stops: 0,
    async stop() {
      (this as any).stops++;
    },
  } as any;
}

describe("userbot-router: остановка не оставляет осиротевшую сессию", () => {
  test("getAgentHandle после stopAll не поднимает сессию", async () => {
    const router = new UserbotRouter({ onMessage: () => {}, defaultAllowedChatIds: DEFAULTS });
    router.registerAgent("smm", { sessionFile: sessionFile(), allowedChatIds: [-100] });

    let starts = 0;
    (router as any).startSession = async (agentKey: string) => {
      starts++;
      const h = fakeHandle(agentKey);
      (router as any).sessions.set(agentKey, h);
      return h;
    };

    await router.stopAll();
    const handle = await router.getAgentHandle("smm");

    expect(handle).toBeNull();
    expect(starts).toBe(0);
    expect((router as any).sessions.size).toBe(0);
  });

  test("сессия, стартующая параллельно с stopAll, всё равно гасится", async () => {
    const router = new UserbotRouter({ onMessage: () => {}, defaultAllowedChatIds: DEFAULTS });
    router.registerAgent("smm", { sessionFile: sessionFile(), allowedChatIds: [-100] });

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const started: any[] = [];
    (router as any).startSession = async (agentKey: string) => {
      const h = fakeHandle(agentKey);
      started.push(h);
      await gate;
      (router as any).sessions.set(agentKey, h);
      return h;
    };

    const inFlight = router.getAgentHandle("smm");
    const stopping = router.stopAll();
    release();
    await inFlight;
    await stopping;

    expect(started).toHaveLength(1);
    expect(started[0].stops).toBe(1);
  });
});

describe("userbot-router: дефолтный allowlist", () => {
  test("пустой allowlist агента заменяется дефолтом роутера", () => {
    expect(effectiveAllowedChatIds({ sessionFile: "s", allowedChatIds: [] }, DEFAULTS)).toEqual(
      DEFAULTS,
    );
  });

  test("явный allowlist агента дефолт не трогает", () => {
    expect(
      effectiveAllowedChatIds({ sessionFile: "s", allowedChatIds: [-100777] }, DEFAULTS),
    ).toEqual([-100777]);
  });

  test("startSession подставляет дефолт через effectiveAllowedChatIds", () => {
    const src = readFileSync(new URL("../lib/userbot-router.ts", import.meta.url), "utf8");
    const body = src.slice(src.indexOf("private async startSession"));
    expect(body).toContain("effectiveAllowedChatIds(config, this.opts.defaultAllowedChatIds)");
  });

  test('USERBOT_ALLOWED_CHATS из одних запятых откатывается на дефолт', () => {
    const key = "auditub";
    const upper = key.toUpperCase();
    const prevSession = process.env[`USERBOT_SESSION_${upper}`];
    const prevChats = process.env[`USERBOT_ALLOWED_CHATS_${upper}`];
    try {
      process.env[`USERBOT_SESSION_${upper}`] = "/tmp/audit-ub.session";
      process.env[`USERBOT_ALLOWED_CHATS_${upper}`] = " , ";
      const empty = resolveCharacterUserbotConfig({ key } as any, DEFAULTS);
      expect(empty?.allowedChatIds).toEqual(DEFAULTS);

      process.env[`USERBOT_ALLOWED_CHATS_${upper}`] = "-100777, -100888";
      const parsed = resolveCharacterUserbotConfig({ key } as any, DEFAULTS);
      expect(parsed?.allowedChatIds).toEqual(["-100777", "-100888"]);
    } finally {
      if (prevSession === undefined) delete process.env[`USERBOT_SESSION_${upper}`];
      else process.env[`USERBOT_SESSION_${upper}`] = prevSession;
      if (prevChats === undefined) delete process.env[`USERBOT_ALLOWED_CHATS_${upper}`];
      else process.env[`USERBOT_ALLOWED_CHATS_${upper}`] = prevChats;
    }
  });
});

describe("userbot-self-sends: откат пометки", () => {
  test("unmarkSelfSend снимает ровно одну регистрацию", () => {
    const chat = -100424242;
    const text = "аудит: провалившаяся отправка";
    markSelfSend(chat, text);
    unmarkSelfSend(chat, text);
    expect(consumeSelfSend(chat, text)).toBe(false);
  });

  test("из двух пометок откат снимает одну, вторая остаётся", () => {
    const chat = -100424243;
    const text = "аудит: две отправки";
    markSelfSend(chat, text);
    markSelfSend(chat, text);
    unmarkSelfSend(chat, text);
    expect(consumeSelfSend(chat, text)).toBe(true);
    expect(consumeSelfSend(chat, text)).toBe(false);
  });

  test("откат несуществующей пометки безвреден", () => {
    expect(() => unmarkSelfSend(-100424244, "ничего не помечали")).not.toThrow();
    expect(() => unmarkSelfSend(-100424244, "")).not.toThrow();
  });

  test("sendMessage и publishPost откатывают пометку при ошибке", () => {
    const src = readFileSync(new URL("../lib/userbot.ts", import.meta.url), "utf8");
    // Ключ отката обязан совпадать с ключом регистрации. С 2026-08-28 это
    // `registered` (текст после парс-мода gramjs), а не сырой `text` — см.
    // audit-2026-08-28-userbot-markdown-self-echo.
    expect(src).toContain("markSelfSend(chatId, registered");
    expect(src).toContain("unmarkSelfSend(chatId, registered)");
    expect(src).toContain("unmarkSelfSend(channelId, plain)");
  });
});

describe("userbot-ingest: имя отправителя не выдаётся за id", () => {
  function captureInfo(fn: () => void): string[] {
    const lines: string[] = [];
    const original = log.info;
    (log as { info: typeof log.info }).info = (msg: string, meta?: unknown) => {
      lines.push(msg);
      return original.call(log, msg, meta as never);
    };
    try {
      fn();
    } finally {
      (log as { info: typeof log.info }).info = original;
    }
    return lines;
  }

  const base = {
    chatId: "-100999",
    messageId: 7,
    text: "аудит ingest",
    isService: false,
  };

  test("без fromUserId лог помечает источник как name, а не uid", () => {
    const record = makeUserbotRecorder({ ownBotIds: [], record: () => 1 as any });
    const lines = captureInfo(() =>
      record({ ...base, fromUserId: null, fromName: "Пётр Иванов" }),
    );
    const line = lines.find((l) => l.includes("id=7")) ?? "";
    expect(line).toContain("from=name:");
    expect(line).not.toContain("uid:");
  });

  test("с fromUserId лог по-прежнему пишет усечённый uid", () => {
    const record = makeUserbotRecorder({ ownBotIds: [], record: () => 1 as any });
    const lines = captureInfo(() =>
      record({ ...base, fromUserId: "123456789", fromName: "Пётр Иванов" }),
    );
    const line = lines.find((l) => l.includes("id=7")) ?? "";
    expect(line).toContain("from=uid:");
    expect(line).not.toContain("name:");
  });

  test("без обоих полей источник помечен как unknown", () => {
    const record = makeUserbotRecorder({ ownBotIds: [], record: () => 1 as any });
    const lines = captureInfo(() => record({ ...base, fromUserId: null, fromName: null }));
    const line = lines.find((l) => l.includes("id=7")) ?? "";
    expect(line).toContain("from=unknown");
  });
});

describe("telegram-credentials: apiId — целое", () => {
  function withEnv<T>(id: string | undefined, hash: string | undefined, fn: () => T): T {
    const prevId = process.env.TELEGRAM_API_ID;
    const prevHash = process.env.TELEGRAM_API_HASH;
    try {
      if (id === undefined) delete process.env.TELEGRAM_API_ID;
      else process.env.TELEGRAM_API_ID = id;
      if (hash === undefined) delete process.env.TELEGRAM_API_HASH;
      else process.env.TELEGRAM_API_HASH = hash;
      return fn();
    } finally {
      if (prevId === undefined) delete process.env.TELEGRAM_API_ID;
      else process.env.TELEGRAM_API_ID = prevId;
      if (prevHash === undefined) delete process.env.TELEGRAM_API_HASH;
      else process.env.TELEGRAM_API_HASH = prevHash;
    }
  }

  test("дробный apiId отвергается", () => {
    withEnv("123.5", "0123456789abcdef0123456789abcdef", () => {
      expect(() => requireTelegramApiCredentials()).toThrow(/positive integer/);
    });
  });

  test("целый apiId проходит", () => {
    withEnv("1234567", "0123456789abcdef0123456789abcdef", () => {
      expect(requireTelegramApiCredentials().apiId).toBe(1234567);
    });
  });
});
