/**
 * Аудит 2026-08-28: две вещи в ночном бэкапе.
 *
 * 1. fsync каталога делала ТОЛЬКО ветка вики. Снапшот БД публикуется тем же
 *    `renameSync`, но ссылку на него не синхронизировал никто — а в дни, когда
 *    каталог вики не найден (MEMORY_DIR не выставлен, cwd уехал) или tar упал,
 *    fsync каталога не случался вообще. VACUUM INTO делает durable
 *    СОДЕРЖИМОЕ снапшота, но не запись о нём в каталоге: питание, пропавшее
 *    после rename, оставляет файл под временным именем — снапшота за день нет,
 *    а `.tmp-*` уже не подберёт никто (`removeTempFile` в finally не выполнится).
 *
 * 2. Пропуск по занятому замку — обычная конкуренция (перезапуск под деплоем:
 *    старый процесс дописывает бэкап, новый через 60 с делает свой стартовый
 *    прогон) — сворачивался в `errors`, а планировщик поднимает `backup_failed`
 *    на любом непустом `errors`. Здоровый день выглядел провалом. Реальный
 *    прогон в этот момент идёт в соседнем процессе и о своих бедах отчитается
 *    сам.
 *
 * Тесты работают в изолированных tmp-каталогах; прод-БД и wiki не трогаются.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, uptime } from "node:os";
import { Database } from "bun:sqlite";
import { backupLockPath, runBackup } from "../lib/backup.ts";

const SAVED_ENV = {
  MEMORY_DB_PATH: process.env.MEMORY_DB_PATH,
  MEMORY_DIR: process.env.MEMORY_DIR,
};

const NOW = new Date("2026-08-28T03:00:00Z");
const SRC = readFileSync(new URL("../lib/backup.ts", import.meta.url), "utf-8");

/** Песочница с БД; вики — по флагу, иначе ветка вики пропускается. */
function mkSandbox(withWiki: boolean) {
  const root = mkdtempSync(join(tmpdir(), "bkfsync-"));
  const dataDir = join(root, "data");
  const backupDir = join(root, "backups");
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, "memory.db");
  const db = new Database(dbPath, { create: true });
  db.exec("CREATE TABLE t(x INTEGER); INSERT INTO t VALUES(1),(2),(3);");
  db.close();
  const wikiDir = join(root, "memory");
  if (withWiki) {
    mkdirSync(wikiDir, { recursive: true });
    writeFileSync(join(wikiDir, "index.md"), "# hello\n");
  }
  process.env.MEMORY_DB_PATH = dbPath;
  process.env.MEMORY_DIR = wikiDir;
  return { root, dataDir, backupDir, dbPath, wikiDir };
}

/** Метка загрузки, какой её пишет сам backup.ts. */
function currentBootStamp(): number {
  return Math.round(Date.now() / 1000 - uptime());
}

/** Замок с живым владельцем: mkdir даст EEXIST и протухшим он не считается. */
function seedLiveLock(backupDir: string): string {
  const lockPath = backupLockPath(backupDir);
  mkdirSync(lockPath, { recursive: true });
  writeFileSync(
    join(lockPath, "owner"),
    JSON.stringify({ pid: process.pid, token: "live", boot: currentBootStamp() }) + "\n",
  );
  return lockPath;
}

afterEach(() => {
  if (SAVED_ENV.MEMORY_DB_PATH === undefined) delete process.env.MEMORY_DB_PATH;
  else process.env.MEMORY_DB_PATH = SAVED_ENV.MEMORY_DB_PATH;
  if (SAVED_ENV.MEMORY_DIR === undefined) delete process.env.MEMORY_DIR;
  else process.env.MEMORY_DIR = SAVED_ENV.MEMORY_DIR;
});

describe("fsync каталога после публикации снапшота БД", () => {
  // Сам вызов fsync из теста не наблюдаем: `node:fs` — namespace-объект ESM,
  // его биндинги не подменяются (проверено: и присваивание, и
  // Object.defineProperty бросают). Поэтому наличие вызова держим стражем
  // исходника, а работоспособность ветки — прогоном.

  test("бэкап без вики доходит до публикации снапшота", async () => {
    const sb = mkSandbox(false);
    try {
      const res = await runBackup(sb.dataDir, sb.backupDir, { now: NOW });
      expect(res.dbPath).not.toBeNull();
      // Ветки вики нет вовсе — то есть и её fsync каталога тоже нет.
      expect(res.wikiPath).toBeNull();
      expect(res.errors).toEqual([]);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test("полный прогон по-прежнему публикует оба файла (контроль)", async () => {
    const sb = mkSandbox(true);
    try {
      const res = await runBackup(sb.dataDir, sb.backupDir, { now: NOW });
      expect(res.dbPath).not.toBeNull();
      expect(res.wikiPath).not.toBeNull();
      expect(res.errors).toEqual([]);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test("fsync каталога стоит в обеих ветках публикации", () => {
    const hits = SRC.split('fsyncPath(dirname(outPath), "backup dir");').length - 1;
    expect(hits).toBe(2);
  });

  test("в ветке БД fsync стоит между rename и записью пути в результат", () => {
    // Порядок важен: до rename синхронизировать нечего, после записи
    // result.dbPath ветка уже считается опубликованной.
    const branch = SRC.indexOf("const outPath = join(backupDir, `db-${tag}.sqlite`);");
    expect(branch).toBeGreaterThan(0);
    // Конец региона проверяем отдельно. `indexOf` на пропавшем якоре отдаёт
    // -1, `slice(branch, -1)` — весь остаток файла, и сторож молча начинает
    // сторожить не ту ветку: перенос fsync в соседнюю секцию такой тест
    // пропустит. Проверено переименованием якоря — тест оставался зелёным.
    const end = SRC.indexOf("// 2) Wiki tarball.");
    expect(end).toBeGreaterThan(branch);
    const head = SRC.slice(branch, end);
    const rename = head.indexOf("fs.renameSync(tmpPath, outPath);");
    const fsync = head.indexOf('fsyncPath(dirname(outPath), "backup dir");');
    const assign = head.indexOf("result.dbPath = outPath;");
    expect(rename).toBeGreaterThan(-1);
    expect(fsync).toBeGreaterThan(rename);
    expect(assign).toBeGreaterThan(fsync);
  });
});

describe("занятый замок — пропуск, а не провал", () => {
  test("конкуренция помечается skipped и сохраняет сообщение в errors", async () => {
    const sb = mkSandbox(true);
    try {
      seedLiveLock(sb.backupDir);
      const res = await runBackup(sb.dataDir, sb.backupDir, { now: NOW });
      expect(res.skipped).toBe(true);
      expect(res.errors.join(" ")).toMatch(/another process owns the backup lock/);
      expect(res.dbPath).toBeNull();
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test("успешный прогон не помечается skipped", async () => {
    const sb = mkSandbox(true);
    try {
      const res = await runBackup(sb.dataDir, sb.backupDir, { now: NOW });
      expect(res.skipped).toBeFalsy();
      expect(res.errors).toEqual([]);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test("сломанный каталог (EACCES) — не skipped, это настоящий провал", async () => {
    const sb = mkSandbox(true);
    mkdirSync(sb.backupDir, { recursive: true });
    chmodSync(sb.backupDir, 0o500);
    try {
      const res = await runBackup(sb.dataDir, sb.backupDir, { now: NOW });
      expect(res.skipped).toBeFalsy();
      expect(res.errors.length).toBeGreaterThan(0);
      expect(res.errors.join(" ")).not.toMatch(/another process owns/);
    } finally {
      chmodSync(sb.backupDir, 0o700);
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test("планировщик читает skipped раньше errors", () => {
    // Страж: алерт backup_failed висит на непустом errors, а сообщение о
    // конкуренции лежит именно там — порядок веток и есть вся правка.
    const at = SRC.indexOf("if (res.skipped) {");
    const alert = SRC.indexOf('emitAlert("warn", "backup_failed"');
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(alert);
  });
});
