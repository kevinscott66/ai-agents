/**
 * Аудит 2026-08-28: пустой `MEMORY_DIR` отменял ночной бэкап вики.
 *
 * 2026-08-27 в `lib/backup.ts` уже разобрали ровно эту ошибку — для
 * `MEMORY_DB_PATH` (строки 365-373, вынесено в `lib/db-path.ts`): `??` ловит
 * только ОТСУТСТВУЮЩУЮ переменную, а `agent/.env.example` ставит её пустой.
 * Правку применили к одной переменной из двух. Соседняя строка 56 того же
 * `.env.example` — `MEMORY_DIR=`, тем же стилем.
 *
 * Пустая строка ломала читателя и писателя по-разному и оба раза тихо:
 * `memory.ts` писал вики в cwd-относительные `./_team/`, а `backup.ts` на
 * `existsSync("")` пропускал архив КАЖДУЮ ночь, оставляя в логе одну строку с
 * пустым путём. `errors` при этом пуст — значит `backup_failed` не поднимался.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { runBackup } from "../lib/backup.ts";
import {
  DEFAULT_MEMORY_DIR,
  resolveMemoryDir,
} from "../lib/memory-dir.ts";

const SAVED_MEMORY_DIR = process.env.MEMORY_DIR;

afterEach(() => {
  if (SAVED_MEMORY_DIR === undefined) delete process.env.MEMORY_DIR;
  else process.env.MEMORY_DIR = SAVED_MEMORY_DIR;
});

describe("resolveMemoryDir", () => {
  test("незаданная переменная даёт умолчание", () => {
    expect(resolveMemoryDir(undefined)).toBe(DEFAULT_MEMORY_DIR);
  });

  test("пустая и пробельная строка считаются незаданными", () => {
    expect(resolveMemoryDir("")).toBe(DEFAULT_MEMORY_DIR);
    expect(resolveMemoryDir("   ")).toBe(DEFAULT_MEMORY_DIR);
    expect(resolveMemoryDir("\t\n")).toBe(DEFAULT_MEMORY_DIR);
  });

  test("заданное значение уважается и обрезается по краям", () => {
    expect(resolveMemoryDir("/srv/wiki")).toBe("/srv/wiki");
    expect(resolveMemoryDir("  /srv/wiki  ")).toBe("/srv/wiki");
  });

  test("свой fallback переданный вызывающим побеждает умолчание", () => {
    expect(resolveMemoryDir("", "/opt/fallback")).toBe("/opt/fallback");
  });
});

describe("бэкап вики при пустом MEMORY_DIR", () => {
  function sandbox() {
    const root = mkdtempSync(join(tmpdir(), "memdir-audit-"));
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });
    const backupDir = join(root, "backups");
    const db = new Database(join(dataDir, "memory.db"), { create: true });
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(x); INSERT INTO t VALUES (1);");
    db.close();
    return { dataDir, backupDir };
  }

  test("пустая строка больше не отменяет архив вики", async () => {
    // Гейт обязан запускаться из каталога `agent/` (CLAUDE.md §3.8.1), а там
    // умолчание `memory/` существует — иначе проверять фолбэк не на чем.
    expect(existsSync(DEFAULT_MEMORY_DIR)).toBe(true);

    const { dataDir, backupDir } = sandbox();
    process.env.MEMORY_DIR = "";
    const res = await runBackup(dataDir, backupDir, {
      now: new Date("2026-08-28T03:00:00Z"),
    });

    expect(res.wikiPath).not.toBeNull();
    expect(existsSync(res.wikiPath as string)).toBe(true);
    expect(res.errors).toEqual([]);
  });

  test("явно заданный каталог по-прежнему уважается", async () => {
    const { dataDir, backupDir } = sandbox();
    const wiki = mkdtempSync(join(tmpdir(), "memdir-wiki-"));
    process.env.MEMORY_DIR = wiki;
    const res = await runBackup(dataDir, backupDir, {
      now: new Date("2026-08-28T03:00:00Z"),
    });

    expect(res.wikiPath).not.toBeNull();
    expect(res.errors).toEqual([]);
  });
});

describe("разбор MEMORY_DIR не размножается", () => {
  test("ни один модуль не читает переменную через ??", () => {
    for (const f of ["../lib/memory.ts", "../lib/memory-async.ts", "../lib/backup.ts"]) {
      const src = readFileSync(new URL(f, import.meta.url), "utf8");
      expect(src).toContain("resolveMemoryDir(process.env.MEMORY_DIR)");
      // Тот самый разъезд, из-за которого правку 2026-08-27 применили только
      // к одной из двух переменных.
      expect(src.includes('process.env.MEMORY_DIR ??')).toBe(false);
    }
  });
});
