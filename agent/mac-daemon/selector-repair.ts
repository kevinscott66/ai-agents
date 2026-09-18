/**
 * Починка селекторов на Mac (этап 4 автономии): кадр `repair` {service, code}.
 *
 * Порядок:
 *  1. SELECTOR_REPAIR_REPO — клон репозитория внутри MAC_PROJECT_ROOTS; нет —
 *     repair_disabled.
 *  2. Замок покупок (holdShopRunner): браузер исполнителя закрыт, покупки ждут.
 *  3. Свежая ветка от origin/main в отдельной рабочей копии, bun install.
 *  4. selfcheck до правки — для тела PR.
 *  5. `claude --print` с неизменяемым заданием (lib/selector-repair.ts):
 *     правка в рабочей копии, из команд — только selfcheck, bun test и tsc.
 *  6. Демон сам смотрит `git status`: пусто — repair_no_change; есть путь вне
 *     файлов вёрстки и тестов — repair_forbidden_paths, ничего не коммитится.
 *  7. selfcheck после, коммит названных путей, пуш ветки, PR в main.
 *
 * Мержа нет и не будет: PR ждёт владельца. Рабочая копия остаётся на диске —
 * удаление за владельцем. Ответ — одна строка JSON (RepairOutcome).
 *
 * Про запуск кода: починщик правит *-playwright.ts и тесты и сам же их
 * запускает (selfcheck, bun test) — это исполнение написанного им кода на
 * Mac. Вход у него только наш неизменяемый текст и инвентарь selfcheck, где
 * каждое значение прошло SAFE_ATTR (латинский идентификатор до 60 символов),
 * так что чужой текст со страницы Яндекса до него не доходит.
 */
import { join } from "node:path";
import {
  buildRepairPrompt,
  isRepairablePath,
  repairAllowedTools,
  repairBranchName,
  repairDisallowedTools,
  repairPrBody,
  emptySelectors,
  REPAIR_SERVICE_LABEL,
  type RepairOutcome,
  type RepairRequest,
  type SelfcheckSummary,
} from "../lib/selector-repair.ts";

export interface CmdResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RepairDeps {
  /** SELECTOR_REPAIR_REPO, уже проверенный по MAC_PROJECT_ROOTS; null — выключено. */
  repo: string | null;
  claudeBin: string;
  hold: () => Promise<(() => void) | null>;
  /** Команда без шелла, argv как есть; cwd — абсолютный путь. */
  runCmd: (argv: string[], cwd: string, timeoutMs: number) => Promise<CmdResult>;
  /** Прогон починщика: промпт на stdin, вывод уходит мосту чанками. */
  runClaude: (argv: string[], cwd: string, prompt: string, timeoutMs: number) => Promise<CmdResult>;
  now: () => Date;
  log: (line: string) => void;
}

export const REPAIR_SETUP_TIMEOUT_MS = 5 * 60_000;
export const REPAIR_SELFCHECK_TIMEOUT_MS = 2 * 60_000;
export const REPAIR_CLAUDE_TIMEOUT_MS = 25 * 60_000;
export const REPAIR_GIT_TIMEOUT_MS = 2 * 60_000;

/** Команда починщика: acceptEdits для правки в рабочей копии и явный список команд. */
export function repairClaudeCommand(claudeBin: string): string[] {
  return [
    claudeBin,
    "--print",
    "--permission-mode", "acceptEdits",
    "--allowedTools", repairAllowedTools().join(","),
    "--disallowedTools", repairDisallowedTools().join(","),
  ];
}

/** `git status --porcelain` → пути; у переименования — оба. */
export function changedPaths(porcelain: string): string[] {
  const out: string[] = [];
  for (const line of porcelain.split("\n")) {
    if (line.length < 4) continue;
    for (const p of line.slice(3).split(" -> ")) out.push(p.replace(/^"|"$/g, ""));
  }
  return [...new Set(out)];
}

/** JSON selfcheck → то, что нужно PR: статус и счётчики. Кривой вывод — null. */
export function parseSelfcheck(stdout: string): SelfcheckSummary | null {
  const line = stdout.trim().split("\n").pop() ?? "";
  try {
    const v = JSON.parse(line) as { status?: unknown; selectors?: unknown };
    if (typeof v.status !== "string" || typeof v.selectors !== "object" || v.selectors === null) return null;
    const selectors: Record<string, number> = {};
    for (const [k, n] of Object.entries(v.selectors as Record<string, unknown>)) if (typeof n === "number") selectors[k] = n;
    return { status: v.status, selectors };
  } catch {
    return null;
  }
}

const tail = (s: string) => s.trim().slice(-300);

export async function runSelectorRepair(req: RepairRequest, deps: RepairDeps): Promise<RepairOutcome> {
  if (!deps.repo) return { ok: false, code: "repair_disabled" };
  const release = await deps.hold();
  if (!release) return { ok: false, code: "repair_busy" };
  const repo = deps.repo;
  const branch = repairBranchName(req.service, deps.now());
  const wt = join(repo, ".claude", "worktrees", branch.replace(/^claude\//, ""));
  const agent = join(wt, "agent");
  const step = async (argv: string[], cwd: string, timeoutMs: number) => {
    const r = await deps.runCmd(argv, cwd, timeoutMs);
    deps.log(`[repair] ${argv.slice(0, 3).join(" ")} → ${r.code}`);
    return r;
  };
  try {
    deps.log(`[repair] ${deps.now().toISOString()} ${req.service} ${req.code} start branch=${branch}`);
    const setup: Array<[string[], string]> = [
      [["git", "fetch", "origin", "main"], repo],
      [["git", "worktree", "add", "-b", branch, wt, "origin/main"], repo],
      [["bun", "install", "--frozen-lockfile"], agent],
      [["bun", "install", "--frozen-lockfile"], join(agent, "mac-daemon")],
    ];
    for (const [argv, cwd] of setup) {
      const r = await step(argv, cwd, REPAIR_SETUP_TIMEOUT_MS);
      if (r.code !== 0) return { ok: false, code: "repair_setup_failed", branch, detail: `${argv.slice(0, 2).join(" ")}: ${tail(r.stderr)}` };
    }
    const selfcheck = ["bun", "mac-daemon/shop.ts", "selfcheck", ...(req.service === "lavka" ? [] : [req.service])];
    const before = parseSelfcheck((await step(selfcheck, agent, REPAIR_SELFCHECK_TIMEOUT_MS)).stdout);

    const run = await deps.runClaude(repairClaudeCommand(deps.claudeBin), agent, buildRepairPrompt(req), REPAIR_CLAUDE_TIMEOUT_MS);
    deps.log(`[repair] claude → ${run.code}`);
    if (run.code !== 0) return { ok: false, code: "repair_run_failed", branch, detail: tail(run.stderr) };

    const status = await step(["git", "status", "--porcelain", "--untracked-files=all"], wt, REPAIR_GIT_TIMEOUT_MS);
    if (status.code !== 0) return { ok: false, code: "repair_setup_failed", branch, detail: `git status: ${tail(status.stderr)}` };
    const changed = changedPaths(status.stdout);
    if (!changed.length) return { ok: false, code: "repair_no_change", branch };
    if (changed.some((p) => !isRepairablePath(p))) return { ok: false, code: "repair_forbidden_paths", branch, changed };

    const after = parseSelfcheck((await step(selfcheck, agent, REPAIR_SELFCHECK_TIMEOUT_MS)).stdout);
    const title = `fix(shop): селекторы ${REPAIR_SERVICE_LABEL[req.service]} после смены вёрстки`;
    const publish: string[][] = [
      ["git", "add", "--", ...changed],
      ["git", "commit", "-m", `${title}\n\nАвтопочинка по ${req.code} (этап 4 автономии).`],
      ["git", "push", "-u", "origin", branch],
    ];
    for (const argv of publish) {
      const r = await step(argv, wt, REPAIR_GIT_TIMEOUT_MS);
      if (r.code !== 0) return { ok: false, code: "repair_push_failed", branch, changed, detail: `${argv.slice(0, 2).join(" ")}: ${tail(r.stderr)}` };
    }
    const pr = await step(
      ["gh", "pr", "create", "--base", "main", "--head", branch, "--title", title, "--body", repairPrBody(req, changed, before, after)],
      wt,
      REPAIR_GIT_TIMEOUT_MS,
    );
    const url = pr.stdout.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/)?.[0];
    if (pr.code !== 0 || !url) return { ok: false, code: "repair_push_failed", branch, changed, detail: `gh pr create: ${tail(pr.stderr)}` };
    deps.log(`[repair] ${deps.now().toISOString()} ${req.service} ok ${url}`);
    return { ok: true, branch, pr_url: url, changed, empty_before: emptySelectors(before), empty_after: emptySelectors(after) };
  } catch (e) {
    return { ok: false, code: "repair_setup_failed", branch, detail: e instanceof Error ? e.message : String(e) };
  } finally {
    release();
  }
}
