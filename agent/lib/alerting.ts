/**
 * T-325 Alerting hooks (T-303 HIGH observability).
 *
 * Minimal in-process alert emitter for 3 known-painful conditions:
 *   1. DB-maint failure (archive/compact threw)
 *   2. Approval backlog (too many pending approvals older than N min)
 *   3. Rate-limit storm (too many rate_limited rejections in window)
 *
 * Each alert:
 *   - log.error(...) with structured fields (severity, code)
 *   - row inserted into `audit_logs` so dashboards / archive pipeline can pick it up.
 *
 * External sinks (PagerDuty, Slack, Telegram) are NOT wired yet — that's a
 * future plug-in over `emitAlert`. Keep this file small and side-effect-light.
 *
 * Thresholds are env-driven, defaults are conservative (high) to avoid noise.
 * Setting a threshold to 0 disables that alert ("off").
 */
import { MAX_TIMER_MS } from "./constants.ts";
import { getErrorMessage } from "./errors.ts";
import { db } from "./db.ts";
import { log, scrubSecretsDeep } from "./log.ts";

export type AlertSeverity = "info" | "warn" | "error" | "critical";

export interface EmitAlertOptions {
  /** Override "now" (ms epoch) — tests only. */
  now?: number;
  /** Skip audit_logs write (tests). */
  skipAuditLog?: boolean;
}

/**
 * Emit a single alert. Writes to log.error AND to audit_logs table.
 * Best-effort: a failure to write the audit row is logged but does not throw.
 */
export function emitAlert(
  severity: AlertSeverity,
  code: string,
  message: string,
  data: Record<string, unknown> = {},
  opts: EmitAlertOptions = {},
): void {
  const now = opts.now ?? Date.now();
  log.error(message, { severity, code, ...data });

  if (opts.skipAuditLog) return;
  try {
    db.prepare(
      `INSERT INTO audit_logs(id, agent_key, chat_id, event_type, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      crypto.randomUUID(),
      "system",
      null,
      `alert.${code}`,
      // Аудит 2026-08-28: строкой выше те же данные уходят в лог через
      // скраббер, а сюда уезжали сырыми — при том что `audit_logs` отдаёт
      // наружу /api/audit Mini App и забирает архив. `data.error` тут
      // произвольный текст чужой ошибки (telegraf-patch.ts, backup.ts,
      // db-maint.ts), то есть ровно то, ради чего скраббер и написан.
      JSON.stringify(scrubSecretsDeep({ severity, message, ...data })),
      now,
    );
  } catch (e) {
    // Don't recurse via emitAlert — just log raw.
    log.error("alerting: failed to write audit_log row", {
      code,
      error: getErrorMessage(e),
    });
  }
}

/* --------------------------------------------------------------------------
 * Thresholds (env-driven, with safe defaults).
 * `0` means "alert disabled".
 * -------------------------------------------------------------------------- */

function envInt(name: string, dflt: number): number {
  const v = process.env[name];
  if (v == null) return dflt;
  // Аудит 2026-08-20: без trim() строка из одних пробелов давала Number("  ")
  // === 0, а ноль здесь означает «алерт выключен навсегда». То есть `ALERT_X=`
  // (пусто) читалось как «дефолт», а `ALERT_X= ` — лишний пробел после знака
  // равенства, самая частая правка .env руками — молча глушило алерт. Для
  // ALERT_RATE_LIMIT_STORM_WINDOW_MINUTES это хуже вдвойне: окно 0 делает
  // выборку пустой при любом числе отказов, при этом тик шедулера продолжает
  // жить (stormTickMs клэмпит период снизу), так что снаружи всё «работает».
  // Соседний parseBudgetEnv в token-budget.ts уже проверяет ровно так.
  const s = v.trim();
  if (s === "") return dflt;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return dflt;
  return Math.floor(n);
}

export interface AlertThresholds {
  approvalBacklogMin: number;
  approvalBacklogAgeMinutes: number;
  rateLimitStormCount: number;
  rateLimitStormWindowMinutes: number;
  /** Не повторять сигнал о шторме чаще, чем раз в столько минут. */
  rateLimitStormCooldownMinutes: number;
  /** То же для бэклога аппрувалов. */
  approvalBacklogCooldownMinutes: number;
}

/* --------------------------------------------------------------------------
 * Кулдаун повторных сигналов.
 *
 * Проверка шторма смотрит в окно, которое короче суток, поэтому её надо
 * опрашивать с частотой самого окна (иначе она видит лишь его долю — см.
 * checkRateLimitStorm). Частый опрос без кулдауна превратил бы длящийся шторм
 * в поток одинаковых алертов.
 *
 * Состояние процессное: рестарт разрешает сигнал заново — это правильно, после
 * рестарта состояние системы другое.
 * -------------------------------------------------------------------------- */

const MIN_MS = 60_000;

const lastAlertAt = new Map<string, number>();

function takeCooldown(code: string, now: number, minutes: number): boolean {
  if (minutes <= 0) return true; // кулдаун выключен
  const prev = lastAlertAt.get(code);
  if (prev !== undefined && now - prev < minutes * MIN_MS) return false;
  lastAlertAt.set(code, now);
  return true;
}

/** Тестовый хук: сбросить кулдауны между кейсами. */
export function _resetAlertCooldowns(): void {
  lastAlertAt.clear();
}

/**
 * С какой частотой опрашивать проверку шторма.
 *
 * Инвариант простой: период опроса не длиннее окна наблюдения — иначе между
 * опросами остаётся слепая зона и проверка видит лишь долю времени. Нижняя
 * граница в минуту — чтобы абсурдно короткое окно из env не устроило опрос
 * каждую секунду; опрос дешёвый, но не бесплатный.
 *
 * Аудит 2026-08-28: верхней границы не было, а `envInt` принимает любое
 * конечное неотрицательное число. `…WINDOW_MINUTES=300000` (путаница «минуты
 * vs миллисекунды»: соседние `WATCHDOG_INTERVAL_MS`, `HEALTH_INTERVAL_MS` как
 * раз в мс) даёт 1.8e10 мс — за пределом знакового 32-битного int, и
 * setInterval ставит период в 1 мс вместо суток. Зажатие сверху инвариант не
 * ломает: MAX_TIMER_MS в таком случае заведомо меньше окна.
 */
export function stormTickMs(thresholds?: Partial<AlertThresholds>): number {
  const t = { ...getThresholds(), ...(thresholds ?? {}) };
  return Math.min(
    MAX_TIMER_MS,
    Math.max(MIN_MS, t.rateLimitStormWindowMinutes * MIN_MS),
  );
}

export function getThresholds(): AlertThresholds {
  return {
    approvalBacklogMin: envInt("ALERT_APPROVAL_BACKLOG_MIN", 10),
    approvalBacklogAgeMinutes: envInt("ALERT_APPROVAL_BACKLOG_AGE_MINUTES", 60),
    approvalBacklogCooldownMinutes: envInt(
      "ALERT_APPROVAL_BACKLOG_COOLDOWN_MINUTES",
      360,
    ),
    rateLimitStormCount: envInt("ALERT_RATE_LIMIT_STORM_COUNT", 50),
    rateLimitStormWindowMinutes: envInt(
      "ALERT_RATE_LIMIT_STORM_WINDOW_MINUTES",
      5,
    ),
    rateLimitStormCooldownMinutes: envInt(
      "ALERT_RATE_LIMIT_STORM_COOLDOWN_MINUTES",
      60,
    ),
  };
}

/* --------------------------------------------------------------------------
 * Individual checks. Each is cheap (single COUNT(*) query).
 * Returns true if alert fired (mostly for tests).
 * -------------------------------------------------------------------------- */

export interface CheckOptions {
  /** Override "now" (ms epoch) — tests only. */
  now?: number;
  thresholds?: Partial<AlertThresholds>;
}

/** Approval backlog: count pending approvals older than ageMinutes. */
export function checkApprovalBacklog(opts: CheckOptions = {}): boolean {
  const t = { ...getThresholds(), ...(opts.thresholds ?? {}) };
  if (t.approvalBacklogMin === 0) return false; // disabled
  const now = opts.now ?? Date.now();
  const ageCutoff = now - t.approvalBacklogAgeMinutes * MIN_MS;
  let count = 0;
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM approvals
         WHERE status='pending' AND created_at < ?`,
      )
      .get(ageCutoff) as { n: number } | undefined;
    count = row?.n ?? 0;
  } catch (e) {
    log.warn("alerting: approval backlog query failed", {
      error: getErrorMessage(e),
    });
    return false;
  }
  if (count >= t.approvalBacklogMin) {
    // Аудит 2026-08-09: кулдаун был приделан к проверке шторма и не приделан
    // к этой — хотя повторяется как раз эта. Шторм по природе короткий, а
    // «висят неразобранные аппрувалы» — это ожидание решения человека, оно
    // длится сутками. Хендлер зовётся раз в час, emitAlert пишет и log.error,
    // и строку в audit_logs, так что один незакрытый бэклог давал ~24 записи
    // в сутки — тот самый «поток одинаковых алертов», ради которого кулдаун
    // и написан. Механика уже есть и ключуется по коду алерта.
    if (!takeCooldown("approval.backlog", now, t.approvalBacklogCooldownMinutes)) {
      return false;
    }
    emitAlert(
      "warn",
      "approval.backlog",
      `approval backlog: ${count} pending approvals older than ${t.approvalBacklogAgeMinutes}m`,
      {
        count,
        ageMinutes: t.approvalBacklogAgeMinutes,
        threshold: t.approvalBacklogMin,
      },
      { now },
    );
    return true;
  }
  return false;
}

/**
 * Rate-limit storm: count rate_limited rows in agent_actions inside window.
 * The codebase records rate-limit rejections via `logAction(... status='rate_limited' ...)`
 * in agent_actions (see `gateOrDispatch` in action-dispatch.ts).
 *
 * Аудит 2026-08-08: окно по умолчанию 5 минут, а вызывали проверку раз в час
 * (db-maint.ts, alertTimer). Проверка смотрит `created_at >= now - 5м`, то есть
 * наблюдала 1/12 каждого часа: шторм на десятой минуте к моменту тика уже
 * полностью выпадал из окна. Пропускалась и устойчивая перегрузка — те же 10
 * отказов в минуту весь час не видны, если не попали в последние пять минут.
 *
 * Период опроса не должен быть длиннее окна — см. alertingTickMs в db-maint.
 */
export function checkRateLimitStorm(opts: CheckOptions = {}): boolean {
  const t = { ...getThresholds(), ...(opts.thresholds ?? {}) };
  if (t.rateLimitStormCount === 0) return false; // disabled
  const now = opts.now ?? Date.now();
  const winStart = now - t.rateLimitStormWindowMinutes * MIN_MS;
  let count = 0;
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM agent_actions
         WHERE status='rate_limited' AND created_at >= ?`,
      )
      .get(winStart) as { n: number } | undefined;
    count = row?.n ?? 0;
  } catch (e) {
    log.warn("alerting: rate-limit storm query failed", {
      error: getErrorMessage(e),
    });
    return false;
  }
  if (count >= t.rateLimitStormCount) {
    // Шторм длится дольше одного окна — сигнал об этом нужен один, а не
    // каждые пять минут, пока он идёт.
    if (!takeCooldown("rate_limit.storm", now, t.rateLimitStormCooldownMinutes)) {
      return false;
    }
    emitAlert(
      "warn",
      "rate_limit.storm",
      `rate-limit storm: ${count} rejections in past ${t.rateLimitStormWindowMinutes}m`,
      {
        count,
        windowMinutes: t.rateLimitStormWindowMinutes,
        threshold: t.rateLimitStormCount,
      },
      { now },
    );
    return true;
  }
  return false;
}

// Аудит 2026-08-29: агрегатор `checkBacklogAlerts` удалён. Он существовал
// ради одного вызова из часового тика db-maint, и когда проверку шторма
// вынесли на собственный таймер (2026-08-08), пережил эту правку молча —
// прод продолжал звать обе проверки часовым тиком вопреки комментарию рядом.
// Периоды у проверок разные по своей природе: backlog считает возраст,
// шторм — частоту в окне. Пары «удобно звать вместе» у них нет.
