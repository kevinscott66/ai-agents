/**
 * Круг 32: ручной суточный прогон отменялся отказом записи маркера.
 *
 * Ветка `force` в `runDaily` начиналась с `if (!writeMaintMarker(...)) return
 * false;` — то есть при недоступной `maint_state` не запускалось НИЧЕГО:
 * ни архив, ни retention сообщений, ни холодное хранилище, ни VACUUM. Ровно
 * это поведение докстринг `claimMaintMarker` описывает как убранное («любой
 * отказ записи выключал весь суточный прогон целиком»), и соседняя ветка
 * `claim === "error"` делает обратное с записанным доводом: маркер — учёт, а
 * не условие работы.
 *
 * Второй половиной `_runDailyNow` ставил `lastDailyYmd = today` ДО прогона и
 * безусловно, хотя инвариант тика записан тридцатью строками выше: «Кэш
 * ставится по РЕЗУЛЬТАТУ». Отменённый прогон закрывал сутки в памяти процесса
 * до полуночи по UTC.
 *
 * Достижимого пути из продакшена сегодня нет: `_runDailyNow` зовут только
 * тесты (`services.ts` берёт у хендла лишь `stop`). Это тестовый шов, который
 * станет живым в тот день, когда его повесят на админ-команду, — и написан он
 * так, что отказ записи учёта отменяет саму работу.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import { startMaintScheduler } from "../lib/db-maint.ts";

const KEY = "daily_ymd";
const TRIGGER = "t_maint_state_block_daily";

/** Запись маркера `daily_ymd` начинает бросать — как при битой/занятой БД. */
function breakMarkerWrites(): void {
  db.exec(`
    CREATE TRIGGER ${TRIGGER} BEFORE INSERT ON maint_state
    WHEN NEW.key = '${KEY}'
    BEGIN SELECT RAISE(ABORT, 'maint_state недоступна'); END;
  `);
}

function restoreMarkerWrites(): void {
  db.exec(`DROP TRIGGER IF EXISTS ${TRIGGER}`);
}

afterEach(() => {
  restoreMarkerWrites();
  db.prepare(`DELETE FROM maint_state WHERE key = ?`).run(KEY);
  db.prepare(
    `DELETE FROM audit_logs WHERE agent_key='system' AND event_type LIKE 'alert.db_maint.%'`,
  ).run();
});

/** Шедулер, который сам ничего не запустит: окно и тики уведены далеко. */
function idleScheduler(steps: { gcMessagesImpl: () => unknown }) {
  return startMaintScheduler({
    gcIntervalMs: 24 * 3600 * 1000,
    dailyPollMs: 24 * 3600 * 1000,
    nowProvider: () => new Date("2026-09-11T15:00:00Z"),
    exportColdStorageImpl: () => [],
    ...steps,
  });
}

describe("форсированный суточный прогон не отменяется отказом учёта", () => {
  test("шаги идут, даже когда маркер записать некуда", () => {
    let ran = 0;
    const h = idleScheduler({ gcMessagesImpl: () => (ran += 1) });
    try {
      breakMarkerWrites();
      h._runDailyNow();
      expect(ran).toBe(1);
    } finally {
      h.stop();
    }
  });

  test("отказ записи маркера виден алертом, а не только в логе", () => {
    const h = idleScheduler({ gcMessagesImpl: () => undefined });
    try {
      breakMarkerWrites();
      h._runDailyNow();
      const n = db
        .prepare(
          `SELECT COUNT(*) AS n FROM audit_logs
           WHERE agent_key='system' AND event_type='alert.db_maint.marker_write_failed'`,
        )
        .get() as { n: number };
      expect(n.n).toBeGreaterThanOrEqual(1);
    } finally {
      h.stop();
    }
  });

  test("маркер по-прежнему стамповался бы, будь БД цела", () => {
    const h = idleScheduler({ gcMessagesImpl: () => undefined });
    try {
      h._runDailyNow();
      const row = db
        .prepare(`SELECT value FROM maint_state WHERE key = ?`)
        .get(KEY) as { value: string } | undefined;
      expect(row?.value).toBe("2026-09-11");
    } finally {
      h.stop();
    }
  });

  test("кэш суток ставится по результату прогона, а не до него", () => {
    // Структурно: присваивание не должно стоять перед вызовом. Проверить
    // поведением нечем — `lastDailyYmd` живёт в замыкании и наружу не выдан,
    // а тик, который его читает, в этом тесте намеренно не запускается.
    const src = require("node:fs").readFileSync(
      new URL("../lib/db-maint.ts", import.meta.url),
      "utf8",
    ) as string;
    const body = src.slice(src.indexOf("_runDailyNow() {"));
    const decl = body.slice(0, body.indexOf("\n    },"));
    expect(decl).toContain("if (runDaily(today, true)) lastDailyYmd = today;");
    expect(decl.indexOf("runDaily(")).toBeLessThan(decl.lastIndexOf("lastDailyYmd = today"));
  });
});
