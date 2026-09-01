/**
 * Аудит 2026-08-29: ретрай self-diag рефандил слот за ход, который уже
 * положил сообщения в чат.
 *
 * Ветка `if (!retryRes.ok)` возвращала все три ведра безусловно, а её
 * комментарий обещал «тот же размен, что в gateOrDispatch». Обещание было
 * неправдой: на прямом пути стоит `if (res.sideEffect) refundNeeded = false;`
 * (`action-dispatch.ts`, аудит 2026-08-21), и через очередь одобрений —
 * `if (!res.sideEffect)` (`commands.ts`, аудит 2026-08-28). Частичная
 * доставка (`sendChunked` бросает после k из N частей) приходит сюда обычным
 * `!ok` с `sideEffect: true`: k сообщений в чате есть, а счётчик флуда
 * откатывается назад.
 *
 * `NO_REFUND_ACTIONS` не спасает — там только GENERATE_IMAGE. Масштаб
 * ограничен `isDiagTaskThrottled` (5 диаг-задач в час), поэтому это не дыра
 * в защите, а неверный учёт ровно там, где ведро и должно тормозить: длинный
 * ответ, рвущийся под флуд-гвардом.
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { db } from "../lib/db.ts";
import { processDiagTask, type SelfDiagDeps } from "../lib/self-diag.ts";
import { createTask, getTask } from "../lib/tasks.ts";
import { setAutonomy } from "../lib/permissions.ts";
import {
  checkAndConsumeRateLimit,
  checkAndConsumeChatRateLimits,
  _resetRateLimits,
} from "../lib/rate-limits.ts";
import { cleanupChat, saveAutonomy, restoreAutonomy } from "./_helpers.ts";

const CHAT = -1_000_829;
const AUTHORITY = "orchestrator";
/** Заведомо больше лимита Telegram — уйдёт несколькими частями. */
const LONG = "строка ответа. ".repeat(700);

let saved = saveAutonomy();

beforeEach(() => {
  saved = saveAutonomy();
  _resetRateLimits();
});

afterEach(() => {
  restoreAutonomy(saved);
  _resetRateLimits();
  db.prepare(`DELETE FROM tasks WHERE chat_id = ?`).run(CHAT);
  cleanupChat(CHAT, "aieng");
  cleanupChat(CHAT, AUTHORITY);
});

function aiengProposes(text: string) {
  return (async () => ({
    id: "msg",
    type: "message",
    role: "assistant",
    model: "test",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
    content: [
      {
        type: "text",
        text: JSON.stringify({
          action: "SEND_MESSAGE",
          payload: { text },
          reason: "fix",
        }),
      },
    ],
  })) as any;
}

function diagTask(text: string) {
  setAutonomy("chat", String(CHAT), "auto");
  return createTask({
    title: "diag",
    chatId: CHAT,
    createdBy: AUTHORITY,
    assignedTo: "aieng",
    inputPayload: {
      _diag: true,
      actionType: "SEND_MESSAGE",
      payload: { text },
      error: "no telegram context",
      _retry_count: 0,
    },
  });
}

function deps(text: string, sendMessage: () => Promise<unknown>): SelfDiagDeps {
  return {
    anthropic: {} as any,
    model: "test",
    callAnthropicImpl: aiengProposes(text),
    buildDispatchCtx: (args: { agentKey: string; chatId: number }) =>
      ({
        agentKey: args.agentKey,
        chatId: args.chatId,
        telegram: { sendMessage },
      }) as any,
  } as unknown as SelfDiagDeps;
}

/** Первая часть уходит, вторая падает — в чате уже есть сообщение. */
function partialSender() {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    send: async () => {
      calls++;
      if (calls === 1) return { message_id: calls, date: 0 };
      throw new Error("bot was blocked by the user");
    },
  };
}

/** Сколько слотов ведра роли ещё свободно (ведро SEND_MESSAGE — 30/мин). */
function freeAgentSlots(agent: string): number {
  let n = 0;
  while (checkAndConsumeRateLimit(agent, "SEND_MESSAGE").ok) n++;
  return n;
}

describe("частичная доставка в ретрае self-diag не рефандится", () => {
  test("предпосылка: длинный текст действительно рвётся на части", async () => {
    const sender = partialSender();
    const task = diagTask(LONG);
    await processDiagTask(getTask(task.id)!, deps(LONG, sender.send));
    // Вторая часть была — значит сценарий частичной доставки настоящий,
    // а не «одно сообщение упало целиком».
    expect(sender.calls).toBeGreaterThan(1);
    expect(getTask(task.id)!.status).toBe("failed");
  });

  test("слот роли остаётся потраченным", async () => {
    const task = diagTask(LONG);
    await processDiagTask(getTask(task.id)!, deps(LONG, partialSender().send));
    expect(getTask(task.id)!.status).toBe("failed");
    // Ход состоялся снаружи — ведро должно помнить об этом.
    expect(freeAgentSlots(AUTHORITY)).toBe(29);
  });

  test("слот чата остаётся потраченным", async () => {
    const ENV = "RATE_LIMIT_PER_CHAT_PER_MIN";
    const savedEnv = process.env[ENV];
    process.env[ENV] = "2";
    try {
      const task = diagTask(LONG);
      await processDiagTask(getTask(task.id)!, deps(LONG, partialSender().send));
      expect(getTask(task.id)!.status).toBe("failed");
      // Из двух слотов чата один съел ретрай: остаётся ровно один.
      expect(checkAndConsumeChatRateLimits(undefined, CHAT, "SEND_MESSAGE").ok).toBe(
        true,
      );
      expect(checkAndConsumeChatRateLimits(undefined, CHAT, "SEND_MESSAGE").ok).toBe(
        false,
      );
    } finally {
      if (savedEnv === undefined) delete process.env[ENV];
      else process.env[ENV] = savedEnv;
    }
  });

  test("полный провал по-прежнему возвращает слот", async () => {
    // Регрессия на соседнюю ветку: ничего не доставлено — рефанд правильный.
    const task = diagTask("короткий ответ");
    await processDiagTask(
      getTask(task.id)!,
      deps("короткий ответ", async () => {
        throw new Error("bot was kicked from the group chat");
      }),
    );
    expect(getTask(task.id)!.status).toBe("failed");
    expect(freeAgentSlots(AUTHORITY)).toBe(30);
  });

  test("успех тратит слот", async () => {
    const task = diagTask("короткий ответ");
    await processDiagTask(
      getTask(task.id)!,
      deps("короткий ответ", async () => ({ message_id: 1, date: 0 })),
    );
    expect(getTask(task.id)!.status).toBe("done");
    expect(freeAgentSlots(AUTHORITY)).toBe(29);
  });
});
