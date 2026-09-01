/**
 * Аудит 2026-08-21: частичная доставка возвращала слот rate-limit, хотя
 * сообщения уже висят в чате.
 *
 * `sendChunked` бросает `PartialSendError` ПОСЛЕ того, как части 1..k
 * доставлены (у юзербота на каждую часть свой FLOOD_WAIT-гвард, так что повод
 * не экзотический). `partialSendFailure` честно превращает это в
 * `{ ok:false }` — повторять вслепую нельзя, дубли. Но `gateOrDispatch` на
 * любой `!res.ok` безусловно зовёт `refundRateLimit` + `refundChatRateLimits`,
 * а SEND_MESSAGE в `NO_REFUND_ACTIONS` не входит.
 *
 * Итог: каждый такой ход кладёт в чат k сообщений и НЕ тратит ни одного слота.
 * Потолок «N сообщений в минуту в этот чат» в этом сценарии не считает вообще
 * ничего — ровно в том режиме (длинный ответ + флуд-гвард), где он нужен.
 *
 * Рассуждение уже записано в самом `NO_REFUND_ACTIONS`: GENERATE_IMAGE не
 * рефандится, потому что «побочный эффект случился ВНУТРИ dispatch'а». Здесь
 * дословно то же самое, просто побочный эффект — сообщения, а не деньги.
 * Поэтому чиним не списком типов действий (полный провал SEND_MESSAGE обязан
 * рефандиться и дальше), а признаком «эффект уже состоялся».
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { gateOrDispatch } from "../lib/action-dispatch.ts";
import { _resetRateLimits } from "../lib/rate-limits.ts";
import { setAutonomy } from "../lib/permissions.ts";
import { cleanupChat, saveAutonomy, restoreAutonomy } from "./_helpers.ts";

const CHAT = -1_000_822;
const AGENT = "smm";
const ENV_KEY = "RATE_LIMIT_PER_CHAT_PER_MIN";
const PER_CHAT_MAX = 3;

/** Гарантированно рвётся минимум на две части (лимит Telegram — 4096). */
const LONG_TEXT = "я".repeat(9000);

let savedGlobal = saveAutonomy();
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  process.env[ENV_KEY] = String(PER_CHAT_MAX);
  _resetRateLimits();
  cleanupChat(CHAT, AGENT);
  savedGlobal = saveAutonomy();
  setAutonomy("global", "*", "auto");
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  restoreAutonomy(savedGlobal);
  _resetRateLimits();
  cleanupChat(CHAT, AGENT);
});

/**
 * Телеграм, у которого первая часть уходит, а вторая падает: ровно вход в
 * `PartialSendError` (`i > 0` в sendChunked).
 */
function tgPartial() {
  let calls = 0;
  const sendMessage = mock(async () => {
    calls += 1;
    if (calls % 2 === 0) throw new Error("403: bot was blocked by the user");
    return { message_id: calls };
  });
  return { sendMessage, delivered: () => Math.ceil(calls / 2) };
}

/** Телеграм, у которого не уходит НИЧЕГО: обычный полный провал. */
function tgDead() {
  const sendMessage = mock(async () => {
    throw new Error("403: bot was blocked by the user");
  });
  return { sendMessage };
}

async function send(tg: unknown, text: string) {
  return gateOrDispatch(
    "SEND_MESSAGE",
    { text } as never,
    { agentKey: AGENT, chatId: CHAT, telegram: tg as never } as never,
  );
}

describe("частичная доставка тратит слот rate-limit", () => {
  test("после PER_CHAT_MAX частичных доставок чат-лимит закрывается", async () => {
    const tg = tgPartial();
    for (let i = 0; i < PER_CHAT_MAX; i++) {
      const r = await send(tg, LONG_TEXT);
      expect(r.kind).toBe("error");
      expect(String((r as { error?: string }).error)).toMatch(/частичная доставка/);
    }
    // Часть каждого сообщения уже в чате — значит слоты потрачены.
    expect(tg.delivered()).toBe(PER_CHAT_MAX);

    const overflow = await send(tg, LONG_TEXT);
    expect(overflow.kind).toBe("rate_limited");
  });

  test("полный провал (не ушло ничего) слот по-прежнему возвращает", async () => {
    const tg = tgDead();
    for (let i = 0; i < PER_CHAT_MAX + 2; i++) {
      const r = await send(tg, "коротко");
      // Ни разу не rate_limited: в чат ничего не попало, платить не за что.
      expect(r.kind).toBe("error");
    }
  });

  test("успешные отправки тратят слот как и раньше (контроль)", async () => {
    const ok = { sendMessage: mock(async () => ({ message_id: 1 })) };
    for (let i = 0; i < PER_CHAT_MAX; i++) {
      expect((await send(ok, "коротко")).kind).toBe("ok");
    }
    expect((await send(ok, "коротко")).kind).toBe("rate_limited");
  });
});
