/**
 * Аудит 2026-08-12: одобренное человеком действие исполнялось с урезанным ctx.
 *
 * `executeApproved` (lib/commands.ts:131-135) собирает ctx из трёх полей —
 * `{ agentKey, chatId, telegram }`. Обычный путь агента (`gateOrDispatch`)
 * получает одиннадцать: `resolveAgent`, `handoffDeps`, `botId`, `requestId`,
 * `delegationChain` и прочее. Всё, что человек одобрил, исполняется без них.
 *
 * Замер (probe: строка апрува DELEGATE_TO_ROLE от orchestrator, права выданы,
 * владелец нажал Approve):
 *
 *   DELEGATE_TO_ROLE бросил: no resolveAgent in dispatch ctx
 *   agent_actions: {"status":"error","error":"no resolveAgent in dispatch ctx",
 *                   "request_id":"tCDJV-R5N1Pm"}
 *   + [self-diag] created task … + [diagnostic] created task …
 *
 * То есть: владелец жмёт Approve → действие не выполняется никогда, зато
 * рождаются две мусорные строки на доске задач и повторная попытка у aieng.
 * Ровно тот механизм, что дал «148 провалов из 154» в T-730. В semi_auto (режим
 * по умолчанию) так себя ведёт CREATE_TEAM_CHANNEL — он в SEMI_AUTO_RISKY и
 * иначе как через апрув не исполняется вовсе; в manual — любое действие, кроме
 * COMMENT_TASK.
 *
 * Второе из того же места: `request_id` в строке аудита НОВЫЙ (его лениво
 * минтит dispatchAndAudit), хотя в самой заявке лежит `request_id` исходного
 * хода агента. Одобренное действие висит в audit_logs сиротой — связать его с
 * запросом, который его породил, нечем. При починке выяснилось, что и «в самой
 * заявке лежит» — правда лишь для одного пути чтения из трёх (замер):
 *
 *   createApproval → null | getApproval → null | resolveApproval → null
 *   listPendingApprovals → req-исходный
 *
 * Колонки `request_id` в таблице `approvals` нет вовсе — она приходит джойном с
 * `agent_actions`, а джойн был написан ровно в `listPendingApprovals` (T-546,
 * для группировки карточек в Mini App). Путь `/approve` в чате читает через
 * `resolveApproval`/`getApproval` и связь терял всегда.
 *
 * Третье: путь апрува зовёт `dispatchAndAudit` напрямую, минуя резервацию
 * бакетов в `gateOrDispatch`. Одобренные действия не считались вообще: агент
 * мог провести через очередь апрувов сколько угодно GENERATE_IMAGE, и бакет
 * 6/час этого не замечал. Считаем — но человеку не отказываем: он уже решил, и
 * отказ на его нажатие был бы новым поведением. Смысл счёта в том, что
 * ПОСЛЕДУЮЩИЕ действия самого агента упрутся в лимит честно.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import {
  createApproval,
  decideApproval,
  getApproval,
  listPendingApprovals,
  resolveApproval,
} from "../lib/approvals.ts";
import { executeApproved } from "../lib/commands.ts";
import { _resetRateLimits, checkRateLimit } from "../lib/rate-limits.ts";
import type { RunningBot } from "../lib/types.ts";

const CHAT_ID = -100_930_555;
const AGENT = "orchestrator";

afterEach(() => {
  db.prepare(`DELETE FROM approvals WHERE chat_id = ?`).run(CHAT_ID);
  db.prepare(`DELETE FROM agent_actions WHERE chat_id = ?`).run(CHAT_ID);
  db.prepare(`DELETE FROM tasks WHERE chat_id = ?`).run(CHAT_ID);
  _resetRateLimits();
});

/** Выдать право с requires_approval и вернуть функцию отката. */
function grant(actionType: string): () => void {
  const prev = db
    .prepare(
      `SELECT allowed, requires_approval FROM permissions
       WHERE agent_key = ? AND action_type = ?`,
    )
    .get(AGENT, actionType) as { allowed: number; requires_approval: number } | undefined;
  db.prepare(
    `INSERT INTO permissions (agent_key, action_type, allowed, requires_approval)
     VALUES (?, ?, 1, 1)
     ON CONFLICT(agent_key, action_type) DO UPDATE SET allowed = 1, requires_approval = 1`,
  ).run(AGENT, actionType);
  return () => {
    if (prev) {
      db.prepare(
        `UPDATE permissions SET allowed = ?, requires_approval = ?
         WHERE agent_key = ? AND action_type = ?`,
      ).run(prev.allowed, prev.requires_approval, AGENT, actionType);
    } else {
      db.prepare(`DELETE FROM permissions WHERE agent_key = ? AND action_type = ?`).run(
        AGENT,
        actionType,
      );
    }
  };
}

/** Заявка в статусе pending; с requestId — с реальной строкой agent_actions. */
function pendingApproval(actionType: string, payload: unknown, requestId?: string) {
  const actionId = `act-ctx-${Math.random().toString(36).slice(2)}`;
  if (requestId) {
    db.prepare(
      `INSERT INTO agent_actions (id, agent_key, chat_id, action_type, payload, status, request_id, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending_approval', ?, ?)`,
    ).run(actionId, AGENT, CHAT_ID, actionType, JSON.stringify(payload), requestId, Date.now());
  }
  return createApproval({
    actionId,
    chatId: CHAT_ID,
    requestedBy: AGENT,
    actionType: actionType as never,
    payload: payload as never,
  });
}

function approved(actionType: string, payload: unknown, requestId?: string) {
  const a = pendingApproval(actionType, payload, requestId);
  return decideApproval(a.id, "approved", "owner");
}

const lastAction = () =>
  db
    .prepare(
      `SELECT action_type, status, error, request_id FROM agent_actions
       WHERE chat_id = ? AND status != 'pending_approval' ORDER BY rowid DESC LIMIT 1`,
    )
    .get(CHAT_ID) as
    | { action_type: string; status: string; error: string | null; request_id: string | null }
    | undefined;

const FAKE_BOT = { def: { key: "backend" }, username: "delabs_backend_bot", id: 42 } as unknown as RunningBot;

describe("одобренное действие исполняется с полным ctx", () => {
  test("замер из шапки: DELEGATE_TO_ROLE больше не падает на resolveAgent", async () => {
    const undo = grant("DELEGATE_TO_ROLE");
    try {
      const row = approved("DELEGATE_TO_ROLE", { role: "backend", task: "почини сборку" });
      const res = await executeApproved(row, {
        resolveAgent: (role) => (role === "backend" ? FAKE_BOT : undefined),
        handoffDeps: {} as never,
        respondAsImpl: async () => "готово, сборка чинится",
      });
      expect(JSON.stringify(res)).toContain("сборка чинится");
      expect(lastAction()?.status).toBe("ok");
    } finally {
      undo();
    }
  });

  test("без резолвера ошибка прежняя — сигнал не глушим", async () => {
    const undo = grant("DELEGATE_TO_ROLE");
    try {
      const row = approved("DELEGATE_TO_ROLE", { role: "backend", task: "t" });
      await expect(executeApproved(row)).rejects.toThrow(/no resolveAgent/);
    } finally {
      undo();
    }
  });

  test("request_id виден всем путям чтения, не только Mini App", () => {
    // Замер до фикса: getApproval → null, resolveApproval → null,
    // listPendingApprovals → req-исходный. Колонки request_id в approvals нет,
    // она приходит джойном — а джойн был ровно в одном запросе из трёх.
    const row = approved("DELEGATE_TO_ROLE", { role: "backend", task: "t" }, "req-исходный");
    expect(getApproval(row.id)?.request_id).toBe("req-исходный");

    const pending = pendingApproval(
      "DELEGATE_TO_ROLE",
      { role: "backend", task: "t" },
      "req-префикс",
    );
    expect(resolveApproval(pending.id.slice(0, 8))?.request_id).toBe("req-префикс");
    expect(
      listPendingApprovals(CHAT_ID).find((x) => x.id === pending.id)?.request_id,
    ).toBe("req-префикс");
  });

  test("request_id заявки переносится в строку аудита, а не минтится новый", async () => {
    const undo = grant("DELEGATE_TO_ROLE");
    try {
      const row = approved("DELEGATE_TO_ROLE", { role: "backend", task: "t" }, "req-исходный");
      expect(row.request_id).toBe("req-исходный");
      await executeApproved(row, {
        resolveAgent: () => FAKE_BOT,
        handoffDeps: {} as never,
        respondAsImpl: async () => "ок",
      });
      expect(lastAction()?.request_id).toBe("req-исходный");
    } finally {
      undo();
    }
  });

  test("одобренные тратят бакет, но человеку не отказывают", async () => {
    const undo = grant("DELEGATE_TO_ROLE");
    const run = async (task: string) =>
      executeApproved(approved("DELEGATE_TO_ROLE", { role: "backend", task }), {
        resolveAgent: () => FAKE_BOT,
        handoffDeps: {} as never,
        respondAsImpl: async () => `сделал: ${task}`,
      });
    try {
      expect(checkRateLimit(AGENT, "DELEGATE_TO_ROLE").ok).toBe(true);
      // Бакет DELEGATE_TO_ROLE — 6/мин. До фикса одобренные не считались вовсе,
      // и цикл упирался в предохранитель, ни разу не исчерпав лимит.
      let n = 0;
      while (checkRateLimit(AGENT, "DELEGATE_TO_ROLE").ok && n++ < 50) {
        await run(`заявка ${n}`);
      }
      expect(n).toBeLessThan(50);
      expect(checkRateLimit(AGENT, "DELEGATE_TO_ROLE").ok).toBe(false);

      // Человек жмёт Approve на следующей карточке — действие выполняется.
      const res = await run("последнее");
      expect(JSON.stringify(res)).toContain("сделал: последнее");
      expect(lastAction()?.status).toBe("ok");
    } finally {
      undo();
    }
  });
});
