/**
 * Аудит 2026-08-27 (второй заход по role-runtime): четыре места, где код
 * разошёлся с собственным описанием.
 *
 * 1. `withRunDeadline` вешал `work.catch` в `.finally()` без условия, а
 *    `.finally()` выполняется на ОБЕИХ ветках гонки. Любой отказ провайдера —
 *    даже на первой миллисекунде при потолке в 30 минут — писал в прод
 *    «провайдер завершился после дедлайна». Расследовать по такому логу
 *    нельзя: он называет не ту причину.
 *
 * 2. Обоснование того же catch («иначе unhandled rejection») неверно:
 *    `Promise.race` подписан на обе ветки. Строка нужна за другим — назвать
 *    настоящую причину, когда гонку выиграл дедлайн. Её и пиним.
 *
 * 3. `claimNextRoleTask` возвращал `getRoleQueueItem(row.id)`, а тот ищет по
 *    `q.task_id`. Не стреляло только потому, что enqueue пишет их равными.
 *
 * 4. Отказ `failRoleTask` глотался по точному тексту "role task lease lost",
 *    но на подобранной соседом задаче он бросает "role task failure raced with
 *    another queue transition" — и это исключение улетало наружу мимо
 *    emitAlert, возвращая молчаливый провал SPAWN_ROLE.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import { log } from "../lib/log.ts";
import {
  enqueueRoleTask,
  getRoleQueueItem,
  processNextRoleTask,
} from "../lib/role-runtime.ts";

const CHAT_ID = -7_731_901;
const DEADLINE_MARK = "завершился после дедлайна";

function cleanup(): void {
  db.prepare("DELETE FROM role_runtime_queue WHERE chat_id = ?").run(CHAT_ID);
  db.prepare("DELETE FROM tasks WHERE chat_id = ?").run(CHAT_ID);
  db.prepare("DELETE FROM audit_logs WHERE event_type = 'alert.role_runtime.task_failed'").run();
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

function failureAlerts(taskId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM audit_logs
        WHERE event_type = 'alert.role_runtime.task_failed' AND payload LIKE ?`,
    )
    .get(`%${taskId}%`) as { n: number };
  return row.n;
}

/** Собрать все warn-строки за время вызова. */
async function withWarnSpy<T>(fn: () => Promise<T>): Promise<{ result: T; warns: string[] }> {
  const warns: string[] = [];
  const original = log.warn;
  (log as { warn: typeof log.warn }).warn = (msg: string, meta?: unknown) => {
    warns.push(msg);
    return original.call(log, msg, meta as never);
  };
  try {
    const result = await fn();
    // Поздний `work.catch` асинхронен — даём микро-паузу, иначе тест
    // проверял бы момент ДО записи и был бы зелёным при любой реализации.
    await new Promise((r) => setTimeout(r, 80));
    return { result, warns };
  } finally {
    (log as { warn: typeof log.warn }).warn = original;
  }
}

describe("строка про дедлайн пишется только когда дедлайн действительно сработал", () => {
  test("обычный отказ провайдера при огромном потолке не называет дедлайн", async () => {
    enqueue("Early Failure Role");
    const { result, warns } = await withWarnSpy(() =>
      processNextRoleTask(
        { internal: async () => { throw new Error("нет исполнителя"); } },
        db,
        { maxRunMs: 600_000, heartbeatMs: 5_000, leaseTimeoutMs: 60_000 },
      ),
    );
    expect(result?.state).toBe("failed");
    expect(warns.filter((w) => w.includes(DEADLINE_MARK))).toEqual([]);
  });

  test("отказ провайдера ПОСЛЕ дедлайна называет дедлайн", async () => {
    enqueue("Late Failure Role");
    const { result, warns } = await withWarnSpy(() =>
      processNextRoleTask(
        {
          internal: () =>
            new Promise((_ok, reject) => {
              setTimeout(() => reject(new Error("поздний отказ провайдера")), 40);
            }),
        },
        db,
        { maxRunMs: 15, heartbeatMs: 5, leaseTimeoutMs: 1_000 },
      ),
    );
    expect(result?.state).toBe("failed");
    expect(warns.filter((w) => w.includes(DEADLINE_MARK)).length).toBe(1);
  });

  test("успешный прогон не называет дедлайн", async () => {
    enqueue("Fast Role");
    const { result, warns } = await withWarnSpy(() =>
      processNextRoleTask({ internal: async () => ({ ok: true }) }, db, {
        maxRunMs: 5_000,
        heartbeatMs: 1_000,
      }),
    );
    expect(result?.state).toBe("done");
    expect(warns.filter((w) => w.includes(DEADLINE_MARK))).toEqual([]);
  });
});

describe("claim возвращает задачу, даже если id строки очереди не равен task_id", () => {
  test("разведённые id и task_id не теряют захваченную задачу", async () => {
    const item = enqueue("Split Id Role");
    // Инвариант «id === task_id» держит только enqueue; сам по себе он ничем
    // не обеспечен, и claim обязан работать без него.
    db.prepare("UPDATE role_runtime_queue SET id = ? WHERE task_id = ?").run(
      `queue-${item.taskId}`,
      item.taskId,
    );

    const result = await processNextRoleTask({ internal: async () => ({ ok: true }) }, db, {
      maxRunMs: 5_000,
      heartbeatMs: 1_000,
    });

    // До фикса claim возвращал null: getRoleQueueItem искал по q.task_id
    // значение q.id, задача оставалась 'running' до истечения аренды.
    expect(result).not.toBeNull();
    expect(result?.taskId).toBe(item.taskId);
    expect(getRoleQueueItem(item.taskId)?.state).toBe("done");
  });
});

describe("сбой записи отказа не отменяет алерт", () => {
  test("гонка с чужим переходом очереди даёт алерт, а не исключение наружу", async () => {
    const item = enqueue("Raced Role");
    let result: Awaited<ReturnType<typeof processNextRoleTask>> = null;

    // Провайдер падает, но к моменту failRoleTask очередь уже не 'running' —
    // ровно то, что делает подметание в claimNextRoleTask, когда задачу
    // подобрал сосед.
    const run = processNextRoleTask(
      {
        internal: async () => {
          db.prepare("UPDATE role_runtime_queue SET state='queued' WHERE task_id=?").run(
            item.taskId,
          );
          throw new Error("провайдер упал");
        },
      },
      db,
      { maxRunMs: 5_000, heartbeatMs: 1_000, leaseTimeoutMs: 60_000 },
    );

    // Главное утверждение: наружу не летит ничего.
    result = await run;
    expect(result).not.toBeNull();
    expect(failureAlerts(item.taskId)).toBe(1);
  });
});
