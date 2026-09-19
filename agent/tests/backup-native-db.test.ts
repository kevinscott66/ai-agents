/**
 * AUD-003: ночной бэкап снимает и native.db (приложение на iPhone), а не
 * только memory.db и вики.
 */
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, utimesSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { runBackup } from "../lib/backup.ts";
import { nativeStatePath } from "../lib/native-db-path.ts";

const SAVED = { ...process.env };
afterEach(() => {
  for (const k of ["MEMORY_DB_PATH", "MEMORY_DIR", "NATIVE_STATE_PATH"]) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "backup-native-"));
  const dataDir = join(root, "data");
  const wikiDir = join(root, "memory");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(wikiDir, { recursive: true });
  writeFileSync(join(wikiDir, "index.md"), "# hi\n");
  const mem = new Database(join(dataDir, "memory.db"), { create: true });
  mem.exec("CREATE TABLE t(x); INSERT INTO t VALUES(1);");
  mem.close();
  process.env.MEMORY_DB_PATH = join(dataDir, "memory.db");
  process.env.MEMORY_DIR = wikiDir;
  delete process.env.NATIVE_STATE_PATH;
  return { root, dataDir, backupDir: join(root, "backups"), nativePath: join(dataDir, "native.db") };
}

function seedNative(path: string) {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE conversations(id TEXT); INSERT INTO conversations VALUES('dialog-1');");
  return db; // остаётся открытым: WAL не сброшен, как на живом сервисе
}

const now = new Date("2026-09-19T03:00:00Z");

test("native.db по умолчанию лежит рядом с memory.db, как у писателя", () => {
  const sb = sandbox();
  expect(nativeStatePath()).toBe(sb.nativePath);
  process.env.NATIVE_STATE_PATH = "/elsewhere/native.db";
  expect(nativeStatePath()).toBe("/elsewhere/native.db");
});

test("снапшот native.db снимается с живой БД и проверяется", async () => {
  const sb = sandbox();
  const live = seedNative(sb.nativePath);
  try {
    const res = await runBackup(sb.dataDir, sb.backupDir, { now });
    expect(res.errors).toEqual([]);
    expect(res.nativePath).toBe(join(sb.backupDir, "native-2026-09-19.sqlite"));
    const snap = new Database(res.nativePath!, { readonly: true });
    expect(snap.query("SELECT id FROM conversations").all()).toEqual([{ id: "dialog-1" }]);
    snap.close();
    expect(readdirSync(sb.backupDir).some((n) => n.includes(".tmp-"))).toBe(false);
  } finally {
    live.close();
  }
});

test("без native.db — не ошибка, остальное снимается", async () => {
  const sb = sandbox();
  const res = await runBackup(sb.dataDir, sb.backupDir, { now });
  expect(res.errors).toEqual([]);
  expect(res.nativePath).toBeNull();
  expect(res.dbPath).not.toBeNull();
  expect(res.wikiPath).not.toBeNull();
});

test("битый native.db — ошибка, старые native-копии ретеншн не трогает", async () => {
  const sb = sandbox();
  mkdirSync(sb.backupDir, { recursive: true });
  const old = join(sb.backupDir, "native-2026-08-01.sqlite");
  writeFileSync(old, "old");
  const t = (now.getTime() - 40 * 86_400_000) / 1000;
  utimesSync(old, t, t);
  writeFileSync(sb.nativePath, "не sqlite");
  const res = await runBackup(sb.dataDir, sb.backupDir, { now });
  expect(res.nativePath).toBeNull();
  expect(res.errors.some((e) => e.includes("native failed"))).toBe(true);
  expect(existsSync(old)).toBe(true);
  expect(res.keptUnverified).toBe(1);
});

test("свежий native-снапшот разрешает удалить старые native-копии", async () => {
  const sb = sandbox();
  mkdirSync(sb.backupDir, { recursive: true });
  const old = join(sb.backupDir, "native-2026-08-01.sqlite");
  writeFileSync(old, "old");
  const t = (now.getTime() - 40 * 86_400_000) / 1000;
  utimesSync(old, t, t);
  seedNative(sb.nativePath).close();
  const res = await runBackup(sb.dataDir, sb.backupDir, { now });
  expect(res.errors).toEqual([]);
  expect(existsSync(old)).toBe(false);
  expect(res.cleaned).toBe(1);
});
