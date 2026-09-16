import { test, expect } from "bun:test";
import { db } from "../lib/db.ts";
import { createTask, updateTaskStatus, getTask } from "../lib/tasks.ts";
import { enqueueRoleTask, claimNextRoleTask, completeRoleTask, failRoleTask } from "../lib/role-runtime.ts";
import { subscribe, type BusEvent } from "../lib/events-bus.ts";

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

test("agent CRUD publishes metadata invalidations after outer transaction and parent rollup", async () => {
  const events: BusEvent[] = [];
  const unsubscribe = subscribe((e) => { if (e.name.startsWith("task.")) events.push(e); });
  const ids: string[] = [];
  try {
    db.transaction(() => {
      const parent = createTask({ chatId: -99160916, createdBy: "backend", title: "private parent" });
      const child = createTask({ chatId: -99160916, createdBy: "backend", title: "private child", parentId: parent.id });
      ids.push(child.id, parent.id);
      updateTaskStatus(child.id, "running");
      updateTaskStatus(child.id, "done", { output: "private output" });
      expect(events).toHaveLength(0);
    })();
    await flush();
    for (const id of ids) {
      expect(events.some((e) => e.name === "task.created" && (e.payload as any).id === id)).toBe(true);
      expect(events.some((e) => e.name === "task.updated" && (e.payload as any).id === id)).toBe(true);
      expect(getTask(id)?.status).toBe("done");
    }
    expect(events.every((e) => Object.keys(e.payload as object).join() === "id")).toBe(true);
  } finally {
    unsubscribe();
    for (const id of ids) db.prepare("DELETE FROM tasks WHERE id=?").run(id);
  }
});

test("role queue publishes creation, claim, completion and failure invalidations", async () => {
  const events: BusEvent[] = [];
  const unsubscribe = subscribe((e) => events.push(e));
  const ids: string[] = [];
  try {
    for (const fail of [false, true]) {
      const item = enqueueRoleTask({ name: "Event fixture", systemPrompt: "private", chatId: -99160916, createdBy: "backend" });
      ids.push(item.taskId);
      await flush();
      expect(events.some((e) => e.name === "task.created" && (e.payload as any).id === item.taskId)).toBe(true);
      const claimed = claimNextRoleTask()!;
      expect(claimed.taskId).toBe(item.taskId);
      await flush();
      events.length = 0;
      if (fail) failRoleTask(item.taskId, "private error", db, claimed.leaseId!);
      else completeRoleTask(item.taskId, "private result", db, claimed.leaseId!);
      await flush();
      expect(events).toHaveLength(1);
      expect(events[0].name).toBe("task.updated");
      expect(events[0].payload).toEqual({ id: item.taskId });
      expect(getTask(item.taskId)?.status).toBe(fail ? "failed" : "done");
    }
  } finally {
    unsubscribe();
    for (const id of ids) {
      db.prepare("DELETE FROM role_runtime_queue WHERE task_id=?").run(id);
      db.prepare("DELETE FROM tasks WHERE id=?").run(id);
    }
  }
});
