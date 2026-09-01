/**
 * Аудит 2026-08-28: два докблока описывали не тот код, который под ними лежит.
 *
 * 1. `lib/time-constants.ts` — «Use these instead of inline arithmetic … T-321
 *    audit found `24 * 60 * 60 * 1000` in 5 files … Consolidated here». На
 *    момент аудита инлайновых выражений в рабочем коде было 17, а импортов
 *    самого файла — шесть. Консолидации не случилось, а строка про неё
 *    осталась: следующий читатель верит ей и пишет очередное `6 * 60 * 60 *
 *    1000` рядом.
 *
 * 2. `lib/request-id.ts` — «attach … at the earliest ingress (telegram
 *    bot/userbot update, Mini App HTTP request, mac-bridge command, scheduler
 *    tick)». Из четырёх перечисленных точек id рождается в одной. Поведение от
 *    этого не страдает (см. разбор в самом докблоке), но документ обещает
 *    сквозную корреляцию там, где её никто не заводил.
 *
 * Обе правки — про текст, поэтому и защищены иначе: не поведением, а обходом
 * дерева. Иначе через полгода докблок снова разойдётся с кодом молча.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DAY_MS, HOUR_MS, MINUTE_MS, SECOND_MS } from "../lib/time-constants.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const SCAN_DIRS = ["lib", "orchestrator", "tools", "characters"];
const SKIP_DIRS = new Set(["node_modules", "dist", "data", "backups", "coverage", ".git", "tests"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(entry)) out.push(p);
  }
  return out;
}

const FILES = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d)));

/** Строки кода без комментариев: в докблоках эти выражения как раз цитируются. */
function codeLines(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => {
      const t = l.trimStart();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    });
}

describe("time-constants: обещанная консолидация", () => {
  test("инлайновой арифметики миллисекунд в рабочем коде нет", () => {
    // `60 * 1000` — общий хвост всех трёх форм (минута, час, сутки).
    const BAD = [/\b60\s*\*\s*1000\b/, /\b1000\s*\*\s*60\b/, /\b86_?400_?000\b/, /\b3_?600_?000\b/];
    const hits: string[] = [];
    for (const p of FILES) {
      if (p.endsWith("/time-constants.ts")) continue;
      for (const l of codeLines(p)) {
        if (BAD.some((re) => re.test(l))) hits.push(`${p.slice(ROOT.length)}: ${l.trim()}`);
      }
    }
    // Список, а не toContain по всему файлу: провалившийся `not.toContain`
    // печатает исходник целиком и топит вывод прогона.
    expect(hits).toEqual([]);
  });

  test("константы остались теми же числами", () => {
    expect(SECOND_MS).toBe(1000);
    expect(MINUTE_MS).toBe(60_000);
    expect(HOUR_MS).toBe(3_600_000);
    expect(DAY_MS).toBe(86_400_000);
  });

  test("модуль правда используется, а не лежит рядом", () => {
    const importers = FILES.filter(
      (p) => !p.endsWith("/time-constants.ts") && readFileSync(p, "utf8").includes("time-constants.ts"),
    );
    expect(importers.length).toBeGreaterThanOrEqual(15);
  });
});

describe("request-id: обещанные точки входа", () => {
  test("id рождается ровно там, где сказано в докблоке", () => {
    const callers: string[] = [];
    for (const p of FILES) {
      if (p.endsWith("/request-id.ts")) continue;
      for (const l of codeLines(p)) {
        // Только вызов, не импорт.
        if (/genRequestId\(\)/.test(l)) callers.push(p.slice(ROOT.length));
      }
    }
    expect([...new Set(callers)].sort()).toEqual([
      // Единственная настоящая точка входа — ход пользователя в telegram.
      "orchestrator/message-handler.ts",
      // Ленивый минт для всех остальных путей.
      "lib/action-dispatch.ts",
    ].sort());
  });

  test("путь апрува протаскивает исходный id, а не минтит новый", () => {
    const src = readFileSync(join(ROOT, "lib/commands.ts"), "utf8");
    expect(src).toContain("requestId: approval.request_id ?? undefined");
    expect(src).not.toContain("genRequestId");
  });
});
