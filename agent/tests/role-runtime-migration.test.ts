import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { MIGRATIONS } from "../lib/migrations.ts";

const migration = MIGRATIONS.find((item) => item.name === "044_role_runtime_queue")!;

function openDb(): Database {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      depth INTEGER NOT NULL,
      chat_id INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      assigned_to TEXT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL,
      deadline INTEGER,
      input TEXT,
      output TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  return database;
}

describe("044_role_runtime_queue migration", () => {
  test("imports only claimable pending legacy work and is idempotent", () => {
    const database = openDb();
    const input = JSON.stringify({
      _spawn_role: true,
      role_slug: "legacy-audit",
      system_prompt: "audit",
      task_hint: "check auth",
    });
    const insert = database.prepare(`
      INSERT INTO tasks(
        id, parent_id, depth, chat_id, created_by, assigned_to, title,
        description, status, priority, deadline, input, output, error,
        created_at, updated_at
      ) VALUES (?, NULL, 0, ?, ?, NULL, ?, NULL, ?, 0, NULL, ?, NULL, NULL, 1, 1)
    `);
    insert.run("pending-legacy", 100, "orchestrator", "Spawn role", "pending", input);
    insert.run("running-legacy", 100, "orchestrator", "Spawn role", "running", input);

    migration.up(database);
    migration.up(database);

    expect(database.prepare("SELECT COUNT(*) AS n FROM role_runtime_queue").get()).toEqual({ n: 1 });
    expect(database.prepare(
      "SELECT task_id, state, provider FROM role_runtime_queue",
    ).get()).toEqual({ task_id: "pending-legacy", state: "queued", provider: "internal" });
    expect(database.prepare(
      "SELECT COUNT(*) AS n FROM role_runtime_queue WHERE task_id='running-legacy'",
    ).get()).toEqual({ n: 0 });
    database.close();
  });
});
