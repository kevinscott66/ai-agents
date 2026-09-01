/**
 * Стартовый бэкап не повторяется на каждом рестарте (аудит 2026-08-04).
 *
 * Шедулер заводил полный прогон «через 60 секунд после старта процесса» —
 * ровно то, что делает деплой. Каждый рестарт с аптаймом больше минуты
 * запускал VACUUM INTO по всей БД плюс tar по вики заново: три деплоя подряд —
 * три полных бэкапа одного и того же состояния, а флап systemd превращал это
 * в цикл. Ретеншн не страдал (имя посуточное, старый файл удаляется перед
 * перезаписью) — страдал диск и тот же единственный поток, где живут 12 ботов.
 *
 * Пропуск завязан на свежесть сегодняшнего снапшота, а не на факт его
 * существования: сутки — не интервал, и вчерашний файл прогон не отменяет.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import { join } from "node:path";
import { startBackupScheduler } from "../lib/backup.ts";

let root = "";
let backups = "";
let handles: Array<{ stop(): void }> = [];

function ymdUTC(d: Date): string {
  return [
    d.getUTCFullYear(),
    String(d.getUTCMonth() + 1).padStart(2, "0"),
    String(d.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

beforeEach(() => {
  root = fs.mkdtempSync("/tmp/backup-storm-");
  backups = join(root, "backups");
  fs.mkdirSync(backups, { recursive: true });
  fs.mkdirSync(join(root, "data"), { recursive: true });
});

afterEach(() => {
  for (const h of handles) h.stop();
  handles = [];
  fs.rmSync(root, { recursive: true, force: true });
});

function scheduler(initialDelayMs: number, intervalMs = 3_600_000) {
  const h = startBackupScheduler({
    dataDir: join(root, "data"),
    backupDir: backups,
    intervalMs,
    initialDelayMs,
    retainDays: 14,
  });
  handles.push(h);
  return h;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Снапшот за сегодня с заданным возрастом. */
function placeSnapshot(ageMs: number): string {
  const p = join(backups, `db-${ymdUTC(new Date())}.sqlite`);
  fs.writeFileSync(p, "снапшот");
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(p, t, t);
  return p;
}

describe("стартовый прогон уважает уже сделанный бэкап", () => {
  test("свежий сегодняшний снапшот отменяет стартовый прогон", async () => {
    const p = placeSnapshot(60_000);
    const sizeBefore = fs.statSync(p).size;
    scheduler(5);
    await sleep(120);
    // Файл не тронут: прогон переписал бы его снапшотом настоящей БД.
    expect(fs.statSync(p).size).toBe(sizeBefore);
  });

  test("снапшот старше интервала прогон не отменяет", async () => {
    // Свежесть, а не наличие: интервал час — снапшоту два часа, пора обновлять.
    const p = placeSnapshot(2 * 3_600_000);
    const mtimeBefore = fs.statSync(p).mtimeMs;
    scheduler(5, 3_600_000);
    await sleep(200);
    expect(fs.statSync(p).mtimeMs).toBeGreaterThan(mtimeBefore);
  });

  test("без единого снапшота прогон происходит", async () => {
    // Контроль: без него «свежий снапшот отменяет прогон» прошло бы и при
    // стартовом прогоне, выключенном насовсем.
    expect(fs.readdirSync(backups)).toHaveLength(0);
    scheduler(5);
    await sleep(200);
    expect(fs.existsSync(join(backups, `db-${ymdUTC(new Date())}.sqlite`))).toBe(
      true,
    );
  });

  test("stop() до стартового таймера отменяет прогон", async () => {
    const h = scheduler(80);
    h.stop();
    await sleep(150);
    expect(fs.readdirSync(backups)).toHaveLength(0);
  });
});
