#!/usr/bin/env bun
/**
 * T-303: поиск синхронного файлового I/O в горячих путях.
 *
 * Аудит 2026-09-11, круг 51: до этой правки скрипт не сканировал НИЧЕГО и
 * говорил об этом «✅ No sync I/O operations found». Корень сканирования был
 * зашит константой `/home/runner/work/ai-agents/ai-agents/agent` — путь
 * раннера GitHub Actions, которого нет ни на одной другой машине. Обход
 * глотал ошибки чтения молча, `findings` оставался пустым, и отчёт печатал
 * зелёную галочку. Скрипт при этом не вызывает никто: ни package.json, ни
 * три живых воркфлоу, ни деплой-скрипты — то есть единственный его запуск
 * возможен руками, и ровно этот запуск выдавал ложный PASS тому, кто пришёл
 * проверить T-303 перед правкой горячего пути.
 *
 * Поэтому: корень берётся из аргумента, по умолчанию — каталог `agent/`
 * рядом со скриптом; «ни одного файла не прочитано» — это отказ с кодом 2,
 * а не находка «чисто». Отличать «просканировали и не нашли» от «не
 * просканировали» обязан сам инструмент, иначе он врёт в ту сторону, в
 * которую врать дороже всего.
 *
 * Второй проход того же круга — враньё в другую сторону, шумом. Первый же
 * честный прогон дал 1615 находок, из них 17 «горячих», и пятнадцать из
 * семнадцати лежали в tests/. Разбирать такой отчёт никто не станет, то есть
 * инструмент бесполезен ровно так же, как когда печатал зелёную галочку.
 * Причин шума три, и все три — про то, что считалось находкой:
 *   • tests/ сканировались наравне с боевым кодом. Тест, читающий свой же
 *     исходник, горячим путём не бывает. Теперь каталог пропускается, а с
 *     флагом `--with-tests` возвращается — иногда нужен и он;
 *   • строка `import { readFileSync } from "node:fs"` считалась вызовом.
 *     Импорт не делает I/O вовсе, а имён в нём бывает три — и каждое давало
 *     свою находку;
 *   • закомментированное упоминание считалось наравне с кодом.
 * Тяжесть тоже мерилась наугад: `trimmed.includes("process")` поднимал до
 * high любую строку с `process.cwd()`, где бы она ни лежала. Теперь тяжесть
 * определяет ТОЛЬКО файл, и список горячих файлов назван поимённо.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";

interface SyncIOUsage {
  file: string;
  line: number;
  operation: string;
  context: string;
  severity: "low" | "medium" | "high";
}

export interface SyncIOReport {
  findings: SyncIOUsage[];
  /** Сколько файлов реально прочитано. Ноль — мерить было нечего. */
  filesScanned: number;
}

export interface AuditOptions {
  /** Сканировать ли tests/. По умолчанию нет — см. шапку. */
  withTests?: boolean;
}

/**
 * Файлы, синхронный I/O в которых стоит на пути запроса или апдейта.
 *
 * Список поимённый намеренно: прежняя версия ловила подстроку «orchestrator»
 * в пути и «process»/«handler» в самой строке, из-за чего в «горячие»
 * попадало всё подряд, а настоящий горячий путь тонул среди них.
 */
const HOT_FILES = [
  "lib/action-dispatch.ts",
  "lib/miniapp-server.ts",
  "lib/tool-loop.ts",
  "orchestrator/message-handler.ts",
];

/** Файлы, которые читаются часто, но не на каждом запросе. */
const FREQUENT_FILES = ["lib/memory.ts", "lib/backup.ts", "lib/digest.ts"];

/**
 * Строка, которая упоминает sync-операцию, но не выполняет её.
 *
 * `//` и ` * ` — комментарий. Импорты снимает `blankImports` ДО разбиения на
 * строки: они бывают многострочными, и построчная проверка ловила только
 * первую строку, а `existsSync,` со второй считала вызовом.
 */
function isNonExecutingMention(trimmed: string): boolean {
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

/**
 * Стирает тела `import ... from "..."` / `export ... from "..."`, сохраняя
 * нумерацию строк.
 *
 * Заменять на пустую строку нельзя: после этого каждая находка ниже съехала бы
 * по номеру, а номер строки — единственное, чем отчёт полезен. Поэтому вместо
 * совпадения кладётся столько же переводов строки, сколько в нём было.
 */
export function blankImports(content: string): string {
  return content.replace(
    /^[ \t]*(?:import|export)\b[^;]*?\bfrom\s+["'][^"']*["'][ \t]*;?/gm,
    (m) => "\n".repeat((m.match(/\n/g) ?? []).length),
  );
}

/** Каталог `agent/` — скрипт лежит в `agent/tools/`. */
export const DEFAULT_ROOT = dirname(import.meta.dir);

export function auditSyncIO(dir: string, opts: AuditOptions = {}): SyncIOReport {
  const findings: SyncIOUsage[] = [];
  let filesScanned = 0;

  function scanFile(filePath: string) {
    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      // Нечитаемый файл — не находка и не ошибка обхода; в счёт не идёт.
      return;
    }
    filesScanned++;
    const lines = blankImports(content).split("\n");

    // Путь относительно корня — по нему и решается тяжесть, и он же идёт в
    // отчёт. Абсолютный префикс каталога на чужой машине ничего не значит.
    const rel = filePath.startsWith(dir + "/") ? filePath.slice(dir.length + 1) : filePath;
    const severity: "low" | "medium" | "high" = HOT_FILES.includes(rel)
      ? "high"
      : FREQUENT_FILES.includes(rel)
        ? "medium"
        : "low";

    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (isNonExecutingMention(trimmed)) return;

      // Look for sync file operations
      const syncOps = [
        "readFileSync",
        "writeFileSync",
        "existsSync",
        "statSync",
        "appendFileSync",
        "unlinkSync",
        "mkdirSync",
      ];

      for (const op of syncOps) {
        if (trimmed.includes(op)) {
          findings.push({
            file: rel,
            line: index + 1,
            operation: op,
            context: trimmed,
            severity,
          });
        }
      }
    });
  }

  function scanDirectory(dirPath: string) {
    let entries: string[];
    try {
      entries = readdirSync(dirPath);
    } catch {
      // Нечитаемый подкаталог пропускаем; корень проверяет вызывающий.
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dirPath, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        // Skip node_modules, .git, etc.
        const skip =
          entry.startsWith(".") ||
          entry === "node_modules" ||
          entry === "data" ||
          (entry === "tests" && !opts.withTests);
        if (!skip) {
          scanDirectory(fullPath);
        }
      } else if (entry.endsWith(".ts") || entry.endsWith(".js")) {
        scanFile(fullPath);
      }
    }
  }

  scanDirectory(dir);
  return { findings, filesScanned };
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const withTests = argv.includes("--with-tests");
  const root = argv.find((a) => !a.startsWith("--")) ?? DEFAULT_ROOT;
  console.log("=== T-303 Sync I/O Audit Results ===\n");

  const { findings, filesScanned } = auditSyncIO(root, { withTests });

  if (filesScanned === 0) {
    // Именно тот случай, ради которого правился скрипт: пустой результат от
    // непрочитанного каталога не смеет выглядеть как чистый результат.
    console.error(
      `❌ Не прочитано ни одного файла в ${root} — измерить нечего. ` +
        `Передайте каталог аргументом: bun tools/sync-io-audit.ts <путь>`,
    );
    return 2;
  }

  // Group by severity
  const highSev = findings.filter((f) => f.severity === "high");
  const medSev = findings.filter((f) => f.severity === "medium");
  const lowSev = findings.filter((f) => f.severity === "low");

  console.log(
    `Scanned ${filesScanned} files in ${root}` + (withTests ? " (включая tests/)" : " (без tests/)"),
  );
  console.log(`Found ${findings.length} sync I/O operations:`);
  console.log(`- High severity (hot paths): ${highSev.length}`);
  console.log(`- Medium severity (frequent): ${medSev.length}`);
  console.log(`- Low severity (initialization): ${lowSev.length}\n`);

  if (highSev.length > 0) {
    console.log("🔥 HIGH SEVERITY - Hot Path Sync I/O:");
    highSev.forEach((f) => {
      console.log(`   ${f.file}:${f.line} - ${f.operation}`);
      console.log(`   ${f.context.substring(0, 80)}${f.context.length > 80 ? "..." : ""}`);
      console.log();
    });
  }

  if (medSev.length > 0) {
    console.log("⚠️  MEDIUM SEVERITY - Frequent Sync I/O:");
    medSev.forEach((f) => {
      console.log(`   ${f.file}:${f.line} - ${f.operation}`);
      console.log(`   ${f.context.substring(0, 80)}${f.context.length > 80 ? "..." : ""}`);
      console.log();
    });
  }

  console.log("💡 RECOMMENDATIONS:");

  if (highSev.length > 0) {
    console.log("- Replace high-severity sync operations with async equivalents");
    console.log("- Consider caching for frequently read files");
    console.log("- Use streaming for large file operations");
  }

  if (medSev.length > 0) {
    console.log("- Evaluate if medium-severity operations can be batched or cached");
    console.log("- Consider moving to worker threads for heavy file operations");
  }

  if (findings.length === 0) {
    console.log(`✅ No sync I/O operations found in ${filesScanned} scanned files`);
  } else {
    console.log(`- Total sync operations to review: ${findings.length}`);
  }

  console.log("\n=== Analysis Complete ===");
  return 0;
}

if (import.meta.main) process.exit(main());
