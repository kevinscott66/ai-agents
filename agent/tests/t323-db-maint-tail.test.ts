/**
 * T-323 db-maint tail coverage.
 *
 * Targets functions/branches not covered by c31-db-maint.test.ts:
 * - compactDb() VACUUM + ANALYZE happy path
 * - archiveOldRows() audit_logs branch + idempotency (no double-archive)
 * - startMaintScheduler() handle: stop() idempotent, _runDailyNow() invokes archive+compact
 * - scheduler daily-window: skips before dailyHourUTC, runs once at/after threshold
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import { logAction } from "../lib/audit.ts";
import {
  archiveOldRows,
  compactDb,
  startMaintScheduler,
} from "../lib/db-maint.ts";

const TEST_CHAT = -1009003231;
const TEST_AGENT = "qa-t323";

function cleanup(): void {
  db.prepare(`DELETE FROM agent_actions WHERE agent_key = ? OR chat_id = ?`).run(
    TEST_AGENT,
    TEST_CHAT,
  );
  db.prepare(`DELETE FROM agent_actions_archive WHERE agent_key = ?`).run(
    TEST_AGENT,
  );
  db.prepare(`DELETE FROM audit_logs WHERE agent_key = ? OR chat_id = ?`).run(
    TEST_AGENT,
    TEST_CHAT,
  );
  db.prepare(`DELETE FROM audit_logs_archive WHERE agent_key = ?`).run(
    TEST_AGENT,
  );
  db.prepare(`DELETE FROM tasks WHERE chat_id = ?`).run(TEST_CHAT);
}

beforeEach(cleanup);
afterEach(cleanup);

function insertAuditLog(id: string, createdAt: number): void {
  db.prepare(
    `INSERT INTO audit_logs (id, agent_key, chat_id, event_type, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, TEST_AGENT, TEST_CHAT, "test_event", '{"k":1}', createdAt);
}

describe("T-323 db-maint tail", () => {
  test("compactDb runs VACUUM + ANALYZE without error", () => {
    // Populate + delete to give VACUUM something to reclaim.
    for (let i = 0; i < 10; i++) {
      logAction({
        agentKey: TEST_AGENT,
        actionType: "SEND_MESSAGE",
        chatId: TEST_CHAT,
        status: "ok",
      });
    }
    db.prepare(`DELETE FROM agent_actions WHERE agent_key = ?`).run(TEST_AGENT);

    const res = compactDb();
    expect(res.ok).toBe(true);
    expect(typeof res.ms).toBe("number");
    expect(res.ms).toBeGreaterThanOrEqual(0);
  });

  test("archiveOldRows archives audit_logs branch", () => {
    const now = Date.now();
    const oldId = `audit-old-${now}`;
    const freshId = `audit-fresh-${now}`;
    const sixtyDaysAgo = now - 60 * 24 * 60 * 60 * 1000;
    insertAuditLog(oldId, sixtyDaysAgo);
    insertAuditLog(freshId, now);

    const res = archiveOldRows({ olderThanDays: 30, now });
    expect(res.audit_logs).toBeGreaterThanOrEqual(1);

    const inSource = db
      .prepare(`SELECT id FROM audit_logs WHERE id = ?`)
      .get(oldId);
    expect(inSource == null).toBe(true);

    const inArchive = db
      .prepare(`SELECT id, archived_at FROM audit_logs_archive WHERE id = ?`)
      .get(oldId) as { id: string; archived_at: number } | undefined;
    expect(inArchive).toBeTruthy();
    expect(inArchive!.archived_at).toBeGreaterThan(0);

    const freshStill = db
      .prepare(`SELECT id FROM audit_logs WHERE id = ?`)
      .get(freshId);
    expect(freshStill).toBeTruthy();
  });

  test("archiveOldRows is idempotent: second run finds nothing left to archive", () => {
    const now = Date.now();
    const oldAction = logAction({
      agentKey: TEST_AGENT,
      actionType: "SEND_MESSAGE",
      chatId: TEST_CHAT,
      status: "ok",
    });
    const sixtyDaysAgo = now - 60 * 24 * 60 * 60 * 1000;
    db.prepare(`UPDATE agent_actions SET created_at = ? WHERE id = ?`).run(
      sixtyDaysAgo,
      oldAction.id,
    );

    const first = archiveOldRows({ olderThanDays: 30, now });
    expect(first.agent_actions).toBe(1);

    const second = archiveOldRows({ olderThanDays: 30, now });
    expect(second.agent_actions).toBe(0);

    // Archive row count for that id stays at 1 (INSERT OR IGNORE).
    const archiveCount = db
      .prepare(`SELECT COUNT(*) AS n FROM agent_actions_archive WHERE id = ?`)
      .get(oldAction.id) as { n: number };
    expect(archiveCount.n).toBe(1);
  });

  test("startMaintScheduler returns handle with stop() idempotent + _runDailyNow()", () => {
    // Use long intervals so timers don't fire during the test.
    const h = startMaintScheduler({
      gcIntervalMs: 60 * 60 * 1000,
      dailyPollMs: 60 * 60 * 1000,
      dailyHourUTC: 4,
      archiveDays: 30,
    });
    try {
      expect(typeof h.stop).toBe("function");
      expect(typeof h._runDailyNow).toBe("function");

      // _runDailyNow invokes archive + compact — must not throw on empty data.
      expect(() => h._runDailyNow()).not.toThrow();
    } finally {
      h.stop();
      // Second stop is a no-op.
      expect(() => h.stop()).not.toThrow();
    }
  });

  test("scheduler daily tick: dailyHourUTC gate runs only when hour >= threshold", async () => {
    // Two synthetic "nows": one before threshold (hour 2 UTC), one after (hour 5 UTC).
    let now = new Date("2026-01-01T02:00:00Z");
    const h = startMaintScheduler({
      gcIntervalMs: 60 * 60 * 1000, // far future
      dailyPollMs: 20, // tick fast
      dailyHourUTC: 4,
      archiveDays: 30,
      nowProvider: () => now,
    });

    try {
      // Insert one OLD agent_action; after the daily tick fires, it should be archived.
      const old = logAction({
        agentKey: TEST_AGENT,
        actionType: "SEND_MESSAGE",
        chatId: TEST_CHAT,
        status: "ok",
      });
      const sixtyDaysAgo = Date.now() - 60 * 24 * 60 * 60 * 1000;
      db.prepare(`UPDATE agent_actions SET created_at = ? WHERE id = ?`).run(
        sixtyDaysAgo,
        old.id,
      );

      // Wait two poll-cycles at hour=2 — must NOT archive.
      await new Promise((r) => setTimeout(r, 60));
      const stillThere = db
        .prepare(`SELECT id FROM agent_actions WHERE id = ?`)
        .get(old.id);
      expect(stillThere).toBeTruthy();

      // Bump synthetic now past threshold.
      now = new Date("2026-01-01T05:00:00Z");
      await new Promise((r) => setTimeout(r, 80));

      const archived = db
        .prepare(`SELECT id FROM agent_actions_archive WHERE id = ?`)
        .get(old.id);
      expect(archived).toBeTruthy();
    } finally {
      h.stop();
    }
  });
});
