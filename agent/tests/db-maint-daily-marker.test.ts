/**
 * Суточное обслуживание не повторяется после рестарта (аудит 2026-08-04).
 *
 * «Уже сделано сегодня» жило в замыкании startMaintScheduler, то есть умирало
 * вместе с процессом. Окно тика — не момент, а «UTC-час ≥ dailyHourUTC», то
 * есть весь остаток суток. Значит любой старт процесса после 04:00 UTC в
 * ближайшие 5 минут запускал archive + gcMessages + VACUUM заново. Деплой —
 * это рестарт: три деплоя за вечер = три полных VACUUM'а, каждый синхронный на
 * единственном потоке, который держит и 12 ботов, и HTTP Mini App.
 *
 * Маркер лежит в `maint_state` (миграция 039). digest решает ту же задачу
 * файлом `.digest-last`, но тот привязан к cwd, а обслуживанию БД доступна по
 * определению.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import { claimMaintMarker, startMaintScheduler } from "../lib/db-maint.ts";

const KEY = "daily_ymd";

function marker(): string | null {
  const row = db
    .prepare(`SELECT value FROM maint_state WHERE key = ?`)
    .get(KEY) as { value: string } | undefined;
  return row?.value ?? null;
}

let handles: Array<{ stop(): void }> = [];

beforeEach(() => {
  db.prepare(`DELETE FROM maint_state WHERE key = ?`).run(KEY);
});

afterEach(() => {
  for (const h of handles) h.stop();
  handles = [];
  db.prepare(`DELETE FROM maint_state WHERE key = ?`).run(KEY);
});

/** Шедулер с быстрым тиком и подставным «сейчас». */
function scheduler(now: Date, pollMs = 5) {
  const h = startMaintScheduler({
    gcIntervalMs: 3_600_000,
    dailyPollMs: pollMs,
    dailyHourUTC: 4,
    nowProvider: () => now,
  });
  handles.push(h);
  return h;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("маркер суточного прогона переживает рестарт", () => {
  test("один и тот же maintenance window claim-ится только одним процессом", () => {
    expect(claimMaintMarker(KEY, "2026-08-04")).toBe("claimed");
    expect(claimMaintMarker(KEY, "2026-08-04")).toBe("taken");
    expect(marker()).toBe("2026-08-04");
  });

  test("первый запуск в окне делает прогон и ставит маркер", async () => {
    scheduler(new Date("2026-08-04T15:00:00Z"));
    await sleep(60);
    expect(marker()).toBe("2026-08-04");
  });

  test("второй процесс в те же сутки прогон НЕ повторяет", async () => {
    const first = scheduler(new Date("2026-08-04T15:00:00Z"));
    await sleep(60);
    expect(marker()).toBe("2026-08-04");
    first.stop();

    // Новый шедулер = новый процесс: замыкание пустое, память ничего не знает.
    // Единственное, что отличает его от «настоящего первого запуска», — строка
    // в БД.
    db.prepare(`UPDATE maint_state SET updated_at = 0 WHERE key = ?`).run(KEY);
    scheduler(new Date("2026-08-04T18:00:00Z"));
    await sleep(60);
    const row = db
      .prepare(`SELECT updated_at FROM maint_state WHERE key = ?`)
      .get(KEY) as { updated_at: number };
    // Маркер не переписан → runDaily не вызывался: он ставит маркер первым
    // делом, до archive/VACUUM.
    expect(row.updated_at).toBe(0);
  });

  test("следующие сутки прогон возобновляют", async () => {
    scheduler(new Date("2026-08-04T15:00:00Z"));
    await sleep(60);
    expect(marker()).toBe("2026-08-04");

    scheduler(new Date("2026-08-05T05:00:00Z"));
    await sleep(60);
    expect(marker()).toBe("2026-08-05");
  });

  test("до dailyHourUTC не запускается вовсе", async () => {
    scheduler(new Date("2026-08-04T03:59:00Z"));
    await sleep(60);
    expect(marker()).toBeNull();
  });

  test("_runDailyNow форсирует прогон и стамповает маркер", () => {
    // Форс нужен как ручной/тестовый рычаг, поэтому маркер на чтении он
    // игнорирует. Но проставить его обязан: работа сделана, и очередной тик не
    // должен повторять VACUUM.
    const h = scheduler(new Date("2026-08-04T15:00:00Z"), 3_600_000);
    expect(marker()).toBeNull();
    h._runDailyNow();
    expect(marker()).toBe("2026-08-04");
  });

  test("маркер ставится ДО тяжёлых шагов", () => {
    // Иначе упавший archive (или VACUUM на полном диске) возвращал бы нас в
    // исходную точку каждые 5 минут — retry-шторм из VACUUM'ов. Проверяем по
    // порядку: маркер уже на месте, когда работа только начата.
    const src = require("node:fs").readFileSync(
      new URL("../lib/db-maint.ts", import.meta.url),
      "utf8",
    ) as string;
    const body = src.slice(src.indexOf("const runDaily = ("));
    const markerAt = body.indexOf("claimMaintMarker");
    const archiveAt = body.indexOf("archiveOldRows(");
    expect(markerAt).toBeGreaterThan(-1);
    expect(archiveAt).toBeGreaterThan(markerAt);
  });
});
