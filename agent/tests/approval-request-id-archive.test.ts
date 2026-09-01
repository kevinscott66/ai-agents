/**
 * Аудит 2026-08-14: `request_id` заявки берётся джойном к `agent_actions`, но
 * строки этой таблицы уезжают в `agent_actions_archive` по 30-суточному
 * отсечению (ADR-0007). После переноса джойн находил пусто, и заявка снова
 * теряла связь с ходом агента — ровно та потеря, ради которой джойн заводился.
 *
 * Замер до правки: действие перенесено в архив → getApproval().request_id ===
 * null (было `req-original`).
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { db } from "../lib/db.ts";
import {
  createApproval,
  getApproval,
  resolveApproval,
  listPendingApprovals,
} from "../lib/approvals.ts";
import { logAction } from "../lib/audit.ts";

const CHAT = -100888;
const REQ = "req-original";

/** Переносит строку действия в архив ровно так, как это делает db-maint. */
function archiveAction(actionId: string, now = Date.now()): void {
  db.prepare(
    `INSERT INTO agent_actions_archive(
       id, agent_key, task_id, chat_id, action_type, payload, status, result,
       error, created_at, archived_at, tg_message_id, request_id)
     SELECT id, agent_key, task_id, chat_id, action_type, payload, status,
            result, error, created_at, ?, tg_message_id, request_id
       FROM agent_actions WHERE id = ?`,
  ).run(now, actionId);
  db.prepare(`DELETE FROM agent_actions WHERE id = ?`).run(actionId);
}

function seed(): { actionId: string; approvalId: string } {
  const { id: actionId } = logAction({
    agentKey: "smm",
    chatId: CHAT,
    actionType: "EDIT_MESSAGE",
    payload: { chatId: CHAT, messageId: 1, text: "правка" },
    status: "pending_approval",
    requestId: REQ,
  });
  const approval = createApproval({
    actionId,
    chatId: CHAT,
    requestedBy: "smm",
    actionType: "EDIT_MESSAGE",
    payload: { chatId: CHAT, messageId: 1, text: "правка" },
  });
  return { actionId, approvalId: approval.id };
}

beforeEach(() => {
  db.prepare(`DELETE FROM approvals`).run();
  db.prepare(`DELETE FROM agent_actions_archive WHERE chat_id = ?`).run(CHAT);
  db.prepare(`DELETE FROM agent_actions WHERE chat_id = ?`).run(CHAT);
});

describe("request_id переживает архивацию действия", () => {
  test("до архивации — как и было", () => {
    const { approvalId } = seed();
    expect(getApproval(approvalId)?.request_id).toBe(REQ);
  });

  test("после архивации getApproval всё ещё отдаёт request_id", () => {
    const { actionId, approvalId } = seed();
    archiveAction(actionId);

    expect(db.prepare(`SELECT 1 FROM agent_actions WHERE id=?`).get(actionId)).toBeNull();
    expect(getApproval(approvalId)?.request_id).toBe(REQ);
  });

  test("resolveApproval по префиксу — тоже", () => {
    const { actionId, approvalId } = seed();
    archiveAction(actionId);

    expect(resolveApproval(approvalId.slice(0, 8))?.request_id).toBe(REQ);
  });

  test("listPendingApprovals — тоже", () => {
    const { actionId, approvalId } = seed();
    archiveAction(actionId);

    const row = listPendingApprovals(CHAT).find((a) => a.id === approvalId);
    expect(row?.request_id).toBe(REQ);
  });

  test("живая таблица остаётся первым источником, архив — запасным", () => {
    const { actionId, approvalId } = seed();
    // Патологический случай: строка есть и там, и там (прогон оборвался между
    // INSERT и DELETE). COALESCE обязан взять живую.
    archiveAction(actionId);
    db.prepare(
      `INSERT INTO agent_actions(id, agent_key, chat_id, action_type, payload,
                                 status, created_at, request_id)
       VALUES (?, 'smm', ?, 'EDIT_MESSAGE', '{}', 'pending', ?, 'req-live')`,
    ).run(actionId, CHAT, Date.now());

    expect(getApproval(approvalId)?.request_id).toBe("req-live");
  });

  test("действия нет нигде — null, а не падение", () => {
    const { actionId, approvalId } = seed();
    archiveAction(actionId);
    db.prepare(`DELETE FROM agent_actions_archive WHERE id = ?`).run(actionId);

    expect(getApproval(approvalId)?.request_id ?? null).toBeNull();
  });
});
