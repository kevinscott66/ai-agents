// T-546: listPendingApprovals surfaces the originating agent turn's request_id
// (via JOIN to agent_actions) so the Mini App can group a batch into one card.
import { test, expect, describe } from "bun:test";
import { logAction } from "../lib/audit.ts";
import { createApproval, listPendingApprovals } from "../lib/approvals.ts";

describe("approval request_id grouping key (T-546)", () => {
  test("listPendingApprovals returns the action's request_id", () => {
    const chatId = -1_000_000 - Math.floor(performance.now());
    const reqId = `req-${chatId}`;
    // Two approvals from ONE agent turn (same request_id) + one solo action.
    // Статус — "pending_approval": ровно его пишет gateOrDispatch, когда
    // заводит заявку. Раньше стояло "approval", которого в ActionStatus нет.
    const a1 = logAction({ agentKey: "qa", chatId, actionType: "DELETE_MESSAGE", payload: {}, status: "pending_approval", requestId: reqId });
    const a2 = logAction({ agentKey: "qa", chatId, actionType: "DELETE_MESSAGE", payload: {}, status: "pending_approval", requestId: reqId });
    const a3 = logAction({ agentKey: "qa", chatId, actionType: "SEND_MESSAGE", payload: {}, status: "pending_approval", requestId: null });

    createApproval({ actionId: a1.id, chatId, requestedBy: "qa", actionType: "DELETE_MESSAGE", payload: {} });
    createApproval({ actionId: a2.id, chatId, requestedBy: "qa", actionType: "DELETE_MESSAGE", payload: {} });
    createApproval({ actionId: a3.id, chatId, requestedBy: "qa", actionType: "SEND_MESSAGE", payload: {} });

    const pending = listPendingApprovals(chatId);
    expect(pending.length).toBe(3);
    const withReq = pending.filter((p) => p.request_id === reqId);
    expect(withReq.length).toBe(2); // the batch shares one request_id
    const solo = pending.filter((p) => p.request_id === null);
    expect(solo.length).toBe(1); // the SEND_MESSAGE has none
  });

  test("an approval with no backing action row has request_id null", () => {
    const chatId = -2_000_000 - Math.floor(performance.now());
    createApproval({ actionId: "no-such-action", chatId, requestedBy: "qa", actionType: "PIN_MESSAGE", payload: {} });
    const pending = listPendingApprovals(chatId);
    expect(pending.length).toBe(1);
    expect(pending[0].request_id).toBe(null);
  });
});
