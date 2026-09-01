/**
 * Аудит 2026-08-08: три места, где провал бэкапа оставался невидимым.
 *
 * 1. Тарбол вики писался сразу в конечный путь (`tar -czf outPath`). Имя
 *    посуточное, поэтому второй за день прогон начинал с усечения уже готового
 *    архива: сбой на середине (кончился диск, процесс убит) оставлял на месте
 *    рабочего бэкапа обрезанный файл того же имени. Снапшот БД в том же файле
 *    давно делает tmp → проверка → rename; вики шла мимо.
 *
 * 2. Сторож рестарт-шторма (`freshSnapshotExists`) смотрел только на
 *    `db-<ymd>.sqlite`. А шаг БД не создаёт файла вовсе, если источник не
 *    найден, — и тогда сторож отключался ровно в том сценарии, где он нужен:
 *    каждый рестарт после первой минуты аптайма заново гонял tar по всей вики.
 *
 * 3. `kick()` выбрасывал результат `runBackup`. Наружу тот не бросает — сбои
 *    он складывает в `result.errors`, а единственный alert внутри привязан к
 *    `kept > 0`, то есть требует файлов старше retainDays. На свежей установке
 *    их нет, поэтому полностью провалившийся бэкап не давал сигнала вообще.
 */
import { describe, test, expect, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { runBackup, startBackupScheduler } from "../lib/backup.ts";

const SAVED = {
  MEMORY_DB_PATH: process.env.MEMORY_DB_PATH,
  MEMORY_DIR: process.env.MEMORY_DIR,
};

const NOW = new Date("2026-05-20T03:00:00Z");
const TAG = "2026-05-20";

function mkSandbox(opts: { withDb?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "backup-vis-"));
  const dataDir = join(root, "data");
  const wikiDir = join(root, "memory");
  const backupDir = join(root, "backups");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(wikiDir, { recursive: true });
  mkdirSync(backupDir, { recursive: true });
  writeFileSync(join(wikiDir, "index.md"), "# hi\n");

  const dbPath = join(dataDir, "memory.db");
  if (opts.withDb !== false) {
    const db = new Database(dbPath, { create: true });
    db.run("CREATE TABLE t(x INTEGER)");
    db.run("INSERT INTO t VALUES(1),(2),(3)");
    db.close();
  }
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

describe("бэкап: провал не должен оставаться невидимым", () => {
  test("провал tar не портит уже готовый архив за тот же день", async () => {
    const sb = mkSandbox();

    const first = await runBackup(sb.dataDir, sb.backupDir, { now: NOW });
    expect(first.wikiPath).toBe(join(sb.backupDir, `memory-${TAG}.tgz`));
    const good = readFileSync(first.wikiPath!);
    expect(good.length).toBeGreaterThan(0);

    // Ломаем источник так, что tar обязан упасть: каталога вики больше нет по
    // тому пути, который он получит на вход.
    process.env.MEMORY_DIR = join(sb.root, "memory", "nope");
    mkdirSync(process.env.MEMORY_DIR, { recursive: true });
    chmodSync(process.env.MEMORY_DIR, 0o000);

    const second = await runBackup(sb.dataDir, sb.backupDir, { now: NOW });
    chmodSync(process.env.MEMORY_DIR, 0o755);

    // Что бы ни случилось со вторым прогоном, вчерашняя работа не должна
    // превратиться в обрезок: либо архив ровно тот же, либо он валиден.
    const after = readFileSync(join(sb.backupDir, `memory-${TAG}.tgz`));
    expect(after.equals(good)).toBe(true);
    if (second.wikiPath === null) {
      // Провал должен быть виден как провал, а не как «файл на месте».
      expect(second.errors.join(" ")).toMatch(/wiki failed/);
    } else {
      // Обратная ветка: tar каталог всё-таки прочитал (так бывает под root,
      // где chmod 000 ничего не запрещает). Тогда провала не было — и жаловаться
      // не на что, а архив обязан быть настоящим. Раньше здесь не проверялось
      // ничего, и «провал выглядит как успех» прошло бы молча — ровно тот баг,
      // ради которого тест написан.
      expect(second.errors.join(" ")).not.toMatch(/wiki failed/);
      expect(readFileSync(second.wikiPath).length).toBeGreaterThan(0);
    }
    // И временный файл после себя не оставлен.
    expect(readdirSync(sb.backupDir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  test("сторож рестарт-шторма считает прогон, а не только снапшот БД", async () => {
    // Источник БД отсутствует: шаг БД пропускается и файла db-<ymd>.sqlite не
    // создаёт. До фикса сторож смотрел только на него и потому запускал полный
    // прогон при каждом рестарте.
    const sb = mkSandbox({ withDb: false });
    const done = await runBackup(sb.dataDir, sb.backupDir, { now: new Date() });
    expect(done.dbPath).toBeNull();
    expect(done.wikiPath).not.toBeNull();

    // Имя тарбола посуточное, поэтому повторный прогон не меняет число файлов —
    // видно его только по mtime.
    const mtimeBefore = statSync(done.wikiPath!).mtimeMs;
    await Bun.sleep(20);

    const handle = startBackupScheduler({
      dataDir: sb.dataDir,
      backupDir: sb.backupDir,
      initialDelayMs: 5,
      intervalMs: 60 * 60 * 1000,
    });
    await Bun.sleep(120);
    handle.stop();

    // Стартовый прогон должен быть пропущен: сегодняшний архив свежий.
    expect(statSync(done.wikiPath!).mtimeMs).toBe(mtimeBefore);
    expect(readdirSync(sb.backupDir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  test("прогон, не создавший ни одного файла, поднимает алерт", async () => {
    // Ни БД, ни каталога вики — оба шага тихо пропускаются, errors пуст,
    // ретеншну нечего держать (kept === 0), то есть до фикса не срабатывал ни
    // один сигнал.
    const sb = mkSandbox({ withDb: false });
    process.env.MEMORY_DIR = join(sb.root, "нет-такого");

    const res = await runBackup(sb.dataDir, sb.backupDir, { now: NOW });
    expect(res.dbPath).toBeNull();
    expect(res.wikiPath).toBeNull();
    expect(res.errors).toEqual([]);
    expect(res.keptUnverified).toBe(0);

    const alerts = seenAlerts(sb, async () => {
      const handle = startBackupScheduler({
        dataDir: sb.dataDir,
        backupDir: sb.backupDir,
        initialDelayMs: 5,
        intervalMs: 60 * 60 * 1000,
      });
      await Bun.sleep(120);
      handle.stop();
    });
    await alerts;
  });
});

/**
 * Планировщик обязан заметить пустой прогон. Проверяем по следу в audit_logs —
 * emitAlert пишет туда; если сигнала нет, счётчик не изменится.
 */
async function seenAlerts(
  sb: { backupDir: string },
  run: () => Promise<void>,
): Promise<void> {
  const { db } = await import("../lib/db.ts");
  const count = () =>
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM audit_logs
            WHERE event_type IN ('alert.backup_failed', 'alert.backup_empty')`,
        )
        .get() as { n: number }
    ).n;
  const before = count();
  await run();
  expect(count()).toBeGreaterThan(before);
  // Файлов бэкапа при этом действительно нет — алерт не «на всякий случай».
  expect(readdirSync(sb.backupDir)).toEqual([]);
}
