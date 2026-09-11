/**
 * Аудит 2026-08-21: блокирующие метки сравнивались точным именем, а метка,
 * которой автономный цикл помечает КАЖДЫЙ свой PR, называется длиннее.
 *
 * Автономный цикл (`deploy/vps-autonomous/autonomous-cycle.sh`, шаг
 * `gh pr edit --add-label`) вешает на каждый свой PR `needs-human-review`;
 * заводит саму метку `gh label create` там же. Прежде эту роль играл
 * deploy/agents-loop.sh — имя без кавычек, потому что скрипта как рабочего
 * пути больше нет: сегодня это десятистрочное надгробие с `exit 1`. Гейт же держал
 * `new Set(["hold","risky","needs-human","do-not-merge"])` и спрашивал `.has()`:
 * `has("needs-human-review")` — false. Замер до правки, docs-only PR в белом
 * списке путей:
 *
 *   метка "needs-human"        -> pr merge вызван: false  action=skipped
 *   метка "needs-human-review" -> pr merge вызван: true   action=merged
 *
 * То есть единственная метка, которая в этом репо реально ставится, гейт не
 * останавливала: `gh pr merge --squash --delete-branch` в main, необратимо и
 * без человека. Из main идёт прод-деплой.
 *
 * Ровно эту ошибку уже находили и чинили на ВТОРОМ автомерже 2026-08-12:
 * `.github/scripts/automerge-filter.sh` сравнивает через
 * `startswith("needs-human")`, и в его шапке записан замер — «24 PR прошли бы
 * фильтр, и все 24 помечены needs-human-review». В TypeScript-копию правку не
 * перенесли, а комментарий над набором продолжал обещать, что «у двух
 * автомержей один список».
 *
 * Поэтому тест ниже не переписывает список литералов в третий раз, а берёт имя
 * метки из того файла, который её и ставит: разъедься они снова — тест
 * покраснеет на самом расхождении, а не на его следствии.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { handleReviewAndMergePr } from "../lib/dispatch/github.ts";
import type { GhRunner, GhRunResult } from "../lib/dispatch/github.ts";

const CTX = { agentKey: "orchestrator", chatId: 0 };
const REPO_ROOT = new URL("../../", import.meta.url).pathname;

/** Docs-only PR: зелёный, в белом списке путей, готов к автомержу. */
function fakeGh(labels: string[]): { runGh: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runGh: GhRunner = async (args): Promise<GhRunResult> => {
    calls.push(args);
    const key = `${args[0]} ${args[1]}`;
    if (key === "pr view") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          state: "OPEN",
          mergeable: "MERGEABLE",
          changedFiles: 1,
          files: [{ path: "docs/plan.md" }],
          labels: labels.map((name) => ({ name })),
        }),
        stderr: "",
      };
    }
    if (key === "pr merge") return { exitCode: 0, stdout: "merged abc1234", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return { runGh, calls };
}

async function mergeAttempted(labels: string[]): Promise<boolean> {
  const { runGh, calls } = fakeGh(labels);
  await handleReviewAndMergePr({ pr_number: 350 }, CTX, { runGh, authority: "approved-action" });
  return calls.some((c) => `${c[0]} ${c[1]}` === "pr merge");
}

/** Метки, которыми автономный цикл помечает свои PR, — прямо из его скриптов. */
function labelsStampedByLoop(): string[] {
  const out = new Set<string>();
  for (const rel of ["deploy/agents-loop.sh", "deploy/vps-autonomous/autonomous-cycle.sh"]) {
    const src = readFileSync(`${REPO_ROOT}${rel}`, "utf8");
    for (const m of src.matchAll(/--label[= ]+([A-Za-z0-9._-]+)/g)) out.add(m[1]!);
  }
  return [...out];
}

describe("метка автономного цикла останавливает автомерж", () => {
  test("скрипты цикла действительно ставят метку", () => {
    const found = labelsStampedByLoop();
    expect(found.length).toBeGreaterThan(0);
    expect(found).toContain("needs-human-review");
  });

  test.each(labelsStampedByLoop())("метка %s не вливается", async (label) => {
    expect(await mergeAttempted([label])).toBe(false);
  });

  test("метка блокирует и в другом регистре", async () => {
    expect(await mergeAttempted(["Needs-Human-Review"])).toBe(false);
  });

  test("блокирует, даже если рядом стоят безобидные метки", async () => {
    expect(await mergeAttempted(["documentation", "needs-human-review"])).toBe(false);
  });
});

describe("контроль: прежнее поведение не поехало", () => {
  test.each(["hold", "risky", "needs-human", "do-not-merge"])(
    "метка %s по-прежнему не вливается",
    async (label) => {
      expect(await mergeAttempted([label])).toBe(false);
    },
  );

  test("безобидная метка не мешает мержу", async () => {
    expect(await mergeAttempted(["documentation"])).toBe(true);
  });

  test("PR без меток вливается", async () => {
    expect(await mergeAttempted([])).toBe(true);
  });
});
