/**
 * T-701 — GRANT_PERMISSION action.
 *
 * Verifies:
 *   1. Non-perm agent → forbidden (caller restriction).
 *   2. perm caller → pending_approval row created; permissions table unchanged
 *      until approval is decided.
 *   3. cmdApprove (executes via dispatchAndAudit) → permissions row mutated;
 *      audit row written.
 *   4. cmdReject → permissions unchanged; approval row marked rejected.
 *   5. reason < 10 chars → error (not approval).
 *   6. unknown target_agent_key → error.
 *   7. unknown action_type → error.
 *   8. always-approve override: even with autonomy=auto, still approval.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { gateOrDispatch } from "../lib/action-dispatch.ts";
import {
  getPermission,
  setPermission,
  setAutonomy,
} from "../lib/permissions.ts";
import {
  getApproval,
  listPendingApprovals,
} from "../lib/approvals.ts";
import { cmdApprove, cmdReject } from "../lib/commands.ts";
import { db } from "../lib/db.ts";
import { saveAutonomy, restoreAutonomy } from "./_helpers.ts";

const TEST_CHAT = 999_701_701;
const PERM_AGENT = "perm";
const TARGET = "smm";

let savedGlobal = saveAutonomy();

function cleanupChatAndTarget(): void {
  db.prepare(`DELETE FROM approvals WHERE chat_id = ?`).run(TEST_CHAT);
  db.prepare(
    `DELETE FROM agent_actions WHERE chat_id = ? OR action_type = 'GRANT_PERMISSION'`,
  ).run(TEST_CHAT);
  db.prepare(
    `DELETE FROM autonomy_modes WHERE scope = 'chat' AND scope_id = ?`,
  ).run(String(TEST_CHAT));
}

function snapshotPerm(agent: string, action: string) {
  return getPermission(agent, action as never);
}

function restorePerm(
  agent: string,
  action: string,
  p: { allowed: boolean; requires_approval: boolean },
) {
  setPermission(agent, action as never, p);
}

const validPayload = () => ({
  target_agent_key: TARGET,
  action_type: "SET_REACTION",
  allowed: true,
  requires_approval: false,
  reason: "smm needs reactions for daily engagement metrics",
});

beforeEach(() => {
  savedGlobal = saveAutonomy();
  cleanupChatAndTarget();
});

afterEach(() => {
  restoreAutonomy(savedGlobal);
  cleanupChatAndTarget();
});

describe("T-701 GRANT_PERMISSION — caller restriction", () => {
  test("non-perm agent → forbidden", async () => {
    // even if we artificially grant SMM a permissions row for GRANT_PERMISSION,
    // caller restriction in evaluateGate refuses.
    setPermission("smm", "GRANT_PERMISSION", {
      allowed: true,
      requires_approval: false,
    });
    try {
      const res = await gateOrDispatch("GRANT_PERMISSION", validPayload(), {
        agentKey: "smm",
        chatId: TEST_CHAT,
      });
      expect(res.kind).toBe("forbidden");
      if (res.kind === "forbidden") {
        expect(res.reason).toContain("perm");
      }
    } finally {
      // clear the artificial row
      db.prepare(
        `DELETE FROM permissions WHERE agent_key = 'smm' AND action_type = 'GRANT_PERMISSION'`,
      ).run();
    }
  });

  test("orchestrator (no perm row) → forbidden", async () => {
    const res = await gateOrDispatch("GRANT_PERMISSION", validPayload(), {
      agentKey: "orchestrator",
      chatId: TEST_CHAT,
    });
    expect(res.kind).toBe("forbidden");
  });
});

describe("T-701 GRANT_PERMISSION — perm caller, approval flow", () => {
  test("perm caller → pending_approval, permissions unchanged", async () => {
    setPermission(PERM_AGENT, "GRANT_PERMISSION", {
      allowed: true,
      requires_approval: false,
    });
    const before = snapshotPerm(TARGET, "SET_REACTION");
    try {
      const res = await gateOrDispatch("GRANT_PERMISSION", validPayload(), {
        agentKey: PERM_AGENT,
        chatId: TEST_CHAT,
      });
      expect(res.kind).toBe("pending_approval");
      if (res.kind !== "pending_approval") throw new Error("expected approval");
      const a = getApproval(res.approvalId);
      expect(a).not.toBeNull();
      expect(a!.status).toBe("pending");
      // permissions row unchanged
      const now = snapshotPerm(TARGET, "SET_REACTION");
      expect(now).toEqual(before);
    } finally {
      restorePerm(TARGET, "SET_REACTION", before);
    }
  });

  test("approval → permissions table mutated, audit row written", async () => {
    setPermission(PERM_AGENT, "GRANT_PERMISSION", {
      allowed: true,
      requires_approval: false,
    });
    const before = snapshotPerm(TARGET, "SET_REACTION");
    try {
      // Force the target into a known starting state.
      setPermission(TARGET, "SET_REACTION", {
        allowed: false,
        requires_approval: false,
      });

      const res = await gateOrDispatch("GRANT_PERMISSION", validPayload(), {
        agentKey: PERM_AGENT,
        chatId: TEST_CHAT,
      });
      if (res.kind !== "pending_approval") {
        throw new Error(`expected pending_approval, got ${res.kind}`);
      }

      const approveMsg = await cmdApprove({
        approvalId: res.approvalId,
        decidedBy: "test-admin",
        chatId: TEST_CHAT,
      });
      expect(approveMsg).toContain("approved");

      // permissions table now updated
      const now = snapshotPerm(TARGET, "SET_REACTION");
      expect(now.allowed).toBe(true);
      expect(now.requires_approval).toBe(false);

      // audit row with _diff:true present
      const auditRows = db
        .prepare(
          `SELECT payload FROM agent_actions
           WHERE action_type = 'GRANT_PERMISSION' AND status = 'ok'
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
    } finally {
      restorePerm(TARGET, "SET_REACTION", before);
    }
  });

  test("reject → permissions unchanged, approval marked rejected", async () => {
    setPermission(PERM_AGENT, "GRANT_PERMISSION", {
      allowed: true,
      requires_approval: false,
    });
    const before = snapshotPerm(TARGET, "SET_REACTION");
    try {
      setPermission(TARGET, "SET_REACTION", {
        allowed: false,
        requires_approval: false,
      });

      const res = await gateOrDispatch("GRANT_PERMISSION", validPayload(), {
        agentKey: PERM_AGENT,
        chatId: TEST_CHAT,
      });
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

      const after = snapshotPerm(TARGET, "SET_REACTION");
      expect(after.allowed).toBe(false);
      expect(after.requires_approval).toBe(false);

      const a = getApproval(res.approvalId);
      expect(a!.status).toBe("rejected");
    } finally {
      restorePerm(TARGET, "SET_REACTION", before);
    }
  });
});

describe("T-701 GRANT_PERMISSION — validation", () => {
  beforeEach(() => {
    setPermission(PERM_AGENT, "GRANT_PERMISSION", {
      allowed: true,
      requires_approval: false,
    });
  });

  test("reason < 10 chars → error, no approval row", async () => {
    const bad = { ...validPayload(), reason: "short" };
    const res = await gateOrDispatch("GRANT_PERMISSION", bad, {
      agentKey: PERM_AGENT,
      chatId: TEST_CHAT,
    });
    expect(res.kind).toBe("error");
    expect(listPendingApprovals(TEST_CHAT).length).toBe(0);
  });

  test("unknown target_agent_key → error", async () => {
    const bad = { ...validPayload(), target_agent_key: "definitely-not-a-role" };
    const res = await gateOrDispatch("GRANT_PERMISSION", bad, {
      agentKey: PERM_AGENT,
      chatId: TEST_CHAT,
    });
    expect(res.kind).toBe("error");
    if (res.kind === "error") {
      expect(res.error).toMatch(/unknown target_agent_key/);
    }
  });

  test("unknown action_type → error", async () => {
    const bad = { ...validPayload(), action_type: "NOT_A_REAL_ACTION" };
    const res = await gateOrDispatch("GRANT_PERMISSION", bad, {
      agentKey: PERM_AGENT,
      chatId: TEST_CHAT,
    });
    expect(res.kind).toBe("error");
    if (res.kind === "error") {
      expect(res.error).toMatch(/unknown action_type/);
    }
  });
});

describe("T-701 GRANT_PERMISSION — always-approve override", () => {
  test("autonomy=auto still produces pending_approval", async () => {
    setPermission(PERM_AGENT, "GRANT_PERMISSION", {
      allowed: true,
      requires_approval: false,
    });
    setAutonomy("global", "*", "auto");
    const res = await gateOrDispatch("GRANT_PERMISSION", validPayload(), {
      agentKey: PERM_AGENT,
      chatId: TEST_CHAT,
    });
    expect(res.kind).toBe("pending_approval");
  });
});
