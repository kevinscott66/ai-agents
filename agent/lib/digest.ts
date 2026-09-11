/**
 * C18: Daily team digest.
 *
 * Once a day at DIGEST_HOUR_UTC, the orchestrator posts an aggregated status
 * summary to all ALLOWED chats. No LLM call — pure SQL + string templating.
 *
 * Tracks last-posted UTC date in a marker file so a process restart on the same
 * day does not re-post. The default path is NOT a bare `.digest-last` in the
 * cwd — that default was removed on 2026-08-08 precisely because the cwd is
 * read-only under the unit's `ProtectSystem=strict`. See `_defaultMarkerPath`:
 * the marker lands next to the DB.
 *
 * All time math is honest UTC. "Today" / "last 24h" means UTC.
 */
import fs from "node:fs";
import { dirname, join } from "node:path";
import { db, DB_PATH } from "./db.ts";
import { countPendingApprovalsInChat, oldestPendingApprovalAt } from "./approvals.ts";
import { getBudget } from "./token-budget.ts";
import { DAY_MS, MINUTE_MS } from "./time-constants.ts";
import { TASK_STATUSES } from "./types.ts";
import { log } from "./log.ts";

export interface BuildDigestOptions {
  /** Window start for "last 24h" sections. Defaults to now-24h. */
  since?: Date;
  /** Override "now" for stable headers in tests. */
  now?: Date;
}

const NO_DATA = "(no data)";

/** Format ms duration as compact human string. */
function fmtAge(ms: number): string {
  if (ms < 0) ms = 0;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h`;
  const day = Math.floor(hr / 24);
  return `${day}d`;
}

function ymdUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Build the digest text. Safe on empty DB. */
export function buildDigest(opts: BuildDigestOptions = {}): string {
  const now = opts.now ?? new Date();
  const since = opts.since ?? new Date(now.getTime() - DAY_MS);
  const sinceMs = since.getTime();
  // Аудит 2026-09-11: дата бралась двумя разными способами. Заголовок —
  // `ymdUTC(now)`, то есть от переданного «сейчас»; строка расхода токенов —
  // `todayUTC()`, то есть от настенных часов, мимо `opts.now`. Совпадало это
  // только тогда, когда `now` и есть «прямо сейчас». Дайджест, собранный за
  // вчера (перезапуск пропущенного прогона, backfill), выдавал заголовок со
  // вчерашней датой и расход токенов за сегодня — в одном сообщении, без
  // единого признака, что даты разные. Берём одну дату на весь дайджест.
  // Одно значение, а не два одноимённых вычисления: заголовок и выборка
  // расхода токенов обязаны называть один и тот же день, и разъехаться им
  // легче всего через второе `ymdUTC(now)`, которое кто-нибудь поправит в
  // одном месте.
  const digestDate = ymdUTC(now);

  const lines: string[] = [];
  lines.push(`📊 Daily digest — ${digestDate} (UTC)`);

  // --- Tasks: per-status counts over last 24h ----------------------------
  lines.push("");
  lines.push("Tasks (last 24h):");
  try {
    // Считаем ВСЕ статусы из канонического TASK_STATUSES: раньше список был
    // захардкожен без awaiting_review и cancelled, и в день, где вся
    // активность — запросы ревью и отмены, total выходил 0, а секция печатала
    // «(no data)» при живой доске. Ровно тот симптом, из-за которого дайджест
    // считали сломанным.
    const statuses = TASK_STATUSES;
    const counts: Record<string, number> = {};
    let total = 0;
    for (const s of statuses) {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS n FROM tasks
           WHERE status = ? AND updated_at >= ?`,
        )
        .get(s, sinceMs) as { n: number } | undefined;
      counts[s] = row?.n ?? 0;
      total += counts[s];
    }
    if (total === 0) {
      lines.push(`  ${NO_DATA}`);
    } else {
      for (const s of statuses) {
        lines.push(`  ${s}: ${counts[s]}`);
      }
    }
  } catch (e: any) {
    lines.push(`  (error: ${e?.message ?? e})`);
  }

  // --- Top 5 most active agents by action count (last 24h) ---------------
  lines.push("");
  lines.push("Top agents (last 24h):");
  try {
    const rows = db
      .prepare(
        `SELECT agent_key, COUNT(*) AS n
         FROM agent_actions
         WHERE created_at >= ?
         GROUP BY agent_key
         -- Второй ключ обязателен: при равном числе действий (а на тихих
         -- сутках равенство — норма, не редкость) LIMIT 5 без него отдаёт
         -- произвольную пятёрку из шести, и дайджест меняет состав от прогона
         -- к прогону без изменений в данных. Аудит 2026-09-11.
         ORDER BY n DESC, agent_key ASC
         LIMIT 5`,
      )
      .all(sinceMs) as { agent_key: string; n: number }[];
    if (!rows.length) {
      lines.push(`  ${NO_DATA}`);
    } else {
      for (const r of rows) {
        lines.push(`  ${r.agent_key}: ${r.n} actions`);
      }
    }
  } catch (e: any) {
    lines.push(`  (error: ${e?.message ?? e})`);
  }

  // --- Approvals: pending count + oldest age -----------------------------
  lines.push("");
  lines.push("Approvals:");
  try {
    // Аудит 2026-08-28: было `listPendingApprovals(undefined, 1000)` — тысяча
    // полных строк с JOIN ради длины массива и минимума по created_at. Счётчик
    // упирался в 1000 и замирал ровно тогда, когда очередь становится
    // проблемой. Обе величины теперь берём агрегатами, без потолка.
    // Без chatId — намеренно: дайджест ежедневный и общий, очередь в нём
    // считается по всем чатам сразу. Имя функции («InChat») читается иначе,
    // поэтому оговорка стоит здесь, у вызова, а не только в сигнатуре.
    const count = countPendingApprovalsInChat();
    const oldest = oldestPendingApprovalAt();
    if (!count || oldest === null) {
      lines.push(`  ${NO_DATA}`);
    } else {
      const age = fmtAge(now.getTime() - oldest);
      lines.push(`  pending: ${count}, oldest: ${age}`);
    }
  } catch (e: any) {
    lines.push(`  (error: ${e?.message ?? e})`);
  }

  // --- Token usage: top 3 agents by input tokens today -------------------
  lines.push("");
  lines.push("Token usage (today UTC):");
  try {
    const rows = db
      .prepare(
        `SELECT agent_key, input_tokens AS input, output_tokens AS output
         FROM agent_token_usage
         WHERE date = ?
         -- Тот же случай, что и у топа агентов выше: нули на старте суток
         -- равны между собой, и тройка была бы произвольной.
         ORDER BY input_tokens DESC, agent_key ASC
         LIMIT 3`,
      )
      .all(digestDate) as { agent_key: string; input: number; output: number }[];
    if (!rows.length) {
      lines.push(`  ${NO_DATA}`);
    } else {
      for (const r of rows) {
        const budget = getBudget(r.agent_key);
        const pct = Number.isFinite(budget) && budget > 0
          ? ` (${Math.round((r.input / budget) * 100)}% of ${budget})`
          : "";
        lines.push(`  ${r.agent_key}: in=${r.input} out=${r.output}${pct}`);
      }
    }
  } catch (e: any) {
    lines.push(`  (error: ${e?.message ?? e})`);
  }

  // --- Errors: failed actions + self-diag retries last 24h ---------------
  lines.push("");
  lines.push("Errors (last 24h):");
  try {
    const failedActions = (db
      .prepare(
        `SELECT COUNT(*) AS n FROM agent_actions
         WHERE status = 'error' AND created_at >= ?`,
      )
      .get(sinceMs) as { n: number } | undefined)?.n ?? 0;
    // Self-diag retries: tasks created in window whose input JSON contains _diag.
    const diagRetries = (db
      .prepare(
        `SELECT COUNT(*) AS n FROM tasks
         WHERE created_at >= ? AND input LIKE '%"_diag":true%'`,
      )
      .get(sinceMs) as { n: number } | undefined)?.n ?? 0;
    if (failedActions === 0 && diagRetries === 0) {
      lines.push(`  ${NO_DATA}`);
    } else {
      lines.push(`  failed actions: ${failedActions}`);
      lines.push(`  self-diag retries: ${diagRetries}`);
    }
  } catch (e: any) {
    lines.push(`  (error: ${e?.message ?? e})`);
  }

  return lines.join("\n");
}

// ===========================================================================
// Scheduler
// ===========================================================================

export interface DigestSender {
  sendMessage(chatId: string | number, text: string): Promise<unknown>;
}

export interface StartDigestSchedulerOptions {
  sender: DigestSender;
  chatIds: string[];
  /** UTC hour [0..23] at which to post. Default 6. */
  hourUTC?: number;
  /** Polling interval, ms. Default 5min. */
  intervalMs?: number;
  /**
   * Path to last-posted-date marker file. Defaults to `_defaultMarkerPath()`
   * — next to the DB, not to the cwd. Read the docblock there before passing a
   * relative path: the unit can only write `data`, `backups` and `/tmp`.
   */
  markerPath?: string;
  /** Override "now" provider, used by tests. */
  nowProvider?: () => Date;
  /**
   * Injectable marker writer — allows tests to simulate write failures without
   * relying on filesystem permissions (which root bypasses on VPS).
   * Throw to simulate EROFS / EACCES; the scheduler then keeps the day-flag
   * in memory only, same as the real prod failure path.
   */
  _markerWriter?: (path: string, value: string) => void;
}

export interface DigestSchedulerHandle {
  stop(): void;
  /** Force a posting attempt now (idempotent for the current UTC day). */
  _runNow(): Promise<boolean>;
}

function readMarker(path: string): string | null {
  try {
    if (!fs.existsSync(path)) return null;
    return fs.readFileSync(path, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function writeMarker(
  path: string,
  value: string,
  writer: (p: string, v: string) => void = (p, v) => fs.writeFileSync(p, v),
): boolean {
  try {
    writer(path, value);
    return true;
  } catch (e) {
    log.warn(`[digest] cannot write marker ${path}`, { error: (e as Error)?.message });
    return false;
  }
}

/**
 * Куда класть маркер по умолчанию.
 *
 * Аудит 2026-08-08: дефолтом был относительный `.digest-last`, то есть
 * `WorkingDirectory` юнита = `/opt/agent-team`. А юнит поднят с
 * `ProtectSystem=strict`, и в `ReadWritePaths` перечислены только
 * `data`, `backups` и `/tmp` — сам корень смонтирован read-only, запись даёт
 * EROFS. Провал записи глотался в log.warn, другого состояния «сегодня уже
 * постили» не было, и каждый тик (5 минут) заново проходил обе проверки: до
 * ~216 копий дайджеста в каждый чат за сутки, и так каждый день.
 *
 * Кладём маркер рядом с БД — этот каталог юнит писать разрешает, и путь не
 * зависит от cwd. Ровно тот же вывод уже сделан для db-maint (маркер в
 * таблице maint_state, migrations.ts), просто на дайджест его не перенесли.
 */
export function _defaultMarkerPath(): string {
  const dir = dirname(DB_PATH);
  return dir && dir !== "." ? join(dir, ".digest-last") : ".digest-last";
}

/**
 * Час UTC как целое 0..23, иначе дефолт.
 *
 * Аудит 2026-08-08: было `opts.hourUTC ?? 6`, а значение приходит из
 * `Number(process.env.DIGEST_HOUR_UTC)` (orchestrator/services.ts). `??` ловит
 * только null/undefined — опечатка в env даёт NaN, и он проезжает насквозь.
 * Дальше `now.getUTCHours() < NaN` всегда false, то есть окно «не раньше
 * hourUTC» исчезает: дайджест уходил в первый же тик после полуночи UTC. Раз в
 * сутки — но не тогда, когда просили, и без единой жалобы в логе.
 *
 * В проекте это уже конвенция (readPerChatMax, readUserbotFloodMax): негодное
 * значение env откатывается к дефолту, а не расползается по коду.
 *
 * Аудит 2026-08-28: описанный выше путь из прода больше не приходит — с
 * `_envHour("DIGEST_HOUR_UTC", 6)` (orchestrator/services.ts) NaN до сюда не
 * доезжает, там уже и валидация, и откат к дефолту. Проверка остаётся: она
 * стоит на границе экспортируемого API, а не на одном известном вызывающем.
 */
function sanitizeHourUTC(v: number | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  if (!Number.isInteger(v) || v < 0 || v > 23) {
    log.warn("[digest] некорректный hourUTC — берём дефолт", { got: v, fallback });
    return fallback;
  }
  return v;
}

export function startDigestScheduler(
  opts: StartDigestSchedulerOptions,
): DigestSchedulerHandle {
  const hourUTC = sanitizeHourUTC(opts.hourUTC, 6);
  const intervalMs = opts.intervalMs ?? 5 * MINUTE_MS;
  const markerPath = opts.markerPath ?? _defaultMarkerPath();
  const nowProvider = opts.nowProvider ?? (() => new Date());
  const fsWrite = opts._markerWriter ?? ((p: string, v: string) => fs.writeFileSync(p, v));

  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  // Второе состояние «сегодня уже постили», не зависящее от диска. `running`
  // защищает только от конкурентного входа, а маркер мог не записаться —
  // и тогда единственным следом дайджеста оставалась строка в логе.
  // Рестарт этот флаг теряет (это уже задача файла-маркера), но storm
  // «каждые 5 минут весь день» закрывает полностью.
  let postedYmd: string | null = null;

  // Always honest UTC.
  const post = async (force: boolean): Promise<boolean> => {
    if (running) return false;
    running = true;
    try {
      const now = nowProvider();
      const today = ymdUTC(now);
      const last = postedYmd ?? readMarker(markerPath);
      if (!force) {
        if (now.getUTCHours() < hourUTC) return false;
        if (last === today) return false;
      } else {
        if (last === today) return false;
      }
      const text = buildDigest({ now });
      // Отмечаемся ДО отправки: отправитель, упавший на полпути, не должен
      // превращаться в бесконечный ретрай — следующий тик пропустит до завтра.
      // Сначала в память, потом на диск: если диск не пишется (read-only
      // корень юнита, ENOSPC), день всё равно считается закрытым, а не
      // переигрывается каждые 5 минут.
      postedYmd = today;
      if (!writeMarker(markerPath, today, fsWrite)) {
        log.warn("[digest] маркер не записан — до рестарта держим дату в памяти", {
          markerPath,
          today,
        });
      }
      let delivered = 0;
      for (const chatId of opts.chatIds) {
        try {
          await opts.sender.sendMessage(chatId, text);
          delivered++;
        } catch (e) {
          log.warn(`[digest] sendMessage to ${chatId} failed`, { error: (e as Error)?.message });
        }
      }
      // Аудит 2026-08-20: полный провал доставки выглядел точно так же, как
      // успех, — маркер записан выше, `true` возвращён, а в журнале только
      // warn'ы вперемешку с остальными. День при этом закрыт: повтора не
      // будет (и не должно быть — см. комментарий выше про бесконечный
      // ретрай). Значит единственный шанс узнать о пропаже — эта строка.
      // Ноль чатов в конфиге сюда же: дайджест уходит в никуда молча.
      if (delivered === 0) {
        log.error("[digest] не доставлен НИ В ОДИН чат — день закрыт, повтора не будет", {
          chats: opts.chatIds.length,
          today,
          markerPath,
        });
        return false;
      }
      if (delivered < opts.chatIds.length) {
        log.warn(`[digest] доставлен в ${delivered} из ${opts.chatIds.length} чатов`, { today });
      }
      return true;
    } finally {
      running = false;
    }
  };

  const tick = async () => {
    if (stopped) return;
    try {
      await post(false);
    } catch (e) {
      log.warn("[digest] tick error", { error: (e as Error)?.message });
    }
  };

  timer = setInterval(tick, intervalMs);
  log.info(
    `[digest] scheduler started: hourUTC=${hourUTC}, every ${Math.round(
      intervalMs / 1000,
    )}s, chats=${opts.chatIds.length}, marker=${markerPath}`,
  );

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
    },
    async _runNow() {
      return post(true);
    },
  };
}
