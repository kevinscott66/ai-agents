/**
 * Аудит 2026-09-14: ретрай self-diag, упёршийся в агентский лимит, съедал
 * слот чата GENERATE_IMAGE.
 *
 * Резервация в `processDiagTask` двухступенчатая, как в `gateOrDispatch`:
 * сперва чат-бакеты, потом агентский. Отказ второго при успехе первого
 * возвращал чат-слот через `refundChatRateLimits` — а у того первая строка
 * `if (NO_REFUND_ACTIONS.has(actionType)) return`. Для GENERATE_IMAGE возврат
 * был no-op'ом: ход, которого не было, держал слот чата весь час. В
 * `gateOrDispatch` ровно этот класс уже чинили отдельной точкой
 * `releaseUnusedChatReservation` (тест audit-2026-09-11-race-loser-eats-chat-slot);
 * здесь ветка к тому же достижима — ранней проверки агентского ведра до
 * резервации в self-diag нет.
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { db } from "../lib/db.ts";
import { processDiagTask, type SelfDiagDeps } from "../lib/self-diag.ts";
import { createTask, getTask } from "../lib/tasks.ts";
import { setAutonomy } from "../lib/permissions.ts";
import {
  checkAndConsumeRateLimit,
  checkPerChatRateLimit,
  _resetRateLimits,
} from "../lib/rate-limits.ts";
import { cleanupChat, saveAutonomy, restoreAutonomy } from "./_helpers.ts";

const CHAT = -1_000_914_14;
const AUTHORITY = "orchestrator";
const ENV = "RATE_LIMIT_PER_CHAT_PER_MIN";

let saved = saveAutonomy();
let savedEnv: string | undefined;

beforeEach(() => {
  saved = saveAutonomy();
  savedEnv = process.env[ENV];
  process.env[ENV] = "1";
  _resetRateLimits();
});

afterEach(() => {
  restoreAutonomy(saved);
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
  _resetRateLimits();
  db.prepare(`DELETE FROM tasks WHERE chat_id = ?`).run(CHAT);
  cleanupChat(CHAT, "aieng");
  cleanupChat(CHAT, AUTHORITY);
});

function deps(onDispatch: () => void): SelfDiagDeps {
  return {
    anthropic: {} as any,
    model: "test",
    callAnthropicImpl: (async () => ({
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
            action: "GENERATE_IMAGE",
            payload: { prompt: "обложка" },
            reason: "fix",
          }),
        },
      ],
    })) as any,
    buildDispatchCtx: (args: { agentKey: string; chatId: number }) =>
      ({
        agentKey: args.agentKey,
        chatId: args.chatId,
        telegram: {
          sendMessage: async () => {
            onDispatch();
            return { message_id: 1, date: 0 };
          },
          sendPhoto: async () => {
            onDispatch();
            return { message_id: 1, date: 0 };
          },
        },
      }) as any,
  } as unknown as SelfDiagDeps;
}

describe("ретрай self-diag, отбитый агентским ведром, отпускает слот чата", () => {
  test("GENERATE_IMAGE: чат-слот свободен после отказа", async () => {
    setAutonomy("chat", String(CHAT), "auto");
    // Выбираем агентское ведро роли до дна — чат-ведро при этом не тронуто.
    while (checkAndConsumeRateLimit(AUTHORITY, "GENERATE_IMAGE").ok) {}
    expect(checkPerChatRateLimit(CHAT, "GENERATE_IMAGE").ok).toBe(true);

    const task = createTask({
      title: "diag",
      chatId: CHAT,
      createdBy: AUTHORITY,
      assignedTo: "aieng",
      inputPayload: {
        _diag: true,
        actionType: "GENERATE_IMAGE",
        payload: { prompt: "обложка" },
        error: "provider timeout",
        _retry_count: 0,
      },
    });
    let dispatched = 0;
    await processDiagTask(getTask(task.id)!, deps(() => dispatched++));

    const after = getTask(task.id)!;
    expect(after.status).toBe("failed");
    expect(String(after.error)).toContain("retry rate limited");
    expect(dispatched).toBe(0);
    // Хода не было — слот чата (1 в минуту) должен остаться свободным.
    expect(checkPerChatRateLimit(CHAT, "GENERATE_IMAGE").ok).toBe(true);
  });
});
