/**
 * T-547 — Mini App approval must EXECUTE the action, not just flip status.
 *
 * Regression for a prod bug: approving an action in the Mini App called
 * decideApproval() (status → approved + SSE) but never executeApproved(), so
 * the underlying action (DELETE_MESSAGE / SEND_MESSAGE / …) never ran. In prod
 * 11 Mini App approvals left every DELETE_MESSAGE stuck in `pending_approval`.
 *
 * These tests drive the real HTTP route /api/approvals/:id/decide and assert
 * that an "approved" decision actually dispatches the action via the requesting
 * agent's Telegram client (resolveTg), while "rejected" does not.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { buildInitData } from "../lib/miniapp-auth.ts";
import {
  startMiniappServer,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";
import { createApproval } from "../lib/approvals.ts";
import { executeApproved } from "../lib/commands.ts";
import { setPermission } from "../lib/permissions.ts";
import { savePermissions } from "./_helpers.ts";
import { db } from "../lib/db.ts";

const BOT_TOKEN = "test_bot_token_for_t547_placeholder";
const USER_ID = 547547;
const CHAT_ID = -100547;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function freshInitData(): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(nowSec()),
    query_id: "q-t547",
    user: JSON.stringify({ id: USER_ID, username: "approver", first_name: "A" }),
  });
}

// Records every sendMessage the executed action performs, proving the action
// actually reached the agent's Telegram client.
const sent: Array<{ chatId: number | string; text: string }> = [];
const fakeTelegram = {
  sendMessage: async (chatId: number | string, text: string) => {
    sent.push({ chatId, text });
    return { message_id: 4242 };
  },
} as any;

let server: MiniappServerHandle;
let base: string;
let sessionInitData: string | undefined;
let sessionCookie: string | undefined;

beforeAll(() => {
  server = startMiniappServer({
    port: 0,
    allowedUserIds: [USER_ID],
    adminUserIds: [USER_ID],
    botToken: BOT_TOKEN,
    // The fix under test: wire a Telegram resolver so approved actions run.
    approvalDeps: { resolveTg: () => fakeTelegram },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop();
});

async function decide(approvalId: string, decision: "approved" | "rejected") {
  const initData = sessionInitData ?? freshInitData();
  sessionInitData = initData;
  const r = await fetch(`${base}/api/approvals/${approvalId}/decide`, {
    method: "POST",
    headers: {
      "x-telegram-init-data": initData,
      ...(sessionCookie ? { cookie: sessionCookie } : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify({ decision, reason: "t547" }),
  });
  const setCookie = r.headers.get("set-cookie");
  if (setCookie) sessionCookie = setCookie.split(";", 1)[0];
  return { status: r.status, body: await r.json() };
}

describe("T-547 Mini App approval executes the action", () => {
  test("approved SEND_MESSAGE actually dispatches via resolveTg", async () => {
    sent.length = 0;
    const approval = createApproval({
      actionId: "t547-action-send",
      chatId: CHAT_ID,
      requestedBy: "copy",
      actionType: "SEND_MESSAGE",
      payload: { chatId: CHAT_ID, text: "hello-from-approval" },
    });

    const { status, body } = await decide(approval.id, "approved");

    expect(status).toBe(200);
    expect(body.executed).toBe(true);
    expect(body.approval.status).toBe("approved");
    // Core assertion: the action reached Telegram (was NOT a no-op).
    expect(sent.length).toBe(1);
    expect(sent[0].text).toBe("hello-from-approval");
  });

  test("rejected decision does NOT execute the action", async () => {
    sent.length = 0;
    const approval = createApproval({
      actionId: "t547-action-reject",
      chatId: CHAT_ID,
      requestedBy: "copy",
      actionType: "SEND_MESSAGE",
      payload: { chatId: CHAT_ID, text: "should-not-send" },
    });

    const { status, body } = await decide(approval.id, "rejected");

    expect(status).toBe(200);
    expect(body.executed).toBe(false);
    expect(body.approval.status).toBe("rejected");
    expect(sent.length).toBe(0);
  });

  test("double-decide is rejected (no second execution)", async () => {
    sent.length = 0;
    const approval = createApproval({
      actionId: "t547-action-double",
      chatId: CHAT_ID,
      requestedBy: "copy",
      actionType: "SEND_MESSAGE",
      payload: { chatId: CHAT_ID, text: "once-only" },
    });

    const first = await decide(approval.id, "approved");
    expect(first.status).toBe(200);
    expect(sent.length).toBe(1);

    // Second decide must fail (decideApproval guards non-pending) and must NOT
    // execute the action again.
    const second = await decide(approval.id, "approved");
    expect(second.status).toBeGreaterThanOrEqual(400);
    expect(sent.length).toBe(1);
  });
});

/**
 * Аудит 2026-08-04: между созданием апрува и нажатием «Approve» запрет мог
 * появиться — и не действовал. executeApproved перепроверял только
 * CALLER_RESTRICTED, а isAgentDisabled/permissions/autonomy не звались вовсе,
 * потому что диспатч идёт напрямую, мимо гейта.
 */
describe("одобренное действие перепроверяет deny-слои гейта", () => {
  function setStatus(agentKey: string, status: "active" | "disabled") {
    db.prepare(
      `INSERT INTO agent_states(agent_key, status, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(agent_key) DO UPDATE SET status = excluded.status,
         updated_at = excluded.updated_at`,
    ).run(agentKey, status, Date.now());
  }

  function pendingApproval(text: string) {
    return createApproval({
      actionId: `t547-gate-${text}`,
      chatId: CHAT_ID,
      requestedBy: "copy",
      actionType: "SEND_MESSAGE",
      payload: { chatId: CHAT_ID, text },
    });
  }

  test("агента выключили после создания апрува — действие не уходит", async () => {
    const approval = pendingApproval("от выключенного");
    const before = sent.length;
    setStatus("copy", "disabled");
    try {
      await expect(
        executeApproved(approval, { resolveTg: () => fakeTelegram }),
      ).rejects.toThrow(/blocked at execution: agent disabled/);
    } finally {
      setStatus("copy", "active");
    }
    expect(sent.length).toBe(before);
  });

  test("право отозвали после создания апрува — действие не уходит", async () => {
    const approval = pendingApproval("без права");
    const before = sent.length;
    // Снимок, а не возврат к «allowed=true, approval=false» на память: то, что
    // сейчас совпадает с сидом миграции 007, останется верным ровно до первого
    // изменения сида — а расплатится за это чужой файл в случайном порядке
    // прогона. T-751.
    const restorePerms = savePermissions([["copy", "SEND_MESSAGE"]]);
    setPermission("copy", "SEND_MESSAGE", { allowed: false, requires_approval: false });
    try {
      await expect(
        executeApproved(approval, { resolveTg: () => fakeTelegram }),
      ).rejects.toThrow(/blocked at execution: permission denied/);
    } finally {
      restorePerms();
    }
    expect(sent.length).toBe(before);
  });
});
