/**
 * Аудит 2026-08-20: `tools/export-archive.ts` — разбор аргументов.
 *
 * Было ровно так:
 *
 *   const dry = process.argv.includes("--dry");
 *   const results = exportColdStorage({ prune: !dry });
 *
 * То есть prune — поведение по умолчанию, а единственный тормоз — точное
 * совпадение со строкой `--dry`. Всё остальное молча означает «удаляй»:
 *
 *   • `--dry-run` — общепринятое написание этого же флага — выгребает архив;
 *   • `--help` тоже. Человек, который спросил у деструктивной утилиты справку,
 *     получает не справку, а прогон. Соседний деструктивный инструмент,
 *     `tools/restore-from-backup.ts:264`, `--help`/`-h` обрабатывает — то есть
 *     конвенция в репо есть, её просто не было здесь;
 *   • любая опечатка (`--dryrun`, `--no-prune`, `--dr`) — тоже.
 *
 * Данные при этом сперва уезжают в gz-файл, и `cold-storage.ts` отменяет prune
 * при любой неудаче экспорта — так что это не потеря данных, а неожиданное
 * необратимое изменение БД от команды, которая его не просила.
 *
 * Ниже — юнит-тесты чистого разбора и прогоны настоящего скрипта в отдельном
 * процессе против временной БД: только они доказывают, что на путях help и
 * ошибки exportColdStorage вообще не зовётся.
 */
import { test, expect, describe, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs, runCli, USAGE } from "../tools/export-archive.ts";

const SCRIPT = join(import.meta.dir, "..", "tools", "export-archive.ts");
const ROW_ID = 990_777;

describe("parseArgs", () => {
  test("без аргументов — боевой прогон с prune", () => {
    const p = parseArgs([]);
    expect(p.ok).toBe(true);
    expect(p.ok && p.help).toBe(false);
    expect(p.ok && !p.help && p.dry).toBe(false);
  });

  test.each(["--dry", "--dry-run", "-n"])("%s — сухой прогон", (flag) => {
    const p = parseArgs([flag]);
    expect(p.ok).toBe(true);
    expect(p.ok && !p.help && p.dry).toBe(true);
  });

  test.each(["--help", "-h"])("%s — справка, а не прогон", (flag) => {
    const p = parseArgs([flag]);
    expect(p.ok).toBe(true);
    expect(p.ok && p.help).toBe(true);
  });

  test.each(["--dryrun", "--no-prune", "--dr", "-d", "dry", "--DRY"])(
    "%s — не «сухой прогон», а ошибка",
    (flag) => {
      const p = parseArgs([flag]);
      expect(p.ok).toBe(false);
      expect(!p.ok && p.unknown).toEqual([flag]);
    },
  );

  test("справка выигрывает у сухого прогона", () => {
    for (const argv of [["--dry", "--help"], ["--help", "--dry"]]) {
      const p = parseArgs(argv);
      expect(p.ok).toBe(true);
      expect(p.ok && p.help).toBe(true);
    }
  });

  test("непонятный аргумент рядом с понятным всё равно останавливает", () => {
    // Иначе `--dry --forse` (опечатка) прошло бы как обычный сухой прогон,
    // а `--forse` — как что угодно, что человек имел в виду.
    const p = parseArgs(["--dry", "--forse"]);
    expect(p.ok).toBe(false);
    expect(!p.ok && p.unknown).toEqual(["--forse"]);
  });

  test("перечисляет ВСЕ непонятные аргументы, а не первый", () => {
    const p = parseArgs(["--a", "--b"]);
    expect(!p.ok && p.unknown).toEqual(["--a", "--b"]);
  });
});

describe("runCli на неразрушающих путях", () => {
  test("справка печатается и возвращает 0", () => {
    const out: string[] = [];
    const code = runCli(["--help"], (s) => out.push(s), () => {});
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("--dry-run");
  });

  test("непонятный аргумент — код 2 и имя аргумента в stderr", () => {
    const err: string[] = [];
    const code = runCli(["--nope"], () => {}, (s) => err.push(s));
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("--nope");
  });

  test("USAGE описывает все распознаваемые флаги", () => {
    for (const flag of ["--dry", "--dry-run", "-n", "--help", "-h"]) {
      expect(USAGE).toContain(flag);
    }
  });
});

// ---- прогоны настоящего скрипта -----------------------------------------

const TMP = mkdtempSync(join(tmpdir(), "export-archive-argv-"));
const DB_PATH = join(TMP, "memory.db");
const BACKUP_ROOT = join(TMP, "backups");

afterAll(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
});

/**
 * У каждого прогона свой BACKUP_DIR. Иначе тест ловил бы не то, что проверяет:
 * `cold-storage.ts` открывает файл выгрузки с флагом `wx` и при EEXIST
 * отменяет prune — то есть боевой прогон после сухого в тот же день ничего бы
 * не удалил, и финальная проверка «харнесс вообще способен удалять» стала бы
 * ложно-красной (см. cold-storage-same-day-overwrite.test.ts).
 */
let runNo = 0;

function run(args: string[]) {
  const r = Bun.spawnSync(["bun", SCRIPT, ...args], {
    env: {
      ...(process.env as Record<string, string>),
      MEMORY_DB_PATH: DB_PATH,
      BACKUP_DIR: join(BACKUP_ROOT, String(++runNo)),
      COLD_STORAGE_DAYS: "0",
    },
  });
  return {
    code: r.exitCode,
    out: r.stdout.toString(),
    err: r.stderr.toString(),
  };
}

/** Кладём строку в архив уже существующей (мигрированной) временной БД. */
function seed(): void {
  const d = new Database(DB_PATH, { create: false, readwrite: true });
  try {
    d.prepare(
      `INSERT OR REPLACE INTO messages_archive
         (id, chat_id, agent_key, is_bot, from_user_id, from_name, text, ts, archived_at)
       VALUES (${ROW_ID}, '-777', NULL, 0, 'u1', 'tester', 'hi', 1, 1)`,
    ).run();
  } finally {
    d.close();
  }
}

function present(): boolean {
  const d = new Database(DB_PATH, { create: false, readwrite: true });
  try {
    return !!d.prepare(`SELECT 1 FROM messages_archive WHERE id=${ROW_ID}`).get();
  } finally {
    d.close();
  }
}

describe("настоящий скрипт против временной БД", () => {
  test(
    "help/dry-run/мусор не трогают архив, а боевой прогон — трогает",
    () => {
      // Первый прогон создаёт файл БД и прогоняет миграции: без него seed()
      // не найдёт messages_archive.
      const warm = run(["--dry"]);
      expect(warm.code).toBe(0);

      seed();
      expect(present()).toBe(true);

      const help = run(["--help"]);
      expect(help.code).toBe(0);
      expect(help.out).toContain("--dry-run");
      // На пути справки не должно быть ни одной строки отчёта экспорта.
      expect(help.out).not.toContain("messages_archive:");
      expect(help.out).not.toContain("Total:");
      expect(present()).toBe(true);

      // Ядро правки: раньше это был боевой прогон с prune.
      const dryRun = run(["--dry-run"]);
      expect(dryRun.code).toBe(0);
      expect(dryRun.out).toContain("(dry run)");
      expect(present()).toBe(true);

      const bogus = run(["--dryrun"]);
      expect(bogus.code).toBe(2);
      expect(bogus.err).toContain("--dryrun");
      expect(bogus.out).not.toContain("Total:");
      expect(present()).toBe(true);

      // Без этого три проверки выше были бы пустыми: надо показать, что
      // харнесс вообще способен удалить строку.
      const real = run([]);
      expect(real.code).toBe(0);
      expect(real.out).toContain("Total:");
      expect(present()).toBe(false);
    },
    60_000,
  );
});

describe("исходник tools/export-archive.ts", () => {
  const src = readFileSync(SCRIPT, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  test("комментарии сняты, но код на месте", () => {
    expect(src).toContain("exportColdStorage");
  });

  test("старая проверка argv.includes(\"--dry\") не вернулась", () => {
    expect(src).not.toContain('process.argv.includes("--dry")');
  });

  test("боевой прогон не запускается при импорте модуля", () => {
    // Без этого сторожа сам факт импорта в тесте выгребал бы архив.
    expect(src).toContain("import.meta.main");
  });
});
