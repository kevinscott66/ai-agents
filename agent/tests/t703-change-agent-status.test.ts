/**
 * T-703 — CHANGE_AGENT_STATUS action.
 *
 * Verifies:
 *   1. Non-perm agent → forbidden (caller restriction).
 *   2. perm caller → pending_approval row created; state unchanged
 *      until approval is decided.
 *   3. cmdApprove → agent_states.status + autonomy_modes(scope=agent)
 *      mutated; audit row written.
 *   4. cmdReject → state unchanged; approval row marked rejected.
 *   5. Validation: missing both fields, invalid enums, reason too short,
 *      unknown target_agent_key.
 *   6. Always-approve override: even with autonomy=auto, still approval.
 *   7. Changing only autonomy (status undefined) works.
 *   8. Changing only status (autonomy undefined) works.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { gateOrDispatch } from "../lib/action-dispatch.ts";
import {
  getPermission,
  setPermission,
  setAutonomy,
  getAutonomy,
} from "../lib/permissions.ts";
import {
  getAgentStatus,
  setAgentStatus,
} from "../lib/dispatch/agent-status.ts";
import {
  getApproval,
  listPendingApprovals,
} from "../lib/approvals.ts";
import { cmdApprove, cmdReject } from "../lib/commands.ts";
import { db } from "../lib/db.ts";
import { saveAutonomy, restoreAutonomy } from "./_helpers.ts";

const TEST_CHAT = 999_703_703;
const PERM_AGENT = "perm";
const TARGET = "smm";

let savedGlobal = saveAutonomy();

function cleanupChatAndTarget(): void {
  db.prepare(`DELETE FROM approvals WHERE chat_id = ?`).run(TEST_CHAT);
  db.prepare(
    `DELETE FROM agent_actions WHERE chat_id = ? OR action_type = 'CHANGE_AGENT_STATUS'`,
  ).run(TEST_CHAT);
  db.prepare(
    `DELETE FROM autonomy_modes WHERE scope = 'chat' AND scope_id = ?`,
  ).run(String(TEST_CHAT));
  db.prepare(
    `DELETE FROM autonomy_modes WHERE scope = 'agent' AND scope_id = ?`,
  ).run(TARGET);
  db.prepare(`DELETE FROM agent_states WHERE agent_key = ?`).run(TARGET);
}

const validPayload = () => ({
  target_agent_key: TARGET,
  new_status: "disabled" as const,
  new_autonomy_mode: "locked" as const,
  reason: "rotating SMM agent out for prompt audit cycle",
});

beforeEach(() => {
  savedGlobal = saveAutonomy();
  cleanupChatAndTarget();
});

afterEach(() => {
  restoreAutonomy(savedGlobal);
  cleanupChatAndTarget();
});

describe("T-703 CHANGE_AGENT_STATUS — caller restriction", () => {
  test("non-perm agent → forbidden even with permission row", async () => {
    setPermission("smm", "CHANGE_AGENT_STATUS", {
      allowed: true,
      requires_approval: false,
    });
    try {
      const res = await gateOrDispatch(
        "CHANGE_AGENT_STATUS",
        validPayload(),
        { agentKey: "smm", chatId: TEST_CHAT },
      );
      expect(res.kind).toBe("forbidden");
      if (res.kind === "forbidden") {
        expect(res.reason).toContain("perm");
      }
    } finally {
      db.prepare(
        `DELETE FROM permissions WHERE agent_key = 'smm' AND action_type = 'CHANGE_AGENT_STATUS'`,
      ).run();
    }
  });

  test("orchestrator (no perm row) → forbidden", async () => {
    const res = await gateOrDispatch(
      "CHANGE_AGENT_STATUS",
      validPayload(),
      { agentKey: "orchestrator", chatId: TEST_CHAT },
    );
    expect(res.kind).toBe("forbidden");
  });
});

describe("T-703 CHANGE_AGENT_STATUS — perm caller, approval flow", () => {
  beforeEach(() => {
    setPermission(PERM_AGENT, "CHANGE_AGENT_STATUS", {
      allowed: true,
      requires_approval: false,
    });
  });

  test("perm caller → pending_approval, state unchanged", async () => {
    const beforeStatus = getAgentStatus(TARGET);
    const beforeAutonomy = getAutonomy(undefined, TARGET);
    const res = await gateOrDispatch(
      "CHANGE_AGENT_STATUS",
      validPayload(),
      { agentKey: PERM_AGENT, chatId: TEST_CHAT },
    );
    expect(res.kind).toBe("pending_approval");
    if (res.kind !== "pending_approval") throw new Error("expected approval");
    const a = getApproval(res.approvalId);
    expect(a).not.toBeNull();
    expect(a!.status).toBe("pending");
    expect(getAgentStatus(TARGET)).toEqual(beforeStatus);
    expect(getAutonomy(undefined, TARGET)).toEqual(beforeAutonomy);
  });

  test("approve → status + autonomy mutated, audit row written", async () => {
    setAgentStatus(TARGET, "active");
    setAutonomy("agent", TARGET, "auto");

    const res = await gateOrDispatch(
      "CHANGE_AGENT_STATUS",
      validPayload(),
      { agentKey: PERM_AGENT, chatId: TEST_CHAT },
    );
    if (res.kind !== "pending_approval") {
      throw new Error(`expected pending_approval, got ${res.kind}`);
    }

    const approveMsg = await cmdApprove({
      approvalId: res.approvalId,
      decidedBy: "test-admin",
      chatId: TEST_CHAT,
    });
    expect(approveMsg).toContain("approved");

    expect(getAgentStatus(TARGET)).toBe("disabled");
    expect(getAutonomy(undefined, TARGET)).toBe("locked");

    const auditRows = db
      .prepare(
        `SELECT payload FROM agent_actions
         WHERE action_type = 'CHANGE_AGENT_STATUS' AND status = 'ok'
         ORDER BY created_at DESC LIMIT 5`,
      )
      .all() as Array<{ payload: string }>;
    const diffRow = auditRows.find((r) => {
      try {
        const p = JSON.parse(r.payload);
        return p && p._diff === true && p.target_agent_key === TARGET;
      } catch {
        return false;
      }
    });
    expect(diffRow).toBeDefined();
  });

  test("reject → state unchanged, approval rejected", async () => {
    setAgentStatus(TARGET, "active");
    setAutonomy("agent", TARGET, "semi_auto");

    const res = await gateOrDispatch(
      "CHANGE_AGENT_STATUS",
      validPayload(),
      { agentKey: PERM_AGENT, chatId: TEST_CHAT },
    );
    if (res.kind !== "pending_approval") {
      throw new Error(`expected pending_approval, got ${res.kind}`);
    }

    const rejMsg = cmdReject({
      approvalId: res.approvalId,
      decidedBy: "test-admin",
      chatId: TEST_CHAT,
      reason: "not justified",
    });
    expect(rejMsg).toContain("Rejected");

    expect(getAgentStatus(TARGET)).toBe("active");
    expect(getAutonomy(undefined, TARGET)).toBe("semi_auto");

    const a = getApproval(res.approvalId);
    expect(a!.status).toBe("rejected");
  });
});

describe("T-703 CHANGE_AGENT_STATUS — validation", () => {
  beforeEach(() => {
    setPermission(PERM_AGENT, "CHANGE_AGENT_STATUS", {
      allowed: true,
      requires_approval: false,
    });
  });

  test("missing both new_status and new_autonomy_mode → error", async () => {
    const bad = {
      target_agent_key: TARGET,
      reason: "no fields supplied here at all",
    };
    const res = await gateOrDispatch("CHANGE_AGENT_STATUS", bad as never, {
      agentKey: PERM_AGENT,
      chatId: TEST_CHAT,
    });
    expect(res.kind).toBe("error");
    expect(listPendingApprovals(TEST_CHAT).length).toBe(0);
  });

  test("invalid new_status → error", async () => {
    const bad = { ...validPayload(), new_status: "frozen" as never };
    const res = await gateOrDispatch("CHANGE_AGENT_STATUS", bad, {
      agentKey: PERM_AGENT,
      chatId: TEST_CHAT,
    });
    expect(res.kind).toBe("error");
    if (res.kind === "error") {
      expect(res.error).toMatch(/invalid new_status/);
    }
  });

  test("invalid new_autonomy_mode → error", async () => {
    const bad = {
      ...validPayload(),
      new_autonomy_mode: "yolo" as never,
    };
    const res = await gateOrDispatch("CHANGE_AGENT_STATUS", bad, {
      agentKey: PERM_AGENT,
      chatId: TEST_CHAT,
    });
    expect(res.kind).toBe("error");
    if (res.kind === "error") {
      expect(res.error).toMatch(/invalid new_autonomy_mode/);
    }
  });

  test("reason < 10 chars → error", async () => {
    const bad = { ...validPayload(), reason: "short" };
    const res = await gateOrDispatch("CHANGE_AGENT_STATUS", bad, {
      agentKey: PERM_AGENT,
      chatId: TEST_CHAT,
    });
    expect(res.kind).toBe("error");
  });

  test("unknown target_agent_key → error", async () => {
    const bad = {
      ...validPayload(),
      target_agent_key: "definitely-not-a-role",
    };
    const res = await gateOrDispatch("CHANGE_AGENT_STATUS", bad, {
      agentKey: PERM_AGENT,
      chatId: TEST_CHAT,
    });
    expect(res.kind).toBe("error");
    if (res.kind === "error") {
      expect(res.error).toMatch(/unknown target_agent_key/);
    }
  });
});

describe("T-703 CHANGE_AGENT_STATUS — always-approve override", () => {
  test("autonomy=auto still produces pending_approval", async () => {
    setPermission(PERM_AGENT, "CHANGE_AGENT_STATUS", {
      allowed: true,
      requires_approval: false,
    });
    setAutonomy("global", "*", "auto");
    const res = await gateOrDispatch(
      "CHANGE_AGENT_STATUS",
      validPayload(),
      { agentKey: PERM_AGENT, chatId: TEST_CHAT },
    );
    expect(res.kind).toBe("pending_approval");
  });
});

describe("T-703 CHANGE_AGENT_STATUS — partial updates", () => {
  beforeEach(() => {
    setPermission(PERM_AGENT, "CHANGE_AGENT_STATUS", {
      allowed: true,
      requires_approval: false,
    });
  });

  test("autonomy-only (status undefined) → only autonomy changes", async () => {
    setAgentStatus(TARGET, "active");
    setAutonomy("agent", TARGET, "auto");

    const payload = {
      target_agent_key: TARGET,
      new_autonomy_mode: "manual" as const,
      reason: "drop SMM to manual review for the weekend",
    };
    const res = await gateOrDispatch("CHANGE_AGENT_STATUS", payload, {
      agentKey: PERM_AGENT,
      chatId: TEST_CHAT,
    });
    if (res.kind !== "pending_approval") {
      throw new Error(`expected pending_approval, got ${res.kind}`);
    }
    await cmdApprove({
      approvalId: res.approvalId,
      decidedBy: "test-admin",
      chatId: TEST_CHAT,
    });

    expect(getAgentStatus(TARGET)).toBe("active");
    expect(getAutonomy(undefined, TARGET)).toBe("manual");
  });

  test("status-only (autonomy undefined) → only status changes", async () => {
    setAgentStatus(TARGET, "active");
    setAutonomy("agent", TARGET, "semi_auto");

    const payload = {
      target_agent_key: TARGET,
      new_status: "disabled" as const,
      reason: "disabling agent during incident response window",
    };
    const res = await gateOrDispatch("CHANGE_AGENT_STATUS", payload, {
      agentKey: PERM_AGENT,
      chatId: TEST_CHAT,
    });
    if (res.kind !== "pending_approval") {
      throw new Error(`expected pending_approval, got ${res.kind}`);
    }
    await cmdApprove({
      approvalId: res.approvalId,
      decidedBy: "test-admin",
      chatId: TEST_CHAT,
    });

    expect(getAgentStatus(TARGET)).toBe("disabled");
    expect(getAutonomy(undefined, TARGET)).toBe("semi_auto");
  });
});
