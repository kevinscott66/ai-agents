/**
 * Аудит 2026-09-11: провал записи аудита стирал признак «наружу уже ушло».
 *
 * Зеркальная ветка на успешном пути (`res.ok` + падение `closeDispatchAudit`)
 * возвращает `sideEffect: true, retryable: false` — с объяснением аудита
 * 2026-08-27: без этого `gateOrDispatch` рефандит слот рейт-лимита за ход,
 * который уже написал в Telegram, и открывает дорогу дубликату. Ветка
 * `!res.ok` тех же полей не ставила вовсе, хотя случай туда доезжает
 * настоящий: частичная доставка (`sendChunked` падает после k из N частей)
 * приходит как `!ok` с `sideEffect: true` — ровно то, что пришпилено тестами
 * audit-2026-08-27-publish-path и audit-2026-08-28-approved-partial-delivery.
 *
 * Наложение двух отказов — не выдумка: `closeDispatchAudit` пишет в ту же
 * SQLite, и SQLITE_BUSY, кончившийся диск или архивация строки на лету дают
 * ровно это. Итог до правки: k частей лежат в чате, слот возвращён, модели
 * сказано «ошибка» без `retryable: false`. Под залипшей БД это повторяется
 * каждый ход — чат набивается кусками, а per-chat лимит не срабатывает,
 * потому что его каждый раз возвращают.
 *
 * Заодно текст: `auditFailureMessage(…, false)` печатал «external side effect
 * did not complete» и в том случае, когда часть сообщения уже ушла.
 */
import { afterEach, beforeEach, describe, expect, test, mock } from "bun:test";
import {
  __setDispatchAuditFaultForTests,
  formatGateResult,
  gateOrDispatch,
} from "../lib/action-dispatch.ts";
import { _resetRateLimits } from "../lib/rate-limits.ts";
import { setAutonomy } from "../lib/permissions.ts";
import { cleanupChat, restoreAutonomy, saveAutonomy } from "./_helpers.ts";

const CHAT = -1_000_911;
const AGENT = "orchestrator";
const RATE_LIMIT_ENV = "RATE_LIMIT_PER_CHAT_PER_MIN";
/** Гарантированно рвётся минимум на две части (лимит Telegram — 4096). */
const LONG_TEXT = "я".repeat(9000);

let previousAutonomy = saveAutonomy();
let previousChatLimit: string | undefined;

/** Телеграм, у которого первая часть уходит, а вторая падает. */
function tgPartial() {
  let calls = 0;
  const sendMessage = mock(async () => {
    calls += 1;
    if (calls % 2 === 0) throw new Error("403: bot was blocked by the user");
    return { message_id: calls };
  });
  return { tg: { sendMessage } as never, sent: () => calls };
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

describe("частичная доставка + провал аудита", () => {
  test("слот не возвращается, а модель получает retryable:false", async () => {
    __setDispatchAuditFaultForTests((phase) => {
      if (phase === "primary") {
        __setDispatchAuditFaultForTests(null);
        throw new Error("audit insert unavailable");
      }
    });
    const first = tgPartial();

    const res = await gateOrDispatch(
      "SEND_MESSAGE",
      { text: LONG_TEXT },
      { agentKey: AGENT, chatId: CHAT, telegram: first.tg },
    );

    expect(res.kind).toBe("error");
    if (res.kind !== "error") return;
    expect(res.retryable).toBe(false);
    expect(JSON.parse(formatGateResult("SEND_MESSAGE", res))).toMatchObject({
      ok: false,
      retryable: false,
    });
    // Часть текста уже в чате.
    expect(first.sent()).toBeGreaterThan(0);

    // Чат-бакет max=1 и слот остался потраченным: следующий ход не отправляет
    // ничего. До правки рефанд возвращал его, и куски копились.
    const second = tgPartial();
    const next = await gateOrDispatch(
      "SEND_MESSAGE",
      { text: "коротко" },
      { agentKey: AGENT, chatId: CHAT, telegram: second.tg },
    );
    expect(next.kind).not.toBe("ok");
    expect(second.sent()).toBe(0);
  });

  test("текст ошибки не называет частичную доставку несостоявшейся", async () => {
    __setDispatchAuditFaultForTests((phase) => {
      if (phase === "primary") {
        __setDispatchAuditFaultForTests(null);
        throw new Error("audit insert unavailable");
      }
    });

    const res = await gateOrDispatch(
      "SEND_MESSAGE",
      { text: LONG_TEXT },
      { agentKey: AGENT, chatId: CHAT, telegram: tgPartial().tg },
    );

    expect(res.kind).toBe("error");
    if (res.kind !== "error") return;
    expect(res.error).toContain("external side effect partially completed");
    expect(res.error).not.toContain("did not complete");
  });

  test("полный провал без побочного эффекта слот по-прежнему возвращает", async () => {
    // Контроль: правка не должна превратить обычную ошибку в «не повторяй».
    __setDispatchAuditFaultForTests((phase) => {
      if (phase === "primary") {
        __setDispatchAuditFaultForTests(null);
        throw new Error("audit insert unavailable");
      }
    });
    const dead = { sendMessage: mock(async () => { throw new Error("403: blocked"); }) };

    const res = await gateOrDispatch(
      "SEND_MESSAGE",
      { text: "коротко" },
      { agentKey: AGENT, chatId: CHAT, telegram: dead as never },
    );

    expect(res.kind).toBe("error");
    if (res.kind !== "error") return;
    expect(res.retryable).toBeUndefined();
    expect(res.error).toContain("external side effect did not complete");

    // Слот вернулся: в чат не попало ничего.
    const ok = { sendMessage: mock(async () => ({ message_id: 1 })) };
    const next = await gateOrDispatch(
      "SEND_MESSAGE",
      { text: "второй" },
      { agentKey: AGENT, chatId: CHAT, telegram: ok as never },
    );
    expect(next.kind).toBe("ok");
  });
});
