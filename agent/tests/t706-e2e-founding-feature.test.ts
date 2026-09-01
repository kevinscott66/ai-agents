/**
 * T-706 — End-to-end test of the founding feature:
 *   action fails → auto diagnostic task → fix proposed → approval → retry succeeds.
 *
 * Scope of this file:
 *   - Covers the slice that is currently on `main`:
 *       * dispatchAndAudit() failure path creates a diagnostic task assigned
 *         to aieng (T-704-ish flow / C7 / C15).
 *       * gateOrDispatch() approval path creates an approval row.
 *       * cmdApprove() approves + executes the queued action.
 *       * After the human grants the missing permission via cmdGrant(), the
 *         original action retries successfully.
 *   - Integrated repair loop driven through the GRANT_PERMISSION action
 *     (perm role proposes → approval → human approve → original actor retries).
 *     The per-action coverage for GRANT_PERMISSION / CHANGE_AGENT_STATUS /
 *     UPDATE_AGENT_PROMPT now lives in t701 / t703 / t702 respectively.
 *
 * No network, no LLM calls, no telegram. Uses in-process bun:sqlite via lib/db.ts
 * and the existing _helpers cleanup pattern.
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { db } from "../lib/db.ts";
import {
  dispatchAndAudit,
  gateOrDispatch,
} from "../lib/action-dispatch.ts";
import {
  processDiagTask,
  type SelfDiagDeps,
} from "../lib/self-diag.ts";
import { getTask } from "../lib/tasks.ts";
import {
  getPermission,
  setPermission,
  setAutonomy,
  getAutonomy,
  type AutonomyMode,
} from "../lib/permissions.ts";
import { getApproval, listPendingApprovals } from "../lib/approvals.ts";
import { cmdApprove, cmdGrant } from "../lib/commands.ts";
import {
  cleanupChat,
  saveAutonomy,
  restoreAutonomy,
} from "./_helpers.ts";

const TEST_CHAT = -1_000_706;
const SAVED_PERMS_KEYS = [
  "orchestrator",
  "aieng",
  "smm",
  "perm",
] as const;

// Snapshot+restore permissions touched by this suite so we don't leak state.
type PermSnap = {
  agentKey: string;
  actionType: string;
  allowed: boolean;
  requires_approval: boolean;
};

function snapshotPerms(): PermSnap[] {
  const rows = db
    .prepare(
      `SELECT agent_key, action_type, allowed, requires_approval
       FROM permissions
       WHERE agent_key IN (${SAVED_PERMS_KEYS.map(() => "?").join(",")})`,
    )
    .all(...(SAVED_PERMS_KEYS as readonly string[])) as Array<{
      agent_key: string;
      action_type: string;
      allowed: number;
      requires_approval: number;
    }>;
  return rows.map((r) => ({
    agentKey: r.agent_key,
    actionType: r.action_type,
    allowed: !!r.allowed,
    requires_approval: !!r.requires_approval,
  }));
}

function restorePerms(snap: PermSnap[]): void {
  for (const p of snap) {
    setPermission(p.agentKey, p.actionType as never, {
      allowed: p.allowed,
      requires_approval: p.requires_approval,
    });
  }
}

let savedAutonomy: AutonomyMode;
let savedPerms: PermSnap[];

beforeEach(() => {
  savedAutonomy = saveAutonomy();
  savedPerms = snapshotPerms();
  // Default autonomy for this suite: semi_auto so SEND_MESSAGE requires approval.
  setAutonomy("global", "*", "semi_auto");
});

afterEach(() => {
  cleanupChat(TEST_CHAT, "orchestrator");
  cleanupChat(TEST_CHAT, "aieng");
  cleanupChat(TEST_CHAT, "smm");
  cleanupChat(TEST_CHAT, "perm");
  restorePerms(savedPerms);
  restoreAutonomy(savedAutonomy);
});

// Build a fake aieng-callable from a canned text response.
function aiengCall(text: string) {
  return (async () => ({
    id: "msg",
    type: "message",
    role: "assistant",
    model: "test",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
    content: [{ type: "text", text }],
  })) as any;
}

function pendingDiagFor(chatId: number) {
  return db
    .prepare(
      `SELECT id FROM tasks
       WHERE chat_id = ? AND assigned_to = 'aieng' AND status = 'pending'
         AND input LIKE '%"_diag":true%'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(chatId) as { id: string } | undefined;
}

describe("T-706 e2e founding feature (loop on main)", () => {
  test("Step 1: failed action creates a diagnostic task assigned to aieng", async () => {
    // SEND_MESSAGE w/o telegram instance → dispatcher records ok:false.
    const res = await dispatchAndAudit(
      "SEND_MESSAGE",
      { text: "hi from t706 step1" } as any,
      { agentKey: "orchestrator", chatId: TEST_CHAT },
    );
    expect(res.ok).toBe(false);

    const diag = pendingDiagFor(TEST_CHAT);
    expect(diag).toBeDefined();
    const task = getTask(diag!.id)!;
    expect(task.assigned_to).toBe("aieng");
    expect(task.status).toBe("pending");
    expect(task.title).toContain("SEND_MESSAGE");
    const inp = task.input as { _diag?: boolean; actionType?: string } | null;
    expect(inp?._diag).toBe(true);
    expect(inp?.actionType).toBe("SEND_MESSAGE");
  });

  test("Step 2: aieng proposes a fix → diag retry → action succeeds end-to-end", async () => {
    setAutonomy("chat", String(TEST_CHAT), "auto");
    // 1) Fail to spawn diag task.
    await dispatchAndAudit(
      "SEND_MESSAGE",
      { text: "hello world" } as any,
      { agentKey: "orchestrator", chatId: TEST_CHAT },
    );
    const diag = pendingDiagFor(TEST_CHAT);
    expect(diag).toBeDefined();

    // 2) Fake telegram for the retry. aieng will propose the same payload.
    const sent: string[] = [];
    const fakeTg: any = {
      sendMessage: async (_chatId: number, text: string) => {
        sent.push(text);
        return { message_id: 11, date: Math.floor(Date.now() / 1000) };
      },
    };

    const deps: SelfDiagDeps = {
      anthropic: {} as any,
      model: "test",
      callAnthropicImpl: aiengCall(
        `{"action":"SEND_MESSAGE","payload":{"text":"hello world"},"reason":"retry with telegram present"}`,
      ),
      buildDispatchCtx: ({ chatId, agentKey }) => ({
        agentKey,
        chatId,
        telegram: fakeTg,
      }),
    };

    await processDiagTask(getTask(diag!.id)!, deps);

    const after = getTask(diag!.id)!;
    expect(after.status).toBe("done");
    expect(sent).toContain("hello world");
    const out = after.output as { retried?: boolean; action?: string } | null;
    expect(out?.retried).toBe(true);
    expect(out?.action).toBe("SEND_MESSAGE");
  });

  test("Step 3: approval-gated action creates an approval + cmdApprove runs it", async () => {
    // semi_auto + SEND_MESSAGE (SEMI_AUTO_RISKY) → gate decision = "approval".
    expect(getAutonomy(TEST_CHAT)).toBe("semi_auto");

    // Ensure orchestrator has the perm at all.
    const p = getPermission("orchestrator", "SEND_MESSAGE");
    expect(p.allowed).toBe(true);

    const sent: string[] = [];
    const fakeTg: any = {
      sendMessage: async (_chatId: number, text: string) => {
        sent.push(text);
        return { message_id: 22, date: Math.floor(Date.now() / 1000) };
      },
    };

    // Step A: agent tries the action → goes to approval queue.
    const gate = await gateOrDispatch(
      "SEND_MESSAGE",
      { text: "needs approval" } as any,
      { agentKey: "orchestrator", chatId: TEST_CHAT, telegram: fakeTg },
    );
    expect(gate.kind).toBe("pending_approval");
    if (gate.kind !== "pending_approval") return; // type-narrow
    const approvalId = gate.approvalId;

    // It's actually in the queue.
    const pending = listPendingApprovals(TEST_CHAT);
    expect(pending.some((a) => a.id === approvalId)).toBe(true);

    // Step B: human approves via cmdApprove → action executes.
    const msg = await cmdApprove({
      approvalId,
      decidedBy: "human:test",
      chatId: TEST_CHAT,
      deps: { resolveTg: () => fakeTg },
    });
    expect(msg).toContain("approved by human:test");

    // Approval row is closed.
    const ap = getApproval(approvalId);
    expect(ap?.status).toBe("approved");

    // Action actually executed (telegram saw the send).
    expect(sent).toContain("needs approval");
  });

  test("Step 4 (full loop): perm denied → diag task → /grant → retry succeeds", async () => {
    // Use smm + a normally-allowed action that we deliberately revoke
    // to simulate "permission_denied" → diagnostic flow.
    // smm has SEND_MESSAGE by default; revoke it so the gate denies.
    setPermission("smm", "SEND_MESSAGE", {
      allowed: false,
      requires_approval: false,
    });

    // Step A: smm tries → forbidden (no diag task — forbidden path doesn't
    // spawn diagnostics on main; we simulate the *user-driven* repair instead).
    const gate1 = await gateOrDispatch(
      "SEND_MESSAGE",
      { text: "smm hi" } as any,
      { agentKey: "smm", chatId: TEST_CHAT },
    );
    expect(gate1.kind).toBe("forbidden");

    // Action got logged with status=forbidden.
    const forbidden = db
      .prepare(
        `SELECT status FROM agent_actions WHERE agent_key='smm' AND chat_id=? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(TEST_CHAT) as { status: string } | undefined;
    expect(forbidden?.status).toBe("forbidden");

    // Step B: human grants the permission via /grant.
    const grantMsg = cmdGrant({ args: ["smm", "SEND_MESSAGE", "auto"] });
    expect(grantMsg).toContain("права обновлены");

    // Bump autonomy to auto so SEMI_AUTO_RISKY doesn't trip approval.
    setAutonomy("chat", String(TEST_CHAT), "auto");

    // Step C: smm retries successfully.
    const sent: string[] = [];
    const fakeTg: any = {
      sendMessage: async (_chatId: number, text: string) => {
        sent.push(text);
        return { message_id: 33, date: Math.floor(Date.now() / 1000) };
      },
    };
    const gate2 = await gateOrDispatch(
      "SEND_MESSAGE",
      { text: "smm hi" } as any,
      { agentKey: "smm", chatId: TEST_CHAT, telegram: fakeTg },
    );
    expect(gate2.kind).toBe("ok");
    expect(sent).toContain("smm hi");
  });

  test("Step 5: aieng giveup → diag task closed without retry side-effects", async () => {
    setAutonomy("chat", String(TEST_CHAT), "auto");
    await dispatchAndAudit(
      "SEND_MESSAGE",
      { text: "won't retry" } as any,
      { agentKey: "orchestrator", chatId: TEST_CHAT },
    );
    const diag = pendingDiagFor(TEST_CHAT);
    expect(diag).toBeDefined();

    let called = false;
    const fakeTg: any = {
      sendMessage: async () => {
        called = true;
        return { message_id: 1, date: 0 };
      },
    };
    const deps: SelfDiagDeps = {
      anthropic: {} as any,
      model: "test",
      callAnthropicImpl: aiengCall(`{"giveup":true,"reason":"can't fix"}`),
      buildDispatchCtx: ({ chatId, agentKey }) => ({
        agentKey,
        chatId,
        telegram: fakeTg,
      }),
    };
    await processDiagTask(getTask(diag!.id)!, deps);
    const after = getTask(diag!.id)!;
    expect(after.status).toBe("done");
    expect(called).toBe(false);
    expect((after.output as { giveup?: boolean } | null)?.giveup).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integrated founding-feature loop, driven through the GRANT_PERMISSION action.
//
// The three founding-feature actions landed on main long ago and each now has
// dedicated per-action coverage (t701 GRANT_PERMISSION, t702 UPDATE_AGENT_PROMPT,
// t703 CHANGE_AGENT_STATUS), so the old per-action `.skip` stubs were removed.
// What was NOT covered anywhere is the end-to-end repair loop where a forbidden
// action is fixed by the perm role proposing GRANT_PERMISSION through the
// approval flow (rather than the human-driven /grant CLI exercised in Step 4).
// ---------------------------------------------------------------------------
describe("T-706 e2e founding feature — integrated GRANT_PERMISSION loop", () => {
  test("smm forbidden → perm proposes GRANT_PERMISSION → approve → smm retries ok", async () => {
    // Restore perm's GRANT_PERMISSION row afterwards (smm's SEND_MESSAGE is
    // already snapshot/restored by the suite-level afterEach).
    const permGrantBefore = getPermission("perm", "GRANT_PERMISSION");
    try {
      // 1) Revoke smm's SEND_MESSAGE so the gate denies.
      setPermission("smm", "SEND_MESSAGE", { allowed: false, requires_approval: false });
      const gate1 = await gateOrDispatch(
        "SEND_MESSAGE",
        { text: "smm integrated hi" } as any,
        { agentKey: "smm", chatId: TEST_CHAT },
      );
      expect(gate1.kind).toBe("forbidden");

      // 2) perm role proposes GRANT_PERMISSION to restore it (always approval-gated).
      setPermission("perm", "GRANT_PERMISSION", { allowed: true, requires_approval: false });
      const proposal = await gateOrDispatch(
        "GRANT_PERMISSION",
        {
          target_agent_key: "smm",
          action_type: "SEND_MESSAGE",
          allowed: true,
          requires_approval: false,
          reason: "restore smm SEND_MESSAGE after accidental revoke (e2e)",
        } as any,
        { agentKey: "perm", chatId: TEST_CHAT },
      );
      expect(proposal.kind).toBe("pending_approval");
      if (proposal.kind !== "pending_approval") return; // type-narrow

      // Still forbidden until the proposal is approved.
      expect(getPermission("smm", "SEND_MESSAGE").allowed).toBe(false);
      expect(listPendingApprovals(TEST_CHAT).some((a) => a.id === proposal.approvalId)).toBe(true);

      // 3) Human approves → GRANT_PERMISSION executes → smm's perm restored.
      const approveMsg = await cmdApprove({
        approvalId: proposal.approvalId,
        decidedBy: "human:test",
        chatId: TEST_CHAT,
      });
      expect(approveMsg).toContain("approved");
      expect(getApproval(proposal.approvalId)?.status).toBe("approved");
      expect(getPermission("smm", "SEND_MESSAGE").allowed).toBe(true);

      // 4) Bump autonomy so SEMI_AUTO_RISKY doesn't re-trip approval on retry.
      setAutonomy("chat", String(TEST_CHAT), "auto");

      // 5) smm retries the original action → succeeds end-to-end.
      const sent: string[] = [];
      const fakeTg: any = {
        sendMessage: async (_chatId: number, text: string) => {
          sent.push(text);
          return { message_id: 44, date: Math.floor(Date.now() / 1000) };
        },
      };
      const gate2 = await gateOrDispatch(
        "SEND_MESSAGE",
        { text: "smm integrated hi" } as any,
        { agentKey: "smm", chatId: TEST_CHAT, telegram: fakeTg },
      );
      expect(gate2.kind).toBe("ok");
      expect(sent).toContain("smm integrated hi");
    } finally {
      setPermission("perm", "GRANT_PERMISSION", {
        allowed: permGrantBefore.allowed,
        requires_approval: permGrantBefore.requires_approval,
      });
    }
  });
});
