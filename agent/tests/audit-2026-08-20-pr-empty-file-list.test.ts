/**
 * Аудит 2026-08-20: REVIEW_AND_MERGE_PR считал пустой список файлов
 * доказательством безопасности.
 *
 * Весь чеклист строится на `filesChanged`: и поиск артефактов сборки, и
 * `filesChanged.some(isRiskyPath)`. На пустом массиве обе проверки отвечают
 * «чисто» — `[].some(...)` это false, — и PR уходит в `gh pr merge --squash`
 * прямо в main. То есть автомерж по диффу, который код не видел вообще.
 *
 * Гейт по усечению (аудит 2026-08-08) сюда не дотягивается: он сравнивает
 * `filesChanged.length < changedFiles` и молчит, когда `changedFiles` не приехал
 * (старый gh, урезанный JSON) или равен нулю.
 *
 * Соседний путь автомержа это правило уже знает: `.github/workflows` отдаёт
 * `SKIP <n> no_files` с формулировкой «пустой список — это «неизвестно», а не
 * «безопасно»» (tests/automerge-filter.test.ts). Шапка dispatch/github.ts
 * утверждает, что оба пути согласованы; по этому пункту не были.
 */
import { describe, test, expect } from "bun:test";
import {
  handleReviewAndMergePr,
  type GhRunner,
  type GhRunResult,
} from "../lib/dispatch/github.ts";
import { TRUSTED_PR_IDENTITY } from "./helpers/pr-view-fixture.ts";

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

const didMerge = (calls: string[][]) =>
  calls.some((c) => c[0] === "pr" && c[1] === "merge");

const commentBody = (calls: string[][]) =>
  calls.find((c) => c[1] === "comment")?.at(-1) ?? "";

describe("REVIEW_AND_MERGE_PR: пустой список файлов — «неизвестно», а не «безопасно»", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["files:[] и changedFiles отсутствует", { files: [] }],
    ["files:[] и changedFiles:0", { files: [], changedFiles: 0 }],
    ["поле files вообще не приехало", {}],
    ["files:[] при changedFiles:1 (уже ловилось усечением)", { files: [], changedFiles: 1 }],
  ];

  for (const [name, extra] of cases) {
    test(`${name} — мержа нет`, async () => {
      const { runGh, calls } = fakeGh({
        "pr view": {
          stdout: JSON.stringify({ ...TRUSTED_PR_IDENTITY, state: "OPEN", mergeable: "MERGEABLE", ...extra }),
        },
      });
      const res = await handleReviewAndMergePr({ pr_number: 101 }, ORCH, { runGh, authority: "approved-action" });

      expect(didMerge(calls)).toBe(false);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.result.checks_passed).toBe(false);
    });
  }

  test("причина доезжает до PR комментарием, а не теряется в результате", async () => {
    const { runGh, calls } = fakeGh({
      "pr view": {
        stdout: JSON.stringify({ ...TRUSTED_PR_IDENTITY, state: "OPEN", mergeable: "MERGEABLE", files: [] }),
      },
    });
    const res = await handleReviewAndMergePr({ pr_number: 102 }, ORCH, { runGh, authority: "approved-action" });

    const body = commentBody(calls);
    expect(body).toContain("Validation Failed");
    // Текст обязан объяснять, почему отказ: «0 файлов» само по себе выглядит
    // как «PR пустой», а причина — «список файлов не получен».
    expect(body.toLowerCase()).toContain("файл");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.action).toBe("commented");
  });

  test("непустой безопасный список по-прежнему мержится", async () => {
    const { runGh, calls } = fakeGh({
      "pr view": {
        stdout: JSON.stringify({
          ...TRUSTED_PR_IDENTITY,
          state: "OPEN",
          mergeable: "MERGEABLE",
          changedFiles: 1,
          files: [{ path: "docs/readme.md" }],
        }),
      },
    });
    const res = await handleReviewAndMergePr({ pr_number: 103 }, ORCH, { runGh, authority: "approved-action" });
    expect(didMerge(calls)).toBe(true);
    expect(res.ok).toBe(true);
  });

  test("закрытый PR отсекается раньше — новая проверка не перехватывает его причину", async () => {
    // t511 гоняет ровно такой ответ: state:MERGED, files:[]. Причиной отказа
    // должно остаться состояние PR, а не пустой список.
    const { runGh, calls } = fakeGh({
      "pr view": {
        stdout: JSON.stringify({ ...TRUSTED_PR_IDENTITY, state: "MERGED", mergeable: "UNKNOWN", files: [] }),
      },
    });
    const res = await handleReviewAndMergePr({ pr_number: 104 }, ORCH, { runGh, authority: "approved-action" });
    expect(didMerge(calls)).toBe(false);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(String(res.result.message)).toContain("not open");
  });

  test("черновик отсекается раньше — тоже без ложной причины", async () => {
    const { runGh, calls } = fakeGh({
      "pr view": {
        stdout: JSON.stringify({
          ...TRUSTED_PR_IDENTITY,
          state: "OPEN",
          mergeable: "MERGEABLE",
          isDraft: true,
          files: [],
        }),
      },
    });
    const res = await handleReviewAndMergePr({ pr_number: 105 }, ORCH, { runGh, authority: "approved-action" });
    expect(didMerge(calls)).toBe(false);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.action).toBe("skipped");
  });
});
