/**
 * Аудит 2026-08-08: self-diag авторизовал одну личность, а действовал другой.
 *
 * `processDiagTask` спрашивает гейт про полномочия `task.created_by` — роли,
 * чьё действие упало. А контекст исполнения строился фабрикой, у которой
 * `agentKey` был жёстко зашит на `aieng` (orchestrator/services.ts). Итог:
 * проверили роль, а исполнил aieng. Расходилось всё сразу — бот-отправитель
 * (в чат пишет aieng), ведро rate-limit (лимит роли цел, тратится чужой) и
 * атрибуция в agent_actions/audit_logs (след ведёт к aieng, хотя решение
 * принималось за роль).
 *
 * Инвариант: исполняет тот, кого проверили. Если бота этой роли сейчас нет —
 * ретрая не будет вовсе; подмена исполнителя это ровно тот же баг.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import { processDiagTask, type SelfDiagDeps } from "../lib/self-diag.ts";
import { createTask, getTask } from "../lib/tasks.ts";
import { setAutonomy } from "../lib/permissions.ts";
import { cleanupChat, saveAutonomy, restoreAutonomy } from "./_helpers.ts";

const CHAT = -1_000_718;
/** Роль-заказчик: НЕ aieng, иначе подмену не отличить от корректной работы. */
const AUTHORITY = "orchestrator";

let saved = saveAutonomy();

afterEach(() => {
  restoreAutonomy(saved);
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

function diagTask(createdBy = AUTHORITY) {
  setAutonomy("chat", String(CHAT), "auto");
  return createTask({
    title: "diag",
    chatId: CHAT,
    createdBy,
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

/** Кто попал в agent_actions за этот чат (dispatchAndAudit пишет ctx.agentKey). */
function actionAuthors(): string[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT agent_key FROM agent_actions WHERE chat_id = ?`,
      )
      .all(CHAT) as { agent_key: string }[]
  ).map((r) => r.agent_key);
}

describe("self-diag: исполнитель ретрая = проверенная гейтом личность", () => {
  test("контекст исполнения запрашивается для роли из created_by", async () => {
    const task = diagTask();
    const asked: Array<Record<string, unknown>> = [];

    await processDiagTask(getTask(task.id)!, {
      anthropic: {} as any,
      model: "test",
      callAnthropicImpl: aiengProposes("SEND_MESSAGE", { text: "привет" }),
      buildDispatchCtx: (args) => {
        asked.push({ ...args });
        return {
          agentKey: args.agentKey,
          chatId: args.chatId,
          telegram: {
            sendMessage: async () => ({ message_id: 1, date: 0 }),
          },
        } as any;
      },
    } as unknown as SelfDiagDeps);

    expect(asked).toHaveLength(1);
    // Именно та роль, про полномочия которой спрашивали гейт. До фикса здесь
    // было undefined: фабрика ключ не принимала и подставляла aieng.
    expect(asked[0]!.agentKey).toBe(AUTHORITY);
    expect(asked[0]!.agentKey).not.toBe("aieng");
  });

  test("след в agent_actions ведёт к роли, а не к aieng", async () => {
    const task = diagTask();

    await processDiagTask(getTask(task.id)!, {
      anthropic: {} as any,
      model: "test",
      callAnthropicImpl: aiengProposes("SEND_MESSAGE", { text: "привет" }),
      buildDispatchCtx: (args) =>
        ({
          agentKey: args.agentKey,
          chatId: args.chatId,
          telegram: {
            sendMessage: async () => ({ message_id: 1, date: 0 }),
          },
        }) as any,
    } as unknown as SelfDiagDeps);

    expect(getTask(task.id)!.status).toBe("done");
    const authors = actionAuthors();
    expect(authors).toContain(AUTHORITY);
    // Атрибуция «за роль решили, aieng сделал» — это и был баг.
    expect(authors).not.toContain("aieng");
  });

  test("бота роли нет — ретрая нет, а не исполнение от чужого имени", async () => {
    const task = diagTask();

    await processDiagTask(getTask(task.id)!, {
      anthropic: {} as any,
      model: "test",
      callAnthropicImpl: aiengProposes("SEND_MESSAGE", { text: "привет" }),
      // Роль не поднята в этом процессе.
      buildDispatchCtx: () => null,
    } as unknown as SelfDiagDeps);

    const after = getTask(task.id)!;
    expect(after.status).toBe("failed");
    expect(String(after.error ?? "")).toContain(AUTHORITY);
    // Никто ничего не диспатчил — ни от имени роли, ни тем более от aieng.
    expect(actionAuthors()).toHaveLength(0);
  });

  test("вердикт гейта не подменяется диагнозом «бота нет»", async () => {
    // Модель предлагает действие, которое второй гейт не пропустит, и роли
    // при этом нет в процессе. Диагноз должен быть точным: не «роль не
    // поднята», а «не прошло гейт» — иначе сигнал о подмене действия теряется.
    const task = diagTask();
    let ctxAsked = false;

    await processDiagTask(getTask(task.id)!, {
      anthropic: {} as any,
      model: "test",
      callAnthropicImpl: aiengProposes("PUBLISH_TO_CHANNEL", {
        text: "публикация",
      }),
      buildDispatchCtx: () => {
        ctxAsked = true;
        return null;
      },
    } as unknown as SelfDiagDeps);

    const after = getTask(task.id)!;
    expect(after.status).toBe("failed");
    expect(String(after.error ?? "")).toContain("blocked by gate");
    // И контекст исполнения для непрошедшей роли даже не собирается.
    expect(ctxAsked).toBe(false);
  });
});
