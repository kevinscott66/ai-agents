/**
 * Аудит 2026-08-28: учебный restore отвечал «успех» на бэкапе, которого нет.
 *
 * `tools/restore-from-backup.ts` — единственная автоматическая проверка того,
 * что копия вообще восстановима. Её вывод (`{"success":true}` и код выхода 0)
 * читает таймер, поэтому «зелёный» здесь равен «копия есть» для всех, кто
 * смотрит наружу. Три способа получить зелёный на пустом месте:
 *
 * 1. Снапшот без таблиц. Файл нулевой длины — валидная пустая база для
 *    sqlite: quick_check отвечает ok, таблиц ноль, счётчиков ноль, сентинел
 *    `-1` (аудит 2026-08-20) ни разу не срабатывает. Печаталось `Tables: 0`,
 *    `errors: []`, exit 0. При этом сам бэкап такой снапшот считает битым:
 *    `verifySnapshot` (lib/backup.ts:82) бросает «в снапшоте нет таблиц».
 *    Проверка копии была слабее проверки при её создании.
 *
 * 2. Половина бэкапа. Гварда была только на «нет обоих файлов», а success
 *    требовал `dbRestored || wikiRestored`. Каталог с одними `memory-*.tgz`
 *    (снапшот БД перестал делаться) проходил дрилл. Ровно этот случай сам
 *    бэкап помечает алертом `backup_partial` (lib/backup.ts:579).
 *
 * 3. `success` считался ДО блока очистки, а очистка умеет писать в `errors` —
 *    выходило `{"success":true,"errors":["Cleanup failed: ..."]}`.
 *
 * Плюс утечка: тестовый каталог создавался безусловно, а убирался только при
 * `!verifyOnly`. `--verify-only` в него ничего не пишет (так и сказано в
 * --help), но пустой `restore-test-*` оставлял каждый раз — на машине аудита
 * их накопилось 253.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { restoreFromBackup } from "../tools/restore-from-backup.ts";

let workDir: string;

/** Валидный wiki-архив `memory-*.tgz` в указанном каталоге. */
function seedWiki(dir: string): void {
  const src = join(workDir, "wiki-src");
  if (!fs.existsSync(src)) {
    fs.mkdirSync(join(src, "memory"), { recursive: true });
    fs.writeFileSync(join(src, "memory", "foo.md"), "# Foo\n");
  }
  const res = Bun.spawnSync([
    "tar", "-czf", join(dir, "memory-2026-08-28.tgz"), "-C", src, "memory",
  ]);
  if (res.exitCode !== 0) throw new Error("tar create failed");
}

/** Валидный снапшот `db-*.sqlite` с одной таблицей. */
function seedDb(dir: string): void {
  const db = new Database(join(dir, "db-2026-08-28.sqlite"));
  db.run(`CREATE TABLE tasks (id INTEGER PRIMARY KEY)`);
  db.run(`INSERT INTO tasks (id) VALUES (1)`);
  db.close();
}

function freshDir(name: string): string {
  const d = join(workDir, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

beforeAll(() => {
  workDir = fs.mkdtempSync(join(tmpdir(), "audit-restore-green-"));
});

afterAll(() => {
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

test("снапшот нулевой длины — это порча, а не пустая база", async () => {
  const dir = freshDir("zero-len");
  fs.writeFileSync(join(dir, "db-2026-08-28.sqlite"), "");
  seedWiki(dir);

  const result = await restoreFromBackup({ backupDir: dir, cleanup: true });

  expect(Object.keys(result.originalRowCounts)).toEqual([]);
  expect(result.success).toBe(false);
  expect(result.errors.some((e) => e.includes("has no tables"))).toBe(true);
});

test("снапшот без таблиц — тоже порча", async () => {
  const dir = freshDir("no-tables");
  new Database(join(dir, "db-2026-08-28.sqlite")).close();
  seedWiki(dir);

  const result = await restoreFromBackup({ backupDir: dir, cleanup: true });

  expect(result.success).toBe(false);
  expect(result.errors.some((e) => e.includes("has no tables"))).toBe(true);
});

test("каталог без снапшота БД не проходит дрилл", async () => {
  const dir = freshDir("wiki-only");
  seedWiki(dir);

  const result = await restoreFromBackup({ backupDir: dir, cleanup: true });

  // Архив вики читается, поэтому wikiRestored: true — и до правки этого
  // хватало для success.
  expect(result.wikiRestored).toBe(true);
  expect(result.success).toBe(false);
  expect(result.errors.some((e) => e.includes("db-*.sqlite"))).toBe(true);
});

test("каталог без архива вики не проходит дрилл", async () => {
  const dir = freshDir("db-only");
  seedDb(dir);

  const result = await restoreFromBackup({ backupDir: dir, cleanup: true });

  expect(result.dbRestored).toBe(true);
  expect(result.success).toBe(false);
  expect(result.errors.some((e) => e.includes("memory-*.tgz"))).toBe(true);
});

test("полный бэкап по-прежнему зелёный", async () => {
  const dir = freshDir("full");
  seedDb(dir);
  seedWiki(dir);

  const result = await restoreFromBackup({ backupDir: dir, cleanup: true });

  expect(result.errors).toEqual([]);
  expect(result.success).toBe(true);
  expect(result.originalRowCounts.tasks).toBe(1);
});

test("--verify-only не оставляет за собой пустой каталог", async () => {
  const dir = freshDir("verify-only");
  seedDb(dir);
  seedWiki(dir);

  const result = await restoreFromBackup({ backupDir: dir, verifyOnly: true });

  expect(result.success).toBe(true);
  // Очистка в verify-only не выполняется по условию — значит каталог и не
  // должен появляться.
  expect(fs.existsSync(result.testDir)).toBe(false);
});

test("провал очистки не оставляет success: true при непустом errors", async () => {
  const dir = freshDir("cleanup-fail");
  seedDb(dir);
  seedWiki(dir);

  const real = fs.rmSync;
  (fs as { rmSync: typeof fs.rmSync }).rmSync = (() => {
    throw new Error("EACCES: permission denied");
  }) as typeof fs.rmSync;
  let result;
  try {
    result = await restoreFromBackup({ backupDir: dir, cleanup: true });
  } finally {
    (fs as { rmSync: typeof fs.rmSync }).rmSync = real;
  }

  expect(result.errors.some((e) => e.startsWith("Cleanup failed"))).toBe(true);
  // Инвариант, на который опираются оба существующих теста дрилла.
  expect(result.success).toBe(false);
});
