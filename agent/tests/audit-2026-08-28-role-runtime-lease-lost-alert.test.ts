/**
 * Аудит 2026-08-28: потеря аренды приходила владельцу как отказ задачи.
 *
 * В `catch` у `processNextRoleTask` две разные ситуации сходились в один
 * алерт `role_runtime.task_failed`. Но при `leaseLost` мы САМИ решили ничего
 * не писать в задачу (`if (!leaseLost)` выше пропускает `failRoleTask`):
 * строка остаётся `running`, и задачу либо уже держит сосед, либо подберёт
 * подметание в `claimNextRoleTask`. То есть код «роль завершилась отказом»
 * приходил про задачу, которая через минуту могла доехать успешной.
 *
 * Цена не косметическая: `task_failed` — единственный терминальный сигнал по
 * SPAWN_ROLE (одобрение владельца ручное, результата он ждёт лично). Пока в
 * него подмешивались потери аренды, он не значил ни «провалилось», ни
 * «доедет» — а решать по нему нужно именно это.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import { enqueueRoleTask, getRoleQueueItem, processNextRoleTask } from "../lib/role-runtime.ts";

const CHAT_ID = -7_731_949;

function cleanup(): void {
  db.prepare("DELETE FROM role_runtime_queue WHERE chat_id = ?").run(CHAT_ID);
  db.prepare("DELETE FROM tasks WHERE chat_id = ?").run(CHAT_ID);
}

beforeEach(cleanup);
afterEach(cleanup);

function enqueue(name: string): { taskId: string } {
  return enqueueRoleTask({
    name,
    systemPrompt: "lease lost alert fixture",
    chatId: CHAT_ID,
    createdBy: "orchestrator",
    provider: "internal",
  });
}

/** Полезная нагрузка алерта плоская: `{severity, message, ...data}`. */
function alerts(code: string, taskId: string): Record<string, any>[] {
  const rows = db
    .prepare(
      `SELECT payload FROM audit_logs
        WHERE event_type = ? AND payload LIKE ?
        ORDER BY id`,
    )
    .all(`alert.${code}`, `%${taskId}%`) as { payload: string }[];
  return rows.map((r) => JSON.parse(r.payload));
}

/** Подменяем leaseId в строке — ровно то, что делает сосед, отобравший аренду. */
function stealLease(taskId: string, delayMs: number): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    db.prepare(
      `UPDATE tasks SET input = json_set(input, '$._role_runtime.leaseId', 'someone-else')
        WHERE id = ?`,
    ).run(taskId);
  }, delayMs);
}

describe("потерянная аренда", () => {
  test("даёт собственный код, а не отказ задачи", async () => {
    const item = enqueue("Lease Lost Role");
    const steal = stealLease(item.taskId, 30);
    try {
      await processNextRoleTask(
        { internal: () => new Promise((ok) => setTimeout(() => ok({ done: true }), 200)) },
        db,
        { maxRunMs: 5_000, heartbeatMs: 10, leaseTimeoutMs: 40 },
      );
    } finally {
      clearTimeout(steal);
    }

    expect(alerts("role_runtime.task_failed", item.taskId).length).toBe(0);
    const lost = alerts("role_runtime.lease_lost", item.taskId);
    expect(lost.length).toBe(1);
    expect(lost[0].roleSlug).toBeTruthy();
    expect(lost[0].provider).toBe("internal");
    expect(lost[0].chatId).toBe(CHAT_ID);
  });

  test("текст алерта не обещает, что результата не будет", async () => {
    const item = enqueue("Lease Lost Wording");
    const steal = stealLease(item.taskId, 30);
    try {
      await processNextRoleTask(
        { internal: () => new Promise((ok) => setTimeout(() => ok({ done: true }), 200)) },
        db,
        { maxRunMs: 5_000, heartbeatMs: 10, leaseTimeoutMs: 40 },
      );
    } finally {
      clearTimeout(steal);
    }

    const [lost] = alerts("role_runtime.lease_lost", item.taskId);
    expect(lost.message).toContain("отброшен");
    expect(lost.message).not.toContain("отказом");
  });

  test("задача остаётся живой — её подберёт восстановление", async () => {
    // Смысл разделения: строка не терминальная, поэтому и код не терминальный.
    const item = enqueue("Lease Lost Still Running");
    const steal = stealLease(item.taskId, 30);
    try {
      await processNextRoleTask(
        { internal: () => new Promise((ok) => setTimeout(() => ok({ done: true }), 200)) },
        db,
        { maxRunMs: 5_000, heartbeatMs: 10, leaseTimeoutMs: 40 },
      );
    } finally {
      clearTimeout(steal);
    }

    expect(getRoleQueueItem(item.taskId)?.state).toBe("running");
    const row = db.prepare("SELECT status FROM tasks WHERE id=?").get(item.taskId) as {
      status: string;
    };
    expect(row.status).toBe("running");
  });
});

describe("настоящий отказ не переехал в новый код", () => {
  test("упавший провайдер по-прежнему даёт task_failed", async () => {
    const item = enqueue("Real Failure Role");
    await processNextRoleTask(
      {
        internal: () => Promise.reject(new Error("провайдер не отвечает")),
      },
      db,
      { maxRunMs: 5_000, heartbeatMs: 10_000, leaseTimeoutMs: 40_000 },
    );

    const failed = alerts("role_runtime.task_failed", item.taskId);
    expect(failed.length).toBe(1);
    expect(failed[0].error).toContain("провайдер не отвечает");
    expect(alerts("role_runtime.lease_lost", item.taskId).length).toBe(0);
    expect(getRoleQueueItem(item.taskId)?.state).toBe("failed");
  });

  test("успешный прогон не даёт ни того, ни другого", async () => {
    const item = enqueue("Happy Role");
    await processNextRoleTask({ internal: async () => ({ ok: 1 }) }, db, {
      maxRunMs: 5_000,
      heartbeatMs: 10_000,
      leaseTimeoutMs: 40_000,
    });

    expect(alerts("role_runtime.task_failed", item.taskId).length).toBe(0);
    expect(alerts("role_runtime.lease_lost", item.taskId).length).toBe(0);
    expect(getRoleQueueItem(item.taskId)?.state).toBe("done");
  });
});
