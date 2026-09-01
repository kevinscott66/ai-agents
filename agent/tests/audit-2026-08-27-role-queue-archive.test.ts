/**
 * Аудит 2026-08-27: `role_runtime_queue` не убиралась ничем.
 *
 * В `archiveOldRows` было три спеки (agent_actions, audit_logs, approvals),
 * `gcMessages` про messages, `gcStaleTasks` правит `tasks` — очередь ролей не
 * трогал никто. Каждая её строка держит `system_prompt` целиком, то есть
 * несколько килобайт текста, живущих в горячей БД бессрочно после того, как
 * роль отработала.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import { archiveOldRows, ROLE_RUNTIME_QUEUE_SPEC } from "../lib/db-maint.ts";

const CHAT_ID = -7_731_919;
const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

function cleanup(): void {
  db.prepare("DELETE FROM role_runtime_queue WHERE chat_id = ?").run(CHAT_ID);
  db.prepare("DELETE FROM role_runtime_queue_archive WHERE chat_id = ?").run(CHAT_ID);
  db.prepare("DELETE FROM tasks WHERE chat_id = ?").run(CHAT_ID);
}

beforeEach(cleanup);
afterEach(cleanup);

function seed(id: string, state: string, ageDays: number): void {
  const taskId = `task-${id}`;
  db.prepare(
    `INSERT INTO tasks(id, depth, chat_id, created_by, title, status, priority,
                       created_at, updated_at)
     VALUES (?, 0, ?, 'orchestrator', ?, 'done', 'normal', ?, ?)`,
  ).run(taskId, CHAT_ID, `role ${id}`, NOW - ageDays * DAY, NOW - ageDays * DAY);
  db.prepare(
    `INSERT INTO role_runtime_queue(
       id, task_id, role_slug, system_prompt, task_hint, provider, state,
       chat_id, created_by, created_at)
     VALUES (?, ?, 'auditor', ?, 'hint', 'internal', ?, ?, 'orchestrator', ?)`,
  ).run(id, taskId, "x".repeat(4096), state, CHAT_ID, NOW - ageDays * DAY);
}

function liveIds(): string[] {
  return (
    db
      .prepare("SELECT id FROM role_runtime_queue WHERE chat_id = ? ORDER BY id")
      .all(CHAT_ID) as { id: string }[]
  ).map((row) => row.id);
}

describe("очередь ролей уезжает в холодное хранилище", () => {
  test("терминальные строки старше отсечки переносятся целиком", () => {
    seed("old-done", "done", 90);
    seed("old-failed", "failed", 90);

    const res = archiveOldRows({ olderThanDays: 30, now: NOW });

    expect(res.role_runtime_queue).toBe(2);
    expect(liveIds()).toEqual([]);
    const archived = db
      .prepare(
        `SELECT system_prompt, state, archived_at FROM role_runtime_queue_archive
          WHERE id = 'old-done'`,
      )
      .get() as { system_prompt: string; state: string; archived_at: number };
    // Промпт переезжает, а не теряется: очередь — след одобренного действия.
    expect(archived.system_prompt.length).toBe(4096);
    expect(archived.state).toBe("done");
    expect(archived.archived_at).toBe(NOW);
  });

  test("незавершённую работу возраст не выносит", () => {
    // Иначе архивация вырывала бы строку из-под аренды claimNextRoleTask.
    seed("old-queued", "queued", 400);
    seed("old-running", "running", 400);

    const res = archiveOldRows({ olderThanDays: 30, now: NOW });

    expect(res.role_runtime_queue).toBe(0);
    expect(liveIds()).toEqual(["old-queued", "old-running"]);
  });

  test("свежие терминальные строки остаются в живой таблице", () => {
    seed("fresh-done", "done", 1);

    const res = archiveOldRows({ olderThanDays: 30, now: NOW });

    expect(res.role_runtime_queue).toBe(0);
    expect(liveIds()).toEqual(["fresh-done"]);
  });

  test("спека объявляет все колонки источника", () => {
    // resolveArchiveColumns fail-closed: незадекларированная колонка роняет
    // весь суточный прогон. Тест ловит дрейф схемы до прода.
    const source = (
      db.prepare("PRAGMA table_info(role_runtime_queue)").all() as { name: string }[]
    ).map((column) => column.name);
    const declared = new Set([
      ...ROLE_RUNTIME_QUEUE_SPEC.columns,
      ...(ROLE_RUNTIME_QUEUE_SPEC.optionalColumns ?? []),
    ]);
    expect(source.filter((column) => !declared.has(column))).toEqual([]);
  });
});
