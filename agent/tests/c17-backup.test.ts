/**
 * C17: nightly automatic backups.
 *
 * Tests run in isolated tmp dirs and override MEMORY_DB_PATH / MEMORY_DIR so
 * the real production DB and wiki are never touched.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, utimesSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { backupLockPath, runBackup, startBackupScheduler } from "../lib/backup.ts";

const SAVED_ENV = {
  MEMORY_DB_PATH: process.env.MEMORY_DB_PATH,
  MEMORY_DIR: process.env.MEMORY_DIR,
};

function mkSandbox() {
  const root = mkdtempSync(join(tmpdir(), "c17-"));
  const dataDir = join(root, "data");
  const wikiDir = join(root, "memory");
  const backupDir = join(root, "backups");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(wikiDir, { recursive: true });
  // Seed DB.
  const dbPath = join(dataDir, "memory.db");
  const db = new Database(dbPath, { create: true });
  db.exec("CREATE TABLE t(x INTEGER); INSERT INTO t VALUES(1),(2),(3);");
  db.close();
  // Seed wiki.
  writeFileSync(join(wikiDir, "index.md"), "# hello\n");
  mkdirSync(join(wikiDir, "_team"), { recursive: true });
  writeFileSync(join(wikiDir, "_team", "log.md"), "log\n");
  return { root, dataDir, wikiDir, backupDir, dbPath };
}

afterEach(() => {
  if (SAVED_ENV.MEMORY_DB_PATH === undefined) delete process.env.MEMORY_DB_PATH;
  else process.env.MEMORY_DB_PATH = SAVED_ENV.MEMORY_DB_PATH;
  if (SAVED_ENV.MEMORY_DIR === undefined) delete process.env.MEMORY_DIR;
  else process.env.MEMORY_DIR = SAVED_ENV.MEMORY_DIR;
});

describe("C17 backups", () => {
  test("runBackup creates db snapshot and wiki tarball with expected names", async () => {
    const sb = mkSandbox();
    process.env.MEMORY_DB_PATH = sb.dbPath;
    process.env.MEMORY_DIR = sb.wikiDir;

    const fixedNow = new Date("2026-05-20T03:00:00Z");
    const res = await runBackup(sb.dataDir, sb.backupDir, { now: fixedNow });

    expect(res.errors).toEqual([]);
    expect(res.dbPath).toBe(join(sb.backupDir, "db-2026-05-20.sqlite"));
    expect(res.wikiPath).toBe(join(sb.backupDir, "memory-2026-05-20.tgz"));
    expect(existsSync(res.dbPath!)).toBe(true);
    expect(existsSync(res.wikiPath!)).toBe(true);

    // Snapshot is a valid SQLite db containing seeded rows.
    const snap = new Database(res.dbPath!, { readonly: true });
    const row = snap.query("SELECT COUNT(*) AS n FROM t").get() as { n: number };
    snap.close();
    expect(row.n).toBe(3);

    rmSync(sb.root, { recursive: true, force: true });
  });

  test("old files (>14 days) are deleted, newer kept", async () => {
    const sb = mkSandbox();
    process.env.MEMORY_DB_PATH = sb.dbPath;
    process.env.MEMORY_DIR = sb.wikiDir;
    mkdirSync(sb.backupDir, { recursive: true });

    const now = new Date("2026-05-20T03:00:00Z");
    const dayMs = 24 * 60 * 60 * 1000;
    const oldPath = join(sb.backupDir, "db-2026-05-01.sqlite");
    const oldWiki = join(sb.backupDir, "memory-2026-05-01.tgz");
    const recentPath = join(sb.backupDir, "db-2026-05-15.sqlite");
    const unrelated = join(sb.backupDir, "README.txt");
    writeFileSync(oldPath, "x");
    writeFileSync(oldWiki, "x");
    writeFileSync(recentPath, "x");
    writeFileSync(unrelated, "x");
    const oldMtime = new Date(now.getTime() - 20 * dayMs);
    const recentMtime = new Date(now.getTime() - 5 * dayMs);
    utimesSync(oldPath, oldMtime, oldMtime);
    utimesSync(oldWiki, oldMtime, oldMtime);
    utimesSync(recentPath, recentMtime, recentMtime);
    utimesSync(unrelated, oldMtime, oldMtime);

    const res = await runBackup(sb.dataDir, sb.backupDir, { now, retainDays: 14 });

    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(oldWiki)).toBe(false);
    expect(existsSync(recentPath)).toBe(true);
    // Unrelated files not matching db-/memory- prefix are preserved.
    expect(existsSync(unrelated)).toBe(true);
    expect(res.cleaned).toBe(2);

    rmSync(sb.root, { recursive: true, force: true });
  });

  test("runBackup gracefully handles missing memory dir", async () => {
    const sb = mkSandbox();
    rmSync(sb.wikiDir, { recursive: true, force: true });
    process.env.MEMORY_DB_PATH = sb.dbPath;
    process.env.MEMORY_DIR = sb.wikiDir;

    const res = await runBackup(sb.dataDir, sb.backupDir, {
      now: new Date("2026-05-20T03:00:00Z"),
    });

    expect(res.dbPath).not.toBeNull();
    expect(res.wikiPath).toBeNull();
    expect(res.errors).toEqual([]);
    expect(existsSync(res.dbPath!)).toBe(true);

    rmSync(sb.root, { recursive: true, force: true });
  });

  test("reclaims a crashed-process lock but respects a live owner", async () => {
    const sb = mkSandbox();
    process.env.MEMORY_DB_PATH = sb.dbPath;
    process.env.MEMORY_DIR = sb.wikiDir;

    const crashed = Bun.spawn(["sh", "-c", "exit 0"]);
    await crashed.exited;
    mkdirSync(sb.backupDir, { recursive: true });
    const lockPath = backupLockPath(sb.backupDir);
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "owner"), `${crashed.pid}\n`);

    const recovered = await runBackup(sb.dataDir, sb.backupDir, {
      now: new Date("2026-05-20T03:00:00Z"),
    });
    expect(recovered.errors).toEqual([]);
    expect(recovered.dbPath).not.toBeNull();
    expect(existsSync(lockPath)).toBe(false);

    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "owner"), `${process.pid}\n`);
    const blocked = await runBackup(sb.dataDir, sb.backupDir, {
      now: new Date("2026-05-20T03:00:00Z"),
    });
    expect(blocked.dbPath).toBeNull();
    expect(blocked.errors.join(" ")).toMatch(/backup lock/);
    expect(existsSync(lockPath)).toBe(true);

    rmSync(sb.root, { recursive: true, force: true });
  });

  test("scheduler stops cleanly before first run", async () => {
    const sb = mkSandbox();
    process.env.MEMORY_DB_PATH = sb.dbPath;
    process.env.MEMORY_DIR = sb.wikiDir;

    const handle = startBackupScheduler({
      dataDir: sb.dataDir,
      backupDir: sb.backupDir,
      intervalMs: 60_000,
      initialDelayMs: 60_000,
    });
    handle.stop();
    // Idempotent.
    handle.stop();

    // Give event loop a moment; no backup files should appear.
    await new Promise((r) => setTimeout(r, 50));
    const entries = existsSync(sb.backupDir) ? readdirSync(sb.backupDir) : [];
    expect(entries.length).toBe(0);

    rmSync(sb.root, { recursive: true, force: true });
  });
});
