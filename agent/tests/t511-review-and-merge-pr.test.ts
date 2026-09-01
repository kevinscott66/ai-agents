/**
 * T-511: Unit tests for REVIEW_AND_MERGE_PR action.
 *
 * Fully hermetic: every test injects a fake GhRunner, so the handler never
 * shells out to the real `gh` CLI and never touches / mutates real PRs. The
 * fake records the commands it received so we can assert the orchestrator took
 * the right branch (merge vs comment vs validation-fail).
 */

import { describe, it, expect } from "bun:test";
import {
  handleReviewAndMergePr,
  type GhRunner,
  type GhRunResult,
} from "../lib/dispatch/github.ts";
import type { ReviewAndMergePrPayload } from "../lib/action-payload.ts";

const validContext = { agentKey: "orchestrator", chatId: -123456789 };
const nonOrchestratorContext = { agentKey: "backend", chatId: -123456789 };

/** A runner that fails the test if it is ever called (for pre-gh-return paths). */
const explodingRunner: GhRunner = async (args) => {
  throw new Error(`gh should not have been called: gh ${args.join(" ")}`);
};

/**
 * Build a fake `gh` runner from canned per-subcommand responses, recording all
 * invocations. Keyed by the first two args (e.g. "pr view", "pr checks").
 */
function fakeGh(
  responses: Record<string, Partial<GhRunResult>>,
): { runGh: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runGh: GhRunner = async (args) => {
    calls.push(args);
    const key = `${args[0]} ${args[1]}`;
    const r = responses[key] ?? { exitCode: 0, stdout: "", stderr: "" };
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.exitCode ?? 0 };
  };
  return { runGh, calls };
}

const openSafePr = JSON.stringify({
  state: "OPEN",
  mergeable: "MERGEABLE",
  // Аудит 2026-08-11: было `agent/tests/foo.test.ts` — с инверсией
  // классификатора в белый список тесты больше не входят.
  files: [{ path: "docs/readme.md" }],
});
const openRiskyPr = JSON.stringify({
  state: "OPEN",
  mergeable: "MERGEABLE",
  files: [{ path: "agent/lib/dispatch/github.ts" }],
});

describe("REVIEW_AND_MERGE_PR Action", () => {
  it("should reject invalid PR numbers (without calling gh)", async () => {
    for (const payload of [{ pr_number: 0 }, { pr_number: -1 }, { pr_number: -999 }]) {
      const result = await handleReviewAndMergePr(payload, validContext, { runGh: explodingRunner, authority: "approved-action" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("Invalid PR number");
    }
  });

  it("should reject non-orchestrator agents (without calling gh)", async () => {
    const result = await handleReviewAndMergePr(
      { pr_number: 123, reason: "x" },
      nonOrchestratorContext,
      { runGh: explodingRunner, authority: "approved-action" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("restricted to orchestrator");
      expect(result.error).toContain("backend");
    }
  });

  it("merges a green, safe (docs/test-only) PR", async () => {
    const { runGh, calls } = fakeGh({
      "pr view": { exitCode: 0, stdout: openSafePr },
      "pr checks": { exitCode: 0 },
      "pr merge": { exitCode: 0, stdout: "Squashed and merged abcdef1234567" },
    });
    const result = await handleReviewAndMergePr({ pr_number: 200 }, validContext, { runGh, authority: "approved-action" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.action).toBe("merged");
      expect(result.result.pr_number).toBe(200);
      expect(result.result.merge_sha).toBe("abcdef1234567");
    }
    expect(calls.some((c) => c[0] === "pr" && c[1] === "merge")).toBe(true);
  });

  it("comments (no merge) on a green but RISKY PR touching agent/lib", async () => {
    const { runGh, calls } = fakeGh({
      "pr view": { exitCode: 0, stdout: openRiskyPr },
      "pr checks": { exitCode: 0 },
    });
    const result = await handleReviewAndMergePr({ pr_number: 201 }, validContext, { runGh, authority: "approved-action" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.action).toBe("commented");
      expect(result.result.checks_passed).toBe(true);
    }
    // Must NOT attempt a merge on risky changes.
    expect(calls.some((c) => c[1] === "merge")).toBe(false);
    expect(calls.some((c) => c[1] === "comment")).toBe(true);
  });

  it("comments the blocking issues when required CI checks fail", async () => {
    const { runGh, calls } = fakeGh({
      "pr view": { exitCode: 0, stdout: openSafePr },
      "pr checks": { exitCode: 1, stderr: "1 failing" },
    });
    const result = await handleReviewAndMergePr({ pr_number: 202 }, validContext, { runGh, authority: "approved-action" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.checks_passed).toBe(false);
      expect(["commented", "validation_failed"]).toContain(result.result.action);
    }
    expect(calls.some((c) => c[1] === "merge")).toBe(false);
  });

  it("fails validation when the PR is not open", async () => {
    const { runGh } = fakeGh({
      "pr view": { exitCode: 0, stdout: JSON.stringify({ state: "MERGED", mergeable: "UNKNOWN", files: [] }) },
    });
    const result = await handleReviewAndMergePr({ pr_number: 203 }, validContext, { runGh, authority: "approved-action" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.checks_passed).toBe(false);
      expect(result.result.message).toContain("not open");
    }
  });

  it("returns an error when gh pr view itself fails", async () => {
    const { runGh } = fakeGh({ "pr view": { exitCode: 1, stderr: "not found" } });
    const result = await handleReviewAndMergePr({ pr_number: 999 }, validContext, { runGh, authority: "approved-action" });
    expect(result.ok).toBe(true); // handler reports validation failure, not a thrown error
    if (result.ok) {
      expect(result.result.checks_passed).toBe(false);
      expect(result.result.message).toContain("Failed to get PR details");
    }
  });

  it("surfaces a merge failure as an error result", async () => {
    const { runGh } = fakeGh({
      "pr view": { exitCode: 0, stdout: openSafePr },
      "pr checks": { exitCode: 0 },
      "pr merge": { exitCode: 1, stderr: "merge blocked by branch protection" },
    });
    const result = await handleReviewAndMergePr({ pr_number: 204 }, validContext, { runGh, authority: "approved-action" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Failed to merge");
  });

  it("fails closed when called without an approval authority", async () => {
    const result = await handleReviewAndMergePr(
      { pr_number: 205 },
      validContext,
      { runGh: explodingRunner },
    );
    expect(result).toEqual({
      ok: false,
      error: "Merge authority is required: use the approval-gated action path",
    });
  });
});
