/**
 * Аудит 2026-08-27: незаписываемый маркер выключал ВСЁ суточное обслуживание.
 *
 * `claimMaintMarker` возвращал `boolean`, и `runDaily` выходил первой строкой
 * на любом `false` — не различая «окно занято другим процессом» и «маркер не
 * удалось записать». На заполнившемся разделе (ENOSPC на WAL) это означало,
 * что ни архивация, ни gcMessages, ни выгрузка в холодное хранилище, ни VACUUM
 * не выполняются именно тогда, когда они и освобождают место; а тик каждые 5
 * минут дописывал алерт в `audit_logs`, чью уборку тот же отказ и отключил.
 */
import { test, expect, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import { claimMaintMarker, startMaintScheduler } from "../lib/db-maint.ts";

const KEY = "daily_ymd";
let handles: Array<{ stop(): void }> = [];

afterEach(() => {
  for (const h of handles) h.stop();
  handles = [];
  db.exec("PRAGMA query_only = OFF");
  db.prepare(`DELETE FROM maint_state WHERE key = ?`).run(KEY);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("claimMaintMarker различает «занято» и «не записалось»", () => {
  db.prepare(`DELETE FROM maint_state WHERE key = ?`).run(KEY);
  expect(claimMaintMarker(KEY, "2026-08-27")).toBe("claimed");
  expect(claimMaintMarker(KEY, "2026-08-27")).toBe("taken");
  try {
    // Единственный способ получить настоящий отказ записи, а не подделку.
    db.exec("PRAGMA query_only = ON");
    expect(claimMaintMarker(KEY, "2026-08-28")).toBe("error");
  } finally {
    db.exec("PRAGMA query_only = OFF");
  }
});

test("шаги обслуживания выполняются, даже когда маркер записать нельзя", async () => {
  db.prepare(`DELETE FROM maint_state WHERE key = ?`).run(KEY);
  let gcCalls = 0;
  let coldCalls = 0;
  try {
    db.exec("PRAGMA query_only = ON");
    const h = startMaintScheduler({
      gcIntervalMs: 3_600_000,
      dailyPollMs: 5,
      dailyHourUTC: 4,
      nowProvider: () => new Date("2026-08-27T05:00:00Z"),
      gcMessagesImpl: () => {
        gcCalls += 1;
        return null;
      },
      exportColdStorageImpl: () => {
        coldCalls += 1;
        return [];
      },
    });
    handles.push(h);
    await sleep(120);
    h.stop();
    // Главное: работа сделана, а не пропущена из-за незаписанного маркера.
    expect(gcCalls).toBeGreaterThan(0);
    expect(coldCalls).toBeGreaterThan(0);
    // И сделана ОДИН раз за сутки: без этого тик каждые 5 минут гонял бы VACUUM
    // до полуночи, потому что маркер так и не записался.
    expect(gcCalls).toBe(1);
  } finally {
    db.exec("PRAGMA query_only = OFF");
  }
});
