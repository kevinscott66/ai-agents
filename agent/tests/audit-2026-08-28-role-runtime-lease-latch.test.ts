/**
 * Аудит 2026-08-28: `leaseLost` — защёлка без сброса.
 *
 * Фикс 2026-08-27 развёл два разных события в сердцебиении роли: `false` от
 * `heartbeatRoleTask` — это ограждение по leaseId, то есть аренду и правда
 * отобрали; исключение — это отказ ЗАПИСИ (SQLITE_BUSY, полный диск), и оно
 * становится потерей аренды только когда не проходит дольше `leaseTimeoutMs`.
 * Ровно так и написано в комментарии у объявления флага.
 *
 * Чего фикс не сделал: успешная ветка сбрасывает только `heartbeatFailingSince`,
 * а `leaseLost` остаётся `true` навсегда. Флаг односторонний, и на строке
 * проверки он стоит первым в `||`, то есть коротким замыканием отменяет
 * `leaseFencedOut` — единственную авторитетную проверку, которая сходила бы в
 * БД и увидела, что аренда на месте.
 *
 * Почему это не теория. `busy_timeout` — 5 секунд (lib/db.ts), аренда по
 * умолчанию — 120. Любая блокировка живой базы дольше двух минут во время
 * прогона роли даёт этот сценарий: суточное обслуживание (архивация + VACUUM),
 * восстановление из бэкапа, второе соединение из `tools/*`. Воркер в проде
 * ОДИН (orchestrator-team.ts), отбирать аренду физически некому — то есть
 * `leaseLost` здесь всегда ложный. Дальше: посчитанный (и оплаченный) результат
 * выбрасывается, `completeRoleTask` не зовётся, `failRoleTask` пропускается по
 * `if (!leaseLost)`, задача остаётся `running`, подметание подберёт её только
 * через `leaseTimeoutMs` и запустит роль заново — до `maxAttempts`. Владелец,
 * одобривший SPAWN_ROLE руками, получает алерт об отказе вместо результата.
 *
 * Правка — одна строка: успешный heartbeat ДОКАЗЫВАЕТ, что аренда наша
 * (UPDATE фенсится по leaseId и требует status='running'), значит он же и
 * снимает флаг. Настоящее ограждение это не ослабляет: после реального отбора
 * аренды в строке лежит чужой leaseId, и `heartbeatRoleTask` уже никогда не
 * вернёт `true` — второй тест ниже держит именно это.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import {
  enqueueRoleTask,
  getRoleQueueItem,
  processNextRoleTask,
} from "../lib/role-runtime.ts";

const CHAT_ID = -7_731_931;

function cleanup(): void {
  db.prepare("DELETE FROM role_runtime_queue WHERE chat_id = ?").run(CHAT_ID);
  db.prepare("DELETE FROM tasks WHERE chat_id = ?").run(CHAT_ID);
}

beforeEach(cleanup);
afterEach(cleanup);

function enqueue(name: string): { taskId: string } {
  return enqueueRoleTask({
    name,
    systemPrompt: "lease latch fixture",
    chatId: CHAT_ID,
    createdBy: "orchestrator",
    provider: "internal",
  });
}

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

/**
 * Роняем ровно UPDATE сердцебиения — он единственный пишет `SET input=?`.
 * В отличие от такого же жгута в аудите 2026-08-27, этот УМЕЕТ ЗАЖИВАТЬ:
 * весь смысл находки в том, что база отвиснет, а флаг — нет.
 */
function breakHeartbeat(): { heal: () => void; restore: () => void; faults: () => number } {
  const realPrepare = db.prepare.bind(db);
  let broken = true;
  let faults = 0;
  (db as any).prepare = (sql: string, ...rest: unknown[]) => {
    if (broken && sql.includes("UPDATE tasks SET input=?, updated_at=?")) {
      faults += 1;
      throw new Error("database is locked");
    }
    return realPrepare(sql, ...rest);
  };
  return {
    heal: () => {
      broken = false;
    },
    restore: () => {
      (db as any).prepare = realPrepare;
    },
    faults: () => faults,
  };
}

describe("отвисшая база снимает флаг потерянной аренды", () => {
  test("после починки записи результат прогона доезжает до задачи", async () => {
    const item = enqueue("Healing Heartbeat Role");
    const fault = breakHeartbeat();
    // База «залипла» дольше аренды (40 мс), потом отвисла — на оставшиеся
    // ~180 мс прогона сердцебиение проходит и подтверждает аренду.
    const healer = setTimeout(fault.heal, 120);
    let res;
    try {
      res = await processNextRoleTask(
        { internal: () => new Promise((ok) => setTimeout(() => ok({ done: true }), 300)) },
        db,
        { maxRunMs: 5_000, heartbeatMs: 10, leaseTimeoutMs: 40 },
      );
    } finally {
      clearTimeout(healer);
      fault.restore();
    }

    // Залипание было настоящим и успело перевалить за аренду.
    expect(fault.faults()).toBeGreaterThan(0);
    expect(res?.state).toBe("done");
    expect(getRoleQueueItem(item.taskId)?.state).toBe("done");
  });

  test("задача не остаётся в running, и ложного алерта об отказе нет", async () => {
    const item = enqueue("Healing Heartbeat Alerts");
    const fault = breakHeartbeat();
    const healer = setTimeout(fault.heal, 120);
    try {
      await processNextRoleTask(
        { internal: () => new Promise((ok) => setTimeout(() => ok({ ok: 1 }), 300)) },
        db,
        { maxRunMs: 5_000, heartbeatMs: 10, leaseTimeoutMs: 40 },
      );
    } finally {
      clearTimeout(healer);
      fault.restore();
    }

    const row = db
      .prepare("SELECT status, output, error FROM tasks WHERE id=?")
      .get(item.taskId) as { status: string; output: string | null; error: string | null };
    expect(row.status).toBe("done");
    expect(row.output ?? "").toContain('"ok"');
    expect(failureAlerts(item.taskId)).toBe(0);
  });
});

describe("настоящее ограждение не ослабло", () => {
  test("отобранная аренда всё так же хоронит прогон", async () => {
    // Здесь база исправна, а leaseId в строке подменён — то есть
    // `heartbeatRoleTask` возвращает false, и вернуть true уже не сможет
    // никогда. Это и есть разница между «не смог записать» и «не моё».
    const item = enqueue("Fenced Out Role");
    const steal = setTimeout(() => {
      db.prepare(
        `UPDATE tasks
            SET input = json_set(input, '$._role_runtime.leaseId', 'someone-else')
          WHERE id = ?`,
      ).run(item.taskId);
    }, 30);
    let res;
    try {
      res = await processNextRoleTask(
        { internal: () => new Promise((ok) => setTimeout(() => ok({ done: true }), 200)) },
        db,
        { maxRunMs: 5_000, heartbeatMs: 10, leaseTimeoutMs: 40 },
      );
    } finally {
      clearTimeout(steal);
    }

    expect(res?.state).not.toBe("done");
    expect(getRoleQueueItem(item.taskId)?.state).not.toBe("done");
    const row = db.prepare("SELECT output FROM tasks WHERE id=?").get(item.taskId) as {
      output: string | null;
    };
    expect(row.output ?? "").not.toContain('"done"');
  });

  test("сердцебиение, не проходящее до самого конца, аренду не подтверждает", async () => {
    // Контроль к первому describe: если базу НЕ починить, поведение прежнее.
    const item = enqueue("Never Healing Role");
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

    expect(fault.faults()).toBeGreaterThan(0);
    expect(res?.state).not.toBe("done");
    expect(getRoleQueueItem(item.taskId)?.state).not.toBe("done");
  });
});
