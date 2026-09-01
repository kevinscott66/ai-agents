/**
 * Аудит 2026-08-28: залипший воркер очереди ролей был виден только в journalctl.
 *
 * Отказ ЗАДАЧИ даёт `alert.role_runtime.task_failed` и доезжает до Mini App.
 * Отказ ТИКА (сбой БД в claimNextRoleTask, до всякой задачи) не давал ничего:
 * аудит 2026-08-27 добавил стек в лог и прямо записал рядом «другой видимости
 * у этого отказа нет», но следа так и не завёл.
 *
 * Снаружи залипший воркер неотличим от простаивающего: он продолжает тикать
 * каждые pollMs и возвращать null. Очередь при этом не разбирает никто, а
 * SPAWN_ROLE ждёт результат, которого не будет.
 *
 * Порог в три отказа подряд отсекает одиночный SQLITE_BUSY; окно повтора не
 * даёт залипшей БД писать строку в audit_logs каждые пять секунд.
 */
import { describe, expect, test } from "bun:test";
import { log } from "../lib/log.ts";
import {
  startRoleRuntimeWorker,
  WORKER_ALERT_AFTER_FAILURES,
  WORKER_ALERT_REPEAT_MS,
} from "../lib/role-runtime-worker.ts";

const executors = { internal: async () => ({}), claude: async () => ({}) } as any;

/** Исполнители не важны: тик падает раньше, на первом обращении к БД. */
function toggleDb(mode: { fail: boolean }) {
  return {
    prepare() {
      if (mode.fail) throw new Error("no such table: role_runtime_queue");
      // Пустая очередь: claimNextRoleTask выходит на этом же запросе.
      return { get: () => ({ present: 0 }) };
    },
  } as any;
}

type Alert = { severity: string; code: string; message: string; data: any };

function collector() {
  const seen: Alert[] = [];
  const alert = ((severity: any, code: any, message: any, data: any = {}) => {
    seen.push({ severity, code, message, data });
  }) as any;
  return { seen, alert };
}

/** Лог глушим: тик обязан писать error, а прогон — оставаться читаемым. */
function muteErrors(): () => void {
  const original = log.error;
  (log as { error: typeof log.error }).error = (() => undefined) as never;
  return () => ((log as { error: typeof log.error }).error = original);
}

/**
 * Воркер делает первый тик сам (`void tick()`), поэтому ждём его, а не зовём
 * `handle.tick()` сразу: параллельный вызов отсечёт `busy` и вернёт null,
 * ничего не тронув. Интервал уводим далеко, чтобы тики считал только тест.
 */
async function ticks(handle: { tick: () => Promise<unknown> }, extra: number) {
  await new Promise((r) => setTimeout(r, 20));
  for (let i = 0; i < extra; i++) await handle.tick();
}

describe("алерт о залипшем воркере", () => {
  test("одиночный отказ никого не будит", async () => {
    const { seen, alert } = collector();
    const restore = muteErrors();
    const handle = startRoleRuntimeWorker({
      executors,
      database: toggleDb({ fail: true }),
      pollMs: 60_000,
      alert,
      now: () => 1_000,
    });
    try {
      await ticks(handle, 0);
      expect(seen).toEqual([]);
    } finally {
      handle.stop();
      restore();
    }
  });

  test("порог отказов подряд даёт ровно один алерт", async () => {
    const { seen, alert } = collector();
    const restore = muteErrors();
    const handle = startRoleRuntimeWorker({
      executors,
      database: toggleDb({ fail: true }),
      pollMs: 60_000,
      alert,
      now: () => 1_000,
    });
    try {
      await ticks(handle, WORKER_ALERT_AFTER_FAILURES - 1);
      expect(seen.length).toBe(1);
      expect(seen[0].severity).toBe("error");
      expect(seen[0].code).toBe("role_runtime.worker_stalled");
      expect(seen[0].data.consecutiveFailures).toBe(WORKER_ALERT_AFTER_FAILURES);
      expect(seen[0].data.error).toBe("no such table: role_runtime_queue");
      // Не "Error: no such table…" — то же правило, что у строки лога.
      expect(String(seen[0].data.error)).not.toContain("Error:");
    } finally {
      handle.stop();
      restore();
    }
  });

  test("внутри окна повтора алерт один, за окном — второй", async () => {
    const { seen, alert } = collector();
    const restore = muteErrors();
    let clock = 1_000;
    const handle = startRoleRuntimeWorker({
      executors,
      database: toggleDb({ fail: true }),
      pollMs: 60_000,
      alert,
      now: () => clock,
    });
    try {
      await ticks(handle, WORKER_ALERT_AFTER_FAILURES + 5);
      expect(seen.length).toBe(1);

      clock += WORKER_ALERT_REPEAT_MS;
      await handle.tick();
      expect(seen.length).toBe(2);
      expect(seen[1].data.consecutiveFailures).toBeGreaterThan(WORKER_ALERT_AFTER_FAILURES);
    } finally {
      handle.stop();
      restore();
    }
  });

  test("успешный тик сбрасывает счётчик — серия начинается заново", async () => {
    const { seen, alert } = collector();
    const restore = muteErrors();
    const mode = { fail: true };
    const handle = startRoleRuntimeWorker({
      executors,
      database: toggleDb(mode),
      pollMs: 60_000,
      alert,
      now: () => 1_000,
    });
    try {
      // Два отказа — порога ещё нет.
      await ticks(handle, WORKER_ALERT_AFTER_FAILURES - 2);
      expect(seen).toEqual([]);

      mode.fail = false;
      await expect(handle.tick()).resolves.toBeNull();

      mode.fail = true;
      await handle.tick();
      await handle.tick();
      expect(seen).toEqual([]);
    } finally {
      handle.stop();
      restore();
    }
  });

  test("успех после алерта снимает и окно: новая серия шумит сразу", async () => {
    const { seen, alert } = collector();
    const restore = muteErrors();
    const mode = { fail: true };
    const handle = startRoleRuntimeWorker({
      executors,
      database: toggleDb(mode),
      pollMs: 60_000,
      alert,
      now: () => 1_000,
    });
    try {
      await ticks(handle, WORKER_ALERT_AFTER_FAILURES - 1);
      expect(seen.length).toBe(1);

      mode.fail = false;
      await handle.tick();

      mode.fail = true;
      for (let i = 0; i < WORKER_ALERT_AFTER_FAILURES; i++) await handle.tick();
      // Часы не двигались: без сброса окна второй аварии пришлось бы ждать 15 минут.
      expect(seen.length).toBe(2);
    } finally {
      handle.stop();
      restore();
    }
  });

  test("падение самого приёмника алерта не ломает тик", async () => {
    const restore = muteErrors();
    const handle = startRoleRuntimeWorker({
      executors,
      database: toggleDb({ fail: true }),
      pollMs: 60_000,
      alert: (() => {
        // Приёмник по умолчанию пишет в ту же БД, которая тут и лежит.
        throw new Error("audit_logs unavailable");
      }) as any,
      now: () => 1_000,
    });
    try {
      await ticks(handle, WORKER_ALERT_AFTER_FAILURES - 1);
      await expect(handle.tick()).resolves.toBeNull();
    } finally {
      handle.stop();
      restore();
    }
  });
});
