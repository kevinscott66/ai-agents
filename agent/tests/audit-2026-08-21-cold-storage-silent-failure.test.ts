/**
 * Аудит 2026-08-21: алерт о провале холодного хранилища не мог сработать.
 *
 * `runDaily` оборачивает месячный шаг в try/catch и в catch зовёт
 * `emitAlert("db_maint.cold_storage_failed")` — с комментарием «тихо упавшая
 * выгрузка означает БД, которая растёт без ограничения». Но
 * `exportColdStorage` обрабатывает отказ У СЕБЯ: пишет `log.error`, снимает
 * недописанный файл, кладёт в результат `{exported: 0, file: null, pruned: 0}`
 * и идёт к следующей таблице (cold-storage.ts:264-279). Наружу оно не бросает
 * НИЧЕГО, поэтому catch не срабатывал ни разу.
 *
 * Хуже того, отличить отказ от «нечего выгружать» вызывающий не мог даже при
 * желании: обе ситуации давали побайтово одинаковую строку результата.
 *
 * Замер до фикса (каталог холодного хранилища подменён обычным файлом, то есть
 * openSync даёт ENOTDIR):
 *
 *   ERROR [cold-storage] экспорт не удался — prune отменён … ENOTDIR …
 *   PROBE alerts: []
 *   PROBE marker: {"value":"2026-09"}
 *
 * То есть: выгрузка не состоялась, архив не почистился, в audit_logs пусто, а
 * следующая попытка — через месяц. Единственным следом оставалась строка лога,
 * которую никто не читает.
 *
 * Существующий тест на этот алерт есть (cold-storage-monthly-catchup.test.ts,
 * «упавшая выгрузка не роняет суточный прогон»), но он подменяет шаг impl'ом,
 * который БРОСАЕТ — то есть проверяет ветку, которой в проде не бывает, и
 * самого алерта не утверждает вовсе.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { db } from "../lib/db.ts";
import { startMaintScheduler } from "../lib/db-maint.ts";
import { exportColdStorage } from "../lib/cold-storage.ts";

const ALERT = "alert.db_maint.cold_storage_failed";

let envBackup: Record<string, string | undefined> = {};

function setEnv(vals: Record<string, string>): void {
  for (const [k, v] of Object.entries(vals)) {
    envBackup[k] = process.env[k];
    process.env[k] = v;
  }
}

beforeEach(() => {
  envBackup = {};
  db.prepare(
    "DELETE FROM maint_state WHERE key IN ('daily_ymd', 'cold_storage_ym')",
  ).run();
});

afterEach(() => {
  for (const [k, v] of Object.entries(envBackup)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  envBackup = {};
});

/** Строка в `messages_archive` старше любой отсечки — иначе выгружать нечего. */
function seedArchivedRow(): void {
  db.prepare(
    `INSERT INTO messages_archive(chat_id, is_bot, from_user_id, text, ts, archived_at)
     VALUES ('-100999', 0, '42', 'холодная строка', 0, 0)`,
  ).run();
}

/**
 * Каталог холодного хранилища, подменённый обычным файлом: `existsSync(dir)`
 * истинен, mkdir пропускается, а openSync внутри даёт ENOTDIR. Это ровно тот
 * класс отказа (раздел/права/путь), ради которого алерт и заводили.
 */
function poisonedBackupDir(): string {
  const base = mkdtempSync(join(tmpdir(), "cold-fail-"));
  writeFileSync(join(base, "cold-storage"), "это файл, а не каталог");
  return base;
}

function healthyBackupDir(): string {
  const base = mkdtempSync(join(tmpdir(), "cold-ok-"));
  mkdirSync(join(base, "cold-storage"), { recursive: true });
  return base;
}

function alertsSince(ts: number): Array<{ event_type: string; payload: string }> {
  return db
    .prepare(
      `SELECT event_type, payload FROM audit_logs
       WHERE created_at >= ? AND event_type = ?`,
    )
    .all(ts, ALERT) as Array<{ event_type: string; payload: string }>;
}

function runMonthlyStep(): number {
  const before = Date.now();
  let now = new Date("2026-09-01T05:00:00.000Z");
  const h = startMaintScheduler({
    nowProvider: () => now,
    dailyPollMs: 10_000_000,
    gcIntervalMs: 10_000_000,
  });
  try {
    h._runDailyNow();
  } finally {
    h.stop();
  }
  return before;
}

describe("провал холодного хранилища доезжает до алерта", () => {
  test("отказ ввода-вывода поднимает alert.db_maint.cold_storage_failed", () => {
    setEnv({ BACKUP_DIR: poisonedBackupDir(), COLD_STORAGE_DAYS: "1" });
    seedArchivedRow();

    const before = runMonthlyStep();

    const alerts = alertsSince(before);
    expect(alerts.length).toBe(1);
    // Причина названа, а не спрятана за «step failed».
    expect(alerts[0]!.payload).toContain("messages_archive");
    expect(alerts[0]!.payload).toContain("ENOTDIR");
  });

  test("удачный прогон алерта не поднимает", () => {
    setEnv({ BACKUP_DIR: healthyBackupDir(), COLD_STORAGE_DAYS: "1" });
    seedArchivedRow();

    const before = runMonthlyStep();

    expect(alertsSince(before)).toEqual([]);
  });

  test("«выгружать нечего» — не отказ", () => {
    // Ни одной строки старше отсечки: результат по форме тот же, что у отказа
    // (exported 0, file null), и раньше отличить их было нечем.
    setEnv({ BACKUP_DIR: healthyBackupDir(), COLD_STORAGE_DAYS: "36500" });

    const before = runMonthlyStep();

    expect(alertsSince(before)).toEqual([]);
  });

  test("результат несёт причину отказа, а не только нули", () => {
    const dir = poisonedBackupDir();
    seedArchivedRow();

    const res = exportColdStorage({ dir, coldDays: 1 });
    const failed = res.filter((r) => r.error !== null);

    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0]!.error).toContain("ENOTDIR");
    // Отказ не притворяется успехом: файла нет и строки на месте. Считаем
    // СВОЮ строку, а не итог `pruned`: холодное хранилище — общий уборщик по
    // всей таблице, и сравнение его счётчика с числом ломается от соседнего
    // файла, оставившего свою старую строку (T-751, второй класс).
    expect(failed[0]!.file).toBeNull();
    const left = db
      .prepare("SELECT COUNT(*) AS n FROM messages_archive WHERE chat_id = ?")
      .get("-100999") as { n: number };
    expect(left.n).toBeGreaterThan(0);
  });

  test("пустая таблица даёт error=null, а не пустую строку", () => {
    const res = exportColdStorage({
      dir: healthyBackupDir(),
      coldDays: 36500,
      prune: false,
    });

    expect(res.length).toBeGreaterThan(0);
    for (const r of res) expect(r.error).toBeNull();
  });
});
