/**
 * C31 DB-maint tests.
 *
 * - archiveOldRows переносит row из agent_actions в agent_actions_archive
 *   и удаляет из исходной таблицы.
 * - gcStaleTasks меняет статус stale running-таски на failed/gc_stale.
 * - dbStats возвращает ненулевые числа после вставок.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import { logAction } from "../lib/audit.ts";
import { createTask, getTask } from "../lib/tasks.ts";
import {
  archiveOldRows,
  gcStaleTasks,
  dbStats,
} from "../lib/db-maint.ts";

const TEST_CHAT = -1009003101;
const TEST_AGENT = "qa";

function cleanup(): void {
  db.prepare(`DELETE FROM agent_actions WHERE agent_key = ? OR chat_id = ?`).run(
    TEST_AGENT,
    TEST_CHAT,
  );
  db.prepare(`DELETE FROM agent_actions_archive WHERE agent_key = ?`).run(
    TEST_AGENT,
  );
  db.prepare(`DELETE FROM tasks WHERE chat_id = ?`).run(TEST_CHAT);
}

beforeEach(cleanup);
afterEach(cleanup);

describe("C31 db-maint", () => {
  test("archiveOldRows moves old rows to archive and deletes from source", () => {
    // Insert one OLD action (created_at 60 days ago) and one fresh.
    const now = Date.now();
    const old = logAction({
      agentKey: TEST_AGENT,
      actionType: "SEND_MESSAGE",
      chatId: TEST_CHAT,
      status: "ok",
    });
    const fresh = logAction({
      agentKey: TEST_AGENT,
      actionType: "SEND_MESSAGE",
      chatId: TEST_CHAT,
      status: "ok",
    });
    // Back-date the "old" row to 60 days ago.
    const sixtyDaysAgo = now - 60 * 24 * 60 * 60 * 1000;
    db.prepare(`UPDATE agent_actions SET created_at = ? WHERE id = ?`).run(
      sixtyDaysAgo,
      old.id,
    );

    const res = archiveOldRows({ olderThanDays: 30, now });
    expect(res.agent_actions).toBe(1);

    // Old row gone from source, present in archive.
    const inSource = db
      .prepare(`SELECT id FROM agent_actions WHERE id = ?`)
      .get(old.id);
    expect(inSource == null).toBe(true);
    const inArchive = db
      .prepare(`SELECT id, archived_at FROM agent_actions_archive WHERE id = ?`)
      .get(old.id) as { id: string; archived_at: number } | undefined;
    expect(inArchive).toBeTruthy();
    expect(inArchive!.archived_at).toBeGreaterThan(0);

    // Fresh row untouched.
    const freshStill = db
      .prepare(`SELECT id FROM agent_actions WHERE id = ?`)
      .get(fresh.id);
    expect(freshStill).toBeTruthy();
  });

  test("gcStaleTasks marks stale running task as failed with gc_stale", () => {
    const t = createTask({
      chatId: TEST_CHAT,
      createdBy: "orchestrator",
      assignedTo: TEST_AGENT,
      title: "stuck task",
    });
    // Set to running, then back-date updated_at to 48h ago.
    db.prepare(
      `UPDATE tasks SET status='running', updated_at=? WHERE id=?`,
    ).run(Date.now() - 48 * 60 * 60 * 1000, t.id);

    const res = gcStaleTasks();
    expect(res.failed).toBeGreaterThanOrEqual(1);
    expect(res.ids).toContain(t.id);

    const after = getTask(t.id);
    expect(after).toBeTruthy();
    expect(after!.status).toBe("failed");
    expect(after!.error).toBe("gc_stale");
  });

  test("gcStaleTasks ignores fresh pending tasks", () => {
    const t = createTask({
      chatId: TEST_CHAT,
      createdBy: "orchestrator",
      assignedTo: TEST_AGENT,
      title: "fresh task",
    });
    const res = gcStaleTasks();
    expect(res.ids).not.toContain(t.id);
    const after = getTask(t.id);
    expect(after!.status).toBe("pending");
  });

  test("dbStats returns rows and total db-file size", () => {
    // Seed some data so counts are non-zero.
    logAction({
      agentKey: TEST_AGENT,
      actionType: "SEND_MESSAGE",
      chatId: TEST_CHAT,
      status: "ok",
    });
    createTask({
      chatId: TEST_CHAT,
      createdBy: "orchestrator",
      assignedTo: TEST_AGENT,
      title: "stats task",
    });

    const stats = dbStats();
    expect(Array.isArray(stats)).toBe(true);
    expect(stats.length).toBeGreaterThan(0);

    const byName = new Map(stats.map((s) => [s.table, s]));
    expect(byName.get("agent_actions")!.rows).toBeGreaterThan(0);
    expect(byName.get("tasks")!.rows).toBeGreaterThan(0);

    // Аудит 2026-08-08: растущие таблицы, которых в статистике не было —
    // по экрану «БД» нельзя было понять, из чего складывается размер файла.
    for (const t of ["content_calendar", "agent_prompts", "processed_triggers"]) {
      expect(byName.has(t)).toBe(true);
      expect(byName.get(t)!.rows).toBeGreaterThanOrEqual(0);
    }

    const dbFile = byName.get("__db_file__");
    expect(dbFile).toBeTruthy();
    expect(dbFile!.size_bytes).toBeGreaterThan(0);
  });
});
