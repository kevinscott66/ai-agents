/**
 * Аудит 2026-08-20: контрольный цикл молча не видел часть открытых PR.
 *
 * `listRecentOpenPrs` берёт `gh pr list --limit 50` и потом фильтрует выдачу по
 * окну свежести. Порядок у `gh pr list` без `--search` — по дате СОЗДАНИЯ вниз,
 * а не по дате обновления. То есть обрезка до 50 происходит по номеру, а фильтр
 * — по updatedAt: свежий, но давно созданный PR отсекается ДО того, как окно его
 * увидит.
 *
 * Замер на живом репозитории 2026-08-20: 83 открытых PR. В первые 50 попали
 * #486..#538, самый старый из них обновлён в 01:48Z. PR #469 обновлён в 04:35Z —
 * почти на три часа свежее — и в выдачу не попал вовсе. Прогон отчитался бы
 * «PRs reviewed: N», ни словом не упомянув, что 33 открытых PR он не смотрел.
 *
 * Здесь чинится именно ЛОЖНЫЙ ОТЧЁТ: обрезка теперь видна в результате и в
 * блоке для STATUS.md. Порядок выборки не трогаем — переход на
 * `--search "sort:updated-desc"` расширяет множество PR, которые этот же
 * прогон может смержить, и это решение владельца, а не аудита.
 */
import { describe, it, expect } from "bun:test";
import {
  listRecentOpenPrs,
  runReviewMode,
  formatReviewSummary,
  PR_LIST_LIMIT,
} from "../orchestrator/review-mode.ts";
import type { GhRunner, GhRunResult } from "../lib/dispatch/github.ts";

const NOW = Date.parse("2026-08-20T12:00:00Z");
const now = () => NOW;
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

function fakeGh(responses: Record<string, Partial<GhRunResult>>): {
  runGh: GhRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const runGh: GhRunner = async (args) => {
    calls.push(args);
    const r = responses[`${args[0]} ${args[1]}`] ?? {};
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.exitCode ?? 0 };
  };
  return { runGh, calls };
}

/**
 * Ровно `n` открытых PR, все внутри окна.
 *
 * `headRefName` обязателен: контрольный цикл смотрит только ветки `agent/*`,
 * а запись без имени ветки считается небезопасной и отсеивается (см. фильтр в
 * `listRecentOpenPrs`). Здесь проверяется признак обрезки, а не право на
 * мерж, поэтому все записи — свои.
 */
const prPage = (n: number) =>
  JSON.stringify(
    Array.from({ length: n }, (_, i) => ({
      number: 1000 - i,
      updatedAt: minsAgo(1),
      headRefName: `agent/t-${1000 - i}`,
    })),
  );

describe("listRecentOpenPrs — обрезка видна (аудит 2026-08-20)", () => {
  it("выдача короче предела → truncated=false", async () => {
    const { runGh } = fakeGh({ "pr list": { stdout: prPage(3) } });
    const res = await listRecentOpenPrs(runGh, 90, now);
    expect(res.prNumbers).toHaveLength(3);
    expect(res.truncated).toBe(false);
  });

  it("выдача ровно в предел → truncated=true", async () => {
    // Признак — длина СЫРОЙ выдачи gh, а не числа PR после фильтра: обрезает
    // именно gh, до того как окно свежести что-либо увидело.
    const { runGh } = fakeGh({ "pr list": { stdout: prPage(PR_LIST_LIMIT) } });
    const res = await listRecentOpenPrs(runGh, 90, now);
    expect(res.truncated).toBe(true);
    expect(res.prNumbers).toHaveLength(PR_LIST_LIMIT);
  });

  it("предел упёрт, но все записи вне окна → всё равно truncated=true", async () => {
    // Худший случай: прогон скажет «нечего смотреть», хотя не видел 33 PR.
    const stale = JSON.stringify(
      Array.from({ length: PR_LIST_LIMIT }, (_, i) => ({
        number: 1000 - i,
        updatedAt: minsAgo(500),
        headRefName: `agent/t-${1000 - i}`,
      })),
    );
    const { runGh } = fakeGh({ "pr list": { stdout: stale } });
    const res = await listRecentOpenPrs(runGh, 90, now);
    expect(res.prNumbers).toEqual([]);
    expect(res.truncated).toBe(true);
  });

  it("пустая выдача → truncated=false", async () => {
    const { runGh } = fakeGh({ "pr list": { stdout: "[]" } });
    const res = await listRecentOpenPrs(runGh, 90, now);
    expect(res).toEqual({ prNumbers: [], truncated: false });
  });

  it("запрошенный лимит совпадает с тем, по которому судим об обрезке", async () => {
    // Иначе признак разъедется с реальностью при правке одной из двух констант.
    const { runGh, calls } = fakeGh({ "pr list": { stdout: "[]" } });
    await listRecentOpenPrs(runGh, 90, now);
    const args = calls[0]!;
    expect(args[args.indexOf("--limit") + 1]).toBe(String(PR_LIST_LIMIT));
  });
});

describe("runReviewMode переносит признак обрезки", () => {
  it("truncated доезжает до результата", async () => {
    const { runGh } = fakeGh({
      "pr list": { stdout: prPage(PR_LIST_LIMIT) },
      "pr view": { stdout: JSON.stringify({ state: "OPEN", mergeable: "MERGEABLE", files: [] }) },
    });
    const res = await runReviewMode({ runGh, now, windowMinutes: 90 });
    expect(res.truncated).toBe(true);
    expect(res.scanned).toBe(PR_LIST_LIMIT);
  });

  it("без обрезки truncated=false", async () => {
    const { runGh } = fakeGh({ "pr list": { stdout: "[]" } });
    const res = await runReviewMode({ runGh, now, windowMinutes: 90 });
    expect(res.truncated).toBe(false);
  });
});

describe("formatReviewSummary говорит об обрезке", () => {
  const line = `${PR_LIST_LIMIT}`;

  it("пустой проход с обрезкой не выглядит как «всё чисто»", () => {
    const out = formatReviewSummary(
      { scanned: 0, pr_numbers: [], results: [], truncated: true },
      "2026-08-20T12:00:00Z",
    );
    expect(out).toContain("nothing to review");
    expect(out).toContain(line);
    expect(out.toLowerCase()).toContain("cap");
  });

  it("непустой проход с обрезкой", () => {
    const out = formatReviewSummary(
      {
        scanned: 1,
        pr_numbers: [7],
        results: [{ pr_number: 7, outcome: { ok: true, result: { action: "merged", pr_number: 7 } } }],
        truncated: true,
      },
      "2026-08-20T12:00:00Z",
    );
    expect(out).toContain("PR #7: **merged**");
    expect(out).toContain(line);
  });

  it("без обрезки строки про предел нет", () => {
    const out = formatReviewSummary(
      { scanned: 0, pr_numbers: [], results: [], truncated: false },
      "2026-08-20T12:00:00Z",
    );
    expect(out.toLowerCase()).not.toContain("cap");
  });

  it("truncated не задан (старые вызовы) → строки нет", () => {
    const out = formatReviewSummary(
      { scanned: 0, pr_numbers: [], results: [] },
      "2026-08-20T12:00:00Z",
    );
    expect(out.toLowerCase()).not.toContain("cap");
  });
});
