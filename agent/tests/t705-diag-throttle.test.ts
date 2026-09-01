/**
 * T-705 throttle: авто-создание diagnostic-task ограничено N/час по типу действия
 * (анти-шторм fix-loop'ов). Покрывает чистый предикат isDiagTaskThrottled.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { db } from "../lib/db.ts";
import { isDiagTaskThrottled, diagTaskThrottleMax } from "../lib/fix-chain.ts";

const TITLE = "Tool error: SEND_MESSAGE";
const NOW = 1_000_000_000_000;

function seedDiagTasks(n: number, ts: number) {
  const ins = db.prepare(
    `INSERT INTO tasks(id, chat_id, created_by, assigned_to, title, status, created_at, updated_at)
     VALUES (?, -1, 'orchestrator', 'aieng', ?, 'pending', ?, ?)`,
  );
  for (let k = 0; k < n; k++) ins.run(`thr-${ts}-${k}`, TITLE, ts, ts);
}

describe("T-705 diag-task throttle", () => {
  beforeEach(() => {
    db.prepare("DELETE FROM tasks WHERE id LIKE 'thr-%'").run();
  });

  test("под лимитом → не throttled", () => {
    seedDiagTasks(diagTaskThrottleMax() - 1, NOW - 1000);
    expect(isDiagTaskThrottled(TITLE, NOW)).toBe(false);
  });

  test("на лимите → throttled", () => {
    seedDiagTasks(diagTaskThrottleMax(), NOW - 1000);
    expect(isDiagTaskThrottled(TITLE, NOW)).toBe(true);
  });

  test("старые (>1ч) не считаются", () => {
    seedDiagTasks(diagTaskThrottleMax() + 2, NOW - 2 * 60 * 60 * 1000);
    expect(isDiagTaskThrottled(TITLE, NOW)).toBe(false);
  });

  test("другой actionType не влияет", () => {
    seedDiagTasks(diagTaskThrottleMax(), NOW - 1000);
    expect(isDiagTaskThrottled("Tool error: DELETE_MESSAGE", NOW)).toBe(false);
  });
});
