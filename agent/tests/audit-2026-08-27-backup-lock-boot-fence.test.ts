/**
 * Аудит 2026-08-27: замок бэкапа не должен становиться бессмертным.
 *
 * До фикса единственным критерием «замок протух» для замка с читаемым owner
 * было `processIsAlive(owner.pid)`. После перезагрузки VPS записанный PID
 * достаётся постороннему демону — замок жив вечно, бэкапы не делаются никогда,
 * самовосстановления нет. Плюс любая ошибка mkdirSync (EACCES/EROFS/ENOSPC)
 * сворачивалась в сообщение «another process owns the backup lock».
 *
 * Тесты работают в изолированных tmp-каталогах; прод-БД и wiki не трогаются.
 */
import { describe, test, expect, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  chmodSync,
  utimesSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir, uptime } from "node:os";
import { Database } from "bun:sqlite";
import {
  acquireBackupLock,
  backupLockPath,
  readBackupLockOwner,
  runBackup,
} from "../lib/backup.ts";

const SAVED_ENV = {
  MEMORY_DB_PATH: process.env.MEMORY_DB_PATH,
  MEMORY_DIR: process.env.MEMORY_DIR,
};

const NOW = new Date("2026-08-27T03:00:00Z");

function mkSandbox() {
  const root = mkdtempSync(join(tmpdir(), "bklock-"));
  const dataDir = join(root, "data");
  const wikiDir = join(root, "memory");
  const backupDir = join(root, "backups");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(wikiDir, { recursive: true });
  const dbPath = join(dataDir, "memory.db");
  const db = new Database(dbPath, { create: true });
  db.exec("CREATE TABLE t(x INTEGER); INSERT INTO t VALUES(1),(2),(3);");
  db.close();
  writeFileSync(join(wikiDir, "index.md"), "# hello\n");
  process.env.MEMORY_DB_PATH = dbPath;
  process.env.MEMORY_DIR = wikiDir;
  return { root, dataDir, wikiDir, backupDir, dbPath };
}

/** Метка загрузки, какой её пишет сам backup.ts. */
function currentBootStamp(): number {
  return Math.round(Date.now() / 1000 - uptime());
}

function seedLock(backupDir: string, owner: Record<string, unknown>): string {
  const lockPath = backupLockPath(backupDir);
  mkdirSync(lockPath, { recursive: true });
  writeFileSync(join(lockPath, "owner"), JSON.stringify(owner) + "\n");
  return lockPath;
}

afterEach(() => {
  if (SAVED_ENV.MEMORY_DB_PATH === undefined) delete process.env.MEMORY_DB_PATH;
  else process.env.MEMORY_DB_PATH = SAVED_ENV.MEMORY_DB_PATH;
  if (SAVED_ENV.MEMORY_DIR === undefined) delete process.env.MEMORY_DIR;
  else process.env.MEMORY_DIR = SAVED_ENV.MEMORY_DIR;
});

describe("backup lock: boot fence + absolute ceiling", () => {
  test("живой PID с чужой метки загрузки не держит замок вечно", async () => {
    const sb = mkSandbox();
    try {
      // PID заведомо живой (наш собственный), но метка загрузки — от прошлой
      // загрузки машины. Ровно ситуация «VPS перезагрузился, PID переиспользован».
      const lockPath = seedLock(sb.backupDir, {
        pid: process.pid,
        token: "stale-token",
        boot: currentBootStamp() - 7 * 24 * 3600,
      });

      const res = await runBackup(sb.dataDir, sb.backupDir, { now: NOW });
      expect(res.errors).toEqual([]);
      expect(res.dbPath).not.toBeNull();
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test("живой PID с текущей меткой загрузки по-прежнему держит замок", async () => {
    const sb = mkSandbox();
    try {
      const lockPath = seedLock(sb.backupDir, {
        pid: process.pid,
        token: "live-token",
        boot: currentBootStamp(),
      });

      const res = await runBackup(sb.dataDir, sb.backupDir, { now: NOW });
      expect(res.dbPath).toBeNull();
      expect(res.errors.join(" ")).toMatch(/another process owns the backup lock/);
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test("замок с живым PID старше абсолютного потолка переиспользуется", async () => {
    const sb = mkSandbox();
    try {
      const lockPath = seedLock(sb.backupDir, {
        pid: process.pid,
        token: "ancient-token",
        boot: currentBootStamp(),
      });
      // Прогон бэкапа идёт минуты; сутки — это заведомо брошенный замок.
      const old = new Date(Date.now() - 24 * 3600 * 1000);
      utimesSync(lockPath, old, old);

      const res = await runBackup(sb.dataDir, sb.backupDir, { now: NOW });
      expect(res.errors).toEqual([]);
      expect(res.dbPath).not.toBeNull();
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test("сбой mkdir не выдаётся за занятый замок", async () => {
    const sb = mkSandbox();
    mkdirSync(sb.backupDir, { recursive: true });
    chmodSync(sb.backupDir, 0o500);
    // Под root права игнорируются — тогда проверять нечего.
    let writable = false;
    try {
      mkdirSync(join(sb.backupDir, ".probe"));
      writable = true;
      rmSync(join(sb.backupDir, ".probe"), { recursive: true, force: true });
    } catch {
      /* ожидаемо: каталог только на чтение */
    }
    try {
      if (writable) return;
      const res = await runBackup(sb.dataDir, sb.backupDir, { now: NOW });
      expect(res.dbPath).toBeNull();
      const joined = res.errors.join(" ");
      expect(joined).toMatch(/cannot acquire the backup lock/);
      expect(joined).not.toMatch(/another process owns/);
    } finally {
      chmodSync(sb.backupDir, 0o700);
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test("новый замок пишет метку загрузки", () => {
    const sb = mkSandbox();
    try {
      mkdirSync(sb.backupDir, { recursive: true });
      const lock = acquireBackupLock(sb.backupDir);
      const owner = readBackupLockOwner(lock.path);
      expect(owner?.pid).toBe(process.pid);
      expect(owner?.token).toBe(lock.token);
      // Без этой записи fence из первого теста нечего было бы проверять.
      expect(typeof owner?.boot).toBe("number");
      expect(Math.abs((owner?.boot ?? 0) - currentBootStamp())).toBeLessThanOrEqual(60);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });
});
