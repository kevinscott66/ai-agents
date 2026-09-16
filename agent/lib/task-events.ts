import { emit } from "./events-bus.ts";

/** Invalidate cached task reads, never publish task contents or claimed status.
 * CRUD may run inside an outer synchronous SQLite transaction. Defer delivery
 * until that stack commits/rolls back; a rollback merely causes a harmless read.
 * This bus is process-local, so clients still need periodic reconciliation.
 */
export function invalidateTask(name: "task.created" | "task.updated", id: string): void {
  queueMicrotask(() => {
    if (name === "task.created") emit("task.created", { id });
    else emit("task.updated", { id });
  });
}
