/**
 * Layer-1 read-only GitHub client — pure shapers (no network).
 */
import { describe, test, expect } from "bun:test";
import { shapeRuns, shapePRs, shapeCommits } from "../lib/github.ts";

describe("shapeRuns", () => {
  test("берёт top-5 workflow_runs с нужными полями", () => {
    const runs = {
      workflow_runs: [
        { name: "CI", head_branch: "main", status: "completed", conclusion: "success" },
        { name: "Deploy", head_branch: "feat/x", status: "in_progress", conclusion: null },
      ],
    };
    const s = shapeRuns(runs);
    expect(s).toHaveLength(2);
    expect(s[0]).toEqual({ name: "CI", branch: "main", status: "completed", conclusion: "success" });
    expect(s[1].conclusion).toBeNull();
  });
  test("пустой/кривой ввод → []", () => {
    expect(shapeRuns({})).toEqual([]);
    expect(shapeRuns(null)).toEqual([]);
  });
});

describe("shapePRs", () => {
  test("маппит номер/заголовок/draft/ветку", () => {
    const s = shapePRs([
      { number: 42, title: "feat: thing", draft: false, head: { ref: "feat/thing" } },
    ]);
    expect(s[0]).toEqual({ number: 42, title: "feat: thing", draft: false, branch: "feat/thing" });
  });
  test("не-массив → []", () => expect(shapePRs({})).toEqual([]));
});

describe("shapeCommits", () => {
  test("sha7 + первая строка сообщения + автор", () => {
    const s = shapeCommits([
      { sha: "abcdef1234567", commit: { message: "fix: bug\n\ndetails", author: { name: "Alex" } } },
    ]);
    expect(s[0]).toEqual({ sha: "abcdef1", message: "fix: bug", author: "Alex" });
  });
  test("не-массив → []", () => expect(shapeCommits(null)).toEqual([]));
});
