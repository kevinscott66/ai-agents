/**
 * Окружение для CLI-процесса claude-agent-sdk — одна чистая функция без зависимостей.
 *
 * Держим отдельно от agent-sdk-runtime.ts по той же причине, по которой футер
 * канала живёт в channel-footer.ts: runtime тянет tools-schema → permissions →
 * audit → lib/db.ts, а там `new Database()` + миграции НА УРОВНЕ МОДУЛЯ.
 * Oneshot-скриптам (tools/daily-draft.ts) нужна отсюда ровно эта функция, а
 * доставалась им вся боевая БД — см. tests/approve-poll-no-db.test.ts.
 */

/**
 * Environment needed by the Claude executable. This is deliberately an
 * allowlist: the SDK child can run shell commands, so inheriting the
 * orchestrator environment would expose every application credential to it.
 * The OAuth credential is the one intentional exception: `options.env`
 * replaces the child environment entirely, so a server-side Claude Code
 * session cannot authenticate from `.env` unless this exact key is forwarded.
 * API, Telegram, GitHub, and application secrets remain excluded.
 */
export const SUBSCRIPTION_RUNTIME_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
  "TZ",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

/** Resolve the inference backend without reading or mutating process.env. */
export function shouldUseSubscription(
  source: Record<string, string | undefined> = process.env,
): boolean {
  const explicit = source.USE_AGENT_SDK?.trim().toLowerCase();
  if (explicit === "true") return true;
  if (explicit === "false") return false;
  return Boolean(source.CLAUDE_CODE_OAUTH_TOKEN?.trim());
}

/**
 * Build the complete child environment for the subscription-backed Claude
 * process. The optional source makes the security contract testable without
 * mutating the process environment.
 */
export function buildSubscriptionEnv(
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const cleanEnv: Record<string, string> = {};
  for (const k of SUBSCRIPTION_RUNTIME_ENV_KEYS) {
    const v = source[k];
    if (v === undefined) continue;
    cleanEnv[k] = v;
  }
  return cleanEnv;
}
