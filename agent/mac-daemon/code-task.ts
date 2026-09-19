/**
 * Задача на код (самоулучшение, пункт 9): кадр `code_task` {title, goal}.
 *
 * Порядок:
 *  1. SELECTOR_REPAIR_REPO — тот же клон, что у починки селекторов, внутри
 *     MAC_PROJECT_ROOTS; нет — code_task_disabled.
 *  2. Одна задача за раз (свой флаг; замок покупок не нужен — браузер не трогаем).
 *  3. Свежая ветка от origin/main в отдельной рабочей копии, bun install.
 *  4. `claude --print` с рамкой из lib/code-task.ts и текстом, который владелец
 *     одобрил в карточке: правка в рабочей копии, из команд — bun test и tsc.
 *  5. Демон сам смотрит `git status`: пусто — code_task_no_change; хоть один
 *     путь вне isCodeTaskPath — code_task_forbidden_paths, ничего не коммитится.
 *  6. tsc после правки — для тела PR, коммит названных путей, пуш, PR в main.
 *
 * Мержа нет и не будет: PR ждёт владельца, CI прогоняет его как любой другой.
 * Рабочая копия остаётся на диске — удаление за владельцем. Ответ — одна
 * строка JSON (CodeTaskOutcome); вывод исполнителя мосту не уходит.
 */
import { join } from "node:path";
import {
  buildCodeTaskPrompt,
  codeTaskAllowedTools,
  codeTaskBranchName,
  codeTaskDisallowedTools,
  codeTaskPrBody,
  isCodeTaskPath,
  type CodeTask,
  type CodeTaskOutcome,
} from "../lib/code-task.ts";
import { changedPaths, type CmdResult } from "./selector-repair.ts";

export interface CodeTaskDeps {
  /** SELECTOR_REPAIR_REPO, уже проверенный по MAC_PROJECT_ROOTS; null — выключено. */
  repo: string | null;
  claudeBin: string;
  /** Команда без шелла, argv как есть; cwd — абсолютный путь. */
  runCmd: (argv: string[], cwd: string, timeoutMs: number) => Promise<CmdResult>;
  /** Прогон исполнителя: промпт на stdin. */
  runClaude: (argv: string[], cwd: string, prompt: string, timeoutMs: number) => Promise<CmdResult>;
  now: () => Date;
  log: (line: string) => void;
}

export const CODE_TASK_SETUP_TIMEOUT_MS = 5 * 60_000;
export const CODE_TASK_CLAUDE_TIMEOUT_MS = 35 * 60_000;
export const CODE_TASK_TSC_TIMEOUT_MS = 3 * 60_000;
export const CODE_TASK_GIT_TIMEOUT_MS = 2 * 60_000;

/** Команда исполнителя: acceptEdits для правки в рабочей копии и явный список команд. */
export function codeTaskClaudeCommand(claudeBin: string): string[] {
  return [
    claudeBin,
    "--print",
    "--permission-mode", "acceptEdits",
    "--allowedTools", codeTaskAllowedTools().join(","),
    "--disallowedTools", codeTaskDisallowedTools().join(","),
  ];
}

/** Заголовок коммита и PR: conventional-префикс и одобренный заголовок. */
export function codeTaskCommitTitle(t: CodeTask): string {
  return `feat(self): ${t.title}`;
}

let busy = false;

const tail = (s: string) => s.trim().slice(-300);

export async function runCodeTask(task: CodeTask, deps: CodeTaskDeps): Promise<CodeTaskOutcome> {
  if (!deps.repo) return { ok: false, code: "code_task_disabled" };
  if (busy) return { ok: false, code: "code_task_busy" };
  busy = true;
  const repo = deps.repo;
  const branch = codeTaskBranchName(deps.now());
  const wt = join(repo, ".claude", "worktrees", branch.replace(/^claude\//, ""));
  const agent = join(wt, "agent");
  const step = async (argv: string[], cwd: string, timeoutMs: number) => {
    const r = await deps.runCmd(argv, cwd, timeoutMs);
    deps.log(`[code-task] ${argv.slice(0, 3).join(" ")} → ${r.code}`);
    return r;
  };
  try {
    deps.log(`[code-task] ${deps.now().toISOString()} start branch=${branch}`);
    const setup: Array<[string[], string]> = [
      [["git", "fetch", "origin", "main"], repo],
      [["git", "worktree", "add", "-b", branch, wt, "origin/main"], repo],
      [["bun", "install", "--frozen-lockfile"], agent],
    ];
    for (const [argv, cwd] of setup) {
      const r = await step(argv, cwd, CODE_TASK_SETUP_TIMEOUT_MS);
      if (r.code !== 0) return { ok: false, code: "code_task_setup_failed", branch, detail: `${argv.slice(0, 2).join(" ")}: ${tail(r.stderr)}` };
    }

    const run = await deps.runClaude(codeTaskClaudeCommand(deps.claudeBin), wt, buildCodeTaskPrompt(task), CODE_TASK_CLAUDE_TIMEOUT_MS);
    deps.log(`[code-task] claude → ${run.code}`);
    if (run.code !== 0) return { ok: false, code: "code_task_run_failed", branch, detail: tail(run.stderr) };

    const status = await step(["git", "status", "--porcelain", "--untracked-files=all"], wt, CODE_TASK_GIT_TIMEOUT_MS);
    if (status.code !== 0) return { ok: false, code: "code_task_setup_failed", branch, detail: `git status: ${tail(status.stderr)}` };
    const changed = changedPaths(status.stdout);
    if (!changed.length) return { ok: false, code: "code_task_no_change", branch };
    const forbidden = changed.filter((p) => !isCodeTaskPath(p));
    if (forbidden.length) return { ok: false, code: "code_task_forbidden_paths", branch, changed: forbidden };

    const tsc = await step(["bunx", "tsc", "--noEmit", "-p", "agent"], wt, CODE_TASK_TSC_TIMEOUT_MS);
    const typecheckOk = tsc.code === 0;
    const title = codeTaskCommitTitle(task);
    const publish: string[][] = [
      ["git", "add", "--", ...changed],
      ["git", "commit", "-m", `${title}\n\nЗадача агента, одобренная владельцем (самоулучшение, пункт 9).`],
      ["git", "push", "-u", "origin", branch],
    ];
    for (const argv of publish) {
      const r = await step(argv, wt, CODE_TASK_GIT_TIMEOUT_MS);
      if (r.code !== 0) return { ok: false, code: "code_task_push_failed", branch, changed, detail: `${argv.slice(0, 2).join(" ")}: ${tail(r.stderr)}` };
    }
    const pr = await step(
      ["gh", "pr", "create", "--base", "main", "--head", branch, "--title", title, "--body", codeTaskPrBody(task, changed, typecheckOk)],
      wt,
      CODE_TASK_GIT_TIMEOUT_MS,
    );
    const url = pr.stdout.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/)?.[0];
    if (pr.code !== 0 || !url) return { ok: false, code: "code_task_push_failed", branch, changed, detail: `gh pr create: ${tail(pr.stderr)}` };
    deps.log(`[code-task] ${deps.now().toISOString()} ok ${url}`);
    return { ok: true, branch, pr_url: url, changed, typecheck_ok: typecheckOk };
  } catch (e) {
    return { ok: false, code: "code_task_setup_failed", branch, detail: e instanceof Error ? e.message : String(e) };
  } finally {
    busy = false;
  }
}
