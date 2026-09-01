/**
 * Аудит 2026-08-08: авто-мерж мог сработать по диффу, который код не видел целиком.
 *
 * `gh pr view --json files` отдаёт максимум 100 файлов: в бинаре gh запрос
 * зашит как `files(first: 100)`, без pageInfo/endCursor — вторую страницу он не
 * берёт и об усечении не сообщает. Обе проверки чеклиста («артефакты сборки» и
 * `risky`) строятся ровно на этом массиве, поэтому PR со 120 файлами
 * проверялся по первым 100. Если dist/ или agent/characters/ лежат в хвосте —
 * checklist отвечает passed, и дальше идёт `gh pr merge --squash` в main.
 *
 * Лечится честным числом: changedFiles не усечено, расхождение = «дифф виден
 * не целиком» = отказ.
 */
import { describe, test, expect } from "bun:test";
import {
  handleReviewAndMergePr,
  type GhRunner,
  type GhRunResult,
} from "../lib/dispatch/github.ts";

const ORCH = { agentKey: "orchestrator", chatId: -1 };

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

/** 100 безобидных путей — ровно столько, сколько отдаёт gh. */
const page = Array.from({ length: 100 }, (_, i) => ({ path: `docs/note-${i}.md` }));

const didMerge = (calls: string[][]) =>
  calls.some((c) => c[0] === "pr" && c[1] === "merge");

describe("REVIEW_AND_MERGE_PR: усечённый список файлов", () => {
  test("120 файлов, видно 100 — мерж не происходит", async () => {
    const { runGh, calls } = fakeGh({
      "pr view": {
        stdout: JSON.stringify({
          state: "OPEN",
          mergeable: "MERGEABLE",
          changedFiles: 120,
          files: page,
        }),
      },
    });
    const res = await handleReviewAndMergePr({ pr_number: 7 }, ORCH, { runGh, authority: "approved-action" });

    expect(didMerge(calls)).toBe(false);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.checks_passed).toBe(false);
    expect(String(res.result.message)).toContain("120");
    expect(String(res.result.message)).toContain("100");
  });

  test("причина усечения доезжает в комментарий к PR, а не только в лог", async () => {
    const { runGh, calls } = fakeGh({
      "pr view": {
        stdout: JSON.stringify({
          state: "OPEN",
          mergeable: "MERGEABLE",
          changedFiles: 101,
          files: page,
        }),
      },
    });
    await handleReviewAndMergePr({ pr_number: 8 }, ORCH, { runGh, authority: "approved-action" });

    const body = calls.find((c) => c[1] === "comment")?.at(-1) ?? "";
    expect(body).toContain("Validation Failed");
    expect(body).toContain("101");
  });

  test("ровно 100 файлов и changedFiles=100 — не ложное срабатывание", async () => {
    const { runGh, calls } = fakeGh({
      "pr view": {
        stdout: JSON.stringify({
          state: "OPEN",
          mergeable: "MERGEABLE",
          changedFiles: 100,
          files: page,
        }),
      },
    });
    const res = await handleReviewAndMergePr({ pr_number: 9 }, ORCH, { runGh, authority: "approved-action" });
    expect(didMerge(calls)).toBe(true);
    expect(res.ok).toBe(true);
  });

  test("старый gh без changedFiles не ломает поведение", async () => {
    // Поле могло не приехать (старая версия gh) — тогда проверять нечего,
    // и падать на этом нельзя: чеклист работает как раньше.
    const { runGh, calls } = fakeGh({
      "pr view": {
        stdout: JSON.stringify({
          state: "OPEN",
          mergeable: "MERGEABLE",
          files: [{ path: "docs/readme.md" }],
        }),
      },
    });
    const res = await handleReviewAndMergePr({ pr_number: 10 }, ORCH, { runGh, authority: "approved-action" });
    expect(didMerge(calls)).toBe(true);
    expect(res.ok).toBe(true);
  });

  test("changedFiles запрашивается у gh — иначе усечение необнаружимо", async () => {
    const { runGh, calls } = fakeGh({
      "pr view": {
        stdout: JSON.stringify({ state: "OPEN", mergeable: "MERGEABLE", files: [] }),
      },
    });
    await handleReviewAndMergePr({ pr_number: 11 }, ORCH, { runGh, authority: "approved-action" });
    const viewArgs = calls.find((c) => c[1] === "view") ?? [];
    expect(viewArgs.join(" ")).toContain("changedFiles");
  });
});

describe("REVIEW_AND_MERGE_PR: risky-PR без комментария не отчитывается успехом", () => {
  test("провал comment на risky-пути виден в результате", async () => {
    const { runGh } = fakeGh({
      "pr view": {
        stdout: JSON.stringify({
          state: "OPEN",
          mergeable: "MERGEABLE",
          changedFiles: 1,
          files: [{ path: "agent/lib/handoff.ts" }],
        }),
      },
      "pr comment": { exitCode: 1, stderr: "403" },
    });
    const res = await handleReviewAndMergePr({ pr_number: 12 }, ORCH, { runGh, authority: "approved-action" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Комментарий — единственный след «PR ждёт человека». Соврать тут нельзя.
    expect(res.result.action).toBe("comment_failed");
  });
});
