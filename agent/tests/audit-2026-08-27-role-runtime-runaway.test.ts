/**
 * Аудит 2026-08-27 (ревью PR #627): прогон роли, который никогда не кончается.
 *
 * Две находки в `processNextRoleTask`, обе про один сценарий — «висит»:
 *
 * 1. Сердцебиение стояло голым телом `setInterval`. `heartbeatRoleTask` пишет
 *    в SQLite: SQLITE_BUSY, переполненный диск, закрытая база — и исключение
 *    уходит из обработчика интервала, где его никто не ловит. Это не падение
 *    задачи, а падение процесса agent-team целиком.
 *
 * 2. Потолка по часам не было вовсе. Провайдер, зависший на сетевом вызове,
 *    держал задачу вечно: сердцебиение исправно продлевало аренду, поэтому
 *    восстановление её не подбирало — «живой» и «сдвинувшийся» для очереди
 *    было одно и то же.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import {
  enqueueRoleTask,
  getRoleQueueItem,
  processNextRoleTask,
} from "../lib/role-runtime.ts";

const CHAT_ID = -7_731_827;

function failureAlerts(taskId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM audit_logs
        WHERE event_type = 'alert.role_runtime.task_failed'
          AND payload LIKE ?`,
    )
    .get(`%${taskId}%`) as { n: number };
  return row.n;
}

function cleanup(): void {
  db.prepare("DELETE FROM role_runtime_queue WHERE chat_id = ?").run(CHAT_ID);
  db.prepare("DELETE FROM tasks WHERE chat_id = ?").run(CHAT_ID);
}

beforeEach(cleanup);
afterEach(cleanup);

function enqueue(name: string): { taskId: string } {
  return enqueueRoleTask({
    name,
    systemPrompt: "bounded fixture",
    chatId: CHAT_ID,
    createdBy: "orchestrator",
    provider: "internal",
  });
}

describe("прогон роли ограничен по часам", () => {
  test("зависший провайдер снимается по дедлайну, а не висит вечно", async () => {
    const item = enqueue("Runaway Role");
    let settled = false;
    const res = await processNextRoleTask(
      // Никогда не резолвится — ровно то, что делает зависший сетевой вызов.
      { internal: () => new Promise(() => { settled = true; }) },
      db,
      { maxRunMs: 30, heartbeatMs: 5, leaseTimeoutMs: 1000 },
    );
    expect(settled).toBe(true); // исполнитель успел стартовать
    expect(res?.state).toBe("failed");
    const row = db.prepare("SELECT status, error FROM tasks WHERE id=?").get(item.taskId) as {
      status: string;
      error: string | null;
    };
    expect(row.status).toBe("failed");
    expect(row.error ?? "").toContain("wall clock");
  });

  test("успевший в потолок прогон завершается нормально", async () => {
    const item = enqueue("Fast Role");
    const res = await processNextRoleTask(
      { internal: async () => ({ ok: true }) },
      db,
      { maxRunMs: 5_000, heartbeatMs: 1_000 },
    );
    expect(res?.state).toBe("done");
    expect(getRoleQueueItem(item.taskId)?.state).toBe("done");
  });

  test("отказ провайдера ПОСЛЕ дедлайна не роняет процесс", async () => {
    enqueue("Late Failure Role");
    // Провайдер падает уже после того, как гонку выиграл дедлайн. Без
    // перехвата это unhandled rejection, то есть смерть процесса.
    const res = await processNextRoleTask(
      {
        internal: () =>
          new Promise((_ok, reject) => {
            setTimeout(() => reject(new Error("поздний отказ провайдера")), 40);
          }),
      },
      db,
      { maxRunMs: 15, heartbeatMs: 5, leaseTimeoutMs: 1000 },
    );
    expect(res?.state).toBe("failed");
    await new Promise((r) => setTimeout(r, 60)); // переживаем поздний reject
    expect(true).toBe(true);
  });
});

describe("сбой сердцебиения не выносит процесс", () => {
  /** Роняем ровно UPDATE сердцебиения — он единственный пишет `SET input=?`. */
  function breakHeartbeat(): { restore: () => void; faults: () => number } {
    const realPrepare = db.prepare.bind(db);
    let faults = 0;
    (db as any).prepare = (sql: string, ...rest: unknown[]) => {
      if (sql.includes("UPDATE tasks SET input=?, updated_at=?")) {
        faults += 1;
        throw new Error("database is locked");
      }
      return realPrepare(sql, ...rest);
    };
    return {
      restore: () => {
        (db as any).prepare = realPrepare;
      },
      faults: () => faults,
    };
  }

  test("временный SQLITE_BUSY не выбрасывает готовый результат прогона", async () => {
    // Аудит 2026-08-27: первый же busy объявлял аренду потерянной, и прогон,
    // который уже посчитал результат, выбрасывался. Отказ записи — проблема
    // хранилища, а не потеря аренды: пока аренда не истекла, продолжаем.
    const item = enqueue("Heartbeat Busy Role");
    const fault = breakHeartbeat();
    let res;
    try {
      res = await processNextRoleTask(
        { internal: () => new Promise((ok) => setTimeout(() => ok({ done: true }), 60)) },
        db,
        { maxRunMs: 5_000, heartbeatMs: 10, leaseTimeoutMs: 60_000 },
      );
    } finally {
      fault.restore();
    }

    expect(fault.faults()).toBeGreaterThan(0);
    expect(res?.state).toBe("done");
    expect(getRoleQueueItem(item.taskId)?.state).toBe("done");
  });

  test("сердцебиение, не проходящее дольше аренды, означает её потерю", async () => {
    const item = enqueue("Heartbeat Dead Role");
    const fault = breakHeartbeat();
    let res;
    try {
      res = await processNextRoleTask(
        { internal: () => new Promise((ok) => setTimeout(() => ok({ done: true }), 200)) },
        db,
        { maxRunMs: 5_000, heartbeatMs: 10, leaseTimeoutMs: 40 },
      );
    } finally {
      fault.restore();
    }

    // Процесс жив, сбои посчитаны, задача не осталась «выполненной».
    expect(fault.faults()).toBeGreaterThan(0);
    expect(res?.state).not.toBe("done");
    expect(getRoleQueueItem(item.taskId)?.state).not.toBe("done");
  });
});

describe("терминальный отказ роли не молчит", () => {
  test("падение исполнителя пишет alert в audit_logs", async () => {
    // SPAWN_ROLE проходит ручное одобрение владельца: провалившийся прогон,
    // о котором нигде нет записи, оставляет владельца ждать вечно.
    const item = enqueue("Loud Failure Role");
    const res = await processNextRoleTask(
      { internal: () => Promise.reject(new Error("provider exploded")) },
      db,
      { maxRunMs: 5_000, heartbeatMs: 1_000, leaseTimeoutMs: 60_000 },
    );

    expect(res?.state).toBe("failed");
    expect(failureAlerts(item.taskId)).toBe(1);
  });

  test("успешный прогон alert не пишет", async () => {
    const item = enqueue("Quiet Success Role");
    const res = await processNextRoleTask(
      { internal: () => Promise.resolve({ done: true }) },
      db,
      { maxRunMs: 5_000, heartbeatMs: 1_000, leaseTimeoutMs: 60_000 },
    );

    expect(res?.state).toBe("done");
    expect(failureAlerts(item.taskId)).toBe(0);
  });
});
