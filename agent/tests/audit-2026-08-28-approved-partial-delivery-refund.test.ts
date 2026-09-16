/**
 * Аудит 2026-08-28: путь одобрений возвращал слот rate-limit за частичную
 * доставку.
 *
 * `executeApproved` (lib/commands.ts) на любой `!res.ok` безусловно звал
 * `refundRateLimit` + `refundChatRateLimits` — с комментарием «Как в
 * gateOrDispatch». В самом `gateOrDispatch` (action-dispatch.ts) при этом
 * стоит `if (res.sideEffect) refundNeeded = false;`: провал, уже оставивший
 * след снаружи, не рефандится. Аудит 2026-08-21 закрыл эту дыру на прямом
 * пути агента и не заметил вторую копию логики за очередью одобрений.
 *
 * `sendChunked` бросает `PartialSendError` ПОСЛЕ доставки частей 1..k,
 * `partialSendFailure` (`dispatch/telegram.ts`) честно ставит
 * `sideEffect: true` — но здесь этот флаг никто не читал. Каждое такое
 * одобрение клало в чат k сообщений и не тратило ни одного слота.
 *
 * За очередью одобрений это ещё вероятнее, чем на прямом пути: через апрув
 * идёт то, что человек счёл достойным подтверждения — длинное, многочастное,
 * часто от лица владельца (свой FLOOD_WAIT-гвард на каждую часть).
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { db } from "../lib/db.ts";
import { createApproval, decideApproval } from "../lib/approvals.ts";
import { executeApproved } from "../lib/commands.ts";
import { _resetRateLimits, checkPerChatRateLimit } from "../lib/rate-limits.ts";
import { setAutonomy } from "../lib/permissions.ts";
import { cleanupChat, saveAutonomy, restoreAutonomy } from "./_helpers.ts";
import type { RunningBot } from "../lib/types.ts";

const CHAT = -1_000_828;
const AGENT = "smm";
const ENV_KEY = "RATE_LIMIT_PER_CHAT_PER_MIN";
const PER_CHAT_MAX = 3;

/** Гарантированно рвётся минимум на две части (лимит Telegram — 4096). */
const LONG_TEXT = "я".repeat(9000);

const FAKE_BOT = {
  def: { key: AGENT },
  username: "delabs_smm_bot",
  id: 77,
} as unknown as RunningBot;

let savedGlobal = saveAutonomy();
let savedEnv: string | undefined;
let undoPerm: (() => void) | null = null;

/** Право с requires_approval: иначе действие до очереди не доходит. */
function grantSendMessage(): () => void {
  const prev = db
    .prepare(
      `SELECT allowed, requires_approval FROM permissions
       WHERE agent_key = ? AND action_type = ?`,
    )
    .get(AGENT, "SEND_MESSAGE") as
    | { allowed: number; requires_approval: number }
    | undefined;
  db.prepare(
    `INSERT INTO permissions (agent_key, action_type, allowed, requires_approval)
     VALUES (?, 'SEND_MESSAGE', 1, 1)
     ON CONFLICT(agent_key, action_type) DO UPDATE SET allowed = 1, requires_approval = 1`,
  ).run(AGENT);
  return () => {
    if (prev) {
      db.prepare(
        `UPDATE permissions SET allowed = ?, requires_approval = ?
         WHERE agent_key = ? AND action_type = 'SEND_MESSAGE'`,
      ).run(prev.allowed, prev.requires_approval, AGENT);
    } else {
      db.prepare(
        `DELETE FROM permissions WHERE agent_key = ? AND action_type = 'SEND_MESSAGE'`,
      ).run(AGENT);
    }
  };
}

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  process.env[ENV_KEY] = String(PER_CHAT_MAX);
  _resetRateLimits();
  cleanupChat(CHAT, AGENT);
  savedGlobal = saveAutonomy();
  setAutonomy("global", "*", "auto");
  undoPerm = grantSendMessage();
});

afterEach(() => {
  undoPerm?.();
  undoPerm = null;
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  restoreAutonomy(savedGlobal);
  _resetRateLimits();
  cleanupChat(CHAT, AGENT);
});

/** Телеграм, у которого первая часть уходит, а вторая падает. */
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
  return { sendMessage: mock(async () => { throw new Error("403: blocked"); }) };
}

/** Одобренная человеком заявка на SEND_MESSAGE в этот чат. */
function approvedSend(text: string) {
  const actionId = `act-appr-${Math.random().toString(36).slice(2)}`;
  const a = createApproval({
    actionId,
    chatId: CHAT,
    requestedBy: AGENT,
    actionType: "SEND_MESSAGE" as never,
    payload: { text } as never,
  });
  return decideApproval(a.id, "approved", "owner");
}

async function execute(tg: unknown, text: string) {
  return executeApproved(approvedSend(text), {
    resolveAgent: (key) => (key === AGENT ? FAKE_BOT : undefined),
    resolveTg: () => tg as never,
  } as never);
}

const chatSlotsLeft = () => checkPerChatRateLimit(CHAT, "SEND_MESSAGE").ok;

describe("одобренная частичная доставка тратит слот", () => {
  test(`после ${PER_CHAT_MAX} частичных доставок чат-лимит закрывается`, async () => {
    const tg = tgPartial();
    for (let i = 0; i < PER_CHAT_MAX; i++) {
      await expect(execute(tg, LONG_TEXT)).rejects.toThrow(/частичная доставка|доставлены/);
    }
    // Части каждого сообщения уже висят в чате — значит слоты потрачены.
    expect(tg.delivered()).toBe(PER_CHAT_MAX);
    expect(chatSlotsLeft()).toBe(false);
  });

  test("полный провал (не ушло ничего) слот по-прежнему возвращает", async () => {
    const tg = tgDead();
    for (let i = 0; i < PER_CHAT_MAX + 2; i++) {
      await expect(execute(tg, "коротко")).rejects.toThrow();
    }
    // В чат не попало ничего — платить не за что.
    expect(chatSlotsLeft()).toBe(true);
  });

  test("успешная отправка тратит слот как и раньше (контроль)", async () => {
    const ok = { sendMessage: mock(async () => ({ message_id: 1 })) };
    for (let i = 0; i < PER_CHAT_MAX; i++) {
      await execute(ok, "коротко");
    }
    expect(chatSlotsLeft()).toBe(false);
  });

  test("рефанд в executeApproved закрыт признаком sideEffect", () => {
    // Страж от возврата к «безусловному рефанду на любой !ok»: комментарий
    // «Как в gateOrDispatch» уже один раз разошёлся с самим gateOrDispatch.
    const src = readFileSync(new URL("../lib/commands.ts", import.meta.url), "utf-8");
    expect(src).toContain("if (!res.sideEffect) {");
    const dispatchSrc = readFileSync(
      new URL("../lib/action-dispatch.ts", import.meta.url),
      "utf-8",
    );
    expect(dispatchSrc).toMatch(/if\s*\(res\.sideEffect\)\s*refundNeeded\s*=\s*false/);
  });
});
