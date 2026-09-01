/**
 * T-702 — UPDATE_AGENT_PROMPT action.
 *
 * Verifies:
 *   1. non-aieng caller → forbidden (caller restriction).
 *   2. aieng caller → pending_approval; agent_prompts row pre-inserted with
 *      applied_at=NULL; version starts at 1.
 *   3. cmdApprove → applied_at set on the agent_prompts row.
 *   4. cmdReject → applied_at stays null; audit_logs UPDATE_AGENT_PROMPT_REJECTED
 *      row written.
 *   5. Validation: prompt too short, prompt too long, reason too short,
 *      unknown target_agent_key — all yield {kind:"error"} and don't queue.
 *   6. Version monotonicity: 2 sequential proposals → versions 1 then 2.
 *   7. Always-approve override active in autonomy=auto mode.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { gateOrDispatch } from "../lib/action-dispatch.ts";
import { setPermission, setAutonomy } from "../lib/permissions.ts";
import { getApproval, listPendingApprovals } from "../lib/approvals.ts";
import { cmdApprove, cmdReject } from "../lib/commands.ts";
import { db } from "../lib/db.ts";
import { saveAutonomy, restoreAutonomy } from "./_helpers.ts";
import {
  MIN_PROMPT_LEN,
  MAX_PROMPT_LEN,
} from "../lib/dispatch/agent-prompt.ts";

const TEST_CHAT = 999_702_702;
const AIENG = "aieng";
const TARGET = "smm";

let savedGlobal = saveAutonomy();

function cleanup(): void {
  db.prepare(`DELETE FROM approvals WHERE chat_id = ?`).run(TEST_CHAT);
  db.prepare(
    `DELETE FROM agent_actions WHERE chat_id = ? OR action_type = 'UPDATE_AGENT_PROMPT'`,
  ).run(TEST_CHAT);
  db.prepare(
    `DELETE FROM autonomy_modes WHERE scope = 'chat' AND scope_id = ?`,
  ).run(String(TEST_CHAT));
  db.prepare(`DELETE FROM agent_prompts WHERE agent_key = ?`).run(TARGET);
  db.prepare(
    `DELETE FROM audit_logs WHERE event_type = 'UPDATE_AGENT_PROMPT_REJECTED'`,
  ).run();
}

const goodPrompt = "x".repeat(80); // ≥ MIN_PROMPT_LEN
const goodReason = "Refines tone-of-voice per latest brand audit feedback";

const validPayload = (overrides: Partial<{
  target_agent_key: string;
  new_prompt: string;
  reason: string;
}> = {}) => ({
  target_agent_key: TARGET,
  new_prompt: goodPrompt,
  reason: goodReason,
  ...overrides,
});

beforeEach(() => {
  savedGlobal = saveAutonomy();
  cleanup();
});

afterEach(() => {
  restoreAutonomy(savedGlobal);
  cleanup();
});

describe("T-702 UPDATE_AGENT_PROMPT — caller restriction", () => {
  test("non-aieng caller (smm) → forbidden, even if artificially permitted", async () => {
    setPermission("smm", "UPDATE_AGENT_PROMPT", {
      allowed: true,
      requires_approval: false,
    });
    try {
      const res = await gateOrDispatch("UPDATE_AGENT_PROMPT", validPayload(), {
        agentKey: "smm",
        chatId: TEST_CHAT,
      });
      expect(res.kind).toBe("forbidden");
      if (res.kind === "forbidden") {
        expect(res.reason).toContain("aieng");
      }
    } finally {
      db.prepare(
        `DELETE FROM permissions WHERE agent_key = 'smm' AND action_type = 'UPDATE_AGENT_PROMPT'`,
      ).run();
    }
  });

  test("orchestrator (no perm row) → forbidden", async () => {
    const res = await gateOrDispatch("UPDATE_AGENT_PROMPT", validPayload(), {
      agentKey: "orchestrator",
      chatId: TEST_CHAT,
    });
    expect(res.kind).toBe("forbidden");
  });
});

describe("T-702 UPDATE_AGENT_PROMPT — aieng approval flow", () => {
  beforeEach(() => {
    setPermission(AIENG, "UPDATE_AGENT_PROMPT", {
      allowed: true,
      requires_approval: false,
    });
  });

  test("aieng caller → pending_approval; agent_prompts row pre-inserted (applied_at=NULL)", async () => {
    const res = await gateOrDispatch("UPDATE_AGENT_PROMPT", validPayload(), {
      agentKey: AIENG,
      chatId: TEST_CHAT,
    });
    expect(res.kind).toBe("pending_approval");
    if (res.kind !== "pending_approval") throw new Error("expected approval");
    const a = getApproval(res.approvalId);
    expect(a).not.toBeNull();
    expect(a!.status).toBe("pending");

    const rows = db
      .prepare(
        `SELECT id, version, applied_at, edited_by, reason
         FROM agent_prompts WHERE agent_key = ? ORDER BY version DESC`,
      )
      .all(TARGET) as Array<{
      id: number;
      version: number;
      applied_at: number | null;
      edited_by: string;
      reason: string;
    }>;
    expect(rows.length).toBe(1);
    expect(rows[0].version).toBe(1);
    expect(rows[0].applied_at).toBeNull();
    expect(rows[0].edited_by).toBe(AIENG);
    expect(rows[0].reason).toBe(goodReason);
  });

  test("cmdApprove → applied_at set on the agent_prompts row", async () => {
    const res = await gateOrDispatch("UPDATE_AGENT_PROMPT", validPayload(), {
      agentKey: AIENG,
      chatId: TEST_CHAT,
    });
    if (res.kind !== "pending_approval") {
      throw new Error(`expected pending_approval, got ${res.kind}`);
    }

    const msg = await cmdApprove({
      approvalId: res.approvalId,
      decidedBy: "test-admin",
      chatId: TEST_CHAT,
    });
    expect(msg).toContain("approved");

    const row = db
      .prepare(
        `SELECT applied_at FROM agent_prompts WHERE agent_key = ? AND version = 1`,
      )
      .get(TARGET) as { applied_at: number | null };
    expect(row.applied_at).not.toBeNull();
    expect(typeof row.applied_at).toBe("number");
  });

  test("cmdReject → applied_at stays null; audit_logs row written", async () => {
    const res = await gateOrDispatch("UPDATE_AGENT_PROMPT", validPayload(), {
      agentKey: AIENG,
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

    const row = db
      .prepare(
        `SELECT applied_at FROM agent_prompts WHERE agent_key = ? AND version = 1`,
      )
      .get(TARGET) as { applied_at: number | null };
    expect(row.applied_at).toBeNull();

    const auditRows = db
      .prepare(
        `SELECT payload FROM audit_logs
         WHERE event_type = 'UPDATE_AGENT_PROMPT_REJECTED'
         ORDER BY created_at DESC LIMIT 5`,
      )
      .all() as Array<{ payload: string }>;
    const found = auditRows.find((r) => {
      try {
        const p = JSON.parse(r.payload);
        return p && p.target_agent_key === TARGET;
      } catch {
        return false;
      }
    });
    expect(found).toBeDefined();
  });
});

describe("T-702 UPDATE_AGENT_PROMPT — validation", () => {
  beforeEach(() => {
    setPermission(AIENG, "UPDATE_AGENT_PROMPT", {
      allowed: true,
      requires_approval: false,
    });
  });

  test("prompt too short → error, no approval queued, no agent_prompts row", async () => {
    const bad = validPayload({ new_prompt: "x".repeat(MIN_PROMPT_LEN - 1) });
    const res = await gateOrDispatch("UPDATE_AGENT_PROMPT", bad, {
      agentKey: AIENG,
      chatId: TEST_CHAT,
    });
    expect(res.kind).toBe("error");
    expect(listPendingApprovals(TEST_CHAT).length).toBe(0);
    const rows = db
      .prepare(`SELECT id FROM agent_prompts WHERE agent_key = ?`)
      .all(TARGET);
    expect(rows.length).toBe(0);
  });

  test("prompt too long → error", async () => {
    const bad = validPayload({ new_prompt: "x".repeat(MAX_PROMPT_LEN + 1) });
    const res = await gateOrDispatch("UPDATE_AGENT_PROMPT", bad, {
      agentKey: AIENG,
      chatId: TEST_CHAT,
    });
    expect(res.kind).toBe("error");
    if (res.kind === "error") expect(res.error).toMatch(/too long/);
  });

  test("reason too short → error", async () => {
    const bad = validPayload({ reason: "short" });
    const res = await gateOrDispatch("UPDATE_AGENT_PROMPT", bad, {
      agentKey: AIENG,
      chatId: TEST_CHAT,
    });
    expect(res.kind).toBe("error");
  });

  test("unknown target_agent_key → error", async () => {
    const bad = validPayload({ target_agent_key: "definitely-not-a-role" });
    const res = await gateOrDispatch("UPDATE_AGENT_PROMPT", bad, {
      agentKey: AIENG,
      chatId: TEST_CHAT,
    });
    expect(res.kind).toBe("error");
    if (res.kind === "error") {
      expect(res.error).toMatch(/unknown target_agent_key/);
    }
  });
});

describe("T-702 UPDATE_AGENT_PROMPT — version monotonicity", () => {
  beforeEach(() => {
    setPermission(AIENG, "UPDATE_AGENT_PROMPT", {
      allowed: true,
      requires_approval: false,
    });
  });

  test("two sequential proposals → versions 1 then 2", async () => {
    const r1 = await gateOrDispatch(
      "UPDATE_AGENT_PROMPT",
      validPayload({ new_prompt: "y".repeat(80), reason: goodReason + " #1" }),
      { agentKey: AIENG, chatId: TEST_CHAT },
    );
    expect(r1.kind).toBe("pending_approval");

    const r2 = await gateOrDispatch(
      "UPDATE_AGENT_PROMPT",
      validPayload({ new_prompt: "z".repeat(80), reason: goodReason + " #2" }),
      { agentKey: AIENG, chatId: TEST_CHAT },
    );
    expect(r2.kind).toBe("pending_approval");

    const rows = db
      .prepare(
        `SELECT version FROM agent_prompts WHERE agent_key = ? ORDER BY version ASC`,
      )
      .all(TARGET) as Array<{ version: number }>;
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
  });
});

describe("T-702 UPDATE_AGENT_PROMPT — always-approve override", () => {
  test("autonomy=auto still yields pending_approval", async () => {
    setPermission(AIENG, "UPDATE_AGENT_PROMPT", {
      allowed: true,
      requires_approval: false,
    });
    setAutonomy("global", "*", "auto");
    const res = await gateOrDispatch("UPDATE_AGENT_PROMPT", validPayload(), {
      agentKey: AIENG,
      chatId: TEST_CHAT,
    });
    expect(res.kind).toBe("pending_approval");
  });
});
