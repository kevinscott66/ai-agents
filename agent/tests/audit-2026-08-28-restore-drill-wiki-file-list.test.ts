/**
 * Аудит 2026-08-28: учебный restore обещал сверку структуры файлов и не делал её.
 *
 * `RestoreResult.wikiFiles.original` (`tools/restore-from-backup.ts`)
 * объявлен в интерфейсе, инициализирован пустым массивом — и не записывается
 * НИКОГДА. Единственный список файлов брался уже ПОСЛЕ распаковки, то есть
 * отвечал на вопрос «что распаковалось», а не «всё ли из архива распаковалось».
 * Сверять `original` с `restored` было нечем, хотя ровно это `--help` тула
 * называет проверкой «file structure».
 *
 * Практический сценарий — архив, часть которого лежит мимо каталога, который
 * тул выбирает после распаковки. Выбор жёстко предпочитает `memory/`, поэтому
 * архив с двумя верхними каталогами распаковывается целиком, а в отчёт попадает
 * только половина. `tar` при этом выходит нулём, каталог найден, ошибок нет:
 * дрилл печатал `success: true` и exit 0 — то есть подтверждал восстановимость
 * копии по половине её содержимого.
 */
import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { restoreFromBackup } from "../tools/restore-from-backup.ts";

let workDir: string;

beforeAll(() => {
  workDir = fs.mkdtempSync(join(tmpdir(), "restore-wiki-list-"));
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

/** Снапшот `db-*.sqlite` с одной непустой таблицей. */
function seedDb(dir: string): void {
  const db = new Database(join(dir, "db-2026-08-28.sqlite"));
  db.run(`CREATE TABLE tasks (id INTEGER PRIMARY KEY)`);
  db.run(`INSERT INTO tasks (id) VALUES (1)`);
  db.close();
}

/**
 * Архив вики из перечисленных путей.
 *
 * `extraTop: true` кладёт второй верхний каталог рядом с `memory/` — то есть
 * ровно тот случай, когда выбранный после распаковки каталог покрывает архив
 * не полностью.
 */
function seedWiki(dir: string, extraTop: boolean): void {
  const src = fs.mkdtempSync(join(workDir, "wiki-src-"));
  fs.mkdirSync(join(src, "memory", "notes"), { recursive: true });
  fs.writeFileSync(join(src, "memory", "foo.md"), "# Foo\n");
  fs.writeFileSync(join(src, "memory", "notes", "bar.md"), "# Bar\n");
  const tops = ["memory"];
  if (extraTop) {
    fs.mkdirSync(join(src, "attachments"), { recursive: true });
    fs.writeFileSync(join(src, "attachments", "diagram.svg"), "<svg/>\n");
    tops.push("attachments");
  }
  const res = Bun.spawnSync([
    "tar", "-czf", join(dir, "memory-2026-08-28.tgz"), "-C", src, ...tops,
  ]);
  if (res.exitCode !== 0) throw new Error("tar create failed");
}

function freshBackupDir(name: string, extraTop = false): string {
  const d = join(workDir, name);
  fs.mkdirSync(d, { recursive: true });
  seedDb(d);
  seedWiki(d, extraTop);
  return d;
}

describe("wikiFiles.original — оглавление архива, а не пустой массив", () => {
  test("обычный прогон заполняет original путями из архива", async () => {
    const res = await restoreFromBackup({ backupDir: freshBackupDir("plain"), cleanup: true });

    expect(res.wikiFiles.original).toContain("memory/foo.md");
    expect(res.wikiFiles.original).toContain("memory/notes/bar.md");
    // Записи-каталоги в список файлов не попадают.
    expect(res.wikiFiles.original.some((f) => f.endsWith("/"))).toBe(false);
    // Распаковка полная — расхождений нет.
    expect(res.errors).toEqual([]);
    expect(res.success).toBe(true);
  });

  test("--verify-only тоже заполняет original (распаковки нет, оглавление есть)", async () => {
    const res = await restoreFromBackup({ backupDir: freshBackupDir("verify"), verifyOnly: true });

    expect(res.wikiFiles.original).toContain("memory/foo.md");
    // Сверять не с чем: отчёт показывает то же оглавление.
    expect(res.wikiFiles.restored).toEqual(res.wikiFiles.original);
    expect(res.errors).toEqual([]);
    expect(res.success).toBe(true);
  });
});

describe("расхождение архива и распакованного", () => {
  test("файл мимо выбранного каталога ломает дрилл, а не проходит молча", async () => {
    const res = await restoreFromBackup({
      backupDir: freshBackupDir("extra-top", true),
      cleanup: true,
    });

    // Выбор каталога жёстко предпочитает memory/, поэтому attachments/ в отчёт
    // о распакованном не попадает — до правки это и был «успех».
    expect(res.wikiFiles.original).toContain("attachments/diagram.svg");
    expect(res.wikiFiles.restored.some((f) => f.includes("diagram.svg"))).toBe(false);

    const mismatch = res.errors.filter((e) => e.includes("not found under memory/"));
    expect(mismatch.length).toBe(1);
    expect(mismatch[0]).toContain("attachments/diagram.svg");
    expect(res.success).toBe(false);
  });

  test("битый архив по-прежнему даёт ошибку, а не пустую сверку", async () => {
    const dir = join(workDir, "corrupt");
    fs.mkdirSync(dir, { recursive: true });
    seedDb(dir);
    fs.writeFileSync(join(dir, "memory-2026-08-28.tgz"), "not a tarball at all");

    const res = await restoreFromBackup({ backupDir: dir, cleanup: true });

    expect(res.errors.some((e) => e.includes("corrupted or unreadable"))).toBe(true);
    expect(res.wikiFiles.original).toEqual([]);
    expect(res.success).toBe(false);
  });
});

describe("исходник", () => {
  const SRC = fs.readFileSync(new URL("../tools/restore-from-backup.ts", import.meta.url), "utf8");

  test("original записывается, а не только объявляется", () => {
    expect(SRC).toContain("result.wikiFiles.original = listing.files;");
  });

  test("сверка стоит на пути распаковки", () => {
    expect(SRC).toContain("missingAfterExtract(");
    expect(SRC).toMatch(/not found under \$\{basename\(wikiRestoreDir\)\}\//);
  });
});
