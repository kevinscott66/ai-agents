/**
 * T-513: unified agent CLI entry.
 *
 *   bun run agent                                  # launch the full multi-bot orchestrator
 *   bun run agent --role orchestrator --mode review  # one-shot control-loop PR review
 *
 * `--mode review` runs the review-only control loop (scan recent PRs → pre-push
 * checklist → comment) and exits; it never launches bots and therefore does
 * not require ANTHROPIC_API_KEY or any Telegram tokens. Any other mode
 * delegates to the normal orchestrator-team bootstrap.
 */
import { log } from "./lib/log.ts";
import { runReviewMode, formatReviewSummary, countReviewOutcomes } from "./orchestrator/review-mode.ts";

export interface AgentArgs {
  role?: string;
  mode?: string;
}

/** Minimal `--key value` / `--key=value` parser for the agent CLI. */
export function parseAgentArgs(argv: string[]): AgentArgs {
  const out: AgentArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    let key: string | undefined;
    let val: string | undefined;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        key = a.slice(2, eq);
        val = a.slice(eq + 1);
      } else {
        key = a.slice(2);
        // consume next token as value if it isn't another flag
        if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
          val = argv[++i];
        }
      }
    }
    if (key === "role") out.role = val;
    else if (key === "mode") out.mode = val;
  }
  return out;
}

async function run() {
  const args = parseAgentArgs(process.argv.slice(2));

  if (args.mode === "review") {
    log.info(`[control] review-mode pass (role=${args.role ?? "orchestrator"})`);
    const result = await runReviewMode();
    const summary = formatReviewSummary(result, new Date().toISOString());
    // Printed to stdout for the internal supervisor/status collector.
    console.log(summary);
    const tally = countReviewOutcomes(result.results);
    log.info(
      `[control] scanned ${result.scanned} PR(s): ` +
        `commented ${tally.reviewed}, skipped ${tally.skipped}, failed ${tally.failed}`,
    );
    // Fail-closed. `autonomous-cycle.sh:270-275` обещает: «если GitHub
    // недостижим — не начинать новую работу», и держится это на `set -e` вокруг
    // вызова. Но бросает только первый `gh pr list`; ошибки отдельных PR
    // ложатся в `outcome` и раньше всё равно давали exit 0 — истёкший PAT или
    // rate limit валили КАЖДЫЙ per-PR вызов, а цикл спокойно шёл брать
    // следующую задачу. Аудит 2026-08-28.
    //
    // Порог намеренно «упало всё»: одиночный PR может ломаться постоянно
    // (удалённая ветка, снесённый форк), и на exit-1 по нему цикл заклинило бы
    // навсегда. Провал ВСЕХ — это уже отказ самого GitHub, а не свойство
    // конкретного PR.
    const nothingWorked = tally.failed > 0 && tally.reviewed + tally.skipped === 0;
    if (nothingWorked) {
      log.error(`[control] все ${tally.failed} PR разбор уронил — выходим ненулевым кодом`);
    }
    process.exit(nothingWorked ? 1 : 0);
  }

  // Default: full orchestrator bootstrap. Imported lazily so review-mode never
  // pulls in the Anthropic client / Telegram tokens it doesn't need.
  const { main } = await import("./orchestrator-team.ts");
  await main();
}

if (import.meta.main) {
  run().catch((e) => {
    log.error("Fatal", { error: String(e) });
    process.exit(1);
  });
}
