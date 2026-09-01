/**
 * Аудит 2026-08-10: одна вью Mini App считает created_at секундами.
 *
 * В БД все created_at — миллисекунды: audit.ts, tasks.ts и approvals.ts пишут
 * Date.now() без деления, а API отдаёт колонку как есть. Все вью так их и
 * читают — `new Date(a.created_at)`. Кроме Agents.tsx, где стоит
 * `new Date(action.created_at * 1000)`.
 *
 * Умножение не роняет ничего и не подсвечивается типами (number он и есть
 * number): 1.75e12 × 1000 = 1.75e15 — в допустимом диапазоне Date, поэтому
 * toLocaleString честно печатает дату где-то в 57-м тысячелетии. То есть
 * единственное место, где видно, КОГДА агент выполнил действие, показывает
 * заведомую чушь — а рядом, в Logs и Dashboard, те же самые строки
 * agent_actions отображаются верно.
 *
 * Тест структурный: DOM-харнесса у Mini App нет, а инвариант тут ровно
 * текстовый — единица времени одна на все вью.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const PAGES_DIR = join(import.meta.dir, "..", "miniapp", "src", "pages");

function pageSources(): Array<{ file: string; src: string }> {
  return readdirSync(PAGES_DIR)
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => ({ file: f, src: readFileSync(join(PAGES_DIR, f), "utf8") }));
}

describe("время во всех вью — миллисекунды", () => {
  test("ни одна вью не домножает created_at на 1000", () => {
    const offenders: string[] = [];
    for (const { file, src } of pageSources()) {
      for (const line of src.split("\n")) {
        if (/created_at\s*\*\s*1000/.test(line)) offenders.push(`${file}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("вью читают created_at напрямую", () => {
    // Обратная сторона: если кто-то начнёт делить на 1000, дата уедет в 1970-е.
    const offenders: string[] = [];
    for (const { file, src } of pageSources()) {
      for (const line of src.split("\n")) {
        if (/created_at\s*\/\s*1000/.test(line)) offenders.push(`${file}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("страница агентов по-прежнему печатает время действия", () => {
    // Чтобы «фикс» не свёлся к удалению строки вместе с датой.
    const src = readFileSync(join(PAGES_DIR, "Agents.tsx"), "utf8");
    expect(src).toContain("new Date(action.created_at)");
  });
});
