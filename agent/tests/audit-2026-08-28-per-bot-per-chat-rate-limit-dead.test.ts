/**
 * Аудит 2026-08-28: анти-флуд «на бота в чате» не мог сработать никогда.
 *
 * `checkPerBotPerChatRateLimit` брала `perChatRule()` — ту же самую, что и
 * общечатовая проверка, с комментарием «Reuse the same rule logic as per-chat».
 * Но бакет `bot:<bot>:chat:<chat>:<action>` — подмножество бакета
 * `chat:<chat>:<action>`: в чатовый пишут все двенадцать ролей, в ботовый —
 * одна. При равном max счётчик чата всегда >= счётчика бота, а проверяется
 * он первым (`checkAndConsumeChatRateLimits`, `gateOrDispatch`). То есть
 * ветка отказа «per bot per chat» недостижима, а ключей мы держали в двенадцать
 * раз больше.
 *
 * Собственный потолок у неё быть обязан: Telegram считает флуд именно по паре
 * (бот, чат) — около 20 сообщений в минуту в группу. Общечатовые 30 этого не
 * ловят: один зациклившийся бот выбирает 20 своих, ловит FLOOD_WAIT и только
 * потом упирается в чатовый лимит.
 *
 * Тесты в `t240-per-bot-per-chat-rate-limit.test.ts` дефект не видели, потому
 * что дёргают ботовую проверку в одиночку — без чатовой, которая в бою идёт
 * первой.
 */
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import {
  checkAndConsumeChatRateLimits,
  checkPerBotPerChatRateLimit,
  _resetRateLimits,
} from "../lib/rate-limits.ts";

const CHAT_KEY = "RATE_LIMIT_PER_CHAT_PER_MIN";
const BOT_KEY = "RATE_LIMIT_PER_BOT_PER_CHAT_PER_MIN";
const savedChat = process.env[CHAT_KEY];
const savedBot = process.env[BOT_KEY];

function setEnv(key: string, v: string | undefined): void {
  if (v === undefined) delete process.env[key];
  else process.env[key] = v;
}

beforeEach(() => {
  setEnv(CHAT_KEY, undefined);
  setEnv(BOT_KEY, undefined);
  _resetRateLimits();
});

afterAll(() => {
  // Без восстановления env течёт в соседние файлы: bun гоняет каталог одним
  // процессом (CLAUDE.md §3.8 п.7).
  setEnv(CHAT_KEY, savedChat);
  setEnv(BOT_KEY, savedBot);
  _resetRateLimits();
});

const ACTION = "SEND_MESSAGE";
const CHAT = -1_001_777_401;

/** Реальный порядок проверок: сперва чат, потом бот, потом коммит обоих. */
function drain(botId: number, chatId: number, tries: number) {
  let ok = 0;
  let reason = "";
  for (let i = 0; i < tries; i++) {
    const r = checkAndConsumeChatRateLimits(botId, chatId, ACTION);
    if (r.ok) ok++;
    else if (!reason) reason = r.reason ?? "";
  }
  return { ok, reason };
}

describe("предпосылки", () => {
  test("ботовая проверка в одиночку срабатывает — потому дефект и не видели", () => {
    setEnv(BOT_KEY, "2");
    _resetRateLimits();
    // Только ботовый бакет, без чатового: ровно так её тестировали в T-240.
    for (let i = 0; i < 2; i++) {
      expect(checkPerBotPerChatRateLimit(7, CHAT, ACTION).ok).toBe(true);
      checkAndConsumeChatRateLimits(7, CHAT, ACTION);
    }
    expect(checkPerBotPerChatRateLimit(7, CHAT, ACTION).ok).toBe(false);
  });
});

describe("у бота в чате свой потолок", () => {
  test("один бот упирается в свой лимит раньше общечатового", () => {
    setEnv(CHAT_KEY, "30");
    setEnv(BOT_KEY, "3");
    _resetRateLimits();
    const r = drain(101, CHAT, 10);
    expect(r.ok).toBe(3);
    expect(r.reason).toContain("per bot per chat");
  });

  test("боты в одном чате не съедают лимиты друг друга", () => {
    setEnv(CHAT_KEY, "30");
    setEnv(BOT_KEY, "3");
    _resetRateLimits();
    expect(drain(101, CHAT, 10).ok).toBe(3);
    expect(drain(102, CHAT, 10).ok).toBe(3);
    expect(drain(103, CHAT, 10).ok).toBe(3);
  });

  test("общечатовый потолок по-прежнему главнее: он ловит сумму по ботам", () => {
    setEnv(CHAT_KEY, "7");
    setEnv(BOT_KEY, "3");
    _resetRateLimits();
    expect(drain(101, CHAT, 10).ok).toBe(3);
    expect(drain(102, CHAT, 10).ok).toBe(3);
    // Третьему боту чат оставил один слот, хотя свои три у него не тронуты.
    const r = drain(103, CHAT, 10);
    expect(r.ok).toBe(1);
    expect(r.reason).toContain("per chat");
    expect(r.reason).not.toContain("per bot per chat");
  });

  test("дефолт — 20 в минуту, как считает флуд сам Telegram", () => {
    setEnv(CHAT_KEY, "100");
    _resetRateLimits();
    const r = drain(101, CHAT, 25);
    expect(r.ok).toBe(20);
    expect(r.reason).toContain("per bot per chat");
  });

  test("боту нельзя больше, чем всему чату: потолок зажат чатовым", () => {
    setEnv(CHAT_KEY, "4");
    setEnv(BOT_KEY, "50");
    _resetRateLimits();
    const r = drain(101, CHAT, 10);
    expect(r.ok).toBe(4);
    expect(r.reason).toContain("per chat");
  });

  test("мусор и ноль в env — дефолт, а не отключение лимита", () => {
    setEnv(CHAT_KEY, "100");
    for (const bad of ["0", "-3", "abc", ""]) {
      setEnv(BOT_KEY, bad);
      _resetRateLimits();
      expect(drain(101, CHAT, 25).ok).toBe(20);
    }
  });

  test("разные чаты одного бота считаются раздельно", () => {
    setEnv(CHAT_KEY, "30");
    setEnv(BOT_KEY, "3");
    _resetRateLimits();
    expect(drain(101, CHAT, 10).ok).toBe(3);
    expect(drain(101, CHAT - 1, 10).ok).toBe(3);
  });
});
