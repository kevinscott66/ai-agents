/**
 * T-513: Control-loop review mode.
 *
 * Runs the orchestrator in a one-shot "review-only" pass: it lists the PRs that
 * were opened/updated recently and runs each one through the pre-push checklist
 * by reusing the T-511 `REVIEW_AND_MERGE_PR` handler (`handleReviewAndMergePr`).
 * Разбор НИЧЕГО не мержит — merge закрыт для полномочия `control-loop` ранним
 * возвратом в lib/dispatch/github.ts — и оставляет PR человеку. Список
 * сужается префиксом ветки `agent/` (`headRefName` в `listRecentOpenPrs`):
 * цикл смотрит свои PR, а не все подряд.
 *
 * Аудит 2026-09-11, круг 50: здесь стояло «в разбор попадают только свои
 * ветки… и это граница безопасности автономного цикла, а не оптимизация».
 * Границей этот фильтр быть не может: у PR из форка `headRefName` — имя ветки
 * В ФОРКЕ, то есть строка, которую целиком выбирает посторонний, и ветка
 * `agent/whatever` попадает в список ровно так же, как своя. Запрос здесь тоже
 * не берёт `isCrossRepository`. Граница — в другом месте и в двух: merge
 * закрыт для `control-loop` ранним возвратом, а личность автора с того же
 * круга проверяет `validatePrChecklist` (форк и незнакомый автор — `skipped`,
 * без комментария). Цена прежней формулировки — не дыра, а ложное чувство
 * периметра: читатель мерил риск этого фильтра как проверку происхождения PR.
 *
 * Итог печатается для внутреннего наблюдателя (раздел «Control loop»).
 *
 * Аудит 2026-09-11: здесь стояло «Every PR gets a validation comment». Это
 * неправда в трёх ветках, и файл опровергает себя двадцатью строками ниже, в
 * разборе `COMMENT_LOST`: «уже рассмотрен» выходит через `skipped` без
 * комментария; `comment_failed`/`validation_failed` — это «проверка
 * отработала, но до PR не доехала»; придержанный человеком PR тоже уходит
 * `skipped`. Цена — мониторинг, построенный на «PR без комментария = цикл не
 * работал»: токен, потерявший право писать, читается как «PR-ов не было».
 *
 * Fully hermetic: all GitHub access goes through an injectable {@link GhRunner},
 * so unit tests pass a fake runner and never touch the network or real PRs.
 */

import { getErrorMessage } from "../lib/errors.ts";
import {
  handleReviewAndMergePr,
  defaultRunGh,
  CONTROL_REVIEW_MARKER_PREFIX,
  controlReviewMarker,
  type GhRunner,
  type GithubResult,
} from "../lib/dispatch/github.ts";

const REPO = "kevinscott66/ai-agents";

/** How far back (minutes) a PR's last update may be to still be reviewed. */
const DEFAULT_WINDOW_MINUTES = 90;
/**
 * Upper bound on PRs pulled from `gh pr list`.
 *
 * Экспортируется, чтобы признак обрезки в {@link listRecentOpenPrs} считался по
 * той же константе, которая уходит в `--limit`: две независимые пятидесятки
 * разъехались бы при первой же правке одной из них.
 */
export const PR_LIST_LIMIT = 50;

export interface ReviewedPr {
  pr_number: number;
  outcome: GithubResult;
}

export interface ReviewModeResult {
  /**
   * Сколько открытых PR попало в окно свежести и ушло в разбор.
   *
   * Аудит 2026-08-28: тут было написано «and were reviewed», а присваивается
   * `prNumbers.length` — длина списка ДО разбора. Отчёт печатал это число под
   * заголовком «PRs reviewed», то есть рапортовал успех независимо от того,
   * чем разбор кончился: пять `skipped` и пять `error` выглядели одинаково с
   * пятью поставленными комментариями. Именно поэтому гейт блокирующих меток
   * (см. isHumanReviewLabel в lib/dispatch/github.ts) молча съедал КАЖДЫЙ PR
   * цикла и это никому не бросалось в глаза. Разбивку по исходам считает
   * {@link countReviewOutcomes}.
   */
  scanned: number;
  /**
   * `gh pr list` упёрся в {@link PR_LIST_LIMIT} — часть открытых PR прогон не
   * видел вовсе. Необязательное поле: старые вызовы `formatReviewSummary`
   * строят результат вручную и про обрезку ничего не знают.
   */
  truncated?: boolean;
  /**
   * Номера PR, которые прогон ВЗЯЛ в работу, в порядке выдачи `gh pr list`, —
   * то есть поимённая версия `scanned`, а не «разобранные». Сколько из них
   * дошло до комментария, знают только `results` и {@link countReviewOutcomes};
   * путать эти два списка — ровно та ошибка, из-за которой заведено поле
   * `scanned` (абзац выше).
   */
  pr_numbers: number[];
  /**
   * Исход разбора каждого PR.
   *
   * Встречаются пять: `commented`, `skipped` (уже рассмотрен, либо придержан
   * человеком), `comment_failed`, `validation_failed` — и `merged`, которого
   * ЭТОТ режим не достигает никогда: merge закрыт для полномочия
   * `control-loop` (lib/dispatch/github.ts).
   *
   * Аудит 2026-09-11: было «merged / commented / failed». Из трёх названных
   * реально встречается одно, а `skipped` — самый частый исход спокойного
   * прогона — не назван вовсе. Разбор, написанный по этой строке (`merged →
   * … иначе провал`), схлопывает «нечего делать» в «сломалось» — ровно та
   * ошибка, которую двадцатью строками ниже уже разбирал `COMMENT_LOST`.
   */
  results: ReviewedPr[];
  /**
   * Сколько PR прогон считает проваленными. Не то же, что `outcome.ok === false`:
   * {@link countReviewOutcomes} добавляет сюда и потерянный комментарий
   * (`COMMENT_LOST` — `comment_failed`, `validation_failed`), потому что разбор
   * без внешнего следа неотличим от несделанного. Обоснование — у самого
   * `COMMENT_LOST` ниже.
   *
   * Необязательное — как и `truncated`, старые вызовы `formatReviewSummary`
   * строят результат вручную.
   */
  failed?: number;
}

/**
 * Разбивка исходов прогона. Считается из `results`, а не хранится: единственный
 * способ не дать счётчику разъехаться с тем, что реально лежит в списке.
 *
 * `skipped` — это тоже закрытая петля: PR либо уже несёт комментарий на текущий
 * head, либо человек его придержал.
 *
 * Провал — это `ok === false` И потерянный комментарий. Аудит 2026-08-28: ветка
 * `else reviewed++` сгребала все успешные исходы, а среди них есть
 * `comment_failed` и `validation_failed` — «проверка отработала, но до PR не
 * доехала» (три ветки `posted ? "commented" : …` в lib/dispatch/github.ts).
 * Комментарий и есть единственный внешний след разбора: нет его — нет и
 * маркера, значит следующий прогон разберёт тот же PR заново. Хуже того, по
 * этой же разбивке считает fail-closed в agent.ts — строка `nothingWorked`:
 * токен, потерявший право писать, давал «Commented: 5 · failed: 0» и exit 0.
 */
const COMMENT_LOST: ReadonlySet<string> = new Set(["comment_failed", "validation_failed"]);

export function countReviewOutcomes(results: ReviewedPr[]): {
  reviewed: number;
  skipped: number;
  failed: number;
} {
  let reviewed = 0;
  let skipped = 0;
  let failed = 0;
  for (const { outcome } of results) {
    if (!outcome.ok) failed++;
    else if (outcome.result.action === "skipped") skipped++;
    else if (COMMENT_LOST.has(outcome.result.action)) failed++;
    else reviewed++;
  }
  return { reviewed, skipped, failed };
}

export interface ReviewModeDeps {
  /** GitHub CLI runner. Defaults to the real `gh` via Bun.spawn. */
  runGh?: GhRunner;
  /** Only PRs updated within this window are reviewed. Default 90 minutes. */
  windowMinutes?: number;
  /** Injectable clock (ms epoch) for deterministic tests. Defaults to Date.now. */
  now?: () => number;
}

interface PrListEntry {
  number: number;
  updatedAt?: string;
  createdAt?: string;
  headRefName?: string;
}

/** Результат выборки: номера PR плюс признак, что выдачу обрезал `gh`. */
export interface RecentOpenPrs {
  /** PR numbers in the order `gh` reported them (newest first). */
  prNumbers: number[];
  /**
   * Выдача `gh pr list` упёрлась в `--limit`, то есть какие-то открытые PR
   * остались за кадром.
   *
   * Аудит 2026-08-20. Порядок у `gh pr list` без `--search` — по дате СОЗДАНИЯ
   * вниз, а окно свежести считается по `updatedAt`. Значит обрезка идёт по
   * номеру, а отбор — по времени обновления, и свежий, но давно созданный PR
   * отсекается до того, как окно его увидит. На живом репозитории в день
   * аудита: 83 открытых PR, в первые 50 попали #486..#538 (самый старый из них
   * обновлён в 01:48Z), а #469 с обновлением в 04:35Z не попал вовсе.
   *
   * Считаем по длине СЫРОЙ выдачи, до фильтра: обрезает именно `gh`, и «ни
   * один PR не прошёл окно» — это не то же самое, что «смотреть было нечего».
   */
  truncated: boolean;
}

/**
 * Lists open PRs whose last update is within `windowMinutes` of `now`.
 */
export async function listRecentOpenPrs(
  runGh: GhRunner,
  windowMinutes: number,
  now: () => number,
): Promise<RecentOpenPrs> {
  const res = await runGh([
    "pr", "list",
    "--repo", REPO,
    "--state", "open",
    "--limit", String(PR_LIST_LIMIT),
    "--json", "number,updatedAt,createdAt,headRefName",
  ]);
  if (res.exitCode !== 0) {
    throw new Error(
      `gh pr list failed: ${(res.stderr || res.stdout).trim() || `exit ${res.exitCode}`}`,
    );
  }

  let entries: PrListEntry[];
  try {
    entries = JSON.parse(res.stdout || "[]");
  } catch {
    throw new Error("Could not parse PR list from gh");
  }

  const cutoff = now() - windowMinutes * 60_000;
  const prNumbers = entries
    .filter((e) => typeof e.number === "number")
    // Сужение до своих веток: имя ветки выбирает автор PR, поэтому это
    // фильтр «на что цикл тратит прогон», а не проверка происхождения —
    // происхождение проверяет validatePrChecklist (см. шапку). Пропавшее имя
    // ветки считаем неподходящим: неполные данные gh не повод разбирать PR.
    .filter((e) => typeof e.headRefName === "string" && e.headRefName.startsWith("agent/"))
    .filter((e) => {
      const stamp = e.updatedAt ?? e.createdAt;
      if (!stamp) return false;
      const t = Date.parse(stamp);
      return Number.isFinite(t) && t >= cutoff;
    })
    .map((e) => e.number);
  return { prNumbers, truncated: entries.length >= PR_LIST_LIMIT };
}

async function hasControlReviewComment(
  prNumber: number,
  runGh: GhRunner,
): Promise<boolean> {
  const res = await runGh([
    "pr", "view", String(prNumber),
    "--repo", REPO,
    // headRefOid — чтобы «уже рассмотрен» считалось для текущего head, а не
    // навсегда: см. controlReviewMarker в lib/dispatch/github.ts.
    "--json", "comments,headRefOid",
  ]);
  if (res.exitCode !== 0) {
    throw new Error(
      `gh pr view comments failed: ${(res.stderr || res.stdout).trim() || `exit ${res.exitCode}`}`,
    );
  }
  let data: { comments?: { body?: string }[]; headRefOid?: string };
  try {
    data = JSON.parse(res.stdout || "{}");
  } catch {
    throw new Error("Could not parse PR comments from gh");
  }
  // Без head-коммита сверяться не с чем: любой наш прошлый комментарий считается
  // разбором. Ищем по общему префиксу — он покрывает и sha-форму (её и пишет
  // прод, в том числе `sha=unknown` ровно для этого случая), и старый
  // безусловный маркер. Точное совпадение с CONTROL_REVIEW_MARKER не находило
  // ничего: аудит 2026-08-28, см. CONTROL_REVIEW_MARKER_PREFIX.
  const marker =
    typeof data.headRefOid === "string" && data.headRefOid.trim()
      ? controlReviewMarker(data.headRefOid)
      : CONTROL_REVIEW_MARKER_PREFIX;
  return (data.comments ?? []).some(
    (comment) => typeof comment.body === "string" && comment.body.includes(marker),
  );
}

/**
 * One-shot control-loop pass: list recent PRs and review each via the T-511
 * handler. Never throws on a single-PR failure — the failure is captured in
 * that PR's `outcome` so the remaining PRs are still reviewed.
 */
export async function runReviewMode(deps: ReviewModeDeps = {}): Promise<ReviewModeResult> {
  const runGh = deps.runGh ?? defaultRunGh;
  const windowMinutes = deps.windowMinutes ?? DEFAULT_WINDOW_MINUTES;
  const now = deps.now ?? Date.now;

  const { prNumbers, truncated } = await listRecentOpenPrs(runGh, windowMinutes, now);
  const results: ReviewedPr[] = [];

  for (const pr_number of prNumbers) {
    let outcome: GithubResult;
    try {
      if (await hasControlReviewComment(pr_number, runGh)) {
        outcome = {
          ok: true,
          result: {
            action: "skipped",
            pr_number,
            message: "control-loop review comment already exists",
            checks_passed: false,
          },
        };
        results.push({ pr_number, outcome });
        continue;
      }
      outcome = await handleReviewAndMergePr(
        { pr_number },
        { agentKey: "orchestrator", chatId: 0 },
        { runGh, authority: "control-loop" },
      );
    } catch (error) {
      outcome = {
        ok: false,
        error: `Review threw: ${getErrorMessage(error)}`,
      };
    }
    results.push({ pr_number, outcome });
  }

  return {
    scanned: prNumbers.length,
    pr_numbers: prNumbers,
    results,
    truncated,
    failed: countReviewOutcomes(results).failed,
  };
}

/**
 * Проход ревью как Markdown-блок.
 *
 * Аудит 2026-09-11, круг 51: здесь было сказано «for the STATUS.md "Control
 * loop" section». Файла STATUS.md в дереве нет; единственный вызывающий —
 * `agent.ts` в режиме review — печатает результат в stdout, откуда его
 * забирает внешний сборщик статуса. Обещание «вот куда это попадёт» было
 * ложным адресом: пошедший править вёрстку искал бы несуществующий файл.
 */
export function formatReviewSummary(result: ReviewModeResult, isoTimestamp: string): string {
  const lines: string[] = [];
  lines.push(`## Control loop — ${isoTimestamp}`);
  lines.push(`- **PRs scanned:** ${result.scanned}`);
  // Строка про обрезку идёт ДО раннего возврата: «нечего смотреть» при упёртом
  // пределе — самый опасный отчёт из возможных, потому что читается как «всё
  // разобрано», а на деле прогон не видел часть открытых PR.
  if (result.truncated) {
    lines.push(
      `- ⚠️ \`gh pr list\` hit the ${PR_LIST_LIMIT}-PR cap — older open PRs were NOT considered.` +
        " The list is ordered by creation date, so a recently-updated older PR can fall outside it.",
    );
  }
  if (result.scanned === 0) {
    lines.push("- No recent PRs in window — nothing to review.");
    return lines.join("\n") + "\n";
  }
  // Разбивка по исходам идёт до построчного списка: без неё «PRs scanned: 5»
  // читалось как «пять PR разобраны», хотя все пять могли уйти в skip или в
  // ошибку — см. комментарий у поля `scanned`.
  const tally = countReviewOutcomes(result.results);
  lines.push(
    `- **Commented:** ${tally.reviewed} · **skipped:** ${tally.skipped} · **failed:** ${tally.failed}`,
  );
  for (const { pr_number, outcome } of result.results) {
    if (outcome.ok) {
      lines.push(`- PR #${pr_number}: **${outcome.result.action}** — ${outcome.result.message ?? ""}`.trimEnd());
    } else {
      lines.push(`- PR #${pr_number}: **error** — ${outcome.error}`);
    }
  }
  return lines.join("\n") + "\n";
}
