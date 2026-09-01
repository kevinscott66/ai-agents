/**
 * C32 — Approval e2e test: verifies approval UI reflects within 2s (T-230).
 *
 * Tests:
 * - Approval created → approval.created SSE event → UI refresh
 * - Approval decided → approval.decided SSE event → UI refresh 
 * - Both events delivered within 2 seconds
 */
process.env.MINIAPP_BOT_TOKEN = "test_bot_token_for_c32";

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { sseUrl } from "./_sse.ts";
import { buildInitData } from "../lib/miniapp-auth.ts";
import {
  startMiniappServer,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";
import {
  emit as busEmit,
  subscribe as busSubscribe,
} from "../lib/events-bus.ts";
import { createApproval, type CreateApprovalInput } from "../lib/approvals.ts";

const BOT_TOKEN = "test_bot_token_for_c32";
const USER_ID = 323232;
const CHAT_ID = -100323;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function freshInitData(): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(nowSec()),
    query_id: "q-approval-e2e",
    user: JSON.stringify({ id: USER_ID, username: "approve", first_name: "A" }),
  });
}

let server: MiniappServerHandle;
let base: string;

beforeAll(() => {
  server = startMiniappServer({
    port: 0,
    allowedUserIds: [USER_ID],
    adminUserIds: [USER_ID],
    botToken: BOT_TOKEN,
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop();
});

describe("C32 approval e2e", () => {
  test("approval.created SSE event delivered within 2s", async () => {
    const initData = freshInitData();
    const ctrl = new AbortController();
    
    // Start SSE connection
    const r = await fetch(
      await sseUrl(base, initData),
      { signal: ctrl.signal },
    );
    expect(r.status).toBe(200);
    
    const reader = r.body!.getReader();
    const dec = new TextDecoder();
    
    let gotApprovalCreated = false;
    const startTime = Date.now();
    
    // Create approval after SSE connection is established
    setTimeout(() => {
      const approvalInput: CreateApprovalInput = {
        actionId: "test-action-123",
        chatId: CHAT_ID,
        requestedBy: "test-agent",
        actionType: "TEST_ACTION",
        payload: { test: true },
      };
      createApproval(approvalInput);
    }, 100);
    
    let buf = "";
    const deadline = Date.now() + 3000; // 3s timeout
    
    while (Date.now() < deadline && !gotApprovalCreated) {
      const { value, done } = await reader.read();
      if (done) break;
      
      buf += dec.decode(value, { stream: true });
      
      if (buf.includes("event: approval.created")) {
        gotApprovalCreated = true;
        const elapsed = Date.now() - startTime;
        expect(elapsed).toBeLessThan(2000); // Must be within 2s
        break;
      }
    }
    
    ctrl.abort();
    try {
      reader.releaseLock();
    } catch {}
    
    expect(gotApprovalCreated).toBe(true);
  });
  
  test("approval.decided SSE event delivered within 2s", async () => {
    const initData = freshInitData();
    
    // First create an approval
    const approvalInput: CreateApprovalInput = {
      actionId: "test-action-456",
      chatId: CHAT_ID,
      requestedBy: "test-agent",
      actionType: "TEST_ACTION",
      payload: { test: true },
    };
    const approval = createApproval(approvalInput);
    
    // Start SSE connection
    const ctrl = new AbortController();
    const r = await fetch(
      await sseUrl(base, initData),
      { signal: ctrl.signal },
    );
    expect(r.status).toBe(200);
    
    const reader = r.body!.getReader();
    const dec = new TextDecoder();
    
    let gotApprovalDecided = false;
    const startTime = Date.now();
    
    // Decide the approval after SSE connection is established
    setTimeout(async () => {
      await fetch(`${base}/api/approvals/${approval.id}/decide`, {
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
    }, 100);
    
    let buf = "";
    const deadline = Date.now() + 3000; // 3s timeout
    
    while (Date.now() < deadline && !gotApprovalDecided) {
      const { value, done } = await reader.read();
      if (done) break;
      
      buf += dec.decode(value, { stream: true });
      
      if (buf.includes("event: approval.decided")) {
        gotApprovalDecided = true;
        const elapsed = Date.now() - startTime;
        expect(elapsed).toBeLessThan(2000); // Must be within 2s
        break;
      }
    }
    
    ctrl.abort();
    try {
      reader.releaseLock();
    } catch {}
    
    expect(gotApprovalDecided).toBe(true);
  });
  
  test("approval UI reflects changes within 2s (integration test)", async () => {
    const initData = freshInitData();
    
    // Get initial approvals count
    const initialR = await fetch(`${base}/api/approvals?status=pending`, {
      headers: { "x-telegram-init-data": initData },
    });
    const initialBody = await initialR.json();
    const initialCount = initialBody.approvals.length;
    
    // Create new approval
    const approvalInput: CreateApprovalInput = {
      actionId: "ui-test-789",
      chatId: CHAT_ID,
      requestedBy: "test-agent",
      actionType: "TEST_UI_ACTION", 
      payload: { ui: true },
    };
    const approval = createApproval(approvalInput);
    
    // Check that approval appears in API within 2s
    const startTime = Date.now();
    let foundApproval = false;
    
    while (!foundApproval && Date.now() - startTime < 2000) {
      const r = await fetch(`${base}/api/approvals?status=pending`, {
        headers: { "x-telegram-init-data": initData },
      });
      const body = await r.json();
      
      foundApproval = body.approvals.some((a: any) => a.id === approval.id);
      
      if (!foundApproval) {
        await new Promise(resolve => setTimeout(resolve, 100)); // Wait 100ms before retry
      }
    }
    
    const createElapsed = Date.now() - startTime;
    expect(foundApproval).toBe(true);
    expect(createElapsed).toBeLessThan(2000);
    
    // Now decide the approval and verify it disappears from pending within 2s
    const decideStartTime = Date.now();
    await fetch(`${base}/api/approvals/${approval.id}/decide`, {
      method: "POST",
      headers: {
        "x-telegram-init-data": initData,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        decision: "approved",
        reason: "ui test approval",
      }),
    });
    
    let approvalDecided = false;
    
    while (!approvalDecided && Date.now() - decideStartTime < 2000) {
      const r = await fetch(`${base}/api/approvals?status=pending`, {
        headers: { "x-telegram-init-data": initData },
      });
      const body = await r.json();
      
      approvalDecided = !body.approvals.some((a: any) => a.id === approval.id);
      
      if (!approvalDecided) {
        await new Promise(resolve => setTimeout(resolve, 100)); // Wait 100ms before retry
      }
    }
    
    const decideElapsed = Date.now() - decideStartTime;
    expect(approvalDecided).toBe(true);
    expect(decideElapsed).toBeLessThan(2000);
  });
});