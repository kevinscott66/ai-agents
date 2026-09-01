#!/usr/bin/env bun
/**
 * T-113 CLI: выгрузка (и очистка) архивных таблиц холодного хранения.
 *
 * Аудит 2026-08-20. Разбор аргументов был такой:
 *
 *   const dry = process.argv.includes("--dry");
 *
 * prune — поведение по умолчанию, и единственное, что его отменяло, — точное
 * совпадение со строкой `--dry`. Всё остальное молча означало «удаляй»:
 * `--dry-run` (общепринятое написание того же флага), любая опечатка и —
 * что хуже всего — `--help`. То есть человек, спросивший у деструктивной
 * утилиты справку, получал вместо справки прогон с очисткой архива.
 * Соседний инструмент `tools/restore-from-backup.ts` (не деструктивный:
 * он читает копии и раскладывает их во временный каталог) `--help`/`-h`
 * обрабатывает первой же строкой `main()`, так что конвенция в репо была —
 * её не было здесь.
 *
 * Данные при этом не теряются: `cold-storage.ts` сперва пишет и fsync-ает
 * gz-файл и отменяет prune при любой неудаче экспорта. Но необратимое
 * изменение БД от команды, которая его не просила, остаётся необратимым.
 *
 * Поэтому: непонятный аргумент — это отказ (код 2), а не «наверное, боевой
 * прогон». Из двух прочтений опечатки выбираем то, которое ничего не удаляет.
 */
import { exportColdStorage } from "../lib/cold-storage.ts";

export const USAGE = `Использование: bun run tools/export-archive.ts [опции]

Выгружает строки архивных таблиц старше COLD_STORAGE_DAYS в gzip-NDJSON
и по умолчанию удаляет выгруженное из БД.

Опции:
  --dry, --dry-run, -n   Только выгрузка, без удаления из БД
  --help, -h             Показать эту справку

Переменные окружения:
  COLD_STORAGE_DAYS      Порог возраста в днях (по умолчанию 365).
                         0 — выгрести архив целиком.
  BACKUP_DIR             Куда класть выгрузку (по умолчанию ./backups).

Примеры:
  bun run tools/export-archive.ts --dry-run
  COLD_STORAGE_DAYS=0 bun run tools/export-archive.ts`;

const DRY_FLAGS = new Set(["--dry", "--dry-run", "-n"]);
const HELP_FLAGS = new Set(["--help", "-h"]);

export type ParsedArgs =
  | { ok: true; help: true }
  | { ok: true; help: false; dry: boolean }
  | { ok: false; unknown: string[] };

/**
 * Справка приоритетнее всего: `--dry --help` — это просьба показать справку,
 * а не выполнить сухой прогон. Непонятный аргумент валит разбор целиком, даже
 * если рядом стоит понятный: `--dry --forse` не должно молча превращаться в
 * обычный сухой прогон, потому что `--forse` человек написал не просто так.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  if (argv.some((a) => HELP_FLAGS.has(a))) return { ok: true, help: true };
  const unknown = argv.filter((a) => !DRY_FLAGS.has(a));
  if (unknown.length > 0) return { ok: false, unknown };
  return { ok: true, help: false, dry: argv.some((a) => DRY_FLAGS.has(a)) };
}

/**
 * Возвращает код выхода. `out`/`err` — параметры, чтобы пути справки и ошибки
 * проверялись тестом без запуска процесса; именно на них `exportColdStorage`
 * не должен звучать вовсе.
 */
export function runCli(
  argv: string[],
  out: (s: string) => void = console.log,
  err: (s: string) => void = console.error,
): number {
  const parsed = parseArgs(argv);

  if (!parsed.ok) {
    err(
      `export-archive: непонятный аргумент: ${parsed.unknown.join(", ")}. ` +
        "Ничего не выгружено и не удалено.",
    );
    err(USAGE);
    return 2;
  }

  if (parsed.help) {
    out(USAGE);
    return 0;
  }

  const results = exportColdStorage({ prune: !parsed.dry });
  let totalExported = 0,
    totalPruned = 0;
  for (const r of results) {
    totalExported += r.exported;
    totalPruned += r.pruned;
    out(
      `${r.table}: exported=${r.exported} pruned=${r.pruned}` +
        (r.file ? ` → ${r.file}` : ""),
    );
  }
  out(
    `\nTotal: exported=${totalExported} pruned=${totalPruned}` +
      (parsed.dry ? " (dry run)" : ""),
  );
  return 0;
}

if (import.meta.main) {
  process.exit(runCli(process.argv.slice(2)));
}
