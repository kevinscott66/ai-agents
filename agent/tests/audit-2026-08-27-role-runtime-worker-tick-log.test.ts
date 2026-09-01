/**
 * Аудит 2026-08-27: воркер SPAWN_ROLE — видимость сбоя тика и удержание loop'а.
 *
 * Отказ САМОЙ задачи с 2026-08-27 даёт строку `alert.role_runtime.task_failed`
 * в audit_logs, то есть виден в Mini App. Отказ ТИКА воркера (сбой БД внутри
 * claimNextRoleTask, до всякой задачи) не виден нигде, кроме journalctl, —
 * и там он писался как `String(error)`, то есть без стека. Между «SQLITE_BUSY»
 * и «no such table» разницы в такой строке нет, а лечатся они по-разному.
 *
 * Второе: `setInterval` воркера был единственным таймером модуля без `unref()`.
 * Watchdog, self-diag и SSE-keepalive свои снимают с учёта; здесь забытый (не
 * остановленный) воркер держал процесс живым.
 */
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { log } from "../lib/log.ts";
import { startRoleRuntimeWorker } from "../lib/role-runtime-worker.ts";

/** Исполнители не важны: тик падает раньше, на обращении к БД. */
const executors = {
  internal: async () => ({}),
  claude: async () => ({}),
} as any;

function captureErrors(): { lines: Array<[string, any]>; restore: () => void } {
  const lines: Array<[string, any]> = [];
  const original = log.error;
  (log as { error: typeof log.error }).error = (msg: string, meta?: unknown) => {
    lines.push([msg, meta]);
    return undefined as never;
  };
  return { lines, restore: () => ((log as { error: typeof log.error }).error = original) };
}

describe("role-runtime worker: сбой тика", () => {
  test("логируется с текстом и стеком, а не через String(error)", async () => {
    const broken = {
      prepare() {
        throw new Error("no such table: role_runtime_queue");
      },
    } as any;

    // `startRoleRuntimeWorker` делает первый тик сразу и сам (`void tick()`),
    // а `busy` не пускает второй параллельно — поэтому ждём именно его, а не
    // зовём `handle.tick()` следом: тот честно вернул бы null, ничего не
    // тронув, и тест проверял бы собственную заглушку.
    const cap = captureErrors();
    const handle = startRoleRuntimeWorker({ executors, database: broken });
    try {
      await new Promise((r) => setTimeout(r, 20));
      await expect(handle.tick()).resolves.toBeNull();
    } finally {
      handle.stop();
      cap.restore();
    }

    const tickFail = cap.lines.find(([msg]) => msg.includes("worker tick failed"));
    expect(tickFail).toBeDefined();
    const meta = tickFail![1] as { error?: string; stack?: string };
    // Не "Error: no such table…", а сам текст — как во всём остальном коде.
    expect(meta.error).toBe("no such table: role_runtime_queue");
    expect(meta.error).not.toContain("Error:");
    expect(typeof meta.stack).toBe("string");
    expect(meta.stack!.length).toBeGreaterThan(0);
  });

  test("сбой тика не пробрасывается наружу", async () => {
    const broken = {
      prepare() {
        throw new Error("database is locked");
      },
    } as any;
    const cap = captureErrors();
    const handle = startRoleRuntimeWorker({ executors, database: broken });
    try {
      await expect(handle.tick()).resolves.toBeNull();
    } finally {
      handle.stop();
      cap.restore();
    }
  });

  test("после stop() тик больше ничего не делает", async () => {
    const cap = captureErrors();
    let touched = 0;
    const counting = {
      prepare() {
        touched++;
        throw new Error("stopped worker must not reach the database");
      },
    } as any;
    const handle = startRoleRuntimeWorker({ executors, database: counting });
    try {
      await new Promise((r) => setTimeout(r, 20));
      const afterFirst = touched;
      expect(afterFirst).toBeGreaterThan(0);
      handle.stop();
      await handle.tick();
      expect(touched).toBe(afterFirst);
    } finally {
      handle.stop();
      cap.restore();
    }
  });

  test("таймер воркера снят с учёта event loop", () => {
    const src = readFileSync(new URL("../lib/role-runtime-worker.ts", import.meta.url), "utf8");
    const body = src.slice(src.indexOf("export function startRoleRuntimeWorker"));
    expect(body).toContain(".unref()");
  });
});
