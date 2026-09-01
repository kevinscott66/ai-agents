/**
 * T-325 alerting hooks tests.
 *
 * Covers:
 *  - emitAlert writes audit_log row + log.error
 *  - approval backlog below threshold: no alert
 *  - approval backlog above threshold: alert fired
 *  - rate-limit storm threshold: alert fires when count exceeds
 *  - db-maint archive failure: alert fired via wrapped catch
 *  - env override: threshold=0 disables alert (treat 0 as "off")
 */
import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
} from "bun:test";
import { db } from "../lib/db.ts";
import {
  emitAlert,
  checkApprovalBacklog,
  checkRateLimitStorm,
  getThresholds,
} from "../lib/alerting.ts";
import { startMaintScheduler } from "../lib/db-maint.ts";

const TEST_CHAT = -1009003250;
const TEST_AGENT = "qa-t325";

// We must clear ALL pending approvals + rate_limited agent_actions, because the
// alert checks scan the whole table (not per-test chat). Other tests may have
// left rows behind. Snapshot+restore is impractical — these tables are runtime
// state, but the test DB is the shared `data/memory.db`. Acceptable to wipe
// approvals/rate_limited rows: no other test asserts on a count of leftovers
// from foreign tests; cleanup is symmetric (beforeEach + afterEach).
function cleanup(): void {
  db.prepare(`DELETE FROM audit_logs WHERE agent_key='system'`).run();
  db.prepare(`DELETE FROM approvals`).run();
  db.prepare(`DELETE FROM agent_actions WHERE status='rate_limited'`).run();
  db.prepare(`DELETE FROM agent_actions WHERE agent_key=? OR chat_id=?`).run(
    TEST_AGENT,
    TEST_CHAT,
  );
}

function countAlerts(code: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM audit_logs WHERE event_type=? AND agent_key='system'`,
    )
    .get(`alert.${code}`) as { n: number };
  return row.n;
}

// Snapshot relevant env vars so tests can mutate them safely.
const ENV_KEYS = [
  "ALERT_APPROVAL_BACKLOG_MIN",
  "ALERT_APPROVAL_BACKLOG_AGE_MINUTES",
  "ALERT_RATE_LIMIT_STORM_COUNT",
  "ALERT_RATE_LIMIT_STORM_WINDOW_MINUTES",
];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  cleanup();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  cleanup();
});

describe("T-325 alerting", () => {
  test("emitAlert writes an audit_logs row", () => {
    expect(countAlerts("test.basic")).toBe(0);
    emitAlert("warn", "test.basic", "hello", { foo: "bar" });
    expect(countAlerts("test.basic")).toBe(1);
    const row = db
      .prepare(
        `SELECT payload FROM audit_logs WHERE event_type='alert.test.basic'`,
      )
      .get() as { payload: string };
    const decoded = JSON.parse(row.payload);
    expect(decoded.severity).toBe("warn");
    expect(decoded.message).toBe("hello");
    expect(decoded.foo).toBe("bar");
  });

  test("approval backlog below threshold: no alert", () => {
    // Insert 2 pending approvals, threshold default 10 -> no alert.
    const now = Date.now();
    const old = now - 120 * 60_000;
    for (let i = 0; i < 2; i++) {
      db.prepare(
        `INSERT INTO approvals(id, action_id, chat_id, requested_by, action_type, payload, status, created_at)
         VALUES (?, ?, ?, ?, 'SEND_MESSAGE', '{}', 'pending', ?)`,
      ).run(
        crypto.randomUUID(),
        crypto.randomUUID(),
        TEST_CHAT,
        TEST_AGENT,
        old,
      );
    }
    const fired = checkApprovalBacklog({ now });
    expect(fired).toBe(false);
    expect(countAlerts("approval.backlog")).toBe(0);
  });

  test("approval backlog above threshold: alert fires", () => {
    const now = Date.now();
    const old = now - 120 * 60_000;
    for (let i = 0; i < 5; i++) {
      db.prepare(
        `INSERT INTO approvals(id, action_id, chat_id, requested_by, action_type, payload, status, created_at)
         VALUES (?, ?, ?, ?, 'SEND_MESSAGE', '{}', 'pending', ?)`,
      ).run(
        crypto.randomUUID(),
        crypto.randomUUID(),
        TEST_CHAT,
        TEST_AGENT,
        old,
      );
    }
    const fired = checkApprovalBacklog({
      now,
      thresholds: { approvalBacklogMin: 3, approvalBacklogAgeMinutes: 60 },
    });
    expect(fired).toBe(true);
    expect(countAlerts("approval.backlog")).toBe(1);
  });

  test("approval backlog: recent approvals don't count (age filter)", () => {
    const now = Date.now();
    // Recent (created 1 minute ago), should NOT trigger 60m-old backlog alert.
    for (let i = 0; i < 20; i++) {
      db.prepare(
        `INSERT INTO approvals(id, action_id, chat_id, requested_by, action_type, payload, status, created_at)
         VALUES (?, ?, ?, ?, 'SEND_MESSAGE', '{}', 'pending', ?)`,
      ).run(
        crypto.randomUUID(),
        crypto.randomUUID(),
        TEST_CHAT,
        TEST_AGENT,
        now - 60_000,
      );
    }
    const fired = checkApprovalBacklog({
      now,
      thresholds: { approvalBacklogMin: 3, approvalBacklogAgeMinutes: 60 },
    });
    expect(fired).toBe(false);
  });

  test("rate-limit storm: alert fires when count exceeds threshold", () => {
    const now = Date.now();
    // Insert 6 rate_limited rows in past minute.
    for (let i = 0; i < 6; i++) {
      db.prepare(
        `INSERT INTO agent_actions(id, agent_key, chat_id, action_type, status, created_at)
         VALUES (?, ?, ?, 'SEND_MESSAGE', 'rate_limited', ?)`,
      ).run(crypto.randomUUID(), TEST_AGENT, TEST_CHAT, now - 30_000);
    }
    const fired = checkRateLimitStorm({
      now,
      thresholds: { rateLimitStormCount: 5, rateLimitStormWindowMinutes: 5 },
    });
    expect(fired).toBe(true);
    expect(countAlerts("rate_limit.storm")).toBe(1);
  });

  test("rate-limit storm: below threshold, no alert", () => {
    const now = Date.now();
    for (let i = 0; i < 2; i++) {
      db.prepare(
        `INSERT INTO agent_actions(id, agent_key, chat_id, action_type, status, created_at)
         VALUES (?, ?, ?, 'SEND_MESSAGE', 'rate_limited', ?)`,
      ).run(crypto.randomUUID(), TEST_AGENT, TEST_CHAT, now - 30_000);
    }
    const fired = checkRateLimitStorm({
      now,
      thresholds: { rateLimitStormCount: 5, rateLimitStormWindowMinutes: 5 },
    });
    expect(fired).toBe(false);
  });

  test("env override: threshold=0 disables alert", () => {
    process.env.ALERT_APPROVAL_BACKLOG_MIN = "0";
    process.env.ALERT_RATE_LIMIT_STORM_COUNT = "0";
    const t = getThresholds();
    expect(t.approvalBacklogMin).toBe(0);
    expect(t.rateLimitStormCount).toBe(0);

    const now = Date.now();
    // Insert plenty of triggers; nothing should fire.
    for (let i = 0; i < 20; i++) {
      db.prepare(
        `INSERT INTO approvals(id, action_id, chat_id, requested_by, action_type, payload, status, created_at)
         VALUES (?, ?, ?, ?, 'SEND_MESSAGE', '{}', 'pending', ?)`,
      ).run(
        crypto.randomUUID(),
        crypto.randomUUID(),
        TEST_CHAT,
        TEST_AGENT,
        now - 120 * 60_000,
      );
      db.prepare(
        `INSERT INTO agent_actions(id, agent_key, chat_id, action_type, status, created_at)
         VALUES (?, ?, ?, 'SEND_MESSAGE', 'rate_limited', ?)`,
      ).run(crypto.randomUUID(), TEST_AGENT, TEST_CHAT, now - 30_000);
    }
    expect(checkApprovalBacklog({ now })).toBe(false);
    expect(checkRateLimitStorm({ now })).toBe(false);
    expect(countAlerts("approval.backlog")).toBe(0);
    expect(countAlerts("rate_limit.storm")).toBe(0);
  });

  test("env override: invalid value falls back to default", () => {
    process.env.ALERT_APPROVAL_BACKLOG_MIN = "not-a-number";
    const t = getThresholds();
    expect(t.approvalBacklogMin).toBe(10); // default
  });

  test("db-maint archive failure: alert fired via wrapped catch", () => {
    // Use scheduler in test mode — don't start timers, just call _runDailyNow
    // after sabotaging archiveOldRows via a dropped table. We simulate by
    // calling startMaintScheduler with dailyPollMs that won't fire, then
    // monkey-patch is too invasive — instead, directly test by ensuring
    // emitAlert is invoked. Simulate via direct insertion: archive fails when
    // archive table is missing; we can't easily drop it. So we trigger compact
    // failure by closing... not viable.
    //
    // Pragmatic approach: trigger emitAlert via the same code path by calling
    // _runDailyNow on a scheduler where we've broken something safely. We
    // create a scheduler, then drop a table the archive query reads; restore
    // after.
    const handle = startMaintScheduler({
      gcIntervalMs: 24 * 3600 * 1000,
      dailyPollMs: 24 * 3600 * 1000,
      nowProvider: () => new Date(2000, 0, 1), // before dailyHourUTC, daily won't auto-fire
    });
    try {
      // Drop the archive table so INSERT...SELECT fails.
      db.exec(`ALTER TABLE agent_actions_archive RENAME TO _aaa_bak`);
      handle._runDailyNow();
      expect(countAlerts("db_maint.archive_failed")).toBeGreaterThanOrEqual(1);
    } finally {
      // Restore.
      try {
        db.exec(`ALTER TABLE _aaa_bak RENAME TO agent_actions_archive`);
      } catch {
        // table already restored or never renamed
      }
      handle.stop();
    }
  });

  test("обе проверки без данных — no-op", () => {
    expect(checkApprovalBacklog()).toBe(false);
    expect(checkRateLimitStorm()).toBe(false);
  });
});
