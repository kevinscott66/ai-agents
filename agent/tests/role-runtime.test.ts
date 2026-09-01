import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import {
  claimNextRoleTask,
  completeRoleTask,
  enqueueRoleTask,
  failRoleTask,
  getRoleQueueItem,
  heartbeatRoleTask,
  processNextRoleTask,
  selectRoleProvider,
} from "../lib/role-runtime.ts";

const CHAT_ID = -7_731_204;

function cleanup(): void {
  db.prepare("DELETE FROM role_runtime_queue WHERE chat_id = ?").run(CHAT_ID);
  db.prepare("DELETE FROM tasks WHERE chat_id = ?").run(CHAT_ID);
}

beforeEach(cleanup);
afterEach(cleanup);

describe("local role runtime queue", () => {
  test("provider selection is explicit and Codex requires supervisor confirmation", () => {
    expect(selectRoleProvider("internal")).toBe("internal");
    expect(selectRoleProvider("claude")).toBe("claude");
    expect(() => selectRoleProvider("unknown")).toThrow("unknown role provider");
    expect(() => selectRoleProvider("codex")).toThrow("unavailable");
    expect(selectRoleProvider("codex", { codexAvailable: true })).toBe("codex");
  });

  test("enqueue and claim are atomic; a second claimant gets no duplicate work", () => {
    const item = enqueueRoleTask({
      name: "Race Review",
      systemPrompt: "review the bounded test fixture",
      taskHint: "check the queue",
      chatId: CHAT_ID,
      createdBy: "orchestrator",
      provider: "internal",
    });

    const first = claimNextRoleTask();
    const second = claimNextRoleTask();
    expect(first?.taskId).toBe(item.taskId);
    expect(second).toBeNull();
    expect(getRoleQueueItem(item.taskId)?.state).toBe("running");
    expect((db.prepare("SELECT status FROM tasks WHERE id=?").get(item.taskId) as { status: string }).status).toBe("running");
  });

  test("heartbeats keep a lease alive and stale running work is recovered with fencing", () => {
    const item = enqueueRoleTask({
      name: "Recoverable Role",
      systemPrompt: "run recoverable work",
      chatId: CHAT_ID,
      createdBy: "orchestrator",
    });
    const first = claimNextRoleTask(db, {
      workerId: "worker-a",
      now: () => 1_000,
      leaseTimeoutMs: 500,
    });
    expect(first?.taskId).toBe(item.taskId);
    expect(first?.leaseId).toBeTruthy();
    expect(heartbeatRoleTask(item.taskId, first!.leaseId!, db, 1_200)).toBe(true);
    expect(getRoleQueueItem(item.taskId)?.heartbeatAt).toBe(1_200);

    const recovered = claimNextRoleTask(db, {
      workerId: "worker-b",
      now: () => 2_000,
      leaseTimeoutMs: 500,
    });
    expect(recovered?.taskId).toBe(item.taskId);
    expect(recovered?.attempt).toBe(2);
    expect(recovered?.leaseId).not.toBe(first?.leaseId);
    expect(heartbeatRoleTask(item.taskId, first!.leaseId!, db, 2_100)).toBe(false);
    expect(() => completeRoleTask(item.taskId, "stale", db, first!.leaseId)).toThrow("lease lost");
    completeRoleTask(item.taskId, "fresh", db, recovered!.leaseId);
    expect(getRoleQueueItem(item.taskId)?.state).toBe("done");
  });

  test("stale cancelled task rows are never claimed", () => {
    const item = enqueueRoleTask({
      name: "Cancelled Role",
      systemPrompt: "must not execute",
      chatId: CHAT_ID,
      createdBy: "orchestrator",
    });
    db.prepare("UPDATE tasks SET status='cancelled' WHERE id=?").run(item.taskId);

    expect(claimNextRoleTask()).toBeNull();
    expect(getRoleQueueItem(item.taskId)?.state).toBe("failed");
  });

  test("completion is idempotent and does not reopen terminal work", () => {
    const item = enqueueRoleTask({
      name: "Complete Role",
      systemPrompt: "return one result",
      chatId: CHAT_ID,
      createdBy: "orchestrator",
    });
    expect(claimNextRoleTask()?.taskId).toBe(item.taskId);

    completeRoleTask(item.taskId, { ok: true });
    completeRoleTask(item.taskId, { ok: true, duplicate: true });

    expect(getRoleQueueItem(item.taskId)?.state).toBe("done");
    const task = db.prepare("SELECT status, output FROM tasks WHERE id=?").get(item.taskId) as { status: string; output: string };
    expect(task.status).toBe("done");
    expect(JSON.parse(task.output)).toEqual({ ok: true });
    expect(() => failRoleTask(item.taskId, "late failure")).toThrow("queue transition");
  });

  test("processes an internal provider and fails visibly when executor is absent", async () => {
    const success = enqueueRoleTask({
      name: "Internal Worker",
      systemPrompt: "run internal",
      chatId: CHAT_ID,
      createdBy: "orchestrator",
      provider: "internal",
    });
    const processed = await processNextRoleTask({
      internal: async (claimed) => ({ role: claimed.roleSlug, provider: claimed.provider }),
    });
    expect(processed?.taskId).toBe(success.taskId);
    expect(processed?.state).toBe("done");

    const missing = enqueueRoleTask({
      name: "Missing Worker",
      systemPrompt: "must fail",
      chatId: CHAT_ID,
      createdBy: "orchestrator",
      provider: "claude",
    });
    const failed = await processNextRoleTask({});
    expect(failed?.taskId).toBe(missing.taskId);
    expect(failed?.state).toBe("failed");
    expect((db.prepare("SELECT status, error FROM tasks WHERE id=?").get(missing.taskId) as { status: string; error: string }).status).toBe("failed");
  });
});
