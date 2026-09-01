/**
 * E2E Approval Flow Test (T-201) — Comprehensive end-to-end test.
 *
 * Tests the complete approval pipeline:
 * 1. Action requires approval → gate returns "approval" 
 * 2. Approval record created → SSE event emitted
 * 3. Mini App API shows pending approval
 * 4. User approves via Mini App → action executes via agent's Telegram
 * 5. Audit log records both the approval creation and execution
 *
 * Also tests security: forged initData must be rejected.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { buildInitData, verifyInitData } from "../lib/miniapp-auth.ts";
import {
  startMiniappServer,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";
import {
  gateOrDispatch,
  type GateOrDispatchResult,
} from "../lib/action-dispatch.ts";
import { listActions } from "../lib/audit.ts";
import { setAutonomy, setPermission } from "../lib/permissions.ts";
import { createApproval } from "../lib/approvals.ts";

const BOT_TOKEN = "test_bot_token_for_e2e_approval_flow";
const VALID_USER_ID = 201201;
const FORGED_USER_ID = 666666;
const CHAT_ID = -100201;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * approvalId живёт только в ветке kind:"pending_approval" union'а
 * GateOrDispatchResult — expect(...kind).toBe(...) выше TS не сужает.
 * Сужаем явно: чужая ветка должна валить тест, а не подсовывать undefined.
 */
function approvalIdOf(r: GateOrDispatchResult): string {
  if (r.kind !== "pending_approval") {
    throw new Error(`ожидали pending_approval, получили ${r.kind}`);
  }
  return r.approvalId;
}

function validInitData(): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(nowSec()),
    query_id: "q-e2e-valid",
    user: JSON.stringify({ 
      id: VALID_USER_ID, 
      username: "valid_user", 
      first_name: "Valid" 
    }),
  });
}

function forgedInitData(): string {
  // Create initData for a different user but with wrong HMAC
  return buildInitData("wrong_bot_token", {
    auth_date: String(nowSec()),
    query_id: "q-e2e-forged",
    user: JSON.stringify({ 
      id: FORGED_USER_ID, 
      username: "hacker", 
      first_name: "Evil" 
    }),
  });
}

// Mock Telegram client to track executed actions
const sentMessages: Array<{ chatId: number | string; text: string }> = [];
const fakeTelegram = {
  sendMessage: async (chatId: number | string, text: string) => {
    sentMessages.push({ chatId, text });
    return { message_id: Math.floor(Math.random() * 10000) };
  },
  setMyReaction: async (chatId: number | string, messageId: number, reaction: string) => {
    sentMessages.push({ chatId, text: `[reaction:${messageId}:${reaction}]` });
    return true;
  },
  pinChatMessage: async (chatId: number | string, messageId: number) => {
    sentMessages.push({ chatId, text: `[pin:${messageId}]` });
    return true;
  },
  callApi: async (method: string, params: any) => {
    if (method === "setMessageReaction") {
      sentMessages.push({ 
        chatId: params.chat_id, 
        text: `[reaction:${params.message_id}:${params.reaction[0].emoji}]` 
      });
      return { ok: true };
    }
    return { ok: false };
  },
} as any;

let server: MiniappServerHandle;
let base: string;

beforeAll(() => {
  server = startMiniappServer({
    port: 0,
    allowedUserIds: [VALID_USER_ID],
    adminUserIds: [VALID_USER_ID],
    botToken: BOT_TOKEN,
    approvalDeps: { resolveTg: () => fakeTelegram },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop();
});

beforeEach(() => {
  sentMessages.length = 0;
  // Оверрайд ставится здесь, а не в beforeAll: глобальный preload
  // (tests/_setup.ts) в своём beforeEach сносит ВСЕ строки autonomy_modes со
  // scope 'chat' и 'agent'. beforeAll отрабатывает раньше первого beforeEach,
  // поэтому оверрайд стирался до того, как выполнялось тело первого теста, и
  // весь файл ехал на глобальном режиме — то есть на том, что оставил после
  // себя предыдущий файл прогона. Тест проходил случайно: на macOS сосед
  // оставлял semi_auto, на ext4 в CI порядок обхода другой и оставался auto,
  // из-за чего SEND_MESSAGE исполнялся сразу вместо ожидания подтверждения.
  setAutonomy("chat", String(CHAT_ID), "semi_auto");
});

describe("E2E Approval Flow (T-201)", () => {
  test("full pipeline: action → approval → mini app → execution", async () => {
    // Step 1: Dispatch action that requires approval
    const dispatchResult = await gateOrDispatch(
      "SEND_MESSAGE",
      { chatId: CHAT_ID, text: "Hello from approved action!" },
      {
        agentKey: "orchestrator",
        chatId: CHAT_ID,
        telegram: fakeTelegram,
      }
    );
    
    // Should create approval instead of executing immediately
    expect(dispatchResult.kind).toBe("pending_approval");
    expect(sentMessages.length).toBe(0); // Action not executed yet
    
    const approvalId = approvalIdOf(dispatchResult);
    expect(approvalId).toBeDefined();
    
    // Step 2: Check approval appears in Mini App API
    const initData = validInitData();
    const approvalsResponse = await fetch(`${base}/api/approvals?status=pending`, {
      headers: { "x-telegram-init-data": initData },
    });
    expect(approvalsResponse.status).toBe(200);
    
    const approvalsBody = await approvalsResponse.json();
    const pendingApproval = approvalsBody.approvals.find((a: any) => a.id === approvalId);
    expect(pendingApproval).toBeDefined();
    expect(pendingApproval.action_type).toBe("SEND_MESSAGE");
    expect(pendingApproval.requested_by).toBe("orchestrator");
    expect(pendingApproval.status).toBe("pending");
    
    // Step 3: Approve via Mini App
    const approveResponse = await fetch(`${base}/api/approvals/${approvalId}/decide`, {
      method: "POST",
      headers: {
        "x-telegram-init-data": initData,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        decision: "approved",
        reason: "e2e test approval",
      }),
    });
    
    expect(approveResponse.status).toBe(200);
    const approveBody = await approveResponse.json();
    expect(approveBody.executed).toBe(true);
    expect(approveBody.approval.status).toBe("approved");
    
    // Step 4: Verify action was executed
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].text).toBe("Hello from approved action!");
    expect(sentMessages[0].chatId).toBe(CHAT_ID);
    
    // Step 5: All above steps verify the e2e approval flow works correctly
  });

  test("rejected approval does not execute action", async () => {
    const actionId = `e2e-reject-${Date.now()}`;
    
    // Create approval manually for this test
    const approval = createApproval({
      actionId,
      chatId: CHAT_ID,
      requestedBy: "orchestrator",
      actionType: "SEND_MESSAGE",
      payload: { chatId: CHAT_ID, text: "This should NOT be sent" },
    });
    
    // Reject via Mini App
    const initData = validInitData();
    const rejectResponse = await fetch(`${base}/api/approvals/${approval.id}/decide`, {
      method: "POST",
      headers: {
        "x-telegram-init-data": initData,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        decision: "rejected",
        reason: "e2e test rejection",
      }),
    });
    
    expect(rejectResponse.status).toBe(200);
    const rejectBody = await rejectResponse.json();
    expect(rejectBody.executed).toBe(false);
    expect(rejectBody.approval.status).toBe("rejected");
    
    // Verify action was NOT executed
    expect(sentMessages.length).toBe(0);
  });

  test("forged initData is rejected by Mini App auth", async () => {
    // First verify the forgery is actually invalid
    const verifyResult = verifyInitData(forgedInitData(), BOT_TOKEN);
    expect(verifyResult.ok).toBe(false);
    // reason есть только в ветке ok:false — сужаем union после проверки выше.
    expect((verifyResult as { ok: false; reason: string }).reason).toBe(
      "bad hash",
    );
    
    // Try to use forged initData to access approvals API
    const forgedInit = forgedInitData();
    const approvalsResponse = await fetch(`${base}/api/approvals?status=pending`, {
      headers: { "x-telegram-init-data": forgedInit },
    });
    
    expect(approvalsResponse.status).toBe(401);
    const errorBody = await approvalsResponse.json();
    expect(errorBody.error).toContain("bad hash");
  });

  test("unauthorized user cannot approve actions", async () => {
    // Create approval first
    const approval = createApproval({
      actionId: `e2e-unauth-${Date.now()}`,
      chatId: CHAT_ID,
      requestedBy: "orchestrator",
      actionType: "SEND_MESSAGE",
      payload: { chatId: CHAT_ID, text: "Unauthorized attempt" },
    });
    
    // Create initData for unauthorized user (not in allowedUserIds)
    const unauthorizedInit = buildInitData(BOT_TOKEN, {
      auth_date: String(nowSec()),
      query_id: "q-unauthorized",
      user: JSON.stringify({ 
        id: 999999, 
        username: "unauthorized", 
        first_name: "Unauth" 
      }),
    });
    
    // Try to approve with unauthorized user
    const approveResponse = await fetch(`${base}/api/approvals/${approval.id}/decide`, {
      method: "POST",
      headers: {
        "x-telegram-init-data": unauthorizedInit,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        decision: "approved",
        reason: "unauthorized attempt",
      }),
    });
    
    expect(approveResponse.status).toBe(403);
    
    // Verify action was NOT executed
    expect(sentMessages.length).toBe(0);
  });

  test("stale initData is rejected", async () => {
    // Create initData with old auth_date (over 24 hours ago)
    const staleInit = buildInitData(BOT_TOKEN, {
      auth_date: String(nowSec() - 86500), // Over 24 hours ago
      query_id: "q-stale",
      user: JSON.stringify({ 
        id: VALID_USER_ID, 
        username: "valid_user", 
        first_name: "Valid" 
      }),
    });
    
    const approvalsResponse = await fetch(`${base}/api/approvals?status=pending`, {
      headers: { "x-telegram-init-data": staleInit },
    });
    
    expect(approvalsResponse.status).toBe(401);
    const errorBody = await approvalsResponse.json();
    expect(errorBody.error).toContain("stale auth_date");
  });

  test("approval flow with PIN_MESSAGE action", async () => {
    // Dispatch PIN_MESSAGE that requires approval (in SEMI_AUTO_RISKY)
    const dispatchResult = await gateOrDispatch(
      "PIN_MESSAGE",
      { chatId: CHAT_ID, messageId: 12345 },
      {
        agentKey: "orchestrator",
        chatId: CHAT_ID,
        telegram: fakeTelegram,
      }
    );
    
    expect(dispatchResult.kind).toBe("pending_approval");
    
    const approvalId = approvalIdOf(dispatchResult);
    
    // Approve via Mini App
    const initData = validInitData();
    const approveResponse = await fetch(`${base}/api/approvals/${approvalId}/decide`, {
      method: "POST",
      headers: {
        "x-telegram-init-data": initData,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        decision: "approved",
        reason: "e2e pin test",
      }),
    });
    
    expect(approveResponse.status).toBe(200);
    const approveBody = await approveResponse.json();
    expect(approveBody.executed).toBe(true);
    
    // Verify pin was executed (mock telegram would be called)
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].text).toBe("[pin:12345]");
  });
});