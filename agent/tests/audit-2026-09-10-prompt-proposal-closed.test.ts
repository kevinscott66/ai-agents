/**
 * Аудит 2026-09-10: заявка закрылась, а строка версии промпта осталась «живой».
 *
 * Аудит 2026-08-27 закрыл этот развал со стороны отказа человека (колонка
 * `rejected_at`, миграция 048). Но заявку закрывает не только человек: TTL
 * (`expireStaleApprovals`) и провал исполнения уже после одобрения
 * (`markApprovalFailed`) меняли статус в `approvals` и на `agent_prompts` не
 * смотрели вовсе. Строка оставалась с `applied_at IS NULL AND rejected_at IS
 * NULL` — ровно тот маркер, по которому одобрение выбирает, что применять, —
 * и следующее одобрение того же текста стамповало applied_at на мёртвой
 * версии, а действительно одобренная навсегда числилась непринятой.
 *
 * Сопоставлять по содержимому здесь нечем и нельзя: db-maint работает по
 * таблице approvals, а две одинаковые версии по тексту неразличимы. Поэтому
 * миграция 050 даёт `agent_prompts.approval_id`, и закрытие идёт строго по
 * нему.
 *
 * Закрывающий маркер — отдельная колонка `closed_at` (миграция 051), а не
 * `rejected_at`: протухшая заявка не отказ. `rejected_at` заведена аудитом
 * 2026-08-27 затем, чтобы роль не переспрашивала то, в чём ей уже отказали, —
 * и протухшая заявка, показанная как «rejected», отбила бы ровно тот
 * переспрос, который здесь нужен.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import { executeTool } from "../lib/tools-schema.ts";
import {
  insertPendingAgentPrompt,
  handleUpdateAgentPromptApproved,
  closeAgentPromptProposals,
} from "../lib/dispatch/agent-prompt.ts";
import { expireStaleApprovals } from "../lib/db-maint.ts";
import { insertApprovalRow, markApprovalFailed, decideApproval } from "../lib/approvals.ts";
import type { UpdateAgentPromptPayload } from "../lib/action-payload.ts";

const TARGET = "qa";
const CHAT = -100_999_910;
const AGENT = "__prompt_close_test__";

function payload(suffix = ""): UpdateAgentPromptPayload {
  return {
    target_agent_key: TARGET,
    new_prompt: `Ты QA-инженер команды. Проверяй строго, отвечай коротко и по делу.${suffix}`,
    reason: `уточняем тон ответов роли QA после жалоб владельца${suffix}`,
  } as UpdateAgentPromptPayload;
}

/** Заявка + строка версии, связанные так же, как их связывает gateOrDispatch. */
function propose(createdAt?: number): { approvalId: string; version: number } {
  const approvalId = insertApprovalRow({
    actionId: `act-${crypto.randomUUID()}`,
    chatId: CHAT,
    requestedBy: AGENT,
    actionType: "UPDATE_AGENT_PROMPT",
    payload: payload(),
  });
  if (createdAt !== undefined) {
    db.prepare("UPDATE approvals SET created_at = ? WHERE id = ?").run(createdAt, approvalId);
  }
  const { version } = insertPendingAgentPrompt(payload(), AGENT, db, approvalId);
  return { approvalId, version };
}

function rows() {
  return db
    .prepare(
      `SELECT version, applied_at, rejected_at, closed_at, approval_id
       FROM agent_prompts WHERE agent_key = ? ORDER BY version`,
    )
    .all(TARGET) as Array<{
    version: number;
    applied_at: number | null;
    rejected_at: number | null;
    closed_at: number | null;
    approval_id: string | null;
  }>;
}

function clean() {
  db.prepare("DELETE FROM agent_prompts WHERE agent_key = ?").run(TARGET);
  db.prepare("DELETE FROM approvals WHERE requested_by = ?").run(AGENT);
  db.prepare("DELETE FROM audit_logs WHERE chat_id = ?").run(CHAT);
  db.prepare("DELETE FROM agent_actions WHERE chat_id = ?").run(CHAT);
}

describe("строка версии закрывается вместе с заявкой", () => {
  beforeEach(clean);
  afterEach(clean);

  test("схема несёт approval_id (миграция 050)", () => {
    const cols = (
      db.prepare("PRAGMA table_info(agent_prompts)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols).toContain("approval_id");
    expect(cols).toContain("closed_at");
  });

  test("истёкшая заявка помечает свою версию, а не оставляет её кандидатом", () => {
    const { approvalId } = propose(Date.now() - 48 * 3_600_000);
    expireStaleApprovals({ ttlMs: 3_600_000 });

    const [v1] = rows();
    expect(v1!.approval_id).toBe(approvalId);
    expect(v1!.closed_at).not.toBeNull();
    expect(v1!.applied_at).toBeNull();
    // Протухло — не «владелец отказал». Подделка отказа отбила бы переспрос.
    expect(v1!.rejected_at).toBeNull();
  });

  test("после истечения одобрение того же текста стамповывает НОВУЮ версию", () => {
    propose(Date.now() - 48 * 3_600_000);
    expireStaleApprovals({ ttlMs: 3_600_000 });
    // Автор переспрашивает тем же текстом — это и есть типичный сценарий.
    propose();

    const res = handleUpdateAgentPromptApproved(payload(), { agentKey: AGENT, chatId: CHAT });
    expect(res.ok).toBe(true);

    const [v1, v2] = rows();
    // До фикса applied_at вставал на v1 (протухшую), а v2 оставалась NULL.
    expect(v1!.applied_at).toBeNull();
    expect(v2!.applied_at).not.toBeNull();
    expect(v2!.rejected_at).toBeNull();
  });

  test("провал исполнения после одобрения тоже закрывает версию", () => {
    const { approvalId } = propose();
    decideApproval(approvalId, "approved", "owner");
    markApprovalFailed(approvalId, "boom");

    const [v1] = rows();
    expect(v1!.closed_at).not.toBeNull();
    expect(v1!.rejected_at).toBeNull();
    expect(v1!.applied_at).toBeNull();
  });

  test("уже применённую версию провал заявки не переписывает", () => {
    const { approvalId } = propose();
    const res = handleUpdateAgentPromptApproved(payload(), { agentKey: AGENT, chatId: CHAT });
    expect(res.ok).toBe(true);
    const appliedAt = rows()[0]!.applied_at;
    expect(appliedAt).not.toBeNull();

    decideApproval(approvalId, "approved", "owner");
    markApprovalFailed(approvalId, "упало уже после применения");

    const [v1] = rows();
    expect(v1!.applied_at).toBe(appliedAt);
    expect(v1!.rejected_at).toBeNull();
    expect(v1!.closed_at).toBeNull();
  });

  test("закрытие идёт строго по approval_id — чужую живую версию не трогает", () => {
    const a = propose();
    const b = propose();
    expect(closeAgentPromptProposals([a.approvalId])).toBe(1);

    const [v1, v2] = rows();
    expect(v1!.closed_at).not.toBeNull();
    expect(v2!.closed_at).toBeNull();
    expect(v2!.approval_id).toBe(b.approvalId);
  });

  test("строки старше миграции 050 (approval_id пуст) проход не задевает", () => {
    insertPendingAgentPrompt(payload(), AGENT);
    const { approvalId } = propose();
    closeAgentPromptProposals([approvalId]);

    const [legacy, linked] = rows();
    expect(legacy!.approval_id).toBeNull();
    expect(legacy!.closed_at).toBeNull();
    expect(linked!.closed_at).not.toBeNull();
  });

  test("пустой список — не запрос в базу и не ошибка", () => {
    expect(closeAgentPromptProposals([])).toBe(0);
  });

  test("GET_PROMPT_HISTORY зовёт протухшее «closed», а не «rejected»", async () => {
    // v1 протухла, v2 ждёт решения, v3 применена — четыре исхода должны
    // называться четырьмя разными словами, иначе роль читает историю неверно.
    propose(Date.now() - 48 * 3_600_000);
    expireStaleApprovals({ ttlMs: 3_600_000 });
    propose();
    propose();
    handleUpdateAgentPromptApproved(payload(), { agentKey: AGENT, chatId: CHAT });

    const out = JSON.parse(
      await executeTool(
        "GET_PROMPT_HISTORY",
        { agentKey: TARGET },
        { agentKey: "aieng", chatId: CHAT },
      ),
    ) as {
      ok: boolean;
      history: Array<{ version: number; status: string; closed: boolean; rejected: boolean }>;
    };
    expect(out.ok).toBe(true);
    const byVersion = new Map(out.history.map((h) => [h.version, h]));
    expect(byVersion.get(1)!.status).toBe("closed");
    expect(byVersion.get(1)!.rejected).toBe(false);
    expect(byVersion.get(2)!.status).toBe("applied");
    expect(byVersion.get(3)!.status).toBe("pending");
  });
});
