/**
 * Аудит 2026-08-07: withUserbotFloodGuard (T-402) был написан и покрыт
 * тестами — и не импортировался НИГДЕ, кроме собственного теста. То есть
 * юзербот ходил в Telegram без pre-flight лимита и без бэкоффа: FLOOD_WAIT
 * прилетал сырой ошибкой, действие терялось, следующая попытка агента била в
 * тот же лимит. Для аккаунта владельца это дорога к временной блокировке.
 *
 * Здесь проверяется не сам гвард (это t402-userbot-flood.test.ts), а факт его
 * ПОДКЛЮЧЕНИЯ к боевым путям — чтобы он не стал мёртвым кодом снова.
 */
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { dispatchAction, type DispatchResult } from "../lib/action-dispatch.ts";
import { _resetRateLimits } from "../lib/rate-limits.ts";
import { cleanupChat, saveAutonomy, restoreAutonomy } from "./_helpers.ts";
import { setAutonomy } from "../lib/permissions.ts";

const TEST_CHAT = -1_000_808;
const prev = saveAutonomy();

/**
 * DispatchResult — объединение, размеченное по `ok`, и expect() тип не сужает.
 * Разворачиваем ветку провала явно, чтобы читать `error`.
 */
const failed = (r: DispatchResult): Extract<DispatchResult, { ok: false }> =>
  r as Extract<DispatchResult, { ok: false }>;

/** Юзербот, который считает вызовы и умеет падать с FLOOD_WAIT первые N раз. */
const fakeUb = (floodTimes = 0) => {
  const calls: string[] = [];
  let flood = floodTimes;
  const maybeFlood = () => {
    if (flood > 0) {
      flood--;
      const e = new Error("FLOOD_WAIT_1") as Error & { seconds?: number };
      e.seconds = 1;
      throw e;
    }
  };
  return {
    calls,
    ub: {
      isNoop: false,
      async sendMessage(_c: number, t: string) {
        calls.push(`send:${t.slice(0, 12)}`);
        maybeFlood();
        return { message_id: 1 };
      },
      async setReaction() {
        calls.push("react");
        maybeFlood();
      },
      async deleteMessage() {
        calls.push("delete");
        maybeFlood();
      },
    } as never,
  };
};

const ctx = (ub: unknown) =>
  ({ agentKey: "orchestrator", chatId: TEST_CHAT, userbot: ub, telegram: undefined }) as never;

describe("userbot flood guard подключён к боевым путям", () => {
  beforeEach(() => {
    _resetRateLimits();
    cleanupChat(TEST_CHAT, "orchestrator");
    setAutonomy("chat", String(TEST_CHAT), "auto");
  });
  afterAll(() => {
    cleanupChat(TEST_CHAT, "orchestrator");
    restoreAutonomy(prev);
  });

  test("SEND_MESSAGE via_userbot: превышение лимита останавливает отправку", async () => {
    const { ub, calls } = fakeUb();
    // Лимит по умолчанию 20 за 60s на (агент, чат).
    for (let i = 0; i < 20; i++) {
      const r = await dispatchAction(
        "SEND_MESSAGE",
        { text: `msg ${i}`, via_userbot: true } as never,
        ctx(ub),
      );
      expect(r.ok).toBe(true);
    }
    expect(calls.length).toBe(20);

    const over = await dispatchAction(
      "SEND_MESSAGE",
      { text: "21-е", via_userbot: true } as never,
      ctx(ub),
    );
    expect(over.ok).toBe(false);
    expect(failed(over).error).toContain("rate limit");
    // Ключевое: до Telegram запрос не дошёл.
    expect(calls.length).toBe(20);
  });

  test("SET_REACTION via_userbot тоже под лимитом (не только отправка)", async () => {
    const { ub, calls } = fakeUb();
    for (let i = 0; i < 20; i++) {
      await dispatchAction(
        "SET_REACTION",
        { messageId: i, emoji: "🔥", via_userbot: true } as never,
        ctx(ub),
      );
    }
    const over = await dispatchAction(
      "SET_REACTION",
      { messageId: 99, emoji: "🔥", via_userbot: true } as never,
      ctx(ub),
    );
    expect(over.ok).toBe(false);
    expect(failed(over).error).toContain("rate limit");
    expect(calls.length).toBe(20);
  });

  test("DELETE_MESSAGE via_userbot тоже под лимитом", async () => {
    const { ub, calls } = fakeUb();
    for (let i = 0; i < 20; i++) {
      await dispatchAction(
        "DELETE_MESSAGE",
        { messageId: i, via_userbot: true } as never,
        ctx(ub),
      );
    }
    const over = await dispatchAction(
      "DELETE_MESSAGE",
      { messageId: 99, via_userbot: true } as never,
      ctx(ub),
    );
    expect(over.ok).toBe(false);
    expect(failed(over).error).toContain("rate limit");
    expect(calls.length).toBe(20);
  });

  test("успешная отправка не тратит слот дважды", async () => {
    const { ub } = fakeUb();
    for (let i = 0; i < 5; i++) {
      const r = await dispatchAction(
        "SEND_MESSAGE",
        { text: `m${i}`, via_userbot: true } as never,
        ctx(ub),
      );
      expect(r.ok).toBe(true);
    }
    // 6-я всё ещё проходит — значит слоты не удваивались.
    const r = await dispatchAction(
      "SEND_MESSAGE",
      { text: "m6", via_userbot: true } as never,
      ctx(ub),
    );
    expect(r.ok).toBe(true);
  });
});
