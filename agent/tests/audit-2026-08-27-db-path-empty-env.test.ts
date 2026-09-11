/**
 * Аудит 2026-08-27 — `MEMORY_DB_PATH=` (пустая строка) обходил `resolveDbPath`.
 *
 * PR #... от 2026-08-20 научил `lib/db.ts` не верить `??` и падать на дефолт
 * при пустом значении, но три ДРУГИХ места читали переменную по-старому:
 *
 *   lib/backup.ts, источник снапшота БД   `?? join(dataDir, "memory.db")`
 *   lib/db-maint.ts, замер размера файла   `?? "data/memory.db"`
 *   orchestrator/services.ts, `dbPath`     `?? "data/memory.db"`
 *
 * `??` срабатывает только на ОТСУТСТВУЮЩУЮ переменную, а `agent/.env.example`
 * строка 55 — `MEMORY_DB_PATH=` без значения, и весь файл написан в этом стиле.
 * Копия примера в `/opt/agent-team/.env` (штатная установка) давала:
 *
 *   1. `fs.existsSync("")` === false → ночной снапшот БД пропускался КАЖДУЮ
 *      ночь. Единственный след — одна строка `[backup] db source not found: `
 *      в логах, в которой даже пути не видно. Прод при этом здоров, база
 *      настоящая (её открыл `db.ts` через `resolveDbPath`) — просто бэкапов
 *      нет. Это самый дорогой из трёх: расхождение между «бэкапы включены» и
 *      «бэкапов не существует» обнаруживается в момент, когда они нужны.
 *   2. `statSync("")` бросал → вкладка «БД» в Mini App показывала размер файла
 *      ровно 0 байт (`catch` в `db-maint.ts` кладёт `__db_file__ = 0`).
 *   3. `dirname("")` === "." → планировщик бэкапов получал `dataDir: "."`.
 *
 * Существующий `audit-2026-08-20-db-path.test.ts` эти места не покрывал, а
 * `tests/_db-path.ts` пинит `MEMORY_DB_PATH` на настоящий временный файл —
 * то есть пустое значение в наборе тестов не встречалось никогда.
 */
import { test, expect, describe, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_DB_PATH, resolveDbPath } from "../lib/db-path.ts";
import { runBackup } from "../lib/backup.ts";

const tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

const ENV_KEY = "MEMORY_DB_PATH";
let envSaved: string | undefined;
let envSavedFlag = false;

function setEnv(v: string | undefined): void {
  if (!envSavedFlag) {
    envSaved = process.env[ENV_KEY];
    envSavedFlag = true;
  }
  if (v === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = v;
}

afterEach(() => {
  if (envSavedFlag) {
    if (envSaved === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = envSaved;
    envSavedFlag = false;
  }
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Настоящая (маленькая) SQLite-база — VACUUM INTO работает только с такой. */
function makeDb(path: string): void {
  const d = new Database(path, { create: true });
  d.exec("CREATE TABLE t(x); INSERT INTO t VALUES (1);");
  d.close();
}

function quiet<T>(fn: () => T): T {
  const orig = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = orig;
  }
}

describe("resolveDbPath: собственный fallback", () => {
  test("переменной нет — возвращается переданный fallback, а не дефолт", () => {
    expect(resolveDbPath(undefined, "/srv/data/memory.db")).toBe(
      "/srv/data/memory.db",
    );
  });

  test("пустая строка — тоже fallback, с предупреждением про него", () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => warns.push(a.map(String).join(" "));
    try {
      expect(resolveDbPath("", "/srv/data/memory.db")).toBe(
        "/srv/data/memory.db",
      );
    } finally {
      console.warn = orig;
    }
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain("/srv/data/memory.db");
  });

  test("без второго аргумента поведение прежнее", () => {
    expect(quiet(() => resolveDbPath(""))).toBe(DEFAULT_DB_PATH);
  });
});

describe("runBackup при MEMORY_DB_PATH=", () => {
  test("снапшот БД создаётся, а не пропускается", async () => {
    const dataDir = tmp("bk-data-");
    const backupDir = tmp("bk-out-");
    makeDb(join(dataDir, "memory.db"));
    setEnv("");

    const r = await quiet(() => runBackup(dataDir, backupDir));

    // До правки здесь было `dbPath: null` и `[backup] db source not found: `.
    expect(r.dbPath).not.toBeNull();
    expect(existsSync(r.dbPath!)).toBe(true);
    expect(r.errors).toEqual([]);
    // Снапшот — настоящая база, а не обрезок.
    const snap = new Database(r.dbPath!, { readonly: true });
    try {
      expect(snap.query("SELECT x FROM t;").all()).toEqual([{ x: 1 }]);
    } finally {
      snap.close();
    }
  });

  test("путь из пробелов ведёт себя так же", async () => {
    const dataDir = tmp("bk-data-");
    const backupDir = tmp("bk-out-");
    makeDb(join(dataDir, "memory.db"));
    setEnv("   ");

    const r = await quiet(() => runBackup(dataDir, backupDir));
    expect(r.dbPath).not.toBeNull();
  });

  test("заданный путь по-прежнему сильнее dataDir", async () => {
    const dataDir = tmp("bk-data-");
    const elsewhere = tmp("bk-else-");
    const backupDir = tmp("bk-out-");
    // В dataDir базы НЕТ — если бы переменную проигнорировали, снапшот бы не
    // получился.
    const real = join(elsewhere, "custom.db");
    makeDb(real);
    setEnv(real);

    const r = await quiet(() => runBackup(dataDir, backupDir));
    expect(r.dbPath).not.toBeNull();
  });
});

describe("исходники: старого `??` не осталось", () => {
  const files = ["lib/backup.ts", "lib/db-maint.ts", "orchestrator/services.ts"];
  for (const f of files) {
    test(`${f} не читает MEMORY_DB_PATH через ??`, () => {
      const src = readFileSync(join(import.meta.dir, "..", f), "utf8");
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .map((l) => l.replace(/\/\/.*$/, ""))
        .join("\n");
      expect(code).not.toContain("process.env.MEMORY_DB_PATH ??");
      expect(code).not.toContain("process.env.MEMORY_DB_PATH ||");
    });
  }

  test("db-maint берёт размер файла у DB_PATH — того же, что открыт под db", () => {
    const src = readFileSync(
      join(import.meta.dir, "..", "lib", "db-maint.ts"),
      "utf8",
    );
    expect(src).toContain("statSync(DB_PATH)");
  });
});
