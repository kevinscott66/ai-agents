/**
 * T-313 — regression tests for the 3 MED security findings from T-300
 * fixed in fix/t313-med-security:
 *
 *   #5 evaluateGate now consults per-agent autonomy mode.
 *   #6 POST /api/budgets and POST /api/tasks now require admin.
 *   #9 LIST_RECENT_MESSAGES no longer bypasses the autonomy gate
 *      (removed from the exemption set — then named READONLY_ACTIONS, since
 *      2026-08-10 LOW_FRICTION_ACTIONS and checked below the `locked` deny).
 */
import { describe, test, expect, beforeAll, afterAll, afterEach, beforeEach } from "bun:test";
import { db } from "../lib/db.ts";
import {
  evaluateGate,
  setAutonomy,
  setPermission,
  getPermission,
} from "../lib/permissions.ts";
import { buildInitData } from "../lib/miniapp-auth.ts";
import {
  startMiniappServer,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";
import {
  saveAutonomy,
  restoreAutonomy,
  cleanupChat,
  savePermissions,
} from "./_helpers.ts";

const TEST_CHAT = 999_313_001;
// T-316: use a unique agent key to avoid parallel-test state leak with other
// suites that use the real "pm" agent (c10.test.ts, c8.test.ts,
// WRITE_WIKI/CREATE_TASK/UPDATE_TASK_STATUS). Bun runs test files in parallel
// against the same SQLite DB; mid-run setAutonomy("pm","locked") here was
// causing 11 unrelated tests to fail in the full suite (T-600 finding).
const TEST_AGENT = "t313-locked-pm";
const TEST_AGENT_OTHER = "t313-other-agent";

function clearAgentAutonomy(agentKey: string): void {
  db.prepare(
    `DELETE FROM autonomy_modes WHERE scope = 'agent' AND scope_id = ?`,
  ).run(agentKey);
}

const savedGlobal = saveAutonomy();
const permRestores: Array<() => void> = [];

beforeEach(() => {
  // Ensure clean slate — other tests may leave agent rows in autonomy_modes.
  restoreAutonomy(savedGlobal);
  cleanupChat(TEST_CHAT);
  clearAgentAutonomy(TEST_AGENT);
  clearAgentAutonomy(TEST_AGENT_OTHER);
  clearAgentAutonomy("t313-orch");
});

afterEach(() => {
  restoreAutonomy(savedGlobal);
  cleanupChat(TEST_CHAT);
  clearAgentAutonomy(TEST_AGENT);
  clearAgentAutonomy(TEST_AGENT_OTHER);
  clearAgentAutonomy("t313-orch");
  // orchestrator — настоящая роль, её строку возвращаем; t313-* ключей в
  // сиде нет вовсе — их строки просто сносим, чтобы таблица не копила
  // мусорные роли. T-751.
  while (permRestores.length) permRestores.pop()!();
  for (const k of [TEST_AGENT, TEST_AGENT_OTHER, "t313-orch"]) {
    db.prepare(`DELETE FROM permissions WHERE agent_key = ?`).run(k);
  }
});

describe("T-313 finding #5 — evaluateGate respects per-agent autonomy", () => {
  test("per-agent locked overrides chat=auto and denies SEND_MESSAGE", () => {
    // Baseline: ensure permission exists and is allowed for the agent.
    setPermission(TEST_AGENT, "SEND_MESSAGE", {
      allowed: true,
      requires_approval: false,
    });
    setAutonomy("chat", String(TEST_CHAT), "auto");
    // Pre-condition: without agent override, gate must allow.
    // (auto + requires_approval=false → allow; SEMI_AUTO_RISKY only kicks
    //  in for semi_auto mode.)
    const allow = evaluateGate({
      agentKey: TEST_AGENT,
      actionType: "SEND_MESSAGE",
      chatId: TEST_CHAT,
    });
    if (allow.decision !== "allow") {
      // Debug: report what the gate actually said.
      throw new Error(`expected allow, got ${JSON.stringify(allow)}`);
    }

    // Set per-agent autonomy to locked — this is what the Mini App writes
    // when a user pauses a specific agent.
    setAutonomy("agent", TEST_AGENT, "locked");

    const denied = evaluateGate({
      agentKey: TEST_AGENT,
      actionType: "SEND_MESSAGE",
      chatId: TEST_CHAT,
    });
    expect(denied.decision).toBe("deny");
    if (denied.decision === "deny") {
      expect(denied.reason).toContain("locked");
    }
  });

  test("other agents are unaffected by per-agent lock", () => {
    setPermission(TEST_AGENT, "SEND_MESSAGE", {
      allowed: true,
      requires_approval: false,
    });
    setPermission(TEST_AGENT_OTHER, "SEND_MESSAGE", {
      allowed: true,
      requires_approval: false,
    });
    setAutonomy("chat", String(TEST_CHAT), "auto");
    setAutonomy("agent", TEST_AGENT, "locked");

    const otherAgent = evaluateGate({
      agentKey: TEST_AGENT_OTHER,
      actionType: "SEND_MESSAGE",
      chatId: TEST_CHAT,
    });
    expect(otherAgent.decision).toBe("allow");

    // Cleanup the other-agent scope (no per-agent row was written but be tidy).
    clearAgentAutonomy(TEST_AGENT_OTHER);
  });
});

describe("T-313 finding #9 — LIST_RECENT_MESSAGES respects locked autonomy", () => {
  test("locked mode denies LIST_RECENT_MESSAGES (no longer readonly bypass)", () => {
    permRestores.push(
      savePermissions([["orchestrator", "LIST_RECENT_MESSAGES"]]),
    );
    setPermission("orchestrator", "LIST_RECENT_MESSAGES", {
      allowed: true,
      requires_approval: false,
    });
    setAutonomy("chat", String(TEST_CHAT), "locked");

    const res = evaluateGate({
      agentKey: "orchestrator",
      actionType: "LIST_RECENT_MESSAGES",
      chatId: TEST_CHAT,
    });
    expect(res.decision).toBe("deny");
  });

  test("auto mode still allows LIST_RECENT_MESSAGES (regression of baseline)", () => {
    permRestores.push(
      savePermissions([["orchestrator", "LIST_RECENT_MESSAGES"]]),
    );
    setPermission("orchestrator", "LIST_RECENT_MESSAGES", {
      allowed: true,
      requires_approval: false,
    });
    setAutonomy("chat", String(TEST_CHAT), "auto");
    const res = evaluateGate({
      agentKey: "orchestrator",
      actionType: "LIST_RECENT_MESSAGES",
      chatId: TEST_CHAT,
    });
    expect(res.decision).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// Finding #6 — admin gate on POST /api/budgets and POST /api/tasks
// ---------------------------------------------------------------------------

const BOT_TOKEN = "test_bot_token_for_t313";
const ADMIN_ID = 313_001;
const NON_ADMIN_ID = 313_002;
const SERVER_CHAT_ID = -1_001_313_999;

// env preserved via try/finally
const prevBotToken = process.env.MINIAPP_BOT_TOKEN;
process.env.MINIAPP_BOT_TOKEN = BOT_TOKEN;

let server: MiniappServerHandle;
let baseUrl: string;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function initDataFor(userId: number): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(nowSec()),
    query_id: `q-${userId}`,
    user: JSON.stringify({
      id: userId,
      username: `u${userId}`,
      first_name: "Test",
      is_bot: false,
    }),
  });
}

describe("T-313 finding #6 — admin gate on POST /api/budgets and /api/tasks", () => {
  beforeAll(() => {
    server = startMiniappServer({
      port: 0,
      allowedUserIds: [ADMIN_ID, NON_ADMIN_ID],
      adminUserIds: [ADMIN_ID],
      botToken: BOT_TOKEN,
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    try {
      await server.stop();
    } finally {
      if (prevBotToken === undefined) {
        delete process.env.MINIAPP_BOT_TOKEN;
      } else {
        process.env.MINIAPP_BOT_TOKEN = prevBotToken;
      }
    }
  });

  test("non-admin POST /api/budgets returns 403", async () => {
    const res = await fetch(`${baseUrl}/api/budgets`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-init-data": initDataFor(NON_ADMIN_ID),
      },
      body: JSON.stringify({ agentKey: "pm", dailyInputTokens: 12345 }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("admin only");
  });

  test("admin POST /api/budgets succeeds", async () => {
    const res = await fetch(`${baseUrl}/api/budgets`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-init-data": initDataFor(ADMIN_ID),
      },
      body: JSON.stringify({ agentKey: "pm", dailyInputTokens: 54321 }),
    });
    expect(res.status).toBe(200);
    // Cleanup: revert the override.
    await fetch(`${baseUrl}/api/budgets`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-init-data": initDataFor(ADMIN_ID),
      },
      body: JSON.stringify({ agentKey: "pm", dailyInputTokens: null }),
    });
  });

  test("non-admin POST /api/tasks returns 403", async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-init-data": initDataFor(NON_ADMIN_ID),
      },
      body: JSON.stringify({ title: "t313 non-admin", chat_id: SERVER_CHAT_ID }),
    });
    expect(res.status).toBe(403);
  });

  test("admin POST /api/tasks succeeds", async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-init-data": initDataFor(ADMIN_ID),
      },
      body: JSON.stringify({ title: "t313 admin", chat_id: SERVER_CHAT_ID }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.task?.title).toBe("t313 admin");
    // Cleanup created task by chat_id.
    db.prepare(`DELETE FROM tasks WHERE chat_id = ?`).run(SERVER_CHAT_ID);
  });
});
