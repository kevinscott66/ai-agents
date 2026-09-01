/**
 * T-704: auto-diagnostic task creation on agent_actions failure.
 *
 * Covers:
 *   - categorizeError() heuristics across 5 buckets
 *   - createDiagnosticTask routes (permission_denied → perm,
 *     missing_capability → aieng, unknown → orchestrator)
 *   - rate_limited / network do NOT create tasks (deferred)
 *   - dedup: second failure with the same (action, category) is a no-op
 *   - inputPayload JSON contains failed_action_id + hypothesis
 *   - does not interfere with the C15 self-diag aieng task
 */
import { describe, test, expect, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import {
  categorizeError,
  pickResponsibleRole,
  createDiagnosticTask,
  type ErrorCategory,
} from "../lib/diagnostic.ts";

const TEST_CHAT = -1_000_704;

function cleanup() {
  db.prepare(`DELETE FROM tasks WHERE chat_id = ?`).run(TEST_CHAT);
  db.prepare(`DELETE FROM agent_actions WHERE chat_id = ?`).run(TEST_CHAT);
}

afterEach(() => {
  cleanup();
});

describe("categorizeError", () => {
  test("permission_denied: 403 / forbidden / not authorized", () => {
    expect(categorizeError("permission denied")).toBe("permission_denied");
    expect(categorizeError("HTTP 403 Forbidden")).toBe("permission_denied");
    expect(categorizeError("user not authorized to do X")).toBe(
      "permission_denied",
    );
    expect(categorizeError("requires approval")).toBe("permission_denied");
  });

  test("rate_limited: 429 / rate limit / quota", () => {
    expect(categorizeError("HTTP 429 too many requests")).toBe("rate_limited");
    expect(categorizeError("rate-limit exceeded")).toBe("rate_limited");
    expect(categorizeError("quota exceeded for image gen")).toBe(
      "rate_limited",
    );
  });

  test("missing_capability: unknown action / not implemented", () => {
    expect(categorizeError("unknown action: FOO_BAR")).toBe(
      "missing_capability",
    );
    expect(categorizeError("not implemented yet")).toBe("missing_capability");
    expect(categorizeError("no handler for action")).toBe("missing_capability");
  });

  test("network: ETIMEDOUT / DNS / 502", () => {
    expect(categorizeError("ETIMEDOUT during fetch")).toBe("network");
    expect(categorizeError("getaddrinfo ENOTFOUND api.example.com")).toBe(
      "network",
    );
    expect(categorizeError("HTTP 502 bad gateway")).toBe("network");
    expect(categorizeError("fetch failed")).toBe("network");
  });

  test("unknown: empty / unrelated message", () => {
    expect(categorizeError("")).toBe("unknown");
    expect(categorizeError(null)).toBe("unknown");
    expect(categorizeError("some weird thing happened")).toBe("unknown");
  });
});

describe("pickResponsibleRole", () => {
  test("routes categories to expected roles", () => {
    expect(pickResponsibleRole("permission_denied")).toBe("perm");
    expect(pickResponsibleRole("missing_capability")).toBe("aieng");
    expect(pickResponsibleRole("rate_limited")).toBeNull();
    expect(pickResponsibleRole("network")).toBeNull();
    expect(pickResponsibleRole("unknown")).toBe("orchestrator");
  });
});

describe("createDiagnosticTask", () => {
  test("permission_denied → creates task assigned to perm", () => {
    const r = createDiagnosticTask({
      failedActionId: "act-perm-1",
      actionType: "SEND_MESSAGE",
      error: "permission denied for SEND_MESSAGE",
      chatId: TEST_CHAT,
      originatingAgent: "backend",
    });
    expect(r.category).toBe("permission_denied");
    expect(r.task).not.toBeNull();
    expect(r.task!.assigned_to).toBe("perm");
    expect(r.task!.created_by).toBe("backend");
    expect(r.task!.title).toContain("[diagnostic]");
    expect(r.task!.title).toContain("permission_denied");

    const input = r.task!.input as Record<string, unknown>;
    expect(input.type).toBe("diagnostic");
    expect(input.failed_action_id).toBe("act-perm-1");
    expect(input.error_category).toBe("permission_denied");
    expect(typeof input.hypothesis).toBe("string");
    expect((input.hypothesis as string).length).toBeGreaterThan(0);
    expect(input.original_error).toContain("permission denied");
  });

  test("missing_capability → creates task assigned to aieng", () => {
    const r = createDiagnosticTask({
      failedActionId: "act-cap-1",
      actionType: "BAR_BAZ",
      error: "unknown action: BAR_BAZ",
      chatId: TEST_CHAT,
    });
    expect(r.category).toBe("missing_capability");
    expect(r.task).not.toBeNull();
    expect(r.task!.assigned_to).toBe("aieng");
    expect(r.task!.created_by).toBe("system");
  });

  test("unknown → escalates to orchestrator", () => {
    const r = createDiagnosticTask({
      failedActionId: "act-unk-1",
      actionType: "SOMETHING",
      error: "weird unexpected condition",
      chatId: TEST_CHAT,
    });
    expect(r.category).toBe("unknown");
    expect(r.task).not.toBeNull();
    expect(r.task!.assigned_to).toBe("orchestrator");
  });

  test("rate_limited → ZERO tasks created (deferred)", () => {
    const before = (
      db
        .prepare(`SELECT COUNT(*) as n FROM tasks WHERE chat_id = ?`)
        .get(TEST_CHAT) as { n: number }
    ).n;
    const r = createDiagnosticTask({
      failedActionId: "act-rl-1",
      actionType: "GENERATE_IMAGE",
      error: "HTTP 429 rate limit exceeded",
      chatId: TEST_CHAT,
    });
    expect(r.category).toBe("rate_limited");
    expect(r.task).toBeNull();
    expect(r.skippedReason).toBe("deferred_rate_limited");
    const after = (
      db
        .prepare(`SELECT COUNT(*) as n FROM tasks WHERE chat_id = ?`)
        .get(TEST_CHAT) as { n: number }
    ).n;
    expect(after).toBe(before);
  });

  test("network → ZERO tasks created (orchestrator handles retry)", () => {
    const r = createDiagnosticTask({
      failedActionId: "act-net-1",
      actionType: "SEND_MESSAGE",
      error: "ETIMEDOUT contacting telegram api",
      chatId: TEST_CHAT,
    });
    expect(r.category).toBe("network");
    expect(r.task).toBeNull();
    expect(r.skippedReason).toBe("deferred_network");
  });

  test("dedup: second failure with same (action,category) is a no-op", () => {
    const r1 = createDiagnosticTask({
      failedActionId: "act-dup-1",
      actionType: "SEND_MESSAGE",
      error: "permission denied",
      chatId: TEST_CHAT,
    });
    expect(r1.task).not.toBeNull();
    const taskId1 = r1.task!.id;

    // Same action id + same error → same category → must dedupe.
    const r2 = createDiagnosticTask({
      failedActionId: "act-dup-1",
      actionType: "SEND_MESSAGE",
      error: "permission denied (different wording, same category)",
      chatId: TEST_CHAT,
    });
    expect(r2.task).toBeNull();
    expect(r2.skippedReason).toBe("duplicate");

    // Only one diagnostic task exists for this action.
    const n = (
      db
        .prepare(
          `SELECT COUNT(*) as n FROM tasks
           WHERE chat_id = ? AND input LIKE '%"failed_action_id":"act-dup-1"%'`,
        )
        .get(TEST_CHAT) as { n: number }
    ).n;
    expect(n).toBe(1);

    // Different action id → DOES create a new task (no false-positive dedup).
    const r3 = createDiagnosticTask({
      failedActionId: "act-dup-2",
      actionType: "SEND_MESSAGE",
      error: "permission denied",
      chatId: TEST_CHAT,
    });
    expect(r3.task).not.toBeNull();
    expect(r3.task!.id).not.toBe(taskId1);
  });

  test("different categories for same action → both create tasks", () => {
    const r1 = createDiagnosticTask({
      failedActionId: "act-multi-1",
      actionType: "SEND_MESSAGE",
      error: "permission denied",
      chatId: TEST_CHAT,
    });
    const r2 = createDiagnosticTask({
      failedActionId: "act-multi-1",
      actionType: "SEND_MESSAGE",
      error: "unknown action: SEND_MESSAGE_V2",
      chatId: TEST_CHAT,
    });
    expect(r1.task).not.toBeNull();
    expect(r2.task).not.toBeNull();
    expect(r1.task!.assigned_to).toBe("perm");
    expect(r2.task!.assigned_to).toBe("aieng");
  });

  test("doesn't interfere with C15 self-diag aieng task (orthogonal payload shape)", () => {
    // The C15 self-diag task uses inputPayload._diag=true. T-704 uses
    // inputPayload.type='diagnostic'. They must not collide.
    const r = createDiagnosticTask({
      failedActionId: "act-orth-1",
      actionType: "SEND_MESSAGE",
      error: "permission denied",
      chatId: TEST_CHAT,
    });
    expect(r.task).not.toBeNull();
    const input = r.task!.input as Record<string, unknown>;
    // T-704 diag must NOT set _diag (so the C15 poller skips it).
    expect(input._diag).toBeUndefined();
    expect(input.type).toBe("diagnostic");
  });
});

describe("category roundtrip via DB", () => {
  test("created task is retrievable and category survives JSON roundtrip", () => {
    const categories: { err: string; cat: ErrorCategory; role: string | null }[] =
      [
        { err: "permission denied", cat: "permission_denied", role: "perm" },
        { err: "unknown action: X", cat: "missing_capability", role: "aieng" },
        { err: "weird thing", cat: "unknown", role: "orchestrator" },
      ];
    for (const { err, cat, role } of categories) {
      const r = createDiagnosticTask({
        failedActionId: `act-rt-${cat}`,
        actionType: "TEST",
        error: err,
        chatId: TEST_CHAT,
      });
      expect(r.category).toBe(cat);
      expect(r.task!.assigned_to).toBe(role);
      const input = r.task!.input as Record<string, unknown>;
      expect(input.error_category).toBe(cat);
    }
  });
});
