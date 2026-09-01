// SEC-3 / T-601: per-(chat,user) ingestion throttle so a group member can't
// drive unbounded LLM spend by flooding agent-triggering messages.
import { test, expect, describe, afterEach, beforeEach } from "bun:test";
import {
  checkAndConsumeIngestLimit,
  _resetRateLimits,
} from "../lib/rate-limits.ts";

const KEYS = ["INGEST_RATE_MAX_PER_WINDOW", "INGEST_RATE_WINDOW_MS"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  _resetRateLimits();
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _resetRateLimits();
});

describe("ingestion rate limit (T-601 / SEC-3)", () => {
  test("allows up to max then blocks within the window", () => {
    process.env.INGEST_RATE_MAX_PER_WINDOW = "3";
    process.env.INGEST_RATE_WINDOW_MS = "60000";
    const t0 = 1_000_000;
    expect(checkAndConsumeIngestLimit(-100, 42, t0).ok).toBe(true);
    expect(checkAndConsumeIngestLimit(-100, 42, t0 + 1).ok).toBe(true);
    expect(checkAndConsumeIngestLimit(-100, 42, t0 + 2).ok).toBe(true);
    const blocked = checkAndConsumeIngestLimit(-100, 42, t0 + 3);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryInMs).toBeGreaterThan(0);
  });

  test("limit is per (chat,user) — a different user is independent", () => {
    process.env.INGEST_RATE_MAX_PER_WINDOW = "2";
    const t0 = 2_000_000;
    expect(checkAndConsumeIngestLimit(-100, 1, t0).ok).toBe(true);
    expect(checkAndConsumeIngestLimit(-100, 1, t0).ok).toBe(true);
    expect(checkAndConsumeIngestLimit(-100, 1, t0).ok).toBe(false);
    // different user, same chat → own bucket
    expect(checkAndConsumeIngestLimit(-100, 2, t0).ok).toBe(true);
    // same user, different chat → own bucket
    expect(checkAndConsumeIngestLimit(-200, 1, t0).ok).toBe(true);
  });

  test("window slides — slots free up after the window passes", () => {
    process.env.INGEST_RATE_MAX_PER_WINDOW = "2";
    process.env.INGEST_RATE_WINDOW_MS = "1000";
    const t0 = 3_000_000;
    expect(checkAndConsumeIngestLimit(-1, 7, t0).ok).toBe(true);
    expect(checkAndConsumeIngestLimit(-1, 7, t0).ok).toBe(true);
    expect(checkAndConsumeIngestLimit(-1, 7, t0).ok).toBe(false);
    // after the window, the old entries have expired
    expect(checkAndConsumeIngestLimit(-1, 7, t0 + 1001).ok).toBe(true);
  });

  test("fail-open on missing chat or user (system/unknown sender passes)", () => {
    process.env.INGEST_RATE_MAX_PER_WINDOW = "1";
    const t0 = 4_000_000;
    expect(checkAndConsumeIngestLimit(undefined, 5, t0).ok).toBe(true);
    expect(checkAndConsumeIngestLimit(-1, undefined, t0).ok).toBe(true);
    expect(checkAndConsumeIngestLimit("", 5, t0).ok).toBe(true);
    // and these must NOT have consumed a real bucket slot
    expect(checkAndConsumeIngestLimit(-1, 5, t0).ok).toBe(true);
  });

  test("invalid env falls back to safe default (15)", () => {
    process.env.INGEST_RATE_MAX_PER_WINDOW = "not-a-number";
    const t0 = 5_000_000;
    for (let i = 0; i < 15; i++) {
      expect(checkAndConsumeIngestLimit(-9, 9, t0 + i).ok).toBe(true);
    }
    expect(checkAndConsumeIngestLimit(-9, 9, t0 + 15).ok).toBe(false);
  });

  test("prefixed and fractional env values are rejected, not truncated", () => {
    process.env.INGEST_RATE_MAX_PER_WINDOW = "2oops";
    process.env.INGEST_RATE_WINDOW_MS = "0.5";
    const t0 = 6_000_000;
    let passed = 0;
    for (let i = 0; i < 16; i++) {
      if (checkAndConsumeIngestLimit(-10, 10, t0).ok) passed++;
    }
    expect(passed).toBe(15);
  });
});
