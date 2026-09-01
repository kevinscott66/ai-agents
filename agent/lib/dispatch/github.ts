/**
 * T-511: GitHub PR review and merge operations.
 *
 * Orchestrator can validate a PR against the pre-push checklist and then either
 * merge it (safe, green, approved-action authority) or comment with the
 * specific blocking issues (red / risky / control-loop review). All GitHub
 * access goes through an injectable {@link GhRunner} so the handler is fully
 * hermetic under test — unit tests pass a fake runner and never touch the
 * network or mutate real PRs.
 */

import { getErrorMessage } from "../errors.ts";
import type { ReviewAndMergePrPayload } from "../action-payload.ts";

const REPO = "kevinscott66/ai-agents";
/**
 * Общий префикс всех маркеров control-loop — и старого безусловного, и sha-формы.
 *
 * Аудит 2026-08-28: фолбэк в review-mode.ts «при отсутствии headRefOid» искал
 * ровно `CONTROL_REVIEW_MARKER`, но эта строка не является подстрокой
 * `<!-- ai-agents-control-review sha=… -->` (после `review` идёт ` sha=`, а не
 * ` -->`), а sha-форму пишут все четыре комментария ниже. Ветка могла вернуть
 * только false: PR разбирался и комментировался на каждом прогоне заново.
 * Поэтому сверка без head идёт по префиксу — он покрывает обе формы.
 */
export const CONTROL_REVIEW_MARKER_PREFIX = "<!-- ai-agents-control-review";

/** Маркер до привязки к head (аудит 2026-08-27). Оставлен для старых комментариев. */
export const CONTROL_REVIEW_MARKER = `${CONTROL_REVIEW_MARKER_PREFIX} -->`;

/**
 * Маркер «control-loop уже высказался», привязанный к head-коммиту PR.
 *
 * Аудит 2026-08-27: раньше маркер был один на все четыре комментария, включая
 * «Validation Failed» и «Merge Failed». `hasControlReviewComment` считает
 * помеченный PR рассмотренным навсегда, так что PR, once упавший на чеклисте,
 * выпадал из петли контроля насовсем — автор чинил замечания, а второго
 * прохода уже не было. Привязка к SHA даёт и то и другое: пока head не
 * изменился, повторных комментариев нет; новый пуш открывает PR заново.
 */
export function controlReviewMarker(headSha?: string | null): string {
  const sha = typeof headSha === "string" ? headSha.trim() : "";
  return `${CONTROL_REVIEW_MARKER_PREFIX} sha=${sha || "unknown"} -->`;
}

export interface GithubHandlerContext {
  agentKey: string;
  chatId: number;
}

export interface GithubOperationResult {
  ok: true;
  result: {
    // comment_failed: проверка отработала, но её вывод до PR не доехал.
    // Отличать обязательно — комментарий и есть единственный внешний след
    // того, что PR ждёт человека (аудит 2026-08-08).
    // skipped: PR вообще не рассматривался — человек его придержал (draft или
    // блокирующая метка). Это не «проверка не прошла»: проверять нечего.
    action: "merged" | "commented" | "validation_failed" | "comment_failed" | "skipped";
    pr_number: number;
    message?: string;
    checks_passed?: boolean;
    merge_sha?: string;
  };
}

export interface GithubOperationError {
  ok: false;
  error: string;
}

export type GithubResult = GithubOperationResult | GithubOperationError;

/** Result of one `gh` invocation. */
export interface GhRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Runs a `gh` subcommand. Args are passed as an array (NOT a shell string) so
 * there is no interpolation / injection surface. Injectable for tests.
 */
export type GhRunner = (args: string[]) => Promise<GhRunResult>;

export interface ReviewAndMergeDeps {
  /** GitHub CLI runner. Defaults to the real `gh` via Bun.spawn. */
  runGh?: GhRunner;
  /** Explicit capability from the approval boundary. Control-loop is review-only. */
  authority?: "approved-action" | "control-loop";
}

/**
 * Итоговый токен для дочернего `gh`: собственный GH_TOKEN важнее, а
 * GITHUB_TOKEN подставляется только когда первого нет (в CI задан только он).
 * Отдельной чистой функцией — чтобы правило проверялось без запуска реального `gh`.
 *
 * Пустая строка равносильна отсутствию: `EnvironmentFile=` в systemd даёт именно
 * `""` для строки `GH_TOKEN=`, и такой токен не аутентифицирует ничего.
 */
export function resolveGhToken(
  ghToken: string | undefined,
  githubToken: string | undefined,
): string | undefined {
  return ghToken || githubToken;
}

/**
 * Keep the GitHub CLI child process on a narrow, non-secret environment.
 * The agent process also has Telegram, model-provider, and session-key
 * variables; passing all of `process.env` made every one of them readable by
 * the executable selected as `gh`.
 */
export function buildGhEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "GH_CONFIG_DIR", "GH_HOST"]) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  const ghToken = resolveGhToken(process.env.GH_TOKEN, process.env.GITHUB_TOKEN);
  if (ghToken) env.GH_TOKEN = ghToken;
  return env;
}

/**
 * Default real runner: spawns `gh` with GITHUB_TOKEN→GH_TOKEN mapping so it
 * authenticates in CI where only GITHUB_TOKEN is set.
 */
export const defaultRunGh: GhRunner = async (args) => {
  const env = buildGhEnv();

  const proc = Bun.spawn([Bun.which("gh") ?? "gh", ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
};

/**
 * Что МОЖНО влить автоматически. Всё остальное — к человеку.
 *
 * Аудит 2026-08-11: до сегодня это был чёрный список — перечисление опасного,
 * а безопасное определялось как «всё прочее». Такой список чинится ровно одним
 * способом: аудит находит очередной непойманный путь и дописывает строку.
 * 2026-08-08 — усечение списка файлов у `gh`; 2026-08-10 — `.github/`,
 * `deploy/`, `package.json`, CLAUDE.md/AGENT.md. Оба раза это были не новые
 * файлы в репо, а старые, которых не было в перечислении. К третьему заходу
 * мимо человека всё ещё проходили:
 *
 *  • `agent/mac-daemon/**` — демон, исполняющий Claude на машине владельца.
 *    MAC_RUN_CLAUDE заперт на orchestrator на уровне кода именно потому, что
 *    это RCE; правка самого демона при этом вливалась автоматически.
 *  • `agent/agent.ts`, `agent/login-userbot.ts`, `agent/join-group.ts`,
 *    `agent/list-dialogs.ts` — код, действующий реальным аккаунтом владельца.
 *  • `agent/tsconfig.json`, `agent/miniapp/vite.config.ts` — как собирается то,
 *    что уезжает на прод.
 *  • `.claude/settings.json` — хуки Claude Code. Файла в репо нет, и чёрный
 *    список молчал бы ровно про тот PR, который его добавит.
 *
 * Второй путь автомержа (`.github/workflows/auto-merge.yml`) с самого начала
 * устроен наоборот: `case` перечисляет безопасное, всё прочее отсекает `*)`.
 * Его шапка утверждает «То же правило продублировано в isRiskyPath()» — теперь
 * это правда не только по букве, но и по форме. Обе стороны согласованности
 * пришпилены в tests/pr-risky-paths-allowlist.test.ts; раньше проверялась одна,
 * и не та: опасно, когда чёрный список пускает то, что белый бы не пустил.
 *
 * Единственное намеренное расхождение с воркфлоу — markdown рядом с кодом
 * агентов (`agent/lib/README.md`): документация, а не поведение. Аудит
 * 2026-08-12: записано это было одним предикатом `agent/**\/*.md`, который
 * оказался шире собственного объяснения и накрывал `agent/characters/` —
 * директорию, которую анти-список воркфлоу называет «никогда auto», а
 * CLAUDE.md — risky по определению. Исключение сужено до всего, что вне неё.
 */
function isAutoMergeable(f: string): boolean {
  // 1. Documentation. Memory, task boards, and status files are consumed by
  //    future autonomous prompts, so they always require human review.
  //    README воркфлоу — единственный безопасный путь в
  //    `.github/`, ровно как в `case` воркфлоу.
  if (f.startsWith("docs/")) return true;
  if (/^README[^/]*\.md$/.test(f)) return true;
  if (/^\.github\/workflows\/README[^/]*\.md$/.test(f)) return true;

  // `.gitignore` был здесь до аудита 2026-08-29. Он держит вне git рантайм-БД
  // (`agent/data/*.db`) и StringSession юзербота (`*.session` — учётные
  // данные): PR, вычёркивающий эти строки, трогает ровно один «безопасный»
  // файл и до правки вливался без человека обоими путями автомержа.

  // 2. Markdown рядом с кодом агентов — см. шапку. Кроме `agent/characters/`:
  //    воркфлоу отсекает эту директорию целиком («system prompts — никогда
  //    auto»), CLAUDE.md называет её risky по определению. Расширение файла не
  //    делает его документацией — в `agent/characters/prompts/copy/*.md`
  //    лежит то, чем пишет роль copy (аудит 2026-08-12).
  if (f.startsWith("agent/characters/")) return false;
  if (f.startsWith("agent/") && f.endsWith(".md")) return true;

  return false;
}

/**
 * Файл, который нельзя влить автоматически — только после человека.
 * Инверсия белого списка: незнакомый путь рискован по умолчанию.
 */
export function isRiskyPath(f: string): boolean {
  return !isAutoMergeable(f);
}

/**
 * Метки, которыми человек говорит «не вливать», не закрывая PR.
 *
 * Аудит 2026-08-21: набор сверялся точным именем, а метка, которой автономный
 * цикл помечает КАЖДЫЙ свой PR (`deploy/agents-loop.sh:76` —
 * `--label needs-human-review`), длиннее той, что лежала в наборе. Замер на
 * docs-only PR в белом списке путей: `needs-human` — skipped, а
 * `needs-human-review` — `pr merge` вызван, action=merged. То есть
 * единственная метка, которая тут реально ставится, гейт не останавливала.
 *
 * Второй автомерж это уже прошёл: `.github/scripts/automerge-filter.sh:75-79`
 * сравнивает `startswith("needs-human")` — правку 2026-08-12 просто не
 * перенесли сюда, хотя комментарий обещал общий список. Держим то же правило:
 * точное имя для трёх меток и префикс для семейства `needs-human*`.
 */
const BLOCKING_LABELS = new Set(["hold", "risky", "do-not-merge"]);
const BLOCKING_LABEL_PREFIXES = ["needs-human"];

export function isBlockingLabel(name: string): boolean {
  const n = name.toLowerCase();
  return BLOCKING_LABELS.has(n) || BLOCKING_LABEL_PREFIXES.some((p) => n.startsWith(p));
}

/**
 * Метка семейства `needs-human*` — просьба к человеку, а не запрет боту смотреть.
 *
 * Аудит 2026-08-28: `deploy/vps-autonomous/autonomous-cycle.sh:540` вешает
 * `needs-human-review` на КАЖДЫЙ свой PR сразу после `gh pr create`, а
 * `listRecentOpenPrs` пропускает в review-mode только ветки `agent/*` — то есть
 * ровно эти PR и никакие другие. Гейт блокирующих меток стоит до чеклиста,
 * поэтому control-loop на каждом своём PR возвращал `{action:"skipped"}` без
 * комментария. Петля обратной связи, ради которой режим и написан, не выдавала
 * ни одного сигнала — а отчёт при этом рапортовал «PRs reviewed: N».
 *
 * Для merge-пути метка по-прежнему запрет. Для control-loop она информационная:
 * слить он всё равно не может (ниже безусловный ранний возврат для
 * `authority === "control-loop"` — он умеет только комментировать), а его
 * единственный полезный выход — тот самый комментарий, которого человек и ждёт,
 * когда ставит метку «нужен человек».
 *
 * `hold` / `risky` / `do-not-merge` остаются запретом для обоих путей: это
 * решение человека «не трогай», и комментарий на таком PR был бы шумом.
 */
export function isHumanReviewLabel(name: string): boolean {
  const n = name.toLowerCase();
  return BLOCKING_LABEL_PREFIXES.some((p) => n.startsWith(p));
}

/**
 * Validates a PR against the pre-push checklist:
 *  - PR is OPEN, не черновик и без блокирующих меток;
 *  - PR is OPEN and not CONFLICTING;
 *  - the whole diff is visible (gh truncates `files` at 100);
 *  - required CI checks pass;
 *  - no build artefacts in the diff;
 *  - flags anything outside the auto-mergeable allowlist (risky → human).
 *
 * Аудит 2026-08-11: в списке значилась ещё одна строка — «no conflict markers in
 * TASKS.md / memory files». Такой проверки здесь нет и не было; маркеры ловит
 * `.github/scripts/check-conflict-markers.sh` в CI, то есть через
 * `pr checks --required` выше. Дока обещала контроль, которого в этом файле нет.
 */
async function validatePrChecklist(
  prNumber: number,
  runGh: GhRunner,
  /** Кто пришёл: merge-путь или review-only control-loop. См. isHumanReviewLabel. */
  authority?: "approved-action" | "control-loop",
): Promise<{
  passed: boolean;
  issues: string[];
  filesChanged: string[];
  risky: boolean;
  /** Причина, по которой PR не рассматривается вовсе (draft / метка человека). */
  blocked?: string;
  /** head-коммит PR: маркер комментария привязывается к нему. */
  headSha?: string;
}> {
  const issues: string[] = [];
  let filesChanged: string[] = [];

  const view = await runGh([
    "pr", "view", String(prNumber),
    "--repo", REPO,
    // changedFiles запрашиваем не для отчёта, а чтобы заметить усечение
    // списка files — см. проверку ниже.
    // isDraft/labels — сигналы человека «не вливать»; воркфлоу их спрашивал
    // с самого начала, этот путь — нет (аудит 2026-08-12).
    "--json", "files,state,mergeable,changedFiles,isDraft,labels,headRefOid",
  ]);
  if (view.exitCode !== 0) {
    issues.push(
      `Failed to get PR details: ${(view.stderr || view.stdout).trim() || `gh exited ${view.exitCode}`}`,
    );
    return { passed: false, issues, filesChanged, risky: false };
  }

  let prData: {
    files?: { path: string }[];
    state?: string;
    mergeable?: string;
    changedFiles?: number;
    isDraft?: boolean;
    labels?: { name?: string }[];
    headRefOid?: string;
  };
  try {
    prData = JSON.parse(view.stdout);
  } catch {
    issues.push("Could not parse PR details from gh");
    return { passed: false, issues, filesChanged, risky: false };
  }

  const headSha = typeof prData.headRefOid === "string" ? prData.headRefOid : undefined;

  if (prData.state !== "OPEN") {
    issues.push(`PR #${prNumber} is not open (state: ${prData.state ?? "unknown"})`);
    return { passed: false, issues, filesChanged, risky: false, headSha };
  }

  // Черновик и блокирующая метка — это решение человека, а не результат
  // проверки. Отвечаем до `pr checks`: гонять проверки на PR, который просили
  // не трогать, незачем, а комментарий на нём был бы шумом.
  if (prData.isDraft) {
    return {
      passed: false,
      issues,
      filesChanged,
      risky: false,
      blocked: "PR — черновик (draft)",
      headSha,
    };
  }
  const blockingLabels = (prData.labels ?? [])
    .map((l) => String(l?.name ?? "").toLowerCase())
    .filter((name) => isBlockingLabel(name))
    // Для control-loop метка «нужен человек» — не запрет, а ровно тот повод
    // оставить комментарий с результатом чеклиста: см. isHumanReviewLabel.
    .filter((name) => !(authority === "control-loop" && isHumanReviewLabel(name)));
  if (blockingLabels.length) {
    return {
      passed: false,
      issues,
      filesChanged,
      risky: false,
      blocked: `на PR стоят блокирующие метки: ${blockingLabels.join(", ")}`,
      headSha,
    };
  }

  if (prData.mergeable === "CONFLICTING") {
    issues.push("PR has merge conflicts");
  }

  filesChanged = (prData.files ?? []).map((f) => f.path);

  // Аудит 2026-08-08: `gh pr view --json files` отдаёт максимум 100 файлов.
  // В самом бинаре запрос зашит как `files(first: 100)` без pageInfo/endCursor,
  // то есть страницу вторую он не берёт и об усечении не сообщает. Обе проверки
  // ниже — «артефакты сборки» и `risky` — строятся ровно на этом массиве.
  //
  // Цена: PR со 120 файлами показывал первые 100. Если dist/ или
  // agent/characters/ лежат в хвосте, обе проверки их не видят, checklist
  // отвечает passed: true, и дальше идёт `gh pr merge --squash` прямо в main.
  // То есть авто-мерж по диффу, который код целиком не читал.
  //
  // changedFiles — честное число файлов в PR, оно не усечено. Расхождение
  // означает «диффа я не видел целиком», и это отказ, а не предупреждение:
  // «✅ Validation Passed» на половине диффа хуже, чем ручной разбор.
  // Аудит 2026-08-20: пустой список проходил весь чеклист как «ничего
  // рискованного не тронуто». Обе проверки ниже строятся на `filesChanged`, а
  // на пустом массиве `.some(isRiskyPath)` и `.filter(...)` честно отвечают
  // «чисто» — и PR уходил в `gh pr merge --squash` прямо в main, то есть
  // автомерж по диффу, который код не видел вообще.
  //
  // Гейт по усечению сюда не дотягивался: он сравнивает длину с `changedFiles`
  // и молчит, когда того поля нет (старый gh, урезанный JSON) или оно равно
  // нулю. Проверка нужна отдельная и до него.
  //
  // Соседний путь автомержа это правило уже знает: `.github/workflows`
  // отвечает `SKIP <n> no_files` — «пустой список это «неизвестно», а не
  // «безопасно»». Шапка этого файла утверждает, что оба пути согласованы; по
  // этому пункту не были.
  if (filesChanged.length === 0) {
    issues.push(
      "gh не вернул ни одного файла — список изменённых файлов не получен, " +
        "проверить дифф не по чему (автомерж невозможен)",
    );
  }

  const totalFiles = prData.changedFiles;
  if (typeof totalFiles === "number" && filesChanged.length < totalFiles) {
    issues.push(
      `PR touches ${totalFiles} files, gh returned only ${filesChanged.length} — ` +
        `дифф виден не целиком, автомерж невозможен (нужен ручной просмотр)`,
    );
  }

  // Required CI checks.
  const checks = await runGh(["pr", "checks", String(prNumber), "--repo", REPO, "--required"]);
  if (checks.exitCode !== 0) {
    issues.push("Required CI checks are not passing");
  }

  // Build artefacts must never be in a diff.
  const buildArtifacts = filesChanged.filter(
    (f) => f.endsWith(".original") || f.endsWith(".bak") || f.includes("dist/") || f.includes("node_modules/"),
  );
  if (buildArtifacts.length) {
    issues.push(`Build artifacts in diff: ${buildArtifacts.join(", ")}`);
  }

  const risky = filesChanged.some(isRiskyPath);

  return { passed: issues.length === 0, issues, filesChanged, risky, headSha };
}

/** Post a comment on the PR; swallow errors (commenting is best-effort). */
async function comment(prNumber: number, body: string, runGh: GhRunner): Promise<boolean> {
  const res = await runGh(["pr", "comment", String(prNumber), "--repo", REPO, "--body", body]);
  return res.exitCode === 0;
}

/**
 * Main handler for REVIEW_AND_MERGE_PR action.
 *
 * Restricted to the orchestrator (also enforced backend-side by CALLER_RESTRICTED).
 *
 * The normal dispatch path supplies `approved-action` only after
 * ALWAYS_APPROVE_ACTIONS has created and consumed a human approval. T-513
 * supplies `control-loop`, which is deliberately review-only and cannot reach
 * `gh pr merge`.
 */
export async function handleReviewAndMergePr(
  payload: ReviewAndMergePrPayload,
  ctx: GithubHandlerContext,
  deps: ReviewAndMergeDeps = {},
): Promise<GithubResult> {
  const { pr_number } = payload;
  const runGh = deps.runGh ?? defaultRunGh;

  if (!pr_number || pr_number <= 0) {
    return { ok: false, error: "Invalid PR number: must be a positive integer" };
  }
  if (ctx.agentKey !== "orchestrator") {
    return {
      ok: false,
      error: `Action REVIEW_AND_MERGE_PR is restricted to orchestrator, called by: ${ctx.agentKey}`,
    };
  }
  if (deps.authority !== "approved-action" && deps.authority !== "control-loop") {
    return {
      ok: false,
      error: "Merge authority is required: use the approval-gated action path",
    };
  }

  try {
    const validation = await validatePrChecklist(pr_number, runGh, deps.authority);

    // Человек придержал PR: ни мержа, ни комментария.
    if (validation.blocked) {
      return {
        ok: true,
        result: {
          action: "skipped",
          pr_number,
          message: `PR #${pr_number} не рассматривается: ${validation.blocked}`,
          checks_passed: false,
        },
      };
    }

    // Red: comment the blocking issues, do not merge.
    if (!validation.passed) {
      const body =
        `${controlReviewMarker(validation.headSha)}\n` +
        `🚫 **Validation Failed**\n\n` +
        `Pre-push checklist failed:\n${validation.issues.map((i) => `- ${i}`).join("\n")}\n\n` +
        `---\n*Automated review by orchestrator agent*`;
      const posted = await comment(pr_number, body, runGh);
      return {
        ok: true,
        result: {
          action: posted ? "commented" : "validation_failed",
          pr_number,
          message: `PR #${pr_number} validation failed: ${validation.issues.join("; ")}`,
          checks_passed: false,
        },
      };
    }

    // Green but risky (core agent code): comment "ready, needs human", do not auto-merge.
    if (validation.risky) {
      const body =
        `${controlReviewMarker(validation.headSha)}\n` +
        `✅ **Validation Passed** — but this PR changes core agent files and needs human review before merge.\n\n` +
        `---\n*Automated review by orchestrator agent*`;
      // Аудит 2026-08-08: результат comment() здесь выбрасывался, хотя ветка
      // выше (validation failed) его читает. comment() не бросает — он
      // возвращает exitCode === 0, так что непоставленный комментарий
      // отчитывался как "commented". А это единственный след того, что PR
      // ждёт человека: соврав здесь, мы оставляли risky-PR без сигнала вообще.
      const posted = await comment(pr_number, body, runGh);
      return {
        ok: true,
        result: {
          action: posted ? "commented" : "comment_failed",
          pr_number,
          message: `PR #${pr_number} passed validation but needs human review (risky changes)`,
          checks_passed: true,
        },
      };
    }

    // The autonomous control loop is intentionally review-only. It can prove
    // the checklist is green, but only an explicitly approved action may merge.
    if (deps.authority === "control-loop") {
      const body =
        `${controlReviewMarker(validation.headSha)}\n` +
        `✅ **Validation Passed** — this PR is safe by policy, but a human approval is required before merge.\n\n` +
        `---\n*Automated review by orchestrator agent; control-loop is review-only*`;
      const posted = await comment(pr_number, body, runGh);
      return {
        ok: true,
        result: {
          action: posted ? "commented" : "comment_failed",
          pr_number,
          message: `PR #${pr_number} passed validation; human approval is required before merge`,
          checks_passed: true,
        },
      };
    }

    // Green and safe with an approved action: squash-merge and delete branch.
    const merge = await runGh(["pr", "merge", String(pr_number), "--repo", REPO, "--squash", "--delete-branch"]);
    if (merge.exitCode !== 0) {
      const body =
        `${controlReviewMarker(validation.headSha)}\n` +
        `❌ **Merge Failed**\n\nValidation passed but automatic merge failed:\n\`\`\`\n${(merge.stderr || merge.stdout).trim()}\n\`\`\`\n\n---\n*Automated review by orchestrator agent*`;
      await comment(pr_number, body, runGh);
      return {
        ok: false,
        error: `Failed to merge PR #${pr_number}: ${(merge.stderr || merge.stdout).trim() || `gh exited ${merge.exitCode}`}`,
      };
    }
    const shaMatch = merge.stdout.match(/([a-f0-9]{7,40})/);
    return {
      ok: true,
      result: {
        action: "merged",
        pr_number,
        message: `PR #${pr_number} successfully merged and branch deleted`,
        checks_passed: true,
        ...(shaMatch ? { merge_sha: shaMatch[1] } : {}),
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: `Failed to review PR #${pr_number}: ${getErrorMessage(error)}`,
    };
  }
}
