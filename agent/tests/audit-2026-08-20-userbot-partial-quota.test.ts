/**
 * Аудит 2026-08-20: ведро юзербота могло кончиться НА СЕРЕДИНЕ длинного ответа.
 *
 * Гвард тратит слот на каждую отправку, а ответ длиннее лимита Telegram уходит
 * N сообщениями. Проверка перед первой частью говорила «можно», части 1..k
 * уходили, а на k+1 ведро кончалось: в чате оставалось оборванное сообщение ОТ
 * ЛИЦА ВЛАДЕЛЬЦА. Дописать его нельзя — повтор дублирует уже доставленное
 * (ровно за этим и существует PartialSendError).
 *
 * Правильное поведение — отказаться ЦЕЛИКОМ до первой отправки: половина
 * сообщения в чате владельца хуже, чем честный отказ, который агент увидит и
 * повторит позже.
 */
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { dispatchAction, type DispatchResult } from "../lib/action-dispatch.ts";
import { _resetRateLimits, userbotFloodCapacity } from "../lib/rate-limits.ts";
import { splitForTelegram } from "../lib/telegram-chunking.ts";
import { cleanupChat, saveAutonomy, restoreAutonomy } from "./_helpers.ts";
import { setAutonomy } from "../lib/permissions.ts";

const TEST_CHAT = -1_000_820;
const prev = saveAutonomy();

const failed = (r: DispatchResult): Extract<DispatchResult, { ok: false }> =>
  r as Extract<DispatchResult, { ok: false }>;

/** Текст, гарантированно разбиваемый на несколько сообщений. */
const LONG = Array.from({ length: 40 }, (_, i) => `Строка ${i} ${"я".repeat(200)}`).join("\n\n");

function fakeUb() {
  const calls: string[] = [];
  return {
    calls,
    ub: {
      isNoop: false,
      async sendMessage(_c: number, t: string) {
        calls.push(t.slice(0, 8));
        return { message_id: calls.length };
      },
    } as never,
  };
}

const ctx = (ub: unknown) =>
  ({ agentKey: "orchestrator", chatId: TEST_CHAT, userbot: ub, telegram: undefined }) as never;

describe("userbotFloodCapacity: ёмкость читается, слот не тратится", () => {
  beforeEach(() => _resetRateLimits());

  test("на пустом ведре свободен весь лимит", () => {
    const c = userbotFloodCapacity("orchestrator", TEST_CHAT);
    expect(c.free).toBe(c.max);
    expect(c.retryInMs).toBe(0);
    // Сам вопрос не занимает слот: второй вызов видит то же самое.
    expect(userbotFloodCapacity("orchestrator", TEST_CHAT).free).toBe(c.max);
  });

  test("без контекста — fail-open, как и у проверки лимита", () => {
    expect(userbotFloodCapacity(undefined, TEST_CHAT).free).toBe(Number.POSITIVE_INFINITY);
    expect(userbotFloodCapacity("orchestrator", undefined).free).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("длинный ответ юзербота не рвётся на середине", () => {
  beforeEach(() => {
    _resetRateLimits();
    cleanupChat(TEST_CHAT, "orchestrator");
    setAutonomy("chat", String(TEST_CHAT), "auto");
  });
  afterAll(() => {
    cleanupChat(TEST_CHAT, "orchestrator");
    restoreAutonomy(prev);
  });

  test("не хватает ёмкости на все части — не отправлено ничего", async () => {
    const parts = splitForTelegram(LONG).length;
    expect(parts).toBeGreaterThan(1);

    const { ub, calls } = fakeUb();
    const max = userbotFloodCapacity("orchestrator", TEST_CHAT).max;
    // Выбираем ведро так, чтобы свободных слотов осталось меньше, чем частей.
    const shortSends = max - parts + 1;
    for (let i = 0; i < shortSends; i++) {
      const r = await dispatchAction(
        "SEND_MESSAGE",
        { text: `msg ${i}`, via_userbot: true } as never,
        ctx(ub),
      );
      expect(r.ok).toBe(true);
    }
    expect(calls.length).toBe(shortSends);

    const long = await dispatchAction(
      "SEND_MESSAGE",
      { text: LONG, via_userbot: true } as never,
      ctx(ub),
    );
    expect(long.ok).toBe(false);
    const err = failed(long).error;
    expect(err).toContain("rate limit");
    expect(err).toContain(String(parts));
    // Главное: до Telegram не ушло НИ ОДНОЙ части. Раньше уходили первые
    // (parts - 1), и в чате владельца висел обрубок.
    expect(err).toContain("Не отправлено ничего");
    expect(calls.length).toBe(shortSends);
  });

  test("ёмкости хватает — уходят все части", async () => {
    const parts = splitForTelegram(LONG).length;
    const { ub, calls } = fakeUb();
    const long = await dispatchAction(
      "SEND_MESSAGE",
      { text: LONG, via_userbot: true } as never,
      ctx(ub),
    );
    expect(long.ok).toBe(true);
    expect(calls.length).toBe(parts);
    // И ведро потрачено ровно на число частей, а не на одну «отправку».
    const c = userbotFloodCapacity("orchestrator", TEST_CHAT);
    expect(c.max - c.free).toBe(parts);
  });
});
