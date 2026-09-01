/**
 * Аудит 2026-08-08: отказ от правки system prompt'а терял след.
 *
 * Два бага в одном месте:
 *   1. cmdReject звал handleUpdateAgentPromptRejected в `try {} catch {}` без
 *      единой строчки лога — упавшая запись аудита исчезала бесследно.
 *   2. Mini App (POST /api/approvals/:id/decide) не звал её ВООБЩЕ: отказ через
 *      веб не писался в audit_logs никак. То есть «кто отказал и почему» по
 *      самому чувствительному действию в системе зависело от того, какой
 *      кнопкой человек воспользовался.
 *
 * Проверяем оба пути через общую auditRejectedApproval.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { db } from "../lib/db.ts";
import { createApproval, getApproval } from "../lib/approvals.ts";
import { cmdReject } from "../lib/commands.ts";
import { auditRejectedApproval } from "../lib/dispatch/agent-prompt.ts";

const CHAT = -1_000_809;

function auditRows() {
  return db
    .prepare(
      `SELECT agent_key, chat_id, payload FROM audit_logs
       WHERE event_type = 'UPDATE_AGENT_PROMPT_REJECTED' AND chat_id = ?`,
    )
    .all(CHAT) as { agent_key: string; chat_id: number; payload: string }[];
}

const promptPayload = {
  target_agent_key: "smm",
  new_prompt: "x".repeat(60),
  reason: "хотим другой тон в канале",
};

describe("отказ от UPDATE_AGENT_PROMPT оставляет след", () => {
  beforeEach(() => {
    db.prepare(`DELETE FROM audit_logs WHERE chat_id = ?`).run(CHAT);
  });

  test("Telegram-путь: cmdReject пишет audit_logs", () => {
    const a = createApproval({
      actionId: crypto.randomUUID(),
      actionType: "UPDATE_AGENT_PROMPT",
      payload: promptPayload,
      requestedBy: "perm",
      chatId: CHAT,
    });
    const out = cmdReject({
      approvalId: a.id,
      decidedBy: "tg:777",
      chatId: CHAT,
      reason: "не сейчас",
    });
    expect(out).toContain("Rejected");
    expect(getApproval(a.id)?.status).toBe("rejected");

    const rows = auditRows();
    expect(rows.length).toBe(1);
    expect(rows[0].agent_key).toBe("smm");
    const p = JSON.parse(rows[0].payload);
    expect(p.decided_by).toBe("tg:777");
    expect(p.reject_reason).toBe("не сейчас");
  });

  test("путь Mini App: та же функция пишет ту же строку", () => {
    // Ровно то, что теперь делает POST /api/approvals/:id/decide на rejected.
    auditRejectedApproval({
      actionType: "UPDATE_AGENT_PROMPT",
      payload: promptPayload,
      decidedBy: "miniapp:777",
      chatId: CHAT,
      requestedBy: "pm",
      approvalId: "appr-web",
      reason: "через веб",
    });
    const rows = auditRows();
    expect(rows.length).toBe(1);
    const p = JSON.parse(rows[0].payload);
    expect(p.decided_by).toBe("miniapp:777");
    expect(p.reject_reason).toBe("через веб");
  });

  test("другие типы действий аудит не пишут — проверка типа внутри", () => {
    auditRejectedApproval({
      actionType: "SEND_MESSAGE",
      payload: { text: "привет" },
      decidedBy: "miniapp:777",
      chatId: CHAT,
      requestedBy: "pm",
      approvalId: "appr-other",
    });
    expect(auditRows().length).toBe(0);
  });

  test("битый payload не роняет отказ — best-effort, но не молча", () => {
    // target_agent_key отсутствует → NOT NULL/JSON всё равно проходит, но
    // главное: функция не бросает наружу ни при каком входе.
    expect(() =>
      auditRejectedApproval({
        actionType: "UPDATE_AGENT_PROMPT",
        payload: null,
        decidedBy: "tg:777",
        chatId: CHAT,
        requestedBy: "pm",
        approvalId: "appr-broken",
      }),
    ).not.toThrow();
  });
});
