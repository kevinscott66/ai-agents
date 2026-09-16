/**
 * Аудит 2026-09-11, круг 51: инструмент проверки, который ничего не проверил,
 * печатал «✅ No sync I/O operations found».
 *
 * tools/sync-io-audit.ts — единственный способ проверить T-303 («синхронный
 * файловый I/O в горячих путях») перед правкой горячего пути. Корень
 * сканирования был зашит константой `/home/runner/work/ai-agents/ai-agents/agent`
 * — это путь раннера GitHub Actions, и на любой другой машине его нет. Обход
 * каталога глотал ошибку чтения молча, находок не набиралось ни одной, и отчёт
 * заканчивался зелёной галочкой. То есть инструмент врал ровно в ту сторону,
 * в которую врать дороже всего: «проверено, чисто» вместо «не проверено».
 *
 * Запускает его только человек руками — ни package.json, ни три живых
 * воркфлоу (checks/commit-attribution/tests-nightly), ни деплой-скрипты на
 * него не ссылаются. Автоматика не заметила бы разницы; заметил бы только тот,
 * кто пришёл убедиться, что горячий путь чист.
 *
 * Здесь проверяется не форматирование отчёта, а его правдивость: пустой
 * результат от непрочитанного каталога обязан быть отказом, а не находкой
 * «чисто».
 */
import { test, expect, describe } from "bun:test";
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditSyncIO, blankImports, main, DEFAULT_ROOT } from "../tools/sync-io-audit.ts";

const SRC = readFileSync(new URL("../tools/sync-io-audit.ts", import.meta.url), "utf8");
/** Шапка модуля — в ней путь раннера назван как разобранная ошибка, и это законно. */
const HEAD = SRC.slice(0, SRC.indexOf("*/") + 2);
/** Всё остальное: код и комментарии при нём. */
const BODY = SRC.slice(HEAD.length);

/** Прогнать main() с перехваченным выводом. */
function runMain(argv: string[]): { code: number; out: string } {
  const chunks: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a: unknown[]) => void chunks.push(a.join(" "));
  console.error = (...a: unknown[]) => void chunks.push(a.join(" "));
  try {
    const code = main(argv);
    return { code, out: chunks.join("\n") };
  } finally {
    console.log = log;
    console.error = err;
  }
}

describe("аудит sync I/O не выдаёт «чисто» за «не смотрел»", () => {
  test("корень сканирования не зашит путём чужого раннера", () => {
    expect(BODY).not.toContain("/home/runner/");
    // Шапка про него говорит — как про закрытую дыру, а не как про настройку.
    expect(HEAD).toContain("/home/runner/");
    // По умолчанию — каталог agent/, тот самый, что и разбирается.
    expect(DEFAULT_ROOT.endsWith("/agent")).toBe(true);
  });

  test("несуществующий каталог — отказ с кодом 2, а не зелёная галочка", () => {
    const ghost = join(tmpdir(), `sync-io-audit-ghost-${process.pid}-${Date.now()}`);
    const { code, out } = runMain([ghost]);
    expect(code).toBe(2);
    expect(out).not.toContain("✅");
    expect(out).toContain("ни одного файла");
  });

  test("пустой каталог — тоже отказ: читать было нечего", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-io-audit-empty-"));
    const { code, out } = runMain([dir]);
    expect(code).toBe(2);
    expect(out).not.toContain("✅");
  });

  test("каталог без синхронного I/O — честное «чисто» с числом файлов", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-io-audit-clean-"));
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    writeFileSync(join(dir, "b.ts"), "export async function b() { return 2; }\n");
    const { code, out } = runMain([dir]);
    expect(code).toBe(0);
    expect(out).toContain("✅");
    // Число файлов в отчёте — то самое, что отличает «чисто» от «не смотрел».
    expect(out).toContain("2 scanned files");
  });

  test("синхронный вызов находится, путь — относительный корню сканирования", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-io-audit-find-"));
    mkdirSync(join(dir, "lib"));
    writeFileSync(join(dir, "lib", "hot.ts"), 'import { readFileSync } from "node:fs";\nreadFileSync("x");\n');
    const { findings, filesScanned } = auditSyncIO(dir);
    expect(filesScanned).toBe(1);
    // Строка импорта I/O не делает — находка ровно одна, на вызове.
    expect(findings.map((f) => f.file)).toEqual(["lib/hot.ts"]);
    expect(findings.map((f) => f.line)).toEqual([2]);
    expect(findings.every((f) => f.operation === "readFileSync")).toBe(true);
  });

  test("импорт и комментарий находками не считаются", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-io-audit-noise-"));
    mkdirSync(join(dir, "lib"));
    writeFileSync(
      join(dir, "lib", "noisy.ts"),
      [
        "import {",
        "  existsSync,",
        "  readFileSync,",
        '} from "node:fs";',
        "// раньше здесь звали readFileSync",
        "/** Докблок про writeFileSync. */",
        "export function f() {",
        '  return existsSync("x");',
        "}",
        "",
      ].join("\n"),
    );
    const { findings } = auditSyncIO(dir);
    // Единственная настоящая операция — на восьмой строке; номер не съехал.
    expect(findings.map((f) => [f.operation, f.line])).toEqual([["existsSync", 8]]);
  });

  test("blankImports сохраняет нумерацию строк", () => {
    // Иначе номера в отчёте указывали бы мимо, а номер — единственное, чем
    // отчёт полезен.
    const src = ['import {', '  readFileSync,', '} from "node:fs";', 'readFileSync("x");'].join("\n");
    const out = blankImports(src);
    expect(out.split("\n").length).toBe(src.split("\n").length);
    expect(out.split("\n")[3]).toBe('readFileSync("x");');
    expect(out.split("\n").slice(0, 3).join("")).toBe("");
  });

  test("tests/ по умолчанию не сканируется, с --with-tests сканируется", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-io-audit-tests-"));
    mkdirSync(join(dir, "tests"));
    mkdirSync(join(dir, "lib"));
    writeFileSync(join(dir, "lib", "a.ts"), 'existsSync("x");\n');
    writeFileSync(join(dir, "tests", "b.test.ts"), 'readFileSync("y");\n');
    const off = auditSyncIO(dir);
    expect(off.filesScanned).toBe(1);
    expect(off.findings.map((f) => f.file)).toEqual(["lib/a.ts"]);
    const on = auditSyncIO(dir, { withTests: true });
    expect(on.filesScanned).toBe(2);
    expect(on.findings.map((f) => f.file).sort()).toEqual(["lib/a.ts", "tests/b.test.ts"]);
  });

  test("тяжесть решает файл, а не случайное слово в строке", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-io-audit-sev-"));
    mkdirSync(join(dir, "lib"));
    // Прежняя версия поднимала до high любую строку со словом «process».
    writeFileSync(join(dir, "lib", "cold.ts"), 'existsSync(process.cwd());\n');
    writeFileSync(join(dir, "lib", "action-dispatch.ts"), 'existsSync("x");\n');
    writeFileSync(join(dir, "lib", "memory.ts"), 'existsSync("x");\n');
    const byFile = new Map(auditSyncIO(dir).findings.map((f) => [f.file, f.severity]));
    expect(byFile.get("lib/cold.ts")).toBe("low");
    expect(byFile.get("lib/action-dispatch.ts")).toBe("high");
    expect(byFile.get("lib/memory.ts")).toBe("medium");
  });

  test("на живом дереве agent/ инструмент читает файлы, а не ноль", () => {
    // Замер, а не утверждение о числе находок: важно лишь, что обход работает
    // там, где по умолчанию и будет запущен.
    const { filesScanned } = auditSyncIO(DEFAULT_ROOT);
    expect(filesScanned).toBeGreaterThan(100);
  });

  test("шапка описывает то, что скрипт делает, а не то, чего он не делает", () => {
    const head = HEAD.replace(/^\s*\*/gm, "").replace(/\s+/g, " ");
    expect(head).toContain("T-303");
    // Прежняя шапка обещала «analyzes the codebase» безотносительно того, чью.
    expect(head).toContain("по умолчанию");
  });
});
