/**
 * Аудит 2026-08-09: ретрай self-diag проходил мимо всех лимитов.
 *
 * `processDiagTask` зовёт `dispatchAndAudit` напрямую — сознательно, потому что
 * гейт он уже позвал вручную (второй рубеж, self-diag-executor-identity).
 * Но rate-limit живёт не в dispatchAndAudit, а в gateOrDispatch: в обход гейта
 * ушли и лимиты. Для SEND_MESSAGE это неприятно, для GENERATE_IMAGE — деньги:
 * каждый ретрай это очередные $0.04 у OpenAI, списанные ВНУТРИ dispatch'а, и
 * ни одно ведро при этом не трогалось. Ровно та дыра, которую с другой стороны
 * латал NO_REFUND_ACTIONS. Единственной границей оставался isDiagTaskThrottled
 * (5 диаг-задач в час), то есть до пяти бесплатных картинок в час мимо лимита
 * «6/час на агента, 30/час суммарно».
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { db } from "../lib/db.ts";
import { processDiagTask, type SelfDiagDeps } from "../lib/self-diag.ts";
import { createTask, getTask } from "../lib/tasks.ts";
import { setAutonomy } from "../lib/permissions.ts";
import {
  checkAndConsumeRateLimit,
  checkRateLimit,
  _resetRateLimits,
} from "../lib/rate-limits.ts";
import { cleanupChat, saveAutonomy, restoreAutonomy } from "./_helpers.ts";

const CHAT = -1_000_719;
const AUTHORITY = "orchestrator";

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

function aiengProposes(action: string, payload: Record<string, unknown>) {
  return (async () => ({
    id: "msg",
    type: "message",
    role: "assistant",
    model: "test",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
    content: [
      { type: "text", text: JSON.stringify({ action, payload, reason: "fix" }) },
    ],
  })) as any;
}

function diagTask() {
  setAutonomy("chat", String(CHAT), "auto");
  return createTask({
    title: "diag",
    chatId: CHAT,
    createdBy: AUTHORITY,
    assignedTo: "aieng",
    inputPayload: {
      _diag: true,
      actionType: "SEND_MESSAGE",
      payload: { text: "привет" },
      error: "no telegram context",
      _retry_count: 0,
    },
  });
}

function deps(sendMessage: () => Promise<unknown>): SelfDiagDeps {
  return {
    anthropic: {} as any,
    model: "test",
    callAnthropicImpl: aiengProposes("SEND_MESSAGE", { text: "привет" }),
    buildDispatchCtx: (args: { agentKey: string; chatId: number }) =>
      ({
        agentKey: args.agentKey,
        chatId: args.chatId,
        telegram: { sendMessage },
      }) as any,
  } as unknown as SelfDiagDeps;
}

const okSend = async () => ({ message_id: 1, date: 0 });

describe("ретрай self-diag тратит лимит той роли, за которую действует", () => {
  test("успешный ретрай занимает слот в ведре роли", async () => {
    const before = checkRateLimit(AUTHORITY, "SEND_MESSAGE");
    expect(before.ok).toBe(true);

    const task = diagTask();
    await processDiagTask(getTask(task.id)!, deps(okSend));
    expect(getTask(task.id)!.status).toBe("done");

    // SEND_MESSAGE — 30/мин на агента. Забиваем оставшиеся 29 и убеждаемся,
    // что 30-го слота уже нет: ретрай его действительно израсходовал.
    for (let i = 0; i < 29; i++) {
      expect(checkAndConsumeRateLimit(AUTHORITY, "SEND_MESSAGE").ok).toBe(true);
    }
    expect(checkAndConsumeRateLimit(AUTHORITY, "SEND_MESSAGE").ok).toBe(false);
  });

  test("исчерпанное ведро роли останавливает ретрай", async () => {
    for (let i = 0; i < 30; i++) {
      expect(checkAndConsumeRateLimit(AUTHORITY, "SEND_MESSAGE").ok).toBe(true);
    }
    let sent = 0;
    const task = diagTask();
    await processDiagTask(
      getTask(task.id)!,
      deps(async () => {
        sent++;
        return { message_id: 1, date: 0 };
      }),
    );

    const after = getTask(task.id)!;
    expect(after.status).toBe("failed");
    expect(String(after.error ?? "")).toContain("rate limited");
    // Главное: до отправки дело не дошло. Для GENERATE_IMAGE это и есть
    // «деньги не потрачены».
    expect(sent).toBe(0);
  });

  test("исчерпанный лимит чата тоже останавливает ретрай", async () => {
    const ENV = "RATE_LIMIT_PER_CHAT_PER_MIN";
    const savedEnv = process.env[ENV];
    process.env[ENV] = "2";
    try {
      // Забиваем корзину чата чужими ходами — ведро роли при этом пустое.
      const { checkAndConsumeChatRateLimits } = await import(
        "../lib/rate-limits.ts"
      );
      for (let i = 0; i < 2; i++) {
        expect(
          checkAndConsumeChatRateLimits(undefined, CHAT, "SEND_MESSAGE").ok,
        ).toBe(true);
      }
      let sent = 0;
      const task = diagTask();
      await processDiagTask(
        getTask(task.id)!,
        deps(async () => {
          sent++;
          return { message_id: 1, date: 0 };
        }),
      );
      const after = getTask(task.id)!;
      expect(after.status).toBe("failed");
      expect(String(after.error ?? "")).toContain("rate limited");
      expect(sent).toBe(0);
    } finally {
      if (savedEnv === undefined) delete process.env[ENV];
      else process.env[ENV] = savedEnv;
    }
  });

  test("провал отправки возвращает слот — падающая инфраструктура не съедает лимит", async () => {
    for (let i = 0; i < 5; i++) {
      const task = diagTask();
      await processDiagTask(
        getTask(task.id)!,
        deps(async () => {
          throw new Error("bot was kicked from the group chat");
        }),
      );
      expect(getTask(task.id)!.status).toBe("failed");
    }
    // Пять провалов — ведро роли по-прежнему пустое.
    for (let i = 0; i < 30; i++) {
      expect(checkAndConsumeRateLimit(AUTHORITY, "SEND_MESSAGE").ok).toBe(true);
    }
  });

  test("лимит тратится у роли-заказчика, а не у aieng", async () => {
    const task = diagTask();
    await processDiagTask(getTask(task.id)!, deps(okSend));
    // У aieng ведро нетронуто: исполнял не он (см. self-diag-executor-identity).
    for (let i = 0; i < 30; i++) {
      expect(checkAndConsumeRateLimit("aieng", "SEND_MESSAGE").ok).toBe(true);
    }
    expect(checkAndConsumeRateLimit("aieng", "SEND_MESSAGE").ok).toBe(false);
  });
});
