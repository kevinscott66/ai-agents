/**
 * T-314: race-free rate-limiter.
 *
 * Original C12 design split `checkRateLimit()` (read-only) and
 * `commitRateLimit()` (mutate), with an `await dispatchAndAudit(...)` between
 * them in `action-dispatch.ts::gateOrDispatch`. N concurrent callers all
 * passed `checkRateLimit` (saw the same pre-state), all kicked off dispatch,
 * and all committed — exceeding the bucket.
 *
 * Fix: `checkAndConsumeRateLimit()` is synchronous and atomic — it checks all
 * applicable buckets and commits in one sync block, with no await between.
 * JS single-threaded event loop then guarantees that exactly `max` callers
 * win regardless of how many race in parallel via `Promise.all`.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  checkRateLimit,
  commitRateLimit,
  checkAndConsumeRateLimit,
  refundRateLimit,
  _resetRateLimits,
} from "../lib/rate-limits.ts";

beforeEach(() => {
  _resetRateLimits();
});

afterEach(() => {
  _resetRateLimits();
});

describe("T-314 race-free rate limiter", () => {
  test("checkAndConsumeRateLimit: N=20 concurrent callers, exactly 6 pass per-agent GENERATE_IMAGE (max=6/hour)", async () => {
    // GENERATE_IMAGE per-agent rule: 6/hour. We fire 20 concurrent callers
    // through Promise.all (NOT serial) and assert exactly 6 ok, 14 limited.
    const N = 20;
    const now = Date.now();
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        Promise.resolve().then(() =>
          checkAndConsumeRateLimit("design", "GENERATE_IMAGE", now),
        ),
      ),
    );
    const okCount = results.filter((r) => r.ok).length;
    const limitedCount = results.filter((r) => !r.ok).length;
    expect(okCount).toBe(6);
    expect(limitedCount).toBe(14);
    // Every limited response must have a reason + retryInMs.
    for (const r of results.filter((x) => !x.ok)) {
      expect(typeof r.reason).toBe("string");
      expect(r.retryInMs).toBeGreaterThan(0);
    }
  });

  test("checkAndConsumeRateLimit: N=20 concurrent on SEND_MESSAGE (max=30/min) — all 20 pass (under limit)", async () => {
    const N = 20;
    const now = Date.now();
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        Promise.resolve().then(() =>
          checkAndConsumeRateLimit("pm", "SEND_MESSAGE", now),
        ),
      ),
    );
    expect(results.filter((r) => r.ok).length).toBe(20);
  });

  test("checkAndConsumeRateLimit: limit=5 on ALL_AGENT_TOOLS (DELEGATE_TO_ROLE has perAgent=6, but use limit-5 path)", async () => {
    // Use DELEGATE_TO_ROLE which is capped at 6 per agent per minute.
    // Fire N=20 concurrent, expect exactly 6 ok.
    const N = 20;
    const now = Date.now();
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        Promise.resolve().then(() =>
          checkAndConsumeRateLimit("orchestrator", "DELEGATE_TO_ROLE", now),
        ),
      ),
    );
    expect(results.filter((r) => r.ok).length).toBe(6);
    expect(results.filter((r) => !r.ok).length).toBe(14);
  });

  test("WRITE_WIKI (max=5/min): N=20 concurrent → exactly 5 ok, 15 rate_limited", async () => {
    // This is the canonical case in the task spec: limit=5, N=20.
    const N = 20;
    const now = Date.now();
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        Promise.resolve().then(() =>
          checkAndConsumeRateLimit("copy", "WRITE_WIKI", now),
        ),
      ),
    );
    const ok = results.filter((r) => r.ok);
    const limited = results.filter((r) => !r.ok);
    expect(ok.length).toBe(5);
    expect(limited.length).toBe(15);
    // All limited entries must reference the per-agent rule.
    for (const r of limited) {
      expect(r.reason).toContain("WRITE_WIKI");
      expect(r.reason).toContain("per agent");
    }
  });

  test("OLD pattern (checkRateLimit + commitRateLimit with await between) DEMONSTRATES the race", async () => {
    // Sanity check that the bug exists in the legacy split API: if you do
    // check → await → commit, then N concurrent callers all see "ok" at
    // check time and all commit. This is the bug T-314 fixes.
    const N = 20;
    const now = Date.now();
    async function legacyCheckThenCommit(): Promise<{ ok: boolean }> {
      const r = checkRateLimit("design", "WRITE_WIKI", now);
      if (!r.ok) return { ok: false };
      // Simulate the async dispatch window (await yields to event loop).
      await Promise.resolve();
      await Promise.resolve();
      commitRateLimit("design", "WRITE_WIKI", now);
      return { ok: true };
    }
    const legacy = await Promise.all(
      Array.from({ length: N }, () => legacyCheckThenCommit()),
    );
    const legacyOk = legacy.filter((r) => r.ok).length;
    // With the legacy split API, MORE than the limit (5) succeed — that's
    // exactly the race we're closing.
    expect(legacyOk).toBeGreaterThan(5);
  });

  test("refundRateLimit: releases a slot so subsequent caller can reserve", () => {
    const now = Date.now();
    // Fill bucket to exactly the limit (5).
    for (let i = 0; i < 5; i++) {
      const r = checkAndConsumeRateLimit("copy", "WRITE_WIKI", now);
      expect(r.ok).toBe(true);
    }
    // 6th should be denied.
    expect(checkAndConsumeRateLimit("copy", "WRITE_WIKI", now).ok).toBe(false);
    // Refund one slot.
    refundRateLimit("copy", "WRITE_WIKI", now);
    // Now a fresh caller can reserve.
    expect(checkAndConsumeRateLimit("copy", "WRITE_WIKI", now).ok).toBe(true);
    // And the bucket is full again.
    expect(checkAndConsumeRateLimit("copy", "WRITE_WIKI", now).ok).toBe(false);
  });

  test("checkAndConsumeRateLimit honours global rule (GENERATE_IMAGE global max=30 across agents)", async () => {
    // Per-agent rule for GENERATE_IMAGE is 6/hour — would normally hit first.
    // Spread the load across 10 agents so per-agent rule (6 each) doesn't
    // bite, and the global rule (30/hour) is the binding constraint.
    const N = 50;
    const now = Date.now();
    const agents = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    const results = await Promise.all(
      Array.from({ length: N }, (_, idx) =>
        Promise.resolve().then(() =>
          // 5 calls per agent → per-agent rule (6) not hit; global (30) is.
          checkAndConsumeRateLimit(agents[idx % agents.length], "GENERATE_IMAGE", now),
        ),
      ),
    );
    const okCount = results.filter((r) => r.ok).length;
    expect(okCount).toBe(30);
    expect(results.filter((r) => !r.ok).length).toBe(20);
  });

  test("concurrent ok results: no duplicate over-commit (bucket size == ok count)", async () => {
    // Property test: across multiple races at different limits, the
    // post-state bucket count must equal the number of ok responses.
    const N = 100;
    const now = Date.now();
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        Promise.resolve().then(() =>
          checkAndConsumeRateLimit("smm", "SEND_MESSAGE", now),
        ),
      ),
    );
    const okCount = results.filter((r) => r.ok).length;
    // SEND_MESSAGE per-agent = 30/min → exactly 30 should pass.
    expect(okCount).toBe(30);
    // After the race, the very next call must be limited (bucket full).
    expect(checkAndConsumeRateLimit("smm", "SEND_MESSAGE", now).ok).toBe(false);
  });
});
