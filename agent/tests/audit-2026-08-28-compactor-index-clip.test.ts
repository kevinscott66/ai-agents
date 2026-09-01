/**
 * Аудит 2026-08-28: индекс вики резался по символу посреди слага.
 *
 * `wikiIndex(...).slice(0, 1500)` — рез по индексу символа. Строка индекса это
 * `- slug — title`, поэтому последней записью регулярно оказывался обрубок
 * (`- deploy-checkli`). Компактор именно по этому списку решает, дописать
 * существующую страницу или завести новую: обрубок даёт либо page-op на
 * несуществующий слаг, либо дубль рядом с настоящей страницей. Делается это
 * без человека в цикле, а результат читают все 12 ролей на каждом ходу.
 *
 * И сам факт обрезки был невидим — список выглядел полным.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { clipWikiIndex } from "../lib/compactor.ts";

const MARKER = "… индекс обрезан по лимиту";

function index(n: number, slugLen = 20): string {
  return Array.from({ length: n }, (_, i) => `- ${String(i).padStart(slugLen, "s")}`).join("\n");
}

describe("clipWikiIndex", () => {
  test("короткий индекс не трогается вовсе", () => {
    const s = index(5);
    expect(clipWikiIndex(s, 1500)).toBe(s);
  });

  test("индекс ровно по лимиту не трогается", () => {
    const s = "- alpha";
    expect(clipWikiIndex(s, s.length)).toBe(s);
  });

  test("обрезка идёт по границе строки — обрубков слагов не остаётся", () => {
    const s = index(200);
    const out = clipWikiIndex(s, 1500);
    const lines = out.split("\n");
    expect(lines.pop()).toBe(MARKER);
    // Каждая уцелевшая строка присутствует в исходнике целиком.
    const src = new Set(s.split("\n"));
    for (const l of lines) expect(src.has(l)).toBe(true);
  });

  test("обрезка подписана, а не молчалива", () => {
    expect(clipWikiIndex(index(200), 1500)).toContain(MARKER);
  });

  test("режем не больше нужного: следующая строка уже не влезала", () => {
    const s = index(200);
    const out = clipWikiIndex(s, 1500);
    const kept = out.split("\n").slice(0, -1);
    const head = kept.join("\n");
    expect(head.length).toBeLessThanOrEqual(1500);
    const nextLine = s.split("\n")[kept.length];
    expect(`${head}\n${nextLine}`.length).toBeGreaterThan(1500);
  });

  test("единственная строка длиннее лимита даёт только маркер", () => {
    // Целой записи не остаётся вовсе, а любой её кусок — ровно тот обрубок,
    // от которого мы уходим.
    expect(clipWikiIndex(`- ${"x".repeat(4000)}`, 1500)).toBe(MARKER);
  });

  test("пустой индекс остаётся пустым", () => {
    expect(clipWikiIndex("", 1500)).toBe("");
  });
});

describe("применение", () => {
  test("компактор больше не режет индекс голым slice", () => {
    const src = readFileSync(new URL("../lib/compactor.ts", import.meta.url).pathname, "utf8");
    // Только строки вызова: `.slice(0, 1500)` встречается ещё и в docstring,
    // где он описывает то, что убрали (CLAUDE.md — source-guard на своём же
    // тексте ломается от собственной правки).
    const calls = src
      .split("\n")
      .filter((l) => l.includes("wikiIndex(") && !l.trimStart().startsWith("*"));
    expect(calls.join("\n")).toContain('clipWikiIndex(wikiIndex("_team"))');
    expect(calls.join("\n")).toContain("clipWikiIndex(wikiIndex(ctx.agentKey))");
    for (const l of calls) expect(l).not.toContain(".slice(");
  });
});
