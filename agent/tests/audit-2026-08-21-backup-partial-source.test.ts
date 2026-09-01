/**
 * Аудит 2026-08-21: пропал ОДИН источник бэкапа — сигнала нет вообще.
 *
 * Оба шага `runBackup` при ненайденном источнике пишут только `log.warn` и
 * ничего не кладут в `result.errors` (backup.ts:137 и :185). Сторож
 * планировщика поднимает `backup_empty` только через конъюнкцию
 * `!res.dbPath && !res.wikiPath`, то есть когда не создалось НИ ОДНОГО файла.
 *
 * Промежуточный случай — снапшот БД удался, каталог вики уехал (MEMORY_DIR не
 * выставлен и сменился cwd; каталог перемещён) — не поднимает ни
 * `backup_failed` (errors пуст), ни `backup_empty` (dbPath не null). Ретеншн
 * тоже молчит: все `memory-*.tgz` ещё моложе retainDays (14), значит
 * `kept === 0` и `backup_retention_held` не срабатывает. Бэкап вики тихо
 * перестаёт делаться и остаётся незамеченным ровно до дня, когда последняя
 * валидная копия сама выпадет за окно ретеншна.
 *
 * Существующий tests/backup-failure-visibility.test.ts покрывает только
 * «оба источника отсутствуют».
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { runBackup, startBackupScheduler } from "../lib/backup.ts";
import { db } from "../lib/db.ts";

const SAVED = {
  MEMORY_DB_PATH: process.env.MEMORY_DB_PATH,
  MEMORY_DIR: process.env.MEMORY_DIR,
};

function mkSandbox() {
  const root = mkdtempSync(join(tmpdir(), "backup-partial-"));
  const dataDir = join(root, "data");
  const wikiDir = join(root, "memory");
  const backupDir = join(root, "backups");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(wikiDir, { recursive: true });
  mkdirSync(backupDir, { recursive: true });
  writeFileSync(join(wikiDir, "index.md"), "# hi\n");

  const dbPath = join(dataDir, "memory.db");
  const d = new Database(dbPath, { create: true });
  d.run("CREATE TABLE t(x INTEGER)");
  d.run("INSERT INTO t VALUES(1),(2),(3)");
  d.close();

  process.env.MEMORY_DB_PATH = dbPath;
  process.env.MEMORY_DIR = wikiDir;
  return { root, dataDir, wikiDir, backupDir, dbPath };
}

afterEach(() => {
  for (const k of ["MEMORY_DB_PATH", "MEMORY_DIR"] as const) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k]!;
  }
});

/** Сколько алертов бэкапа с данным кодом уже в audit_logs. */
function alertCount(code: string): number {
  return (
    db
      .prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE event_type = ?`)
      .get(`alert.${code}`) as { n: number }
  ).n;
}

async function tick(sb: { dataDir: string; backupDir: string }): Promise<void> {
  const handle = startBackupScheduler({
    dataDir: sb.dataDir,
    backupDir: sb.backupDir,
    initialDelayMs: 5,
    intervalMs: 60 * 60 * 1000,
  });
  await Bun.sleep(150);
  handle.stop();
}

describe("бэкап: пропажа одного источника видима", () => {
  test("вики уехала, БД на месте — планировщик поднимает алерт", async () => {
    // Сам прогон молчит: ошибок нет, потому что «источник не найден» — не
    // ошибка ни для одного из двух шагов.
    const probe = mkSandbox();
    process.env.MEMORY_DIR = join(probe.root, "нет-такого");
    const res = await runBackup(probe.dataDir, probe.backupDir, { now: new Date() });
    expect(res.dbPath).not.toBeNull();
    expect(res.wikiPath).toBeNull();
    expect(res.errors).toEqual([]);
    expect(res.keptUnverified).toBe(0);

    // Дальше — планировщик, и обязательно в ЧИСТОМ каталоге: сторож
    // рестарт-шторма пропускает прогон, если снапшот за сегодня уже лежит,
    // то есть после runBackup выше тик бы ничего не сделал.
    const sb = mkSandbox();
    process.env.MEMORY_DIR = join(sb.root, "нет-такого");

    const before = alertCount("backup_partial");
    const beforeEmpty = alertCount("backup_empty");
    const beforeFailed = alertCount("backup_failed");
    await tick(sb);

    // Утечка сигнала была именно здесь.
    expect(alertCount("backup_partial")).toBeGreaterThan(before);
    // И это именно «часть», а не «пусто»/«упало»: файл БД на диске есть.
    expect(alertCount("backup_empty")).toBe(beforeEmpty);
    expect(alertCount("backup_failed")).toBe(beforeFailed);
    expect(readdirSync(sb.backupDir).some((n) => n.startsWith("db-"))).toBe(true);
  });

  test("оба источника на месте — алерта нет", async () => {
    const sb = mkSandbox();
    const before = alertCount("backup_partial");
    await tick(sb);
    expect(alertCount("backup_partial")).toBe(before);
    const names = readdirSync(sb.backupDir);
    expect(names.some((n) => n.startsWith("db-"))).toBe(true);
    expect(names.some((n) => n.startsWith("memory-"))).toBe(true);
  });

  test("оба источника пропали — по-прежнему backup_empty, а не partial", async () => {
    const sb = mkSandbox();
    process.env.MEMORY_DIR = join(sb.root, "нет-такого");
    process.env.MEMORY_DB_PATH = join(sb.root, "нет-такой.db");

    const beforeEmpty = alertCount("backup_empty");
    const beforePartial = alertCount("backup_partial");
    await tick(sb);

    expect(alertCount("backup_empty")).toBeGreaterThan(beforeEmpty);
    expect(alertCount("backup_partial")).toBe(beforePartial);
    expect(readdirSync(sb.backupDir)).toEqual([]);
  });
});
