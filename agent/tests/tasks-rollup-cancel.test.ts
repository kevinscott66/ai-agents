/**
 * Regression tests for the parent-rollup-on-cancellation gap (audit pass 2).
 *
 * Two fixes are covered here:
 *  1. updateTaskStatus() now triggers rollupParent when a child becomes
 *     `cancelled` (previously only done/failed), so a parent whose LAST child
 *     settles via cancellation no longer stays stuck in pending/running.
 *  2. rollupParent() target priority: any failed → failed; else any done →
 *     done; else (every child cancelled) → cancelled (not "done").
 */
import { describe, test, expect } from "bun:test";
import { createTask, updateTaskStatus, getTask } from "../lib/tasks.ts";

function makeDone(id: string) {
  updateTaskStatus(id, "running");
  updateTaskStatus(id, "done");
}

describe("rollupParent — cancellation paths", () => {
  test("last child cancelled (sibling done) → parent rolls up to done", () => {
    const parent = createTask({ chatId: -1, createdBy: "test", title: "p" });
    const a = createTask({ chatId: -1, createdBy: "test", title: "a", parentId: parent.id });
    const b = createTask({ chatId: -1, createdBy: "test", title: "b", parentId: parent.id });

    makeDone(a.id);
    // Parent must still be open — not all children terminal yet.
    expect(getTask(parent.id)!.status).not.toBe("done");

    // Cancelling the final pending child must trigger the rollup.
    updateTaskStatus(b.id, "cancelled");
    expect(getTask(parent.id)!.status).toBe("done");
  });

  test("all children cancelled → parent rolls up to cancelled (nothing completed)", () => {
    const parent = createTask({ chatId: -1, createdBy: "test", title: "p2" });
    const a = createTask({ chatId: -1, createdBy: "test", title: "a", parentId: parent.id });
    const b = createTask({ chatId: -1, createdBy: "test", title: "b", parentId: parent.id });

    updateTaskStatus(a.id, "cancelled");
    expect(getTask(parent.id)!.status).not.toBe("cancelled"); // b still pending
    updateTaskStatus(b.id, "cancelled");
    expect(getTask(parent.id)!.status).toBe("cancelled");
  });

  test("any failed child wins over done/cancelled siblings → parent failed", () => {
    const parent = createTask({ chatId: -1, createdBy: "test", title: "p3" });
    const a = createTask({ chatId: -1, createdBy: "test", title: "a", parentId: parent.id });
    const b = createTask({ chatId: -1, createdBy: "test", title: "b", parentId: parent.id });
    const c = createTask({ chatId: -1, createdBy: "test", title: "c", parentId: parent.id });

    makeDone(a.id);
    updateTaskStatus(b.id, "cancelled");
    updateTaskStatus(c.id, "running");
    updateTaskStatus(c.id, "failed");
    expect(getTask(parent.id)!.status).toBe("failed");
  });
});
