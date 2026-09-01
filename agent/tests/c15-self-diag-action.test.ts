/**
 * T-701 — CREATE_DIAGNOSTIC_TASK as a first-class action.
 *
 * Covers the DoD:
 *   - explicit call creates a routed diagnostic task;
 *   - recursion / cascade guards (diag-of-diag, diag-of-CREATE_TASK);
 *   - filters mirror self-diag (approval-gated + rate-limit skipped);
 *   - target_agent_key overrides the category-routed assignee;
 *   - validation surfaces as kind:"error" through the gate;
 *   - gate allows the action for any role with NO approval (not a side-effect).
 */
import { describe, test, expect, afterEach } from "bun:test";
import { gateOrDispatch } from "../lib/action-dispatch.ts";
import {
  handleCreateDiagnosticTask,
  validateCreateDiagnosticTaskPayload,
} from "../lib/dispatch/diagnostic-action.ts";
import { logAction } from "../lib/audit.ts";
import { setPermission } from "../lib/permissions.ts";
import { savePermissions } from "./_helpers.ts";
import { getTask } from "../lib/tasks.ts";
import { db } from "../lib/db.ts";

const TEST_CHAT = 999_701_701;
const CALLER = "qa";

/** Seed a failed action row and return its id. */
function seedFailedAction(opts: {
  agentKey?: string;
  actionType: string;
  error: string;
  taskId?: string | null;
}): string {
  const { id } = logAction({
    agentKey: opts.agentKey ?? "smm",
    chatId: TEST_CHAT,
    taskId: opts.taskId ?? null,
    actionType: opts.actionType as never,
    payload: {},
    status: "error",
    error: opts.error,
  });
  return id;
}

function cleanup(): void {
  db.prepare(`DELETE FROM agent_actions WHERE chat_id = ?`).run(TEST_CHAT);
  db.prepare(
    `DELETE FROM tasks WHERE chat_id = ? AND title LIKE '[diagnostic]%'`,
  ).run(TEST_CHAT);
}

// smm — настоящая роль; строка DELETE_MESSAGE после теста возвращается на
// место, иначе следующий файл видит требование подтверждения. T-751.
const permRestores: Array<() => void> = [];

afterEach(() => {
  while (permRestores.length) permRestores.pop()!();
  cleanup();
});

describe("T-701 validateCreateDiagnosticTaskPayload", () => {
  test("missing failed_action_id → error", () => {
    expect(
      validateCreateDiagnosticTaskPayload({
        hypothesis: "something went wrong here",
      } as never),
    ).toMatch(/failed_action_id/);
  });

  test("short hypothesis → error", () => {
    expect(
      validateCreateDiagnosticTaskPayload({
        failed_action_id: "x",
        hypothesis: "too short",
      }),
    ).toMatch(/hypothesis/);
  });

  test("unknown target_agent_key → error", () => {
    expect(
      validateCreateDiagnosticTaskPayload({
        failed_action_id: "x",
        hypothesis: "a sufficiently long hypothesis string",
        target_agent_key: "not-a-real-role",
      }),
    ).toMatch(/unknown target_agent_key/);
  });

  test("malformed suggested_fix → error", () => {
    expect(
      validateCreateDiagnosticTaskPayload({
        failed_action_id: "x",
        hypothesis: "a sufficiently long hypothesis string",
        suggested_fix: { action: "", payload: {} },
      }),
    ).toMatch(/suggested_fix\.action/);
  });

  test("valid payload → null", () => {
    expect(
      validateCreateDiagnosticTaskPayload({
        failed_action_id: "x",
        hypothesis: "a sufficiently long hypothesis string",
        target_agent_key: "perm",
        suggested_fix: { action: "GRANT_PERMISSION", payload: { allowed: true } },
      }),
    ).toBeNull();
  });
});

describe("T-701 handleCreateDiagnosticTask — creation + routing", () => {
  test("permission_denied error → routes to perm, task created", () => {
    const failedId = seedFailedAction({
      actionType: "SET_REACTION",
      error: "permission denied: SET_REACTION not allowed",
    });
    const res = handleCreateDiagnosticTask(
      {
        failed_action_id: failedId,
        hypothesis: "smm lacks SET_REACTION permission; perm should grant it",
      },
      { agentKey: CALLER, chatId: TEST_CHAT },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.error_category).toBe("permission_denied");
    expect(res.result.assigned_to).toBe("perm");
    expect(res.result.task_id).not.toBeNull();
    const task = getTask(res.result.task_id!);
    expect(task?.assigned_to).toBe("perm");
    expect(task?.title).toContain("[diagnostic]");
  });

  test("target_agent_key overrides category routing", () => {
    const failedId = seedFailedAction({
      actionType: "SET_REACTION",
      error: "permission denied",
    });
    const res = handleCreateDiagnosticTask(
      {
        failed_action_id: failedId,
        hypothesis: "explicitly route this investigation to aieng",
        target_agent_key: "aieng",
      },
      { agentKey: CALLER, chatId: TEST_CHAT },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.assigned_to).toBe("aieng");
  });

  test("failed_action_id not found → error", () => {
    const res = handleCreateDiagnosticTask(
      {
        failed_action_id: "does-not-exist",
        hypothesis: "this references a non-existent action id",
      },
      { agentKey: CALLER, chatId: TEST_CHAT },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/not found/);
  });
});

describe("T-701 handleCreateDiagnosticTask — cascade guards", () => {
  test("diagnosing a CREATE_TASK → recursion_guard skip", () => {
    const failedId = seedFailedAction({
      actionType: "CREATE_TASK",
      error: "some failure creating a task",
    });
    const res = handleCreateDiagnosticTask(
      {
        failed_action_id: failedId,
        hypothesis: "should be skipped by the recursion guard entirely",
      },
      { agentKey: CALLER, chatId: TEST_CHAT },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.task_id).toBeNull();
    expect(res.result.skipped_reason).toBe("recursion_guard");
  });

  test("diagnosing a CREATE_DIAGNOSTIC_TASK → recursion_guard skip", () => {
    const failedId = seedFailedAction({
      actionType: "CREATE_DIAGNOSTIC_TASK",
      error: "a diagnostic action itself failed",
    });
    const res = handleCreateDiagnosticTask(
      {
        failed_action_id: failedId,
        hypothesis: "diag-of-diag must not create a cascade",
      },
      { agentKey: CALLER, chatId: TEST_CHAT },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.skipped_reason).toBe("recursion_guard");
  });

  test("rate-limit error → skipped_rate_limited", () => {
    const failedId = seedFailedAction({
      actionType: "SEND_MESSAGE",
      error: "429 Too Many Requests — rate limit exceeded",
    });
    const res = handleCreateDiagnosticTask(
      {
        failed_action_id: failedId,
        hypothesis: "transient rate limit, no diagnostic task warranted",
      },
      { agentKey: CALLER, chatId: TEST_CHAT },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.skipped_reason).toBe("skipped_rate_limited");
    expect(res.result.task_id).toBeNull();
  });

  test("approval-gated original action → skipped_approval_gated", () => {
    // Make the failed action's agent require approval for that action type.
    permRestores.push(savePermissions([["smm", "DELETE_MESSAGE"]]));
    setPermission("smm", "DELETE_MESSAGE", {
      allowed: true,
      requires_approval: true,
    });
    const failedId = seedFailedAction({
      agentKey: "smm",
      actionType: "DELETE_MESSAGE",
      error: "delete failed for some non-rate-limit reason",
    });
    const res = handleCreateDiagnosticTask(
      {
        failed_action_id: failedId,
        hypothesis: "approval-gated action belongs in the approvals queue",
      },
      { agentKey: CALLER, chatId: TEST_CHAT },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.skipped_reason).toBe("skipped_approval_gated");
  });
});

describe("T-701 gate integration", () => {
  test("any role may dispatch with NO approval (decision allow)", async () => {
    const failedId = seedFailedAction({
      actionType: "SET_REACTION",
      error: "unknown action: bad capability",
    });
    const res = await gateOrDispatch(
      "CREATE_DIAGNOSTIC_TASK",
      {
        failed_action_id: failedId,
        hypothesis: "missing capability should route to aieng automatically",
      },
      { agentKey: CALLER, chatId: TEST_CHAT },
    );
    expect(res.kind).toBe("ok");
  });

  test("invalid payload surfaces as kind:error (not approval)", async () => {
    const res = await gateOrDispatch(
      "CREATE_DIAGNOSTIC_TASK",
      { failed_action_id: "x", hypothesis: "short" } as never,
      { agentKey: CALLER, chatId: TEST_CHAT },
    );
    expect(res.kind).toBe("error");
  });
});
