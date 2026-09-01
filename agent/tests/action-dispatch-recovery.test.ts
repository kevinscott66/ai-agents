/**
 * Fault-injection coverage for the non-transactional dispatch boundary.
 *
 * A Telegram side effect cannot be rolled back when its audit insert fails.
 * The dispatcher must make that state explicit and persist a recovery status
 * when possible.
 *
 * Аудит 2026-08-27: слот рейт-лимита в этой ветке НЕ возвращается. Раньше
 * возвращался «во всех случаях провала», но провал аудита — единственный
 * случай, где сам дispatcher записывает `side_effect_succeeded: true`:
 * сообщение уже в чате. Рефанд означал бы, что ход, положивший сообщение в
 * чат, не стоил ничего, и сломанная БД аудита открывала бы неограниченную
 * неучтённую отправку. Это ровно то рассуждение, что и у `sideEffect` в
 * gateOrDispatch (аудит 2026-08-21), просто оно не доходило сюда.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __setDispatchAuditFaultForTests,
  formatGateResult,
  gateOrDispatch,
} from "../lib/action-dispatch.ts";
import { db } from "../lib/db.ts";
import { _resetRateLimits } from "../lib/rate-limits.ts";
import { setAutonomy } from "../lib/permissions.ts";
import { cleanupChat, restoreAutonomy, saveAutonomy } from "./_helpers.ts";

const CHAT = -1_000_990;
const AGENT = "orchestrator";
const RATE_LIMIT_ENV = "RATE_LIMIT_PER_CHAT_PER_MIN";

let previousAutonomy = saveAutonomy();
let previousChatLimit: string | undefined;

function fakeTelegram(sent: string[]) {
  return {
    sendMessage: async (_chatId: number, text: string) => {
      sent.push(text);
      return { message_id: sent.length, date: Math.floor(Date.now() / 1000) };
    },
  } as never;
}

function actionRows() {
  return db
    .prepare(
      `SELECT status, error, result FROM agent_actions
       WHERE chat_id = ? AND action_type = 'SEND_MESSAGE'
       ORDER BY created_at`,
    )
    .all(CHAT) as { status: string; error: string | null; result: string | null }[];
}

beforeEach(() => {
  previousAutonomy = saveAutonomy();
  previousChatLimit = process.env[RATE_LIMIT_ENV];
  process.env[RATE_LIMIT_ENV] = "1";
  setAutonomy("global", "*", "auto");
  _resetRateLimits();
  __setDispatchAuditFaultForTests(null);
  cleanupChat(CHAT, AGENT);
});

afterEach(() => {
  __setDispatchAuditFaultForTests(null);
  _resetRateLimits();
  cleanupChat(CHAT, AGENT);
  restoreAutonomy(previousAutonomy);
  if (previousChatLimit === undefined) delete process.env[RATE_LIMIT_ENV];
  else process.env[RATE_LIMIT_ENV] = previousChatLimit;
});

describe("dispatch/audit failure recovery", () => {
  test("side effect success becomes explicit error, recovery status is audited, and the reservation is NOT refunded", async () => {
    const sent: string[] = [];
    __setDispatchAuditFaultForTests((phase) => {
      if (phase === "primary") {
        __setDispatchAuditFaultForTests(null);
        throw new Error("audit insert unavailable");
      }
    });

    const first = await gateOrDispatch(
      "SEND_MESSAGE",
      { text: "first" },
      { agentKey: AGENT, chatId: CHAT, telegram: fakeTelegram(sent) },
    );

    expect(first.kind).toBe("error");
    if (first.kind !== "error") return;
    expect(first.error).toContain("external side effect succeeded");
    expect(first.error).toContain("recovery audit status recorded as error");
    expect(first.actionId).toBeString();
    expect(first.retryable).toBe(false);
    expect(JSON.parse(formatGateResult("SEND_MESSAGE", first))).toMatchObject({
      ok: false,
      retryable: false,
    });
    expect(sent).toEqual(["first"]);

    const rows = actionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("error");
    expect(rows[0]!.error).toContain("audit insert unavailable");
    expect(JSON.parse(rows[0]!.result!)).toEqual({ side_effect_succeeded: true });

    // Чат-бакет max=1, и слот остался потраченным: сообщение "first" реально
    // ушло в чат. Второй ход упирается в лимит и ничего не отправляет.
    const second = await gateOrDispatch(
      "SEND_MESSAGE",
      { text: "second" },
      { agentKey: AGENT, chatId: CHAT, telegram: fakeTelegram(sent) },
    );
    expect(second.kind).not.toBe("ok");
    expect(sent).toEqual(["first"]);
  });

  test("when recovery audit also fails, dispatch still returns explicitly and keeps the reservation spent", async () => {
    __setDispatchAuditFaultForTests(() => {
      throw new Error("audit storage unavailable");
    });
    const sent: string[] = [];

    const first = await gateOrDispatch(
      "SEND_MESSAGE",
      { text: "unrecoverable audit" },
      { agentKey: AGENT, chatId: CHAT, telegram: fakeTelegram(sent) },
    );

    expect(first.kind).toBe("error");
    if (first.kind !== "error") return;
    expect(first.error).toContain("external side effect succeeded");
    expect(first.error).toContain("recovery audit also failed");
    expect(first.actionId).toMatch(/^audit-unavailable:/);
    expect(first.retryable).toBe(false);
    expect(sent).toEqual(["unrecoverable audit"]);
    expect(actionRows()).toHaveLength(0);

    __setDispatchAuditFaultForTests(null);
    const second = await gateOrDispatch(
      "SEND_MESSAGE",
      { text: "after refund" },
      { agentKey: AGENT, chatId: CHAT, telegram: fakeTelegram(sent) },
    );
    expect(second.kind).not.toBe("ok");
    expect(sent).toEqual(["unrecoverable audit"]);
  });
});
