/**
 * Аудит 2026-08-09: страница вики росла без предела.
 *
 * `MAX_PAGE_CONTENT = 800` ограничивает только НОВЫЙ кусок, который компактор
 * предлагает записать. А `mergeAndWrite` дописывает его секцией в конец уже
 * существующей страницы — потолка на страницу целиком не было ни одного.
 * Компактор запускается на каждую содержательную реплику агента, так что рост
 * непрерывный.
 *
 * Растёт не только файл на диске: страницу целиком отдаёт READ_WIKI (уходит в
 * контекст модели) и её содержимое лежит в FTS-индексе, который читается на
 * каждом ходу.
 *
 * Инвариант: страница не превышает потолок, свежие секции важнее старых, а
 * голова страницы — то, ради чего её заводили, — переживает любую обрезку.
 */
import { describe, test, expect } from "bun:test";
import { trimMergedPage, _compactorInternals } from "../lib/compactor.ts";

const LIMIT = _compactorInternals.MAX_MERGED_PAGE;
const SEP = "\n\n---\n## Update ";

function section(day: number, body: string): string {
  const d = String(day).padStart(2, "0");
  return `${SEP}2026-03-${d}\n\n${body}\n`;
}

/** Страница из головы и N секций примерно по `each` символов. */
function page(head: string, n: number, each = 900): string {
  let s = head;
  for (let i = 1; i <= n; i++) s += section(i, `секция-${i} ` + "x".repeat(each));
  return s;
}

describe("compactor: страница вики не растёт без предела", () => {
  test("страница длиннее потолка обрезается", () => {
    const grown = page("# Проект\n\nисходное описание", 40);
    expect(grown.length).toBeGreaterThan(LIMIT);
    expect(trimMergedPage(grown).length).toBeLessThanOrEqual(LIMIT);
  });

  test("выбрасываются самые старые секции, свежие остаются", () => {
    const out = trimMergedPage(page("# Проект\n\nописание", 40));
    expect(out).toContain("секция-40");
    expect(out).toContain("секция-39");
    expect(out).not.toContain("секция-1 ");
    expect(out).not.toContain("секция-2 ");
  });

  test("голова страницы переживает обрезку", () => {
    const out = trimMergedPage(page("# Проект\n\nради-этого-заводили", 40));
    expect(out).toContain("ради-этого-заводили");
  });

  test("обрезка не молчит — в странице остаётся счёт выброшенного", () => {
    const out = trimMergedPage(page("# Проект\n\nописание", 40));
    expect(out).toMatch(/Обрезано при слиянии: \d+ более ранних секций/);
  });

  test("отметки об обрезке не копятся от прогона к прогону", () => {
    let p = page("# Проект\n\nописание", 40);
    for (let round = 0; round < 5; round++) {
      p = trimMergedPage(p);
      p += section(50 + round, "новое " + "y".repeat(2000));
    }
    const notes = p.match(/Обрезано при слиянии/g) ?? [];
    expect(notes.length).toBeLessThanOrEqual(1);
    expect(trimMergedPage(p).length).toBeLessThanOrEqual(LIMIT);
  });

  test("короткая страница не трогается вовсе", () => {
    const small = page("# Проект\n\nописание", 2, 50);
    expect(small.length).toBeLessThan(LIMIT);
    expect(trimMergedPage(small)).toBe(small);
  });

  test("голова больше потолка — режется и она, но страница остаётся в рамках", () => {
    const huge = "# Проект\n\n" + "z".repeat(LIMIT * 2);
    const out = trimMergedPage(huge + section(1, "хвост"));
    expect(out.length).toBeLessThanOrEqual(LIMIT);
  });
});
