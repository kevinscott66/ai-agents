/**
 * Read-only GitHub client (Layer 1 — agents get repo VISIBILITY, never write).
 *
 * Security:
 *   - token (GITHUB_READ_TOKEN) is a fine-grained, read-only PAT.
 *   - the repo is a SERVER-SIDE constant (GITHUB_REPO env), NOT an agent param —
 *     so an agent cannot point the token at an arbitrary repo (no SSRF/probing).
 *   - fetchJson centralizes timeout + size cap.
 *   - mutations (push/merge/dispatch) are deliberately NOT implemented here.
 *
 * Аудит 2026-08-20: обещание «no SSRF/probing» держалось только на том, что
 * GITHUB_REPO ставит человек. Формат не проверялся вообще, а значение шло в
 * ПУТЬ URL как есть. `owner/repo?x=1` открывает query-строку: запрос уходит на
 * `/repos/owner/repo`, GitHub отвечает 200 объектом репозитория, все три
 * шейпера получают не тот тип и молча возвращают [] — fetchGithubStatus при
 * этом рапортует ok:true, и агент сообщает команде «CI чист, открытых PR нет»
 * вместо ошибки, ровно в том туле, ради которого его и спрашивают.
 * `../../user` схлопывает путь в https://api.github.com/user — read-токен
 * уходит на чужой эндпоинт. Поэтому формат теперь проверяется явно.
 */
import { fetchJson } from "./http.ts";

const GH_API = "https://api.github.com";
const DEFAULT_REPO = "kevinscott66/ai-agents";

export function githubConfigured(): boolean {
  return !!process.env.GITHUB_READ_TOKEN;
}

/**
 * owner/repo по правилам GitHub: только [A-Za-z0-9._-], ровно один слэш.
 * `.` разрешена (репозитории вида `foo.github.io`), но `..` и `?`/`#`/`/`
 * внутри сегмента — нет, а значит ни выхода вверх, ни открытия query.
 */
const REPO_RE = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;

export function repo(): string {
  const raw = (process.env.GITHUB_REPO ?? "").trim();
  if (!raw) return DEFAULT_REPO;
  if (!REPO_RE.test(raw) || raw.includes("..")) {
    // Отказ, а не тихий фолбэк на DEFAULT_REPO: иначе оператор, опечатавшийся
    // в GITHUB_REPO, получит бодрый отчёт по ЧУЖОМУ (дефолтному) репозиторию
    // и не узнает об этом.
    throw new Error(
      "GITHUB_REPO должен быть в формате owner/repo (буквы, цифры, . _ -)",
    );
  }
  return raw;
}

async function gh<T>(path: string): Promise<T> {
  const token = process.env.GITHUB_READ_TOKEN;
  if (!token) throw new Error("GITHUB_READ_TOKEN is not set");
  return fetchJson<T>(`${GH_API}/repos/${repo()}${path}`, {
    label: "github",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "agent-team",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    maxBytes: 3_000_000,
  });
}

export interface GithubStatus {
  repo: string;
  ci: Array<{ name: string; branch: string; status: string; conclusion: string | null }>;
  openPRs: Array<{ number: number; title: string; draft: boolean; branch: string }>;
  recentCommits: Array<{ sha: string; message: string; author: string }>;
}

/** Чистые шейперы (тестируемо без сети). */
export function shapeRuns(runs: unknown): GithubStatus["ci"] {
  // Аудит 2026-08-29: здесь стоял `?? []`, а он ловит только null/undefined —
  // на любом другом значении под ключом (объект, строка, число) шейпер бросал
  // TypeError вместо обещанного докблоком файла «молча возвращают []». Из
  // fetchGithubStatus это неотличимо от обрыва сети: в логе GET_METRICS
  // остаётся «runs.slice is not a function» без намёка, что ответ пришёл.
  // Соседние shapePRs/shapeCommits проверяют тип с самого начала — теперь и
  // этот тоже.
  const raw = (runs as { workflow_runs?: unknown })?.workflow_runs;
  const arr = Array.isArray(raw) ? raw : [];
  return arr.slice(0, 5).map((r) => {
    const x = r as Record<string, unknown>;
    return {
      name: String(x.name ?? "?"),
      branch: String(x.head_branch ?? "?"),
      status: String(x.status ?? "?"),
      conclusion: x.conclusion == null ? null : String(x.conclusion),
    };
  });
}

export function shapePRs(prs: unknown): GithubStatus["openPRs"] {
  const arr = Array.isArray(prs) ? prs : [];
  return arr.slice(0, 15).map((p) => {
    const x = p as Record<string, unknown>;
    return {
      number: Number(x.number ?? 0),
      title: String(x.title ?? "").slice(0, 120),
      draft: Boolean(x.draft),
      branch: String((x.head as Record<string, unknown> | undefined)?.ref ?? "?"),
    };
  });
}

export function shapeCommits(commits: unknown): GithubStatus["recentCommits"] {
  const arr = Array.isArray(commits) ? commits : [];
  return arr.slice(0, 5).map((c) => {
    const x = c as Record<string, unknown>;
    const commit = (x.commit as Record<string, unknown> | undefined) ?? {};
    const author = (commit.author as Record<string, unknown> | undefined) ?? {};
    return {
      sha: String(x.sha ?? "").slice(0, 7),
      message: String(commit.message ?? "").split("\n")[0].slice(0, 80),
      author: String(author.name ?? "?"),
    };
  });
}

export async function fetchGithubStatus(): Promise<GithubStatus> {
  const [runs, prs, commits] = await Promise.all([
    gh<unknown>("/actions/runs?per_page=5"),
    gh<unknown>("/pulls?state=open&per_page=15"),
    gh<unknown>("/commits?per_page=5"),
  ]);
  return {
    repo: repo(),
    ci: shapeRuns(runs),
    openPRs: shapePRs(prs),
    recentCommits: shapeCommits(commits),
  };
}
