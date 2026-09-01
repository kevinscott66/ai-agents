/**
 * Аудит 2026-08-20 — retention сообщений был единственным шагом суточного
 * прогона, отказ которого не поднимал алерт.
 *
 * В `runDaily` четыре шага, каждый в своём `try`. Три при исключении зовут
 * `emitAlert`: archive → `db_maint.archive_failed`, cold-storage →
 * `db_maint.cold_storage_failed`, compact → `db_maint.compact_failed`. А
 * `gcMessages` — только `log.warn("[db-maint] messages-gc error")`. Ни строки в
 * `audit_logs`, ни сигнала.
 *
 * Чем это плохо именно здесь: `gcMessages` — единственный шаг, отвечающий за
 * retention персональных данных. Тихо упавший перенос `messages` →
 * `messages_archive` означает, что `MESSAGES_RETENTION_DAYS` перестал
 * действовать и тексты сообщений пользователей копятся в живой БД
 * неограниченно долго. Уронить его есть чем: расхождение схемы с архивом
 * (ровно это чинила миграция 040), `SQLITE_BUSY` от второго соединения
 * (query-db-worker, tools/*, mac-bridge) в момент `.immediate()`, ENOSPC.
 * Заметить без алерта можно было только по строке `messages` на вкладке «БД»
 * или по размеру файла — то есть месяцы спустя.
 *
 * Почему не поймали: алертов `db_maint.*` в тестах два упоминания, оба —
 * `db_maint.archive_failed`. Инварианта «у каждого шага runDaily есть свой
 * алерт» не формулировал никто, а t318-messages-gc.test.ts целиком про happy
 * path; шва под подмену (как `gcStaleTasksImpl`/`exportColdStorageImpl`) у
 * этого шага не было вовсе, то есть уронить его в тесте было нечем.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { db } from "../lib/db.ts";
import { startMaintScheduler } from "../lib/db-maint.ts";

function countAlerts(code: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM audit_logs WHERE event_type=? AND agent_key='system'`,
    )
    .get(`alert.${code}`) as { n: number };
  return row.n;
}

function clearAlerts(): void {
  db.prepare(
    `DELETE FROM audit_logs WHERE agent_key='system' AND event_type LIKE 'alert.db_maint.%'`,
  ).run();
}

beforeEach(clearAlerts);
afterEach(clearAlerts);

/** Шедулер, который сам ничего не запустит: суточное окно и тики уведены далеко. */
function idleScheduler(gcMessagesImpl: () => unknown) {
  return startMaintScheduler({
    gcIntervalMs: 24 * 3600 * 1000,
    dailyPollMs: 24 * 3600 * 1000,
    nowProvider: () => new Date(2000, 0, 1),
    gcMessagesImpl,
    // Соседние шаги не должны шуметь своими алертами в этом тесте.
    exportColdStorageImpl: () => [],
  });
}

describe("отказ retention'а сообщений виден, а не растворяется в log.warn", () => {
  test("упавший gcMessages поднимает db_maint.messages_gc_failed", () => {
    const handle = idleScheduler(() => {
      throw new Error("no such column: kind");
    });
    try {
      handle._runDailyNow();
      expect(countAlerts("db_maint.messages_gc_failed")).toBeGreaterThanOrEqual(1);
    } finally {
      handle.stop();
    }
  });

  test("в алерт попадает причина, а не голый факт отказа", () => {
    const handle = idleScheduler(() => {
      throw new Error("database is locked");
    });
    try {
      handle._runDailyNow();
      const row = db
        .prepare(
          `SELECT payload FROM audit_logs
           WHERE agent_key='system' AND event_type='alert.db_maint.messages_gc_failed'
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get() as { payload: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.payload).toContain("database is locked");
    } finally {
      handle.stop();
    }
  });

  test("падение retention'а не отменяет остальные шаги прогона", () => {
    // Шаги стоят каждый в своём try — сигнал не должен стоить прогона.
    const handle = idleScheduler(() => {
      throw new Error("boom");
    });
    try {
      expect(() => handle._runDailyNow()).not.toThrow();
    } finally {
      handle.stop();
    }
  });

  test("успешный gcMessages алерт не поднимает", () => {
    let called = 0;
    const handle = idleScheduler(() => {
      called++;
      return { archived: 0, deleted: 0 };
    });
    try {
      handle._runDailyNow();
      expect(called).toBe(1);
      expect(countAlerts("db_maint.messages_gc_failed")).toBe(0);
    } finally {
      handle.stop();
    }
  });

  test("инвариант: у каждого шага runDaily свой алерт", () => {
    // Именно отсутствие такого утверждения дало шагу прожить без сигнала.
    const src = readFileSync(new URL("../lib/db-maint.ts", import.meta.url), "utf8");
    const i = src.indexOf("const runDaily = ");
    expect(i).toBeGreaterThan(0);
    // Якорь конца — объявление следующей функции, а не текст комментария над
    // ней. Аудит 2026-08-29 переписал тот комментарий, `indexOf` вернул -1,
    // `slice(i, -1)` захватил весь остаток файла — и тест упал на правке,
    // которой не касался. Объявление переживает редактуру комментариев.
    const j = src.indexOf("const _alertingHourlyTick", i);
    expect(j).toBeGreaterThan(i);
    const body = src.slice(i, j);
    const catches = body.split("} catch (e) {").length - 1;
    const alerts = body.split("emitAlert(").length - 1;
    expect(catches).toBeGreaterThanOrEqual(4);
    // Было `toBe(catches)`. Равенство держалось на том, что о неудаче каждый шаг
    // сообщал ИСКЛЮЧЕНИЕМ — а холодное хранилище с 2026-08-21 сообщает о ней
    // возвратом (`exportColdStorage` ловит отказ по таблице у себя и отдаёт
    // причину в результате), и его алерт живёт вне `catch`. Инвариант, ради
    // которого тест писался, — «шаг без алерта не проходит», то есть алертов не
    // меньше, чем мест отказа. Ужесточать обратно нельзя: это заставило бы
    // будущие result-based шаги бросать ради счётчика.
    expect(alerts).toBeGreaterThanOrEqual(catches);
  });
});
