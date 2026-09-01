/**
 * Повтор после падения перестал быть немым (аудит 2026-08-29).
 *
 * Подметание брошенных аренд в `claimNextRoleTask` возвращало задачу в очередь
 * по одному только протухшему heartbeat'у. Отличить «процесс умер, не дойдя до
 * модели» от «процесс умер посреди прогона» было нечем: `startedAt` ставится в
 * момент ЗАХВАТА, а не отправки. Второй случай — прогон через Agent SDK, уже
 * списанный в `agent_token_usage`; повтор списывает его заново, и так до трёх
 * раз (`maxAttempts`), при этом единственный след — строка `tasks.error`,
 * которую увидит лишь тот, кто пришёл смотреть именно эту задачу. Платит за
 * повтор владелец, а узнать о нём ему было неоткуда.
 *
 * Метка `dispatchedAt` ставится ПЕРЕД вызовом исполнителя и переживает падение
 * процесса, потому что лежит в строке задачи, — тот же приём, что у
 * `markDiagDispatched` в `self-diag`. По ней подметание и решает, чем является
 * повтор: продолжением работы или второй оплатой того же прогона.
 *
 * Алерт шлётся ПОСЛЕ коммита: он пишет в `audit_logs`, и отправленный изнутри
 * `tx.immediate()` при откате остался бы рассказом о событии, которого не было.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import {
  enqueueRoleTask,
  claimNextRoleTask,
  markRoleTaskDispatched,
  getRoleQueueItem,
} from "../lib/role-runtime.ts";

const CHAT_ID = -7_731_952;

type Alert = { severity: string; code: string; message: string; data: Record<string, unknown> };

function cleanup(): void {
  db.prepare("DELETE FROM role_runtime_queue WHERE chat_id = ?").run(CHAT_ID);
  db.prepare("DELETE FROM tasks WHERE chat_id = ?").run(CHAT_ID);
}
beforeEach(cleanup);
afterEach(cleanup);

function enqueue(name: string) {
  return enqueueRoleTask({
    name,
    systemPrompt: "paid rerun fixture",
    chatId: CHAT_ID,
    createdBy: "orchestrator",
    provider: "internal",
  });
}

function collector() {
  const out: Alert[] = [];
  const alert = ((severity: string, code: string, message: string, data: Record<string, unknown> = {}) => {
    out.push({ severity, code, message, data });
  }) as never;
  return { out, alert };
}

/** Отматывает heartbeat в прошлое — ровно то, что видит подметание. */
function expireLease(taskId: string, at: number): void {
  db.prepare(
    `UPDATE tasks SET input = json_set(input, '$._role_runtime.heartbeatAt', ?), updated_at = ?
     WHERE id = ?`,
  ).run(at, at, taskId);
}

function leaseOf(taskId: string): Record<string, any> {
  const row = db.prepare(`SELECT input FROM tasks WHERE id = ?`).get(taskId) as {
    input: string;
  };
  return JSON.parse(row.input)._role_runtime;
}

describe("метка отправки отличает оплаченный повтор от бесплатного", () => {
  test("без метки подбор молчит — до модели не дошло", () => {
    const { taskId } = enqueue("paid-a");
    const claimed = claimNextRoleTask(db, { maxAttempts: 3 });
    expect(claimed?.taskId).toBe(taskId);
    expect(leaseOf(taskId).dispatchedAt).toBeUndefined();

    expireLease(taskId, Date.now() - 60 * 60_000);
    const c = collector();
    claimNextRoleTask(db, { maxAttempts: 3, alert: c.alert });
    expect(c.out).toEqual([]);
    expect(getRoleQueueItem(taskId)?.state).toBe("running");
  });

  test("с меткой подбор называет повтор оплаченным", () => {
    const { taskId } = enqueue("paid-b");
    const claimed = claimNextRoleTask(db, { maxAttempts: 3 });
    expect(markRoleTaskDispatched(taskId, claimed!.leaseId!, db)).toBe(true);
    expect(typeof leaseOf(taskId).dispatchedAt).toBe("number");

    expireLease(taskId, Date.now() - 60 * 60_000);
    const c = collector();
    claimNextRoleTask(db, { maxAttempts: 3, alert: c.alert });
    expect(c.out.map((a) => a.code)).toEqual(["role_runtime.rerun_after_crash"]);
    expect(c.out[0]!.data).toMatchObject({ taskId, attempt: 1, nextAttempt: 2 });
  });

  test("исчерпанные попытки сообщают об отказе, а не о повторе", () => {
    const { taskId } = enqueue("paid-c");
    const claimed = claimNextRoleTask(db, { maxAttempts: 1 });
    markRoleTaskDispatched(taskId, claimed!.leaseId!, db);
    expireLease(taskId, Date.now() - 60 * 60_000);

    const c = collector();
    claimNextRoleTask(db, { maxAttempts: 1, alert: c.alert });
    expect(c.out.map((a) => a.code)).toEqual(["role_runtime.lease_expired"]);
    expect(c.out[0]!.data).toMatchObject({ taskId, dispatched: true });
    expect(getRoleQueueItem(taskId)?.state).toBe("failed");
  });

  test("метка переживает подбор и остаётся у своей попытки", () => {
    const { taskId } = enqueue("paid-d");
    const first = claimNextRoleTask(db, { maxAttempts: 3 });
    markRoleTaskDispatched(taskId, first!.leaseId!, db);
    const stamped = leaseOf(taskId).dispatchedAt as number;

    expireLease(taskId, Date.now() - 60 * 60_000);
    const c = collector();
    // Подметание и захват идут одной транзакцией: этот же вызов возвращает
    // задачу в очередь и тут же берёт её заново.
    const second = claimNextRoleTask(db, { maxAttempts: 3, alert: c.alert });
    expect(second?.taskId).toBe(taskId);
    expect(second?.leaseId).not.toBe(first?.leaseId);
    // Новая аренда — новая попытка: метка прошлой не должна выдавать её за
    // уже оплаченную, иначе один краш давал бы алерт на каждом следующем круге.
    expect(leaseOf(taskId).dispatchedAt).toBeUndefined();
    expect(stamped).toBeGreaterThan(0);
    expect(c.out.map((a) => a.code)).toEqual(["role_runtime.rerun_after_crash"]);
  });
});

describe("markRoleTaskDispatched огорожена по аренде", () => {
  test("чужой leaseId метку не ставит", () => {
    const { taskId } = enqueue("paid-e");
    claimNextRoleTask(db, { maxAttempts: 3 });
    expect(markRoleTaskDispatched(taskId, "someone-else", db)).toBe(false);
    expect(leaseOf(taskId).dispatchedAt).toBeUndefined();
  });

  test("повторный вызов идемпотентен и не двигает метку", () => {
    const { taskId } = enqueue("paid-f");
    const claimed = claimNextRoleTask(db, { maxAttempts: 3 });
    expect(markRoleTaskDispatched(taskId, claimed!.leaseId!, db, 1_000)).toBe(true);
    expect(markRoleTaskDispatched(taskId, claimed!.leaseId!, db, 2_000)).toBe(true);
    expect(leaseOf(taskId).dispatchedAt).toBe(1_000);
  });
});
