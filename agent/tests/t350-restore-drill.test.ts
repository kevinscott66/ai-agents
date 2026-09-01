/**
 * T-350 / T-525: Backup restore-drill regression test.
 *
 * Mirrors the manual smoke test of agent/tools/restore-from-backup.ts as an
 * automated check: build a dummy backup directory (a real sqlite snapshot
 * `db-*.sqlite` + a gzipped wiki tarball `memory-*.tgz`), run the actual
 * restore routine, and assert the drill reports success with the correct row
 * counts and wiki file list. This locks the tool against silent regressions
 * (e.g. backup-file naming, extraction path discovery, row-count comparison).
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  findLatestBackups,
  restoreFromBackup,
} from "../tools/restore-from-backup.ts";

let workDir: string;
let backupDir: string;
let wikiSrcDir: string;

beforeAll(() => {
  workDir = fs.mkdtempSync(join(tmpdir(), "t350-restore-"));
  backupDir = join(workDir, "backups");
  wikiSrcDir = join(workDir, "memory");
  fs.mkdirSync(backupDir, { recursive: true });
  fs.mkdirSync(wikiSrcDir, { recursive: true });

  // 1. Dummy DB snapshot: two tables with known row counts.
  const dbPath = join(backupDir, "db-2026-06-06.sqlite");
  const dbb = new Database(dbPath);
  dbb.run(`CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT)`);
  dbb.run(`INSERT INTO tasks (title) VALUES ('a'), ('b')`); // 2 rows
  dbb.run(`CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT)`);
  dbb.run(`INSERT INTO messages (body) VALUES ('hello')`); // 1 row
  dbb.close();

  // 2. Dummy wiki tarball: memory/foo.md inside memory-*.tgz.
  fs.writeFileSync(join(wikiSrcDir, "foo.md"), "# Foo\n");
  const tarRes = Bun.spawnSync(
    ["tar", "-czf", join(backupDir, "memory-2026-06-06.tgz"), "-C", workDir, "memory"],
  );
  if (tarRes.exitCode !== 0) {
    throw new Error(
      `tar create failed: ${new TextDecoder().decode(tarRes.stderr)}`,
    );
  }
});

afterAll(() => {
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

test("findLatestBackups picks the db + wiki backup files", () => {
  const found = findLatestBackups(backupDir);
  expect(found.dbBackup).toContain("db-2026-06-06.sqlite");
  expect(found.wikiBackup).toContain("memory-2026-06-06.tgz");
});

test("restoreFromBackup runs a full drill: db + wiki restored, row counts match", async () => {
  const result = await restoreFromBackup({
    backupDir,
    cleanup: true,
  });

  expect(result.success).toBe(true);
  expect(result.dbRestored).toBe(true);
  expect(result.wikiRestored).toBe(true);
  expect(result.errors).toEqual([]);
  expect(result.missingTables).toEqual([]);

  // Row counts verified from the live backup file.
  expect(result.originalRowCounts.tasks).toBe(2);
  expect(result.originalRowCounts.messages).toBe(1);
  // Restored counts must equal the originals (no data loss in the copy).
  expect(result.restoredRowCounts.tasks).toBe(2);
  expect(result.restoredRowCounts.messages).toBe(1);

  // Wiki file list contains the seeded note.
  expect(result.wikiFiles.restored.some((f) => f.endsWith("foo.md"))).toBe(true);

  // cleanup:true removed the temp test dir.
  expect(fs.existsSync(result.testDir)).toBe(false);
});

test("verifyOnly mode validates files without extracting", async () => {
  const result = await restoreFromBackup({
    backupDir,
    verifyOnly: true,
  });

  expect(result.success).toBe(true);
  expect(result.dbRestored).toBe(true);
  expect(result.wikiRestored).toBe(true);
  expect(result.originalRowCounts.tasks).toBe(2);
  // In verify-only mode restored counts mirror originals (no copy made).
  expect(result.restoredRowCounts.tasks).toBe(2);
});

test("findLatestBackups throws on a missing backup directory", () => {
  expect(() => findLatestBackups(join(workDir, "does-not-exist"))).toThrow();
});
