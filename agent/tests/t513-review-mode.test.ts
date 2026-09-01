/**
 * T-513: Unit tests for control-loop review mode.
 *
 * Fully hermetic: every test injects a fake GhRunner and a fixed clock, so the
 * review pass never shells out to the real `gh` CLI and never touches real PRs.
 */

import { describe, it, expect } from "bun:test";
import {
  listRecentOpenPrs,
  runReviewMode,
  formatReviewSummary,
} from "../orchestrator/review-mode.ts";
import { parseAgentArgs } from "../agent.ts";
import type { GhRunner, GhRunResult } from "../lib/dispatch/github.ts";
import { controlReviewMarker } from "../lib/dispatch/github.ts";

/** Fixed "now" for deterministic windowing. */
const NOW = Date.parse("2026-06-07T12:00:00Z");
const now = () => NOW;
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

/**
 * Build a fake `gh` runner from canned per-subcommand responses, recording all
 * invocations. Keyed by the first two args (e.g. "pr list", "pr view").
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

describe("listRecentOpenPrs", () => {
  it("keeps only PRs updated within the window", async () => {
    const { runGh } = fakeGh({
      "pr list": {
        exitCode: 0,
        stdout: JSON.stringify([
          { number: 10, headRefName: "agent/ten", updatedAt: minsAgo(5) },   // fresh
          { number: 11, headRefName: "agent/eleven", updatedAt: minsAgo(89) },  // just inside 90m
          { number: 12, headRefName: "agent/twelve", updatedAt: minsAgo(120) }, // stale
          { number: 13, headRefName: "agent/thirteen", createdAt: minsAgo(2) },   // falls back to createdAt
          { number: 14, headRefName: "feature/human", updatedAt: minsAgo(1) }, // not autonomous
        ]),
      },
    });
    const prs = await listRecentOpenPrs(runGh, 90, now);
    expect(prs.prNumbers).toEqual([10, 11, 13]);
  });

  it("drops entries without a usable timestamp", async () => {
    // Обе строки — с agent-веткой: этот тест меряет ТОЛЬКО ось времени.
    // Отсутствие ветки проверяет следующий тест, иначе одна строка падала бы
    // сразу по двум причинам и ни одну из них не доказывала.
    const { runGh } = fakeGh({
      "pr list": {
        exitCode: 0,
        stdout: JSON.stringify([
          { number: 20, headRefName: "agent/twenty" },
          { number: 21, headRefName: "agent/twenty-one", updatedAt: minsAgo(1) },
        ]),
      },
    });
    expect((await listRecentOpenPrs(runGh, 90, now)).prNumbers).toEqual([21]);
  });

  it("fails closed when the branch name is missing or not agent-owned", async () => {
    const { runGh } = fakeGh({
      "pr list": {
        exitCode: 0,
        stdout: JSON.stringify([
          { number: 22, updatedAt: minsAgo(1) },
          { number: 23, headRefName: "feature/human", updatedAt: minsAgo(1) },
          { number: 24, headRefName: "agent/owned", updatedAt: minsAgo(1) },
        ]),
      },
    });
    expect((await listRecentOpenPrs(runGh, 90, now)).prNumbers).toEqual([24]);
  });

  it("throws when gh pr list fails", async () => {
    const { runGh } = fakeGh({ "pr list": { exitCode: 1, stderr: "boom" } });
    await expect(listRecentOpenPrs(runGh, 90, now)).rejects.toThrow("gh pr list failed");
  });

  it("handles an empty PR list", async () => {
    const { runGh } = fakeGh({ "pr list": { exitCode: 0, stdout: "[]" } });
    expect((await listRecentOpenPrs(runGh, 90, now)).prNumbers).toEqual([]);
  });
});

describe("runReviewMode", () => {
  it("returns scanned=0 when no recent PRs", async () => {
    const { runGh, calls } = fakeGh({ "pr list": { exitCode: 0, stdout: "[]" } });
    const result = await runReviewMode({ runGh, now, windowMinutes: 90 });
    expect(result.scanned).toBe(0);
    expect(result.results).toEqual([]);
    // No per-PR review calls when nothing is in window.
    expect(calls.some((c) => c[1] === "view")).toBe(false);
  });

  it("comments on both safe and risky PRs without ever merging", async () => {
    // The fake can't vary `pr view` per PR via the simple key map, so test the
    // two outcomes separately, each with a single in-window PR.
    const safe = fakeGh({
      "pr list": { exitCode: 0, stdout: JSON.stringify([{ number: 200, headRefName: "agent/safe", updatedAt: minsAgo(3) }]) },
      "pr view": { exitCode: 0, stdout: openSafePr },
      "pr checks": { exitCode: 0 },
    });
    const safeRes = await runReviewMode({ runGh: safe.runGh, now });
    expect(safeRes.scanned).toBe(1);
    expect(safeRes.pr_numbers).toEqual([200]);
    const o0 = safeRes.results[0].outcome;
    expect(o0.ok).toBe(true);
    if (o0.ok) {
      expect(o0.result.action).toBe("commented");
      expect(o0.result.message).toContain("human approval");
    }
    expect(safe.calls.some((c) => c[1] === "merge")).toBe(false);

    const risky = fakeGh({
      "pr list": { exitCode: 0, stdout: JSON.stringify([{ number: 201, headRefName: "agent/risky", updatedAt: minsAgo(3) }]) },
      "pr view": { exitCode: 0, stdout: openRiskyPr },
      "pr checks": { exitCode: 0 },
    });
    const riskyRes = await runReviewMode({ runGh: risky.runGh, now });
    const o1 = riskyRes.results[0].outcome;
    expect(o1.ok).toBe(true);
    if (o1.ok) expect(o1.result.action).toBe("commented");
    // Risky PR must not be merged.
    expect(risky.calls.some((c) => c[1] === "merge")).toBe(false);
  });

  it("reviews every in-window PR even if one fails", async () => {
    // Both PRs route to the same canned `pr view` (safe); both remain pending
    // human approval.
    const { runGh, calls } = fakeGh({
      "pr list": {
        exitCode: 0,
        stdout: JSON.stringify([
          { number: 300, headRefName: "agent/three-hundred", updatedAt: minsAgo(2) },
          { number: 301, headRefName: "agent/three-oh-one", updatedAt: minsAgo(4) },
        ]),
      },
      "pr view": { exitCode: 0, stdout: openSafePr },
      "pr checks": { exitCode: 0 },
    });
    const result = await runReviewMode({ runGh, now });
    expect(result.scanned).toBe(2);
    expect(result.pr_numbers).toEqual([300, 301]);
    expect(result.results.every((r) => r.outcome.ok)).toBe(true);
    expect(calls.filter((c) => c[1] === "merge")).toHaveLength(0);
  });

  /** Фейк `gh` для одного PR с заданным набором комментариев и head-коммитом. */
  function reviewedPrRunner(opts: {
    commentBodies: string[];
    headSha: string;
    calls: string[][];
  }): GhRunner {
    return async (args) => {
      opts.calls.push(args);
      if (args[1] === "list") {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            { number: 302, headRefName: "agent/already-reviewed", updatedAt: minsAgo(2) },
          ]),
          stderr: "",
        };
      }
      if (args.some((a) => a.startsWith("comments"))) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            comments: opts.commentBodies.map((body) => ({ body })),
            headRefOid: opts.headSha,
          }),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: openSafePr, stderr: "" };
    };
  }

  it("does not repeat a control-loop comment on an unchanged head", async () => {
    const calls: string[][] = [];
    const runGh = reviewedPrRunner({
      calls,
      headSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      commentBodies: [
        `${controlReviewMarker("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef")}\nold review`,
      ],
    });

    const result = await runReviewMode({ runGh, now });
    expect(result.results[0].outcome).toMatchObject({
      ok: true,
      result: { action: "skipped" },
    });
    expect(calls.some((call) => call[1] === "checks")).toBe(false);
    expect(calls.some((call) => call[1] === "comment")).toBe(false);
    expect(calls.some((call) => call[1] === "merge")).toBe(false);
  });

  it("reviews again after a new push: the marker is scoped to the head commit", async () => {
    // Аудит 2026-08-27: раньше маркер был безусловным, и PR, once получивший
    // «Validation Failed», выпадал из петли контроля навсегда — автор чинил
    // замечания, а второго прохода уже не было.
    const calls: string[][] = [];
    const runGh = reviewedPrRunner({
      calls,
      headSha: "1111111111111111111111111111111111111111",
      commentBodies: [
        `${controlReviewMarker("0000000000000000000000000000000000000000")}\n🚫 **Validation Failed**`,
      ],
    });

    const result = await runReviewMode({ runGh, now });
    expect(result.results[0].outcome.ok).toBe(true);
    expect(calls.some((call) => call[1] === "checks")).toBe(true);
    expect(calls.some((call) => call[1] === "merge")).toBe(false);
  });

  it("falls back to the marker prefix when gh reports no head commit", async () => {
    const calls: string[][] = [];
    const runGh = reviewedPrRunner({
      calls,
      headSha: "",
      // Ровно то, что прод пишет без известного head. До аудита 2026-08-28 здесь
      // стоял CONTROL_REVIEW_MARKER — тело, которого прод не пишет нигде, и
      // зелёный тест уживался со сломанной веткой.
      commentBodies: [`${controlReviewMarker("")}\nprevious review`],
    });

    const result = await runReviewMode({ runGh, now });
    expect(result.results[0].outcome).toMatchObject({
      ok: true,
      result: { action: "skipped" },
    });
    expect(calls.some((call) => call[1] === "checks")).toBe(false);
  });
});

describe("formatReviewSummary", () => {
  it("renders an empty pass", () => {
    const out = formatReviewSummary({ scanned: 0, pr_numbers: [], results: [] }, "2026-06-07T12:00:00Z");
    expect(out).toContain("## Control loop — 2026-06-07T12:00:00Z");
    // Аудит 2026-08-28: было "PRs reviewed" — заголовок обещал разбор, а число
    // приходило из длины списка ДО разбора. Теперь честное "scanned", а исходы
    // печатаются отдельной строкой (см. countReviewOutcomes).
    expect(out).toContain("PRs scanned:** 0");
    expect(out).toContain("nothing to review");
  });

  it("renders merged and errored PRs", () => {
    const out = formatReviewSummary(
      {
        scanned: 2,
        pr_numbers: [1, 2],
        results: [
          { pr_number: 1, outcome: { ok: true, result: { action: "merged", pr_number: 1, message: "done" } } },
          { pr_number: 2, outcome: { ok: false, error: "kaboom" } },
        ],
      },
      "2026-06-07T12:00:00Z",
    );
    expect(out).toContain("PR #1: **merged** — done");
    expect(out).toContain("PR #2: **error** — kaboom");
  });
});

describe("parseAgentArgs", () => {
  it("parses --key value form", () => {
    expect(parseAgentArgs(["--role", "orchestrator", "--mode", "review"])).toEqual({
      role: "orchestrator",
      mode: "review",
    });
  });

  it("parses --key=value form", () => {
    expect(parseAgentArgs(["--role=orchestrator", "--mode=review"])).toEqual({
      role: "orchestrator",
      mode: "review",
    });
  });

  it("ignores unknown flags and bare tokens", () => {
    expect(parseAgentArgs(["foo", "--verbose", "--mode", "review"])).toEqual({ mode: "review" });
  });

  it("returns empty object for no args", () => {
    expect(parseAgentArgs([])).toEqual({});
  });
});
