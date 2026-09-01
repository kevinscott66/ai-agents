/**
 * T-402: Userbot anti-flood gate per character/chat
 *
 * Hermetic: no network, no real userbot client, no file writes.
 * All process.env mutations are restored in try/finally.
 *
 * Test coverage:
 *  (a) 100 sends in a row → limiter cuts to budget, rest rejected with retryInMs
 *  (b) Two different characters in the same chat have independent buckets
 *  (c) floodBackoffMs grows exponentially, respects server seconds + cap
 *  (d) parseFloodWaitSeconds handles gramjs-style errors (message string + .seconds field)
 *  (e) withUserbotFloodGuard retries on FLOOD_WAIT and gives up after maxFloodRetries
 *  (f) withUserbotFloodGuard passes non-FLOOD_WAIT errors through immediately
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  checkUserbotFloodLimit,
  commitUserbotFloodLimit,
  _resetRateLimits,
} from "../lib/rate-limits.ts";
import {
  floodBackoffMs,
  parseFloodWaitSeconds,
  isFloodWaitError,
  withUserbotFloodGuard,
  _resetFloodCooldowns,
  INITIAL_BACKOFF_MS,
  MAX_BACKOFF_MS,
} from "../lib/userbot-flood.ts";

// ─── helpers ────────────────────────────────────────────────────────────────

const FLOOD_MAX_KEY = "USERBOT_FLOOD_MAX_PER_WINDOW";
const FLOOD_WIN_KEY = "USERBOT_FLOOD_WINDOW_MS";
// Аудит 2026-08-28: от него зависит, ведём мы ведро на роль или на аккаунт.
const ROUTER_KEY = "USERBOT_ROUTER_ENABLED";

function saveEnv() {
  return {
    max: process.env[FLOOD_MAX_KEY],
    win: process.env[FLOOD_WIN_KEY],
    router: process.env[ROUTER_KEY],
  };
}
function restoreEnv(saved: ReturnType<typeof saveEnv>) {
  if (saved.max === undefined) delete process.env[FLOOD_MAX_KEY];
  else process.env[FLOOD_MAX_KEY] = saved.max;
  if (saved.win === undefined) delete process.env[FLOOD_WIN_KEY];
  else process.env[FLOOD_WIN_KEY] = saved.win;
  if (saved.router === undefined) delete process.env[ROUTER_KEY];
  else process.env[ROUTER_KEY] = saved.router;
}

let savedEnv: ReturnType<typeof saveEnv>;

beforeEach(() => {
  savedEnv = saveEnv();
  _resetRateLimits();
  // Аудит 2026-08-28: кулдаун FLOOD_WAIT ведётся на аккаунт, а не на роль, и
  // взведённый одним тестом глушит все следующие — раньше их разделяли разные
  // characterId.
  _resetFloodCooldowns();
});

afterEach(() => {
  restoreEnv(savedEnv);
  _resetRateLimits();
  _resetFloodCooldowns();
});

// ─── (a) Limiter cuts to budget ──────────────────────────────────────────────

describe("checkUserbotFloodLimit — per-character/chat bucket", () => {
  test("(a) 100 sends → only budget passes, rest rejected with retryInMs", () => {
    // Set a small budget for the test
    process.env[FLOOD_MAX_KEY] = "20";
    process.env[FLOOD_WIN_KEY] = "60000";

    const charId = "tgdev";
    const chatId = "-1001";
    const now = 1_000_000;
    let passed = 0;
    let rejected = 0;
    let retryInMsSeen = false;

    for (let i = 0; i < 100; i++) {
      const r = checkUserbotFloodLimit(charId, chatId, now);
      if (r.ok) {
        passed++;
        commitUserbotFloodLimit(charId, chatId, now);
      } else {
        rejected++;
        if (r.retryInMs !== undefined && r.retryInMs > 0) retryInMsSeen = true;
      }
    }

    expect(passed).toBe(20);
    expect(rejected).toBe(80);
    expect(retryInMsSeen).toBe(true);
  });

  // ─── (b) Independent buckets per character ──────────────────────────────

  // Аудит 2026-08-28: раздельные вёдра у двух ролей верны только когда у роли
  // своя сессия, то есть при включённом роутере. На общей сессии владельца это
  // был учетверённый потолок — см.
  // audit-2026-08-28-userbot-flood-shared-account.test.ts.
  test("(b) with router: two different characters in same chat have independent buckets", () => {
    process.env[FLOOD_MAX_KEY] = "5";
    process.env[FLOOD_WIN_KEY] = "60000";
    process.env[ROUTER_KEY] = "true"; // восстанавливает afterEach

    const chat = "-2001";
    const now = 2_000_000;

    // Fill bucket for charA
    for (let i = 0; i < 5; i++) {
      const r = checkUserbotFloodLimit("charA", chat, now);
      expect(r.ok).toBe(true);
      commitUserbotFloodLimit("charA", chat, now);
    }
    // charA is now rate-limited
    expect(checkUserbotFloodLimit("charA", chat, now).ok).toBe(false);

    // charB bucket is independent — should allow 5 sends
    let passedB = 0;
    for (let i = 0; i < 5; i++) {
      const r = checkUserbotFloodLimit("charB", chat, now);
      if (r.ok) {
        passedB++;
        commitUserbotFloodLimit("charB", chat, now);
      }
    }
    expect(passedB).toBe(5);
    // charB is now also rate-limited
    expect(checkUserbotFloodLimit("charB", chat, now).ok).toBe(false);
  });

  test("missing characterId → always passes (no-context fallback)", () => {
    process.env[FLOOD_MAX_KEY] = "1";
    const now = 3_000_000;
    for (let i = 0; i < 5; i++) {
      expect(checkUserbotFloodLimit(undefined, "-9999", now).ok).toBe(true);
    }
  });

  test("missing chatId → always passes", () => {
    process.env[FLOOD_MAX_KEY] = "1";
    const now = 4_000_000;
    for (let i = 0; i < 5; i++) {
      expect(checkUserbotFloodLimit("charX", undefined, now).ok).toBe(true);
    }
  });

  test("invalid env values fall back to defaults (fail-closed: 20/60s)", () => {
    process.env[FLOOD_MAX_KEY] = "not-a-number";
    process.env[FLOOD_WIN_KEY] = "-5";

    const now = 5_000_000;
    let passed = 0;
    for (let i = 0; i < 25; i++) {
      const r = checkUserbotFloodLimit("charD", "-3001", now);
      if (r.ok) {
        passed++;
        commitUserbotFloodLimit("charD", "-3001", now);
      }
    }
    // Default is 20, so exactly 20 should pass
    expect(passed).toBe(20);
  });

  test("prefixed and fractional env values are rejected, not truncated", () => {
    process.env[FLOOD_MAX_KEY] = "2oops";
    process.env[FLOOD_WIN_KEY] = "0.5";
    const now = 5_500_000;
    let passed = 0;
    for (let i = 0; i < 21; i++) {
      const r = checkUserbotFloodLimit("strict", "-3002", now);
      if (r.ok) {
        passed++;
        commitUserbotFloodLimit("strict", "-3002", now);
      }
    }
    expect(passed).toBe(20);
  });

  test("reason string mentions character/chat limit", () => {
    process.env[FLOOD_MAX_KEY] = "1";
    commitUserbotFloodLimit("charE", "-4001");
    const r = checkUserbotFloodLimit("charE", "-4001");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/userbot flood limit/);
  });
});

// ─── (c) floodBackoffMs ───────────────────────────────────────────────────────

describe("floodBackoffMs — exponential backoff calculator", () => {
  test("(c) grows exponentially across attempts (jitter=0 for determinism)", () => {
    const b0 = floodBackoffMs(0, undefined, 0); // 1000
    const b1 = floodBackoffMs(1, undefined, 0); // 2000
    const b2 = floodBackoffMs(2, undefined, 0); // 4000
    const b3 = floodBackoffMs(3, undefined, 0); // 8000

    expect(b0).toBe(INITIAL_BACKOFF_MS);
    expect(b1).toBe(2 * INITIAL_BACKOFF_MS);
    expect(b2).toBe(4 * INITIAL_BACKOFF_MS);
    expect(b3).toBe(8 * INITIAL_BACKOFF_MS);
  });

  test("respects server-provided seconds when larger than exponential", () => {
    // attempt=0 → base=1000ms, server=45s=45000ms → should use 45000
    const b = floodBackoffMs(0, 45, 0);
    expect(b).toBe(45_000);
  });

  test("caps at MAX_BACKOFF_MS", () => {
    const b = floodBackoffMs(100, undefined, 0);
    expect(b).toBe(MAX_BACKOFF_MS);
  });

  test("cap also applies when server provides enormous wait", () => {
    const b = floodBackoffMs(0, 99999, 0);
    expect(b).toBe(MAX_BACKOFF_MS);
  });

  test("later attempts are always >= earlier attempts (monotone without jitter)", () => {
    for (let i = 0; i < 7; i++) {
      expect(floodBackoffMs(i + 1, undefined, 0)).toBeGreaterThanOrEqual(
        floodBackoffMs(i, undefined, 0),
      );
    }
  });
});

// ─── (d) parseFloodWaitSeconds ───────────────────────────────────────────────

describe("parseFloodWaitSeconds — gramjs error parsing", () => {
  test("(d) parses FLOOD_WAIT_<N> from error message string", () => {
    expect(parseFloodWaitSeconds(new Error("FLOOD_WAIT_30"))).toBe(30);
    expect(parseFloodWaitSeconds(new Error("flood_wait_120"))).toBe(120); // case-insensitive
  });

  test("parses .seconds field (gramjs FloodWaitError-style)", () => {
    const err = { seconds: 47, message: "A FLOOD_WAIT error occurred" };
    expect(parseFloodWaitSeconds(err)).toBe(47);
  });

  test(".seconds field takes priority over message", () => {
    const err = { seconds: 10, message: "FLOOD_WAIT_999" };
    expect(parseFloodWaitSeconds(err)).toBe(10); // .seconds wins
  });

  test("returns undefined for non-FLOOD_WAIT errors", () => {
    expect(parseFloodWaitSeconds(new Error("CONNECTION_KILLED"))).toBeUndefined();
    expect(parseFloodWaitSeconds(null)).toBeUndefined();
    expect(parseFloodWaitSeconds(undefined)).toBeUndefined();
    expect(parseFloodWaitSeconds(42)).toBeUndefined();
  });

  test("parses FLOOD_WAIT from string primitive", () => {
    expect(parseFloodWaitSeconds("FLOOD_WAIT_15")).toBe(15);
  });

  test("isFloodWaitError returns true for FLOOD_WAIT errors without seconds", () => {
    // Error message has FLOOD_WAIT but no numeric suffix
    expect(isFloodWaitError(new Error("FLOOD_WAIT"))).toBe(true);
  });

  test("isFloodWaitError returns false for unrelated errors", () => {
    expect(isFloodWaitError(new Error("TIMEOUT"))).toBe(false);
  });
});

// ─── (e) withUserbotFloodGuard retries ────────────────────────────────────────

describe("withUserbotFloodGuard — FLOOD_WAIT retry behaviour", () => {
  test("(e) succeeds on first try and commits bucket", async () => {
    process.env[FLOOD_MAX_KEY] = "5";
    const noopSleep = async (_ms: number) => {};
    let calls = 0;

    const result = await withUserbotFloodGuard(
      "agent1",
      "-5001",
      async () => {
        calls++;
        return "sent";
      },
      { _sleep: noopSleep, _recorder: null },
    );

    expect(result.ok).toBe(true);
    expect(result.value).toBe("sent");
    expect(calls).toBe(1);
    expect(result.floodRetries).toBe(0);
  });

  test("retries on FLOOD_WAIT and eventually succeeds", async () => {
    process.env[FLOOD_MAX_KEY] = "5";
    const sleptMs: number[] = [];
    const noopSleep = async (ms: number) => { sleptMs.push(ms); };
    let calls = 0;
    const floodErr = new Error("FLOOD_WAIT_5");

    const result = await withUserbotFloodGuard(
      "agent2",
      "-5002",
      async () => {
        calls++;
        if (calls < 3) throw floodErr;
        return "ok";
      },
      { _sleep: noopSleep, _recorder: null, maxFloodRetries: 3 },
    );

    expect(result.ok).toBe(true);
    expect(calls).toBe(3);
    expect(result.floodRetries).toBe(2);
    expect(sleptMs.length).toBe(2);
  });

  test("gives up after maxFloodRetries and returns error", async () => {
    process.env[FLOOD_MAX_KEY] = "5";
    const noopSleep = async (_ms: number) => {};
    const floodErr = { seconds: 10, message: "FLOOD_WAIT_10" };

    const result = await withUserbotFloodGuard(
      "agent3",
      "-5003",
      async () => { throw floodErr; },
      { _sleep: noopSleep, _recorder: null, maxFloodRetries: 2 },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe(floodErr);
    expect(result.floodRetries).toBe(3); // attempts: 0,1,2 → 3 flood retries
  });

  test("(f) non-FLOOD_WAIT error propagates immediately without retry", async () => {
    process.env[FLOOD_MAX_KEY] = "5";
    const noopSleep = async (_ms: number) => {};
    const boom = new Error("PEER_NOT_FOUND");
    let calls = 0;

    const result = await withUserbotFloodGuard(
      "agent4",
      "-5004",
      async () => {
        calls++;
        throw boom;
      },
      { _sleep: noopSleep, _recorder: null, maxFloodRetries: 3 },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe(boom);
    expect(calls).toBe(1); // no retry
    expect(result.floodRetries).toBe(0);
  });

  test("returns rateLimited when pre-flight check fails", async () => {
    process.env[FLOOD_MAX_KEY] = "2";
    const now = Date.now();
    commitUserbotFloodLimit("agent5", "-5005", now);
    commitUserbotFloodLimit("agent5", "-5005", now);
    // Bucket is full — pre-flight should block

    const result = await withUserbotFloodGuard(
      "agent5",
      "-5005",
      async () => "should not run",
      { _recorder: null },
    );

    expect(result.ok).toBe(false);
    expect(result.rateLimited).toBeDefined();
    expect(result.rateLimited!.retryInMs).toBeGreaterThanOrEqual(0);
  });

  test("episode recorder is called on first FLOOD_WAIT", async () => {
    process.env[FLOOD_MAX_KEY] = "5";
    const noopSleep = async (_ms: number) => {};
    const recorded: string[] = [];
    let calls = 0;
    const floodErr = new Error("FLOOD_WAIT_3");

    const result = await withUserbotFloodGuard(
      "agent6",
      "-5006",
      async () => {
        calls++;
        if (calls === 1) throw floodErr;
        return "ok";
      },
      {
        _sleep: noopSleep,
        _recorder: (line) => recorded.push(line),
        maxFloodRetries: 3,
      },
    );

    expect(result.ok).toBe(true);
    expect(recorded.length).toBe(1); // recorded exactly once
    expect(recorded[0]).toMatch(/FLOOD_WAIT/);
    expect(recorded[0]).toMatch(/agent6/);
  });
});

/**
 * Аудит 2026-08-08: дефолтный приёмник инцидента писал в
 * `.claude/memory/episodes/<today>.md` относительно cwd. На проде cwd —
 * /opt/agent-team, куда деплой везёт только agent/; каталога нет, запись падала,
 * `catch {}` глотал. Единственный долговечный след FLOOD_WAIT у аккаунта
 * владельца на проде не появлялся никогда.
 *
 * Инъекция `_recorder` тестами это и скрывала: проверяли, что рекордер зовут,
 * а не что дефолтный куда-то доезжает. Здесь — именно дефолтный путь.
 */
describe("дефолтный приёмник инцидента доезжает до audit_logs", () => {
  test("makeDefaultEpisodeRecorder пишет строку alert.userbot.flood_wait", async () => {
    const { makeDefaultEpisodeRecorder } = await import("../lib/userbot-flood.ts");
    const { db } = await import("../lib/db.ts");
    const marker = `FLOOD_WAIT_7 marker-${process.pid}`;
    makeDefaultEpisodeRecorder()(marker);
    const row = db
      .prepare(
        `SELECT payload FROM audit_logs
         WHERE event_type = 'alert.userbot.flood_wait'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get() as { payload: string } | undefined;
    expect(row).toBeDefined();
    expect(JSON.parse(row!.payload).message).toBe(marker);
  });
});
