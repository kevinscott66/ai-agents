/**
 * Аудит 2026-08-12: оркестраторский автомерж не спрашивал ни про draft, ни про метки.
 *
 * Автомержа в репозитории тогда было два, и они обязаны были решать одинаково
 * — это стояло в шапке воркфлоу auto-merge.yml («То же правило продублировано
 * в isRiskyPath()»). Воркфлоу отсекал PR по четырём сигналам человека:
 *
 *   if [ "$DRAFT" = "true" ]; then echo "  SKIP: draft"; continue; fi
 *   if echo ",$LABELS," | grep -qE ',(hold|risky|needs-human|do-not-merge),'; then
 *     echo "  SKIP: blocking label"; continue
 *   fi
 *
 * Второй путь — `handleReviewAndMergePr`, его гоняет control-loop (`--mode review`).
 * С публичного релиза 2026-09-01 он единственный: воркфлоу удалён, его `case`
 * уцелел в .github/scripts/automerge-filter.sh как файл политики и не
 * вызывается ничем (tests/audit-2026-09-11-automerge-single-path.test.ts).
 * Поэтому находка ниже перестала быть расхождением двух мержеров и стала
 * единственным ответом системы на метку `hold`.
 * Замер на PR, который человек пометил `hold` и оставил черновиком, а трогает он
 * один docs/plan.md:
 *
 *   outcome: {"ok":true,"result":{"action":"merged","pr_number":350,…}}
 *   gh pr view 350 --repo … --json files,state,mergeable,changedFiles
 *   gh pr checks 350 --repo … --required
 *   gh pr merge 350 --repo … --squash --delete-branch
 *   isDraft спрошен: false
 *   labels спрошены: false
 *   merge выполнен: true
 *
 * Полей isDraft/labels нет в запросе, то есть вопрос не задавался вовсе. Метка
 * `hold` — единственный способ человека сказать «этот PR не вливать», не закрывая
 * его; один из двух мержеров её соблюдал, второй о ней не знал. Squash в main
 * необратим.
 *
 * Инвариант: оба сигнала человека (draft, блокирующая метка) останавливают
 * оркестраторский автомерж — молча, без комментария в PR и без лишних вызовов gh.
 */
import { describe, test, expect } from "bun:test";
import { handleReviewAndMergePr } from "../lib/dispatch/github.ts";
import { runReviewMode } from "../orchestrator/review-mode.ts";
import type { GhRunner, GhRunResult } from "../lib/dispatch/github.ts";

const CTX = { agentKey: "orchestrator", chatId: 0 };

interface PrView {
  files?: { path: string }[];
  state?: string;
  mergeable?: string;
  changedFiles?: number;
  isDraft?: boolean;
  labels?: { name: string }[];
}

/** Чистый docs-only PR: зелёный, в белом списке путей, готов к автомержу. */
function safePr(extra: PrView = {}): PrView {
  return {
    state: "OPEN",
    mergeable: "MERGEABLE",
    changedFiles: 1,
    files: [{ path: "docs/plan.md" }],
    ...extra,
  };
}

/** Фейковый gh: отдаёт заданный PR, зелёные чеки и успешный мёрж, пишет вызовы. */
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

const did = (calls: string[][], sub: string) =>
  calls.some((c) => `${c[0]} ${c[1]}` === sub);

describe("замер из шапки", () => {
  test("pr view спрашивает draft-статус и метки", async () => {
    const { runGh, calls } = fakeGh(safePr());
    await handleReviewAndMergePr({ pr_number: 350 }, CTX, { runGh, authority: "approved-action" });
    const fields = calls.find((c) => `${c[0]} ${c[1]}` === "pr view")?.at(-1) ?? "";
    expect(fields).toContain("isDraft");
    expect(fields).toContain("labels");
  });
});

describe("сигналы человека останавливают автомерж", () => {
  test("черновик не вливается", async () => {
    const { runGh, calls } = fakeGh(safePr({ isDraft: true }));
    const res = await handleReviewAndMergePr({ pr_number: 350 }, CTX, { runGh, authority: "approved-action" });
    expect(did(calls, "pr merge")).toBe(false);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result.action).toBe("skipped");
  });

  test.each(["hold", "risky", "needs-human", "do-not-merge"])(
    "метка %s не вливается",
    async (label) => {
      const { runGh, calls } = fakeGh(safePr({ labels: [{ name: label }] }));
      const res = await handleReviewAndMergePr({ pr_number: 350 }, CTX, { runGh, authority: "approved-action" });
      expect(did(calls, "pr merge")).toBe(false);
      // Без этой строки падение инструмента неотличимо от «метка заблокировала»:
      // мёржа нет в обоих случаях, а сообщение проверялось только при res.ok.
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.result.message).toContain(label);
    },
  );

  test("регистр метки не важен", async () => {
    const { runGh, calls } = fakeGh(safePr({ labels: [{ name: "Needs-Human" }] }));
    await handleReviewAndMergePr({ pr_number: 350 }, CTX, { runGh, authority: "approved-action" });
    expect(did(calls, "pr merge")).toBe(false);
  });

  test("заблокированный PR не получает комментария и лишних вызовов gh", async () => {
    const { runGh, calls } = fakeGh(safePr({ labels: [{ name: "hold" }] }));
    await handleReviewAndMergePr({ pr_number: 350 }, CTX, { runGh, authority: "approved-action" });
    // Комментарий на каждом проходе цикла — это шум в PR, который человек уже
    // осознанно придержал.
    expect(did(calls, "pr comment")).toBe(false);
    // Отказ виден из первого же ответа: гонять чеки незачем.
    expect(did(calls, "pr checks")).toBe(false);
  });
});

describe("не переусердствовали", () => {
  test("посторонняя метка мёржу не мешает", async () => {
    const { runGh, calls } = fakeGh(safePr({ labels: [{ name: "docs" }] }));
    const res = await handleReviewAndMergePr({ pr_number: 350 }, CTX, { runGh, authority: "approved-action" });
    expect(did(calls, "pr merge")).toBe(true);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result.action).toBe("merged");
  });

  test("PR без меток и без флага draft вливается как раньше", async () => {
    const { runGh, calls } = fakeGh(safePr());
    const res = await handleReviewAndMergePr({ pr_number: 350 }, CTX, { runGh, authority: "approved-action" });
    expect(did(calls, "pr merge")).toBe(true);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result.action).toBe("merged");
  });
});

describe("проход control-loop", () => {
  test("из трёх PR ни один не вливается без human approval", async () => {
    const views: Record<string, PrView> = {
      "1": safePr({ isDraft: true }),
      "2": safePr({ labels: [{ name: "hold" }] }),
      "3": safePr(),
    };
    const merged: number[] = [];
    const runGh: GhRunner = async (args): Promise<GhRunResult> => {
      const key = `${args[0]} ${args[1]}`;
      if (key === "pr list") {
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify(
            [1, 2, 3].map((number) => ({
              number,
              updatedAt: "2026-08-12T11:59:00Z",
              headRefName: `agent/review-${number}`,
            })),
          ),
        };
      }
      if (key === "pr view") {
        return { exitCode: 0, stderr: "", stdout: JSON.stringify(views[args[2]!]) };
      }
      if (key === "pr merge") {
        merged.push(Number(args[2]));
        return { exitCode: 0, stdout: "merged abc1234", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const res = await runReviewMode({
      runGh,
      now: () => Date.parse("2026-08-12T12:00:00Z"),
    });
    expect(res.scanned).toBe(3);
    expect(merged).toEqual([]);
  });
});
