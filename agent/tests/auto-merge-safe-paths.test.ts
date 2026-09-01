/**
 * Аудит 2026-08-10: два пути автомержа расходились в самом важном файле репо.
 *
 * Путей два. Оркестраторский (isRiskyPath в lib/dispatch/github.ts) —
 * чёрный список: что не названо рискованным, то вливается. И
 * `.github/workflows/auto-merge.yml` — белый: вливается только то, что явно
 * перечислено в `case`. Второй устроен правильнее, но в его safe-ветке лежали
 * CLAUDE.md и AGENT.md — инструкции, которые загружает каждый следующий агент,
 * включая автономный цикл на runner'ах. Их автомерж означает, что следующая
 * итерация работает по правилам, которых не читал ни один человек.
 *
 * Отдельно: в шапке того же файла CLAUDE.md/AGENT.md не было ни дня — код
 * разошёлся со своим же описанием, и описание выглядело верным.
 *
 * Проверяем форму: содержимое safe-ветки `case` и то, что шапка её описывает.
 *
 * Аудит 2026-08-12: сам `case` переехал из инлайна auto-merge.yml в
 * .github/scripts/automerge-filter.sh — решение об автомёрдже теперь
 * прогоняется тестами целиком (tests/automerge-filter.test.ts). Шапка
 * осталась в воркфлоу, и её сверка со списком — по-прежнему здесь.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isRiskyPath } from "../lib/dispatch/github.ts";

const ROOT = join(import.meta.dir, "..", "..");
const WF = readFileSync(
  join(ROOT, ".github", "workflows", "auto-merge.yml"),
  "utf8",
);
const FILTER = readFileSync(
  join(ROOT, ".github", "scripts", "automerge-filter.sh"),
  "utf8",
);

/** Шаблоны из safe-ветки `case` — всё до закрывающего `*)`. */
function safePatterns(): string[] {
  const from = FILTER.indexOf('case "$1" in');
  expect(from).toBeGreaterThan(-1);
  // Терминатор — ветка `*)`; просто искать `*)` нельзя, он есть и внутри
  // самих шаблонов (`.claude/memory/*)`).
  const rest = FILTER.slice(from);
  const end = rest.search(/^\s*\*\)\s*return 1 ;;$/m);
  expect(end).toBeGreaterThan(0);
  return rest
    .slice(0, end)
    .split("\n")
    .map((l) => l.trim().match(/^(.*)\)\s*return 0 ;;$/)?.[1])
    .filter((p): p is string => p !== undefined)
    .flatMap((p) => p.split("|"));
}

describe("белый список автомержа", () => {
  const patterns = safePatterns();

  test("инструкции агентам не вливаются автоматически", () => {
    expect(patterns).not.toContain("CLAUDE.md");
    expect(patterns).not.toContain("AGENT.md");
  });

  test("model-consumed memory and statuses require human review", () => {
    for (const path of [".claude/memory/*", "STATUS.md", "STATUS-*.md", "WATCHDOG.md", "TASKS.md"]) {
      expect(patterns).not.toContain(path);
    }
  });

  test("код и CI в белый список не попали", () => {
    for (const p of patterns) {
      expect(p.startsWith("agent/")).toBe(false);
      // Единственное исключение по .github — README воркфлоу.
      if (p.startsWith(".github/")) expect(p).toContain("README");
    }
  });

  test("шапка описывает тот же список, что и код", () => {
    // Расхождение кода с описанием и было тем, из-за чего правило «CLAUDE.md
    // не автомержится» выглядело соблюдённым, не будучи им.
    const header = WF.slice(0, WF.indexOf("on:"));
    // Перечисление безопасных путей — строки вида «#   - <путь>».
    const listed = [...header.matchAll(/^#\s+-\s+(.+)$/gm)].map((m) => m[1].trim());
    // `.gitignore` ушёл отсюда аудитом 2026-08-29: он держит вне git
    // `agent/data/*.db` и `*.session`, поэтому его правку смотрит человек.
    expect(listed).not.toContain(".gitignore");
    expect(listed).not.toContain("TASKS.md");
    expect(listed).not.toContain("CLAUDE.md");
    expect(listed).not.toContain("AGENT.md");
    // И сказано прямым текстом, почему их там нет.
    expect(header).toContain("memory, TASKS.md, and status files are not in the safe");
  });
});

describe("оба пути автомержа согласованы", () => {
  test("CLAUDE.md и AGENT.md рискованны и для оркестраторского пути", () => {
    expect(isRiskyPath("CLAUDE.md")).toBe(true);
    expect(isRiskyPath("AGENT.md")).toBe(true);
  });

  test("всё, что белый список считает безопасным, чёрный не считает рискованным", () => {
    // Иначе один путь вливает то, что другой отправляет человеку.
    for (const sample of [
      "docs/adr/0001.md",
      "README.md",
    ]) {
      expect(isRiskyPath(sample)).toBe(false);
    }
  });
});
