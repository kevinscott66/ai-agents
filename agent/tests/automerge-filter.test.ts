/**
 * Аудит 2026-08-12: auto-merge вливал в main ровно то, что обещал не вливать.
 *
 * Замер на живом списке открытых PR (`gh pr list --state open --base main
 * --limit 40`, 2026-08-12), прогнанном через тогдашнюю логику воркфлоу
 * дословно: **24 PR из 40 прошли фильтр и были бы смёрджены сквошем в main**.
 * Все 24 — с меткой `needs-human-review` и в состоянии UNSTABLE, где
 * «Test suite baseline floor (>=670 pass)» = FAILURE (проверено на #360, #353,
 * #342).
 *
 * Две независимые причины:
 *
 * 1) Метки склеивались в строку и проверялись как
 *    `grep -qE ',(hold|risky|needs-human|do-not-merge),'`. Метка в репо
 *    называется `needs-human-review` — ',needs-human-review,' не совпадает с
 *    ',needs-human,' никогда. Метка, существующая ровно для того, чтобы позвать
 *    человека, не блокировала ни одного мёрджа.
 *
 * 2) CI-гейта не было вообще, хотя шапка auto-merge.yml обещала «CI зелёный
 *    (если есть checks)». Единственной проверкой был mergeStateStatus, а
 *    BLOCKED выставляется только при branch protection — на приватном репо
 *    free-плана её нет (GET /repos/.../branches/main/protection → 403
 *    «Upgrade to GitHub Pro»). Красный CI даёт UNSTABLE, который проходил.
 *
 * Заодно закрыты два fail-open края: пустой список файлов трактовался как «все
 * файлы безопасны» (UNSAFE так и оставался 0), а список из 100 файлов — это
 * страничный лимит gh, то есть возможная обрезка, по которой судьбу мёрджа
 * решать нельзя.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const SCRIPT = join(
  import.meta.dir,
  "..",
  "..",
  ".github",
  "scripts",
  "automerge-filter.sh",
);

interface PrFixture {
  number: number;
  headRefName?: string;
  author?: { login: string } | null;
  isCrossRepository?: boolean;
  isDraft?: boolean;
  mergeable?: string;
  mergeStateStatus?: string;
  labels?: { name: string }[];
  files?: { path: string }[];
  statusCheckRollup?: Record<string, unknown>[];
}

function pr(over: Partial<PrFixture> & { number: number }): PrFixture {
  return {
    headRefName: `agent/pr-${over.number}`,
    // Аудит 2026-08-29: фильтр требует автора из аллоу-листа и не-форк.
    // Отсутствие полей — это «неизвестный автор», а не «автор не важен».
    author: { login: "kevinscott66" },
    isCrossRepository: false,
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    labels: [],
    files: [{ path: "docs/README.md" }],
    statusCheckRollup: [{ name: "checks", conclusion: "SUCCESS" }],
    ...over,
  };
}

function run(prs: PrFixture[]): string[] {
  const p = Bun.spawnSync(["bash", SCRIPT], {
    stdin: Buffer.from(JSON.stringify(prs)),
  });
  const err = p.stderr.toString().trim();
  expect({ code: p.exitCode, err }).toEqual({ code: 0, err: "" });
  return p.stdout
    .toString()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Каждое утверждение здесь спавнит `bash` с боевым скриптом фильтра — это не
 * юнит, а прогон настоящего кода воркфлоу, и подменять его нечем. В одиночку
 * файл проходит за ~19 с, но под полным `bun test` (≈390 файлов) спавн дорожает
 * настолько, что тест из семи проверок упирался в дефолтные 5000 мс и падал по
 * таймауту — зелёный поодиночке, красный в общем прогоне. Запас, а не
 * ускорение: считать спавн процесса быстрым мы не вправе.
 */
const SPAWN_TIMEOUT_MS = 60_000;
const slowTest = (name: string, fn: () => void) =>
  test(name, fn, SPAWN_TIMEOUT_MS);

function decision(prs: PrFixture[]): string {
  const out = run(prs);
  expect(out).toHaveLength(1);
  return out[0]!;
}

describe("блокирующие метки", () => {
  slowTest("needs-human-review блокирует (боевой случай: 24 PR)", () => {
    expect(
      decision([pr({ number: 360, labels: [{ name: "needs-human-review" }] })]),
    ).toBe("SKIP 360 blocking_label:needs-human-review");
  });

  slowTest("любое имя из семейства needs-human* блокирует", () => {
    for (const name of ["needs-human", "needs-human-review", "needs-humans"]) {
      expect(decision([pr({ number: 1, labels: [{ name }] })])).toContain(
        "blocking_label",
      );
    }
  });

  slowTest("hold / risky / do-not-merge блокируют", () => {
    for (const name of ["hold", "risky", "do-not-merge"]) {
      expect(decision([pr({ number: 2, labels: [{ name }] })])).toBe(
        `SKIP 2 blocking_label:${name}`,
      );
    }
  });

  slowTest("метка, лишь СОДЕРЖАЩАЯ блокирующее слово, не блокирует", () => {
    // 'not-risky' и 'on-hold-discussion' — не команды воркфлоу.
    for (const name of ["not-risky", "unhold", "merge-do-not-merge-later"]) {
      expect(decision([pr({ number: 3, labels: [{ name }] })])).toBe(
        "MERGE 3 agent/pr-3",
      );
    }
  });

  slowTest("безобидные метки не мешают", () => {
    expect(
      decision([
        pr({ number: 4, labels: [{ name: "docs" }, { name: "test" }] }),
      ]),
    ).toBe("MERGE 4 agent/pr-4");
  });
});

describe("CI-гейт", () => {
  slowTest("красный тест-джоб останавливает мёрдж", () => {
    expect(
      decision([
        pr({
          number: 5,
          mergeStateStatus: "UNSTABLE",
          statusCheckRollup: [
            { name: "Backend typecheck (tsc --noEmit)", conclusion: "SUCCESS" },
            { name: "No committed conflict markers", conclusion: "SUCCESS" },
            {
              name: "Test suite baseline floor (>=670 pass)",
              conclusion: "FAILURE",
            },
          ],
        }),
      ]),
    ).toBe(
      "SKIP 5 ci_not_green:Test suite baseline floor (>=670 pass)=FAILURE",
    );
  });

  slowTest("ещё не доехавший CI — не зелёный (вернёмся следующим прогоном)", () => {
    for (const s of [
      { conclusion: null, status: "IN_PROGRESS" },
      { state: "PENDING" },
      { conclusion: "CANCELLED" },
      { conclusion: "TIMED_OUT" },
      { conclusion: "ACTION_REQUIRED" },
    ]) {
      expect(
        decision([
          pr({ number: 6, statusCheckRollup: [{ name: "checks", ...s }] }),
        ]),
      ).toContain("SKIP 6 ci_not_green:");
    }
  });

  slowTest("чеков нет вовсе — не мёрджим (fail-closed)", () => {
    expect(decision([pr({ number: 7, statusCheckRollup: [] })])).toBe(
      "SKIP 7 no_checks",
    );
    const noField = pr({ number: 8 });
    delete noField.statusCheckRollup;
    expect(decision([noField])).toBe("SKIP 8 no_checks");
  });

  slowTest("SUCCESS/NEUTRAL/SKIPPED считаются зелёными", () => {
    expect(
      decision([
        pr({
          number: 9,
          statusCheckRollup: [
            { name: "a", conclusion: "SUCCESS" },
            { name: "b", conclusion: "NEUTRAL" },
            { name: "c", conclusion: "SKIPPED" },
            { context: "legacy-status", state: "SUCCESS" },
          ],
        }),
      ]),
    ).toBe("MERGE 9 agent/pr-9");
  });

  slowTest("регистр итога не важен", () => {
    expect(
      decision([
        pr({ number: 10, statusCheckRollup: [{ name: "a", state: "success" }] }),
      ]),
    ).toBe("MERGE 10 agent/pr-10");
  });
});

describe("список файлов", () => {
  slowTest("пустой список — это «неизвестно», а не «безопасно»", () => {
    expect(decision([pr({ number: 11, files: [] })])).toBe("SKIP 11 no_files");
  });

  slowTest("ровно страница gh (100 файлов) — считаем обрезанной", () => {
    const files = Array.from({ length: 100 }, (_, i) => ({
      path: `.claude/memory/notes/n${i}.md`,
    }));
    expect(decision([pr({ number: 12, files })])).toBe(
      "SKIP 12 file_list_truncated:100",
    );
  });

  slowTest("код и CI не проходят как безопасные пути", () => {
    for (const path of [
      "agent/lib/action-dispatch.ts",
      "agent/characters/smm.ts",
      ".github/workflows/deploy.yml",
      "CLAUDE.md",
      "AGENT.md",
      "package.json",
      "agent/miniapp/src/App.tsx",
    ]) {
      expect(decision([pr({ number: 13, files: [{ path }] })])).toBe(
        `SKIP 13 unsafe_paths:${path}`,
      );
    }
  });

  slowTest("память, статусы и task board требуют человека", () => {
    expect(
      decision([
        pr({
          number: 14,
          files: [
            { path: "docs/adr/0007.md" },
            { path: "README.md" },
            { path: ".github/workflows/README.md" },
          ],
        }),
      ]),
    ).toBe("MERGE 14 agent/pr-14");
    for (const [number, path] of [
      [141, ".claude/memory/notes/x.md"],
      [142, "TASKS.md"],
      [143, "STATUS.md"],
      [144, "WATCHDOG.md"],
    ] as const) {
      expect(decision([pr({ number, files: [{ path }] })])).toBe(
        `SKIP ${number} unsafe_paths:${path}`,
      );
    }
  });

  slowTest("один опасный файл среди безопасных блокирует весь PR", () => {
    expect(
      decision([
        pr({
          number: 15,
          files: [
            { path: "STATUS.md" },
            { path: "agent/lib/db.ts" },
            { path: "TASKS.md" },
          ],
        }),
      ]),
    ).toBe("SKIP 15 unsafe_paths:STATUS.md agent/lib/db.ts TASKS.md");
  });
});

describe("состояние PR", () => {
  slowTest("draft, не-mergeable, DIRTY и BLOCKED пропускаются", () => {
    expect(decision([pr({ number: 16, isDraft: true })])).toBe("SKIP 16 draft");
    expect(decision([pr({ number: 17, mergeable: "CONFLICTING" })])).toBe(
      "SKIP 17 not_mergeable:CONFLICTING",
    );
    expect(decision([pr({ number: 18, mergeable: "UNKNOWN" })])).toBe(
      "SKIP 18 not_mergeable:UNKNOWN",
    );
    expect(decision([pr({ number: 19, mergeStateStatus: "DIRTY" })])).toBe(
      "SKIP 19 merge_state:DIRTY",
    );
    expect(decision([pr({ number: 20, mergeStateStatus: "BLOCKED" })])).toBe(
      "SKIP 20 merge_state:BLOCKED",
    );
  });

  slowTest("UNSTABLE при зелёных чеках разрешён (branch protection недоступна)", () => {
    expect(decision([pr({ number: 21, mergeStateStatus: "UNSTABLE" })])).toBe(
      "MERGE 21 agent/pr-21",
    );
  });
});

describe("формат вывода", () => {
  slowTest("несколько PR — по строке на каждый, порядок сохраняется", () => {
    const out = run([
      pr({ number: 30 }),
      pr({ number: 31, labels: [{ name: "needs-human-review" }] }),
      pr({ number: 32, files: [{ path: "agent/lib/x.ts" }] }),
    ]);
    expect(out).toEqual([
      "MERGE 30 agent/pr-30",
      "SKIP 31 blocking_label:needs-human-review",
      "SKIP 32 unsafe_paths:agent/lib/x.ts",
    ]);
  });

  slowTest("пустой список PR — пустой вывод, код 0", () => {
    expect(run([])).toEqual([]);
    const p = Bun.spawnSync(["bash", SCRIPT], { stdin: Buffer.from("") });
    expect(p.exitCode).toBe(0);
    expect(p.stdout.toString().trim()).toBe("");
  });
});
