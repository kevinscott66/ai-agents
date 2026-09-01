/**
 * Ротация бэкапов не съедает последнюю копию (аудит 2026-08-04).
 *
 * runBackup наружу не бросает: сбой снапшота уходит в result.errors и log.warn.
 * Ретеншн при этом шёл безусловно — то есть при сломанном бэкапе единственное,
 * что продолжало исправно работать, было удаление старых копий. Через retainDays
 * дней не оставалось ни одной, и узнать об этом можно было ровно в тот момент,
 * когда бэкап понадобился.
 *
 * Плюс два следствия того же места:
 *  - сегодняшний снапшот удалялся ПЕРЕД VACUUM INTO (тот отказывается
 *    перезаписывать), так что провал попытки оставлял и без старого, и без
 *    нового;
 *  - результат VACUUM INTO не проверялся вовсе — обрезанный файл лежал и
 *    выглядел валидным бэкапом.
 */
import { describe, test, expect, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readdirSync,
  utimesSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { runBackup } from "../lib/backup.ts";
import { DAY_MS } from "../lib/time-constants.ts";

const SAVED = {
  MEMORY_DB_PATH: process.env.MEMORY_DB_PATH,
  MEMORY_DIR: process.env.MEMORY_DIR,
};

const NOW = new Date("2026-05-20T03:00:00Z");

function mkSandbox(opts: { withDb?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "backup-ret-"));
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
  return { root, dataDir, wikiDir, backupDir, dbPath };
}

/** Положить старый файл-бэкап с mtime за пределами окна хранения. */
function seedOld(backupDir: string, name: string, daysAgo: number): string {
  const p = join(backupDir, name);
  writeFileSync(p, "старый бэкап");
  const t = (NOW.getTime() - daysAgo * DAY_MS) / 1000;
  utimesSync(p, t, t);
  return p;
}

afterEach(() => {
  for (const k of ["MEMORY_DB_PATH", "MEMORY_DIR"] as const) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

describe("ретеншн ждёт свежую замену", () => {
  test("снапшот не получился — старые копии остаются", async () => {
    // Источника БД нет: шаг 1 логирует warn и оставляет dbPath = null.
    const sb = mkSandbox({ withDb: false });
    process.env.MEMORY_DB_PATH = join(sb.dataDir, "нет-такого.db");
    process.env.MEMORY_DIR = sb.wikiDir;
    const old = seedOld(sb.backupDir, "db-2026-01-01.sqlite", 40);

    const res = await runBackup(sb.dataDir, sb.backupDir, {
      now: NOW,
      retainDays: 14,
    });

    expect(res.dbPath).toBeNull();
    expect(existsSync(old)).toBe(true); // раньше файл удалялся
    expect(res.keptUnverified).toBeGreaterThanOrEqual(1);
  });

  test("виды не путаются: удачный вики-бэкап не чистит db-копии", async () => {
    const sb = mkSandbox({ withDb: false });
    process.env.MEMORY_DB_PATH = join(sb.dataDir, "нет-такого.db");
    process.env.MEMORY_DIR = sb.wikiDir; // вики на месте — tar пройдёт
    const oldDb = seedOld(sb.backupDir, "db-2026-01-01.sqlite", 40);
    const oldWiki = seedOld(sb.backupDir, "memory-2026-01-01.tgz", 40);

    const res = await runBackup(sb.dataDir, sb.backupDir, {
      now: NOW,
      retainDays: 14,
    });

    expect(res.wikiPath).not.toBeNull();
    expect(existsSync(oldWiki)).toBe(false); // замена есть — можно чистить
    expect(existsSync(oldDb)).toBe(true); // замены нет — трогать нельзя
  });

  test("когда всё удалось, ротация работает как раньше", async () => {
    const sb = mkSandbox();
    process.env.MEMORY_DB_PATH = sb.dbPath;
    process.env.MEMORY_DIR = sb.wikiDir;
    seedOld(sb.backupDir, "db-2026-01-01.sqlite", 40);
    seedOld(sb.backupDir, "memory-2026-01-01.tgz", 40);

    const res = await runBackup(sb.dataDir, sb.backupDir, {
      now: NOW,
      retainDays: 14,
    });

    expect(res.errors).toEqual([]);
    expect(res.cleaned).toBe(2);
    expect(res.keptUnverified).toBe(0);
    const left = readdirSync(sb.backupDir).sort();
    expect(left).toEqual(["db-2026-05-20.sqlite", "memory-2026-05-20.tgz"]);
  });
});

describe("снапшот проверяется", () => {
  test("битый источник не оставляет файл-обманку и не считается успехом", async () => {
    const sb = mkSandbox({ withDb: false });
    // Файл на месте и непустой, но это не БД — VACUUM INTO упадёт.
    writeFileSync(sb.dbPath, "это не sqlite, а просто текст");
    process.env.MEMORY_DB_PATH = sb.dbPath;
    process.env.MEMORY_DIR = sb.wikiDir;

    const res = await runBackup(sb.dataDir, sb.backupDir, { now: NOW });

    expect(res.dbPath).toBeNull();
    expect(res.errors.join(" ")).toMatch(/db failed/);
    // Ни целевого имени, ни временного огрызка рядом с ним.
    const left = readdirSync(sb.backupDir).filter((n) => n.startsWith("db-"));
    expect(left).toEqual([]);
  });

  test("ошибка проверки пустого снапшота удаляет временный файл", async () => {
    const sb = mkSandbox({ withDb: false });
    const emptyDb = new Database(sb.dbPath, { create: true });
    emptyDb.close();
    process.env.MEMORY_DB_PATH = sb.dbPath;
    process.env.MEMORY_DIR = sb.wikiDir;

    const res = await runBackup(sb.dataDir, sb.backupDir, { now: NOW });

    expect(res.dbPath).toBeNull();
    expect(res.errors.join(" ")).toMatch(/db failed/);
    expect(readdirSync(sb.backupDir).filter((name) => name.startsWith("db-") && name.includes(".tmp-")).length).toBe(0);
  });

  test("вчерашний снапшот переживает провал сегодняшнего", async () => {
    const sb = mkSandbox({ withDb: false });
    writeFileSync(sb.dbPath, "это не sqlite");
    process.env.MEMORY_DB_PATH = sb.dbPath;
    process.env.MEMORY_DIR = sb.wikiDir;
    // Тот же день: именно этот файл старый код сносил ПЕРЕД попыткой.
    const sameDay = join(sb.backupDir, "db-2026-05-20.sqlite");
    writeFileSync(sameDay, "вчерашняя рабочая копия");

    await runBackup(sb.dataDir, sb.backupDir, { now: NOW });

    expect(existsSync(sameDay)).toBe(true);
    expect(statSync(sameDay).size).toBeGreaterThan(0);
  });

  test("успешный снапшот действительно открывается как БД", async () => {
    const sb = mkSandbox();
    process.env.MEMORY_DB_PATH = sb.dbPath;
    process.env.MEMORY_DIR = sb.wikiDir;

    const res = await runBackup(sb.dataDir, sb.backupDir, { now: NOW });
    expect(res.dbPath).not.toBeNull();

    const snap = new Database(res.dbPath!, { readonly: true });
    try {
      expect(snap.prepare("SELECT COUNT(*) AS n FROM t").get()).toEqual({ n: 3 });
    } finally {
      snap.close();
    }
  });
});
