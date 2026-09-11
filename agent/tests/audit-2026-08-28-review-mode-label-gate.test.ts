/**
 * Аудит 2026-08-28: control-loop не рассматривал НИ ОДНОГО своего PR.
 *
 * Три сцепленных дефекта в одной петле обратной связи:
 *
 * 1. `listRecentOpenPrs` пропускает дальше только ветки `agent/*` — то есть
 *    ровно те PR, которые открывает автономный цикл. А цикл сразу после
 *    `gh pr create` вешает на каждый свой PR метку `needs-human-review`
 *    (`gh pr edit --add-label` в `deploy/vps-autonomous/autonomous-cycle.sh`).
 *    Гейт блокирующих меток
 *    в `validatePrChecklist` стоит ДО чеклиста, поэтому каждый такой PR
 *    возвращал `{action:"skipped"}` без единого комментария. Режим, написанный
 *    ради «сначала разбери открытые PR, потом бери новую задачу», не давал
 *    вообще никакого сигнала.
 *
 * 2. Отчёт печатал `prNumbers.length` под заголовком «PRs reviewed» — то есть
 *    длину списка ДО разбора. Пять пропусков выглядели как пять разборов,
 *    поэтому пункт 1 и не бросался в глаза.
 *
 * 3. `agent.ts --mode review` выходил с кодом 0 безусловно. Обещание
 *    fail-closed из шапки `autonomous-cycle.sh` держалось только на первом
 *    `gh pr list`: истёкший PAT валил каждый per-PR вызов, а цикл шёл дальше
 *    брать новую задачу.
 *
 * Инвариант, который тут закрепляется: метка семейства `needs-human*` — запрет
 * для merge-пути и информация для review-only control-loop; `hold` / `risky` /
 * `do-not-merge` остаются запретом для обоих.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import {
  handleReviewAndMergePr,
  isBlockingLabel,
  isHumanReviewLabel,
} from "../lib/dispatch/github.ts";
import {
  runReviewMode,
  formatReviewSummary,
  countReviewOutcomes,
} from "../orchestrator/review-mode.ts";
import type { GhRunner, GhRunResult, GithubResult } from "../lib/dispatch/github.ts";
import type { ReviewedPr } from "../orchestrator/review-mode.ts";
import { TRUSTED_PR_IDENTITY } from "./helpers/pr-view-fixture.ts";

const CTX = { agentKey: "orchestrator", chatId: 0 };
const NOW = Date.parse("2026-08-28T12:00:00Z");

interface PrView {
  state?: string;
  mergeable?: string;
  files?: { path: string }[];
  isDraft?: boolean;
  labels?: { name: string }[];
}

/** Зелёный docs-only PR: в белом списке путей, готов к автомержу. */
function safePr(extra: PrView = {}): PrView {
  return {
    ...TRUSTED_PR_IDENTITY,
    state: "OPEN",
    mergeable: "MERGEABLE",
    files: [{ path: "docs/plan.md" }],
    ...extra,
  };
}

function fakeGh(view: PrView): { runGh: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runGh: GhRunner = async (args): Promise<GhRunResult> => {
    calls.push(args);
    const key = `${args[0]} ${args[1]}`;
    if (key === "pr view") return { exitCode: 0, stdout: JSON.stringify(view), stderr: "" };
    if (key === "pr merge") return { exitCode: 0, stdout: "merged abc1234", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return { runGh, calls };
}

const did = (calls: string[][], sub: string) => calls.some((c) => `${c[0]} ${c[1]}` === sub);

const ok = (action: string): GithubResult => ({
  ok: true,
  result: { action: action as never, pr_number: 1, message: "" },
});
const err = (): GithubResult => ({ ok: false, error: "kaboom" });
const reviewed = (items: GithubResult[]): ReviewedPr[] =>
  items.map((outcome, i) => ({ pr_number: i + 1, outcome }));

describe("метка цикла больше не глушит control-loop", () => {
  test("needs-human-review + control-loop: чеклист прогнан, комментарий поставлен", async () => {
    const { runGh, calls } = fakeGh(safePr({ labels: [{ name: "needs-human-review" }] }));
    const res = await handleReviewAndMergePr({ pr_number: 350 }, CTX, {
      runGh,
      authority: "control-loop",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.result.action).toBe("commented");
      expect(res.result.checks_passed).toBe(true);
    }
    expect(did(calls, "pr comment")).toBe(true);
    // Чеклист действительно прогнан, а не пропущен: раньше `pr checks` до
    // этого PR не доходил вовсе.
    expect(did(calls, "pr checks")).toBe(true);
  });

  test("та же метка на merge-пути по-прежнему запрет", async () => {
    const { runGh, calls } = fakeGh(safePr({ labels: [{ name: "needs-human-review" }] }));
    const res = await handleReviewAndMergePr({ pr_number: 350 }, CTX, {
      runGh,
      authority: "approved-action",
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result.action).toBe("skipped");
    expect(did(calls, "pr merge")).toBe(false);
    expect(did(calls, "pr comment")).toBe(false);
  });

  test.each(["hold", "risky", "do-not-merge"])(
    "метка %s остаётся запретом и для control-loop",
    async (label) => {
      const { runGh, calls } = fakeGh(safePr({ labels: [{ name: label }] }));
      const res = await handleReviewAndMergePr({ pr_number: 350 }, CTX, {
        runGh,
        authority: "control-loop",
      });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.result.action).toBe("skipped");
      expect(did(calls, "pr comment")).toBe(false);
      expect(did(calls, "pr checks")).toBe(false);
    },
  );

  test("регистр метки не важен", async () => {
    const { runGh, calls } = fakeGh(safePr({ labels: [{ name: "Needs-Human-Review" }] }));
    await handleReviewAndMergePr({ pr_number: 350 }, CTX, { runGh, authority: "control-loop" });
    expect(did(calls, "pr comment")).toBe(true);
  });

  test("послабление не открывает control-loop дорогу к мержу", async () => {
    const { runGh, calls } = fakeGh(safePr({ labels: [{ name: "needs-human-review" }] }));
    await handleReviewAndMergePr({ pr_number: 350 }, CTX, { runGh, authority: "control-loop" });
    expect(did(calls, "pr merge")).toBe(false);
  });

  test("черновик остаётся пропуском для обоих путей", async () => {
    for (const authority of ["control-loop", "approved-action"] as const) {
      const { runGh, calls } = fakeGh(safePr({ isDraft: true }));
      const res = await handleReviewAndMergePr({ pr_number: 350 }, CTX, { runGh, authority });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.result.action).toBe("skipped");
      expect(did(calls, "pr comment")).toBe(false);
    }
  });
});

describe("классификаторы меток", () => {
  test("isHumanReviewLabel ловит только семейство needs-human", () => {
    expect(isHumanReviewLabel("needs-human")).toBe(true);
    expect(isHumanReviewLabel("needs-human-review")).toBe(true);
    expect(isHumanReviewLabel("NEEDS-HUMAN-REVIEW")).toBe(true);
    for (const other of ["hold", "risky", "do-not-merge", "docs", ""]) {
      expect(isHumanReviewLabel(other)).toBe(false);
    }
  });

  test("isBlockingLabel не ослаблен: needs-human* всё ещё блокирующая", () => {
    for (const label of ["hold", "risky", "do-not-merge", "needs-human", "needs-human-review"]) {
      expect(isBlockingLabel(label)).toBe(true);
    }
    expect(isBlockingLabel("docs")).toBe(false);
  });
});

describe("сквозной прогон цикла", () => {
  /** PR ровно такой, какой открывает autonomous-cycle.sh: ветка agent/*, метка. */
  const cyclePr = JSON.stringify(
    safePr({ labels: [{ name: "needs-human-review" }] }),
  );

  function cycleGh(): { runGh: GhRunner; calls: string[][] } {
    const calls: string[][] = [];
    const runGh: GhRunner = async (args): Promise<GhRunResult> => {
      calls.push(args);
      const key = `${args[0]} ${args[1]}`;
      if (key === "pr list") {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              number: 700,
              headRefName: "agent/backend-vps-20260828-101010",
              updatedAt: new Date(NOW - 5 * 60_000).toISOString(),
            },
          ]),
          stderr: "",
        };
      }
      if (key === "pr view") return { exitCode: 0, stdout: cyclePr, stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    return { runGh, calls };
  }

  test("PR автономного цикла получает комментарий, а не молчаливый пропуск", async () => {
    const { runGh, calls } = cycleGh();
    const result = await runReviewMode({ runGh, now: () => NOW });
    expect(result.pr_numbers).toEqual([700]);
    expect(result.results).toHaveLength(1);
    const outcome = result.results[0].outcome;
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.result.action).toBe("commented");
    expect(did(calls, "pr comment")).toBe(true);
    expect(result.failed).toBe(0);
  });

  test("failed считается по упавшим PR", async () => {
    const runGh: GhRunner = async (args) => {
      const key = `${args[0]} ${args[1]}`;
      if (key === "pr list") {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              number: 701,
              headRefName: "agent/qa-vps-1",
              updatedAt: new Date(NOW - 1000).toISOString(),
            },
          ]),
          stderr: "",
        };
      }
      // Ровно то, что делает истёкший PAT: per-PR вызовы валятся.
      return { exitCode: 1, stdout: "", stderr: "HTTP 401" };
    };
    const result = await runReviewMode({ runGh, now: () => NOW });
    expect(result.failed).toBe(1);
    expect(countReviewOutcomes(result.results)).toEqual({ reviewed: 0, skipped: 0, failed: 1 });
  });
});

describe("отчёт различает разбор и пропуск", () => {
  test("countReviewOutcomes раскладывает исходы", () => {
    expect(
      countReviewOutcomes(reviewed([ok("commented"), ok("merged"), ok("skipped"), err()])),
    ).toEqual({ reviewed: 2, skipped: 1, failed: 1 });
  });

  test("заголовок больше не обещает разбор вместо скана", () => {
    const out = formatReviewSummary(
      { scanned: 2, pr_numbers: [1, 2], results: reviewed([ok("skipped"), err()]) },
      "2026-08-28T12:00:00Z",
    );
    expect(out).toContain("PRs scanned:** 2");
    expect(out).not.toContain("PRs reviewed");
    expect(out).toContain("**Commented:** 0");
    expect(out).toContain("**skipped:** 1");
    expect(out).toContain("**failed:** 1");
  });

  test("пустой прогон печатается без разбивки", () => {
    const out = formatReviewSummary({ scanned: 0, pr_numbers: [], results: [] }, "t");
    expect(out).toContain("nothing to review");
    expect(out).not.toContain("Commented:");
  });
});

describe("fail-closed по коду возврата", () => {
  const AGENT_SRC = readFileSync(new URL("../agent.ts", import.meta.url), "utf8");

  test("review-ветка больше не выходит нулём безусловно", () => {
    expect(AGENT_SRC).not.toContain("process.exit(0);");
    expect(AGENT_SRC).toContain("process.exit(nothingWorked ? 1 : 0);");
  });

  test("порог — «упало всё», одиночный провал цикл не клинит", () => {
    const nothingWorked = (r: ReviewedPr[]) => {
      const t = countReviewOutcomes(r);
      return t.failed > 0 && t.reviewed + t.skipped === 0;
    };
    expect(nothingWorked(reviewed([err(), err()]))).toBe(true);
    expect(nothingWorked(reviewed([err(), ok("commented")]))).toBe(false);
    expect(nothingWorked(reviewed([err(), ok("skipped")]))).toBe(false);
    expect(nothingWorked(reviewed([ok("commented")]))).toBe(false);
    expect(nothingWorked([])).toBe(false);
  });
});
