/**
 * Отложенные проверки: SCHEDULE_FOLLOWUP / CANCEL_FOLLOWUP и таймер, который в
 * срок будит самого агента.
 *
 * Зачем. 2026-09-18 Mac не отвечал, и агент предложил владельцу «напомнить
 * через пару минут» — то есть поручил доделать дело человеку. Напоминание
 * (lib/reminders.ts) тут не годится: оно только шлёт текст и агента не будит.
 * Проверка — наоборот: в срок сервер пишет владельцу «Проверяю, как обещал:
 * <задача>» и запускает ход оркестратора ответом на это сообщение. Агент
 * делает задачу сам и пишет итог.
 *
 * Границы.
 *  - Ставит только оркестратор, только в личном чате владельца и без
 *    делегирования (followupRefusal) — ход в срок идёт от имени владельца, и
 *    завести его из группы или по просьбе другой роли нельзя.
 *  - Задача — пометка агента, а не слова владельца: так она и подаётся в ход
 *    (renderFollowupTurn). Деньги по-прежнему только через подпись Face ID,
 *    сообщения третьим лицам — через подтверждение: ход проходит те же гейты.
 *  - Потолки против зацикленного агента: MAX_ACTIVE активных и MAX_PER_DAY
 *    заведённых за сутки на чат. Проверка может поставить следующую — цепочка
 *    упрётся в суточный потолок.
 *  - Захват атомарный (scheduled → running). Рестарт посреди хода оставляет
 *    'running'; повторять нельзя — ход мог уже что-то сделать, поэтому такие
 *    строки становятся 'failed'.
 *  - Сбой отправки вступления (до хода) — «не начато»: строка возвращается в
 *    'scheduled', всего до MAX_ATTEMPTS попыток.
 */
import { db } from "./db.ts";
import { log } from "./log.ts";
import { safeTick } from "./safe-timer.ts";
import { getErrorMessage } from "./errors.ts";
import { parseUserIdList } from "./allowlist.ts";
import { DAY_MS, MINUTE_MS, SECOND_MS } from "./time-constants.ts";
import { formatMsk, isoMsk } from "./reminder-time.ts";

export const FOLLOWUP_TASK_MAX = 300;
export const FOLLOWUP_MIN_MIN = 1;
export const FOLLOWUP_MAX_MIN = 24 * 60;
export const MAX_ACTIVE_FOLLOWUPS = 5;
export const MAX_FOLLOWUPS_PER_DAY = 20;
export const MAX_ATTEMPTS = 3;
/** Ход дольше этого — процесс умер посреди него. */
export const RUNNING_STALE_MS = 30 * MINUTE_MS;
export const DEFAULT_TICK_MS = 30 * SECOND_MS;

export type FollowupStatus = "scheduled" | "running" | "done" | "cancelled" | "failed";

export interface FollowupRow {
  id: string;
  chat_id: number;
  user_id: string;
  agent_key: string;
  task: string;
  due_at: number;
  status: FollowupStatus;
  attempts: number;
  created_at: number;
  claimed_at: number | null;
  finished_at: number | null;
  error: string | null;
}

export const followupsEnabled = () => process.env.FOLLOWUPS_ENABLED !== "false";

export type FollowupCaller = {
  agentKey: string;
  chatId: number;
  triggerUserId?: string;
  delegationChain?: string[];
};

/** Только оркестратор, только владелец в своём личном чате, без делегирования. */
export function followupRefusal(c: FollowupCaller): string | null {
  if (!followupsEnabled()) return "отложенные проверки выключены (FOLLOWUPS_ENABLED)";
  if (c.agentKey !== "orchestrator") return `forbidden: followups are restricted to orchestrator (caller: ${c.agentKey})`;
  const delegated = (c.delegationChain ?? []).some((k) => k !== c.agentKey);
  const owners = parseUserIdList(process.env.MINIAPP_ADMIN_USER_IDS);
  const userId = c.triggerUserId;
  if (delegated || !userId || !owners.includes(Number(userId)) || String(c.chatId) !== userId) {
    return "forbidden: отложенные проверки — только в личном чате владельца";
  }
  return null;
}

// ─── Хранилище ──────────────────────────────────────────────────────────────

export function getFollowup(id: string): FollowupRow | null {
  return (db.prepare(`SELECT * FROM followups WHERE id = ?`).get(id) as FollowupRow | null) ?? null;
}

export function activeFollowups(chatId: number): FollowupRow[] {
  return db
    .prepare(`SELECT * FROM followups WHERE chat_id = ? AND status IN ('scheduled','running') ORDER BY due_at ASC, id ASC`)
    .all(chatId) as FollowupRow[];
}

export function createFollowup(opts: {
  chatId: number;
  userId: string;
  agentKey: string;
  task: unknown;
  inMin: unknown;
  now?: number;
}): { ok: true; followup: FollowupRow } | { ok: false; error: string } {
  const now = opts.now ?? Date.now();
  const task = typeof opts.task === "string" ? opts.task.trim() : "";
  if (!task) return { ok: false, error: "task is required" };
  if (task.length > FOLLOWUP_TASK_MAX) return { ok: false, error: `task is too long (max ${FOLLOWUP_TASK_MAX} chars)` };
  const inMin = typeof opts.inMin === "number" ? opts.inMin : Number(opts.inMin);
  if (!Number.isInteger(inMin) || inMin < FOLLOWUP_MIN_MIN || inMin > FOLLOWUP_MAX_MIN) {
    return { ok: false, error: `in_min must be an integer ${FOLLOWUP_MIN_MIN}..${FOLLOWUP_MAX_MIN}` };
  }
  const active = activeFollowups(opts.chatId).length;
  if (active >= MAX_ACTIVE_FOLLOWUPS) {
    return { ok: false, error: `уже ${active} активных проверок (максимум ${MAX_ACTIVE_FOLLOWUPS}): сними лишнюю через CANCEL_FOLLOWUP` };
  }
  const today = (
    db.prepare(`SELECT COUNT(*) AS n FROM followups WHERE chat_id = ? AND created_at >= ?`).get(opts.chatId, now - DAY_MS) as {
      n: number;
    }
  ).n;
  if (today >= MAX_FOLLOWUPS_PER_DAY) {
    return { ok: false, error: `за сутки поставлено ${today} проверок (максимум ${MAX_FOLLOWUPS_PER_DAY}): скажи владельцу, что проверять дальше сам не буду` };
  }
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO followups (id, chat_id, user_id, agent_key, task, due_at, status, attempts, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'scheduled', 0, ?)`,
  ).run(id, opts.chatId, opts.userId, opts.agentKey, task, now + inMin * MINUTE_MS, now);
  return { ok: true, followup: getFollowup(id)! };
}

/** Отмена в своём чате; чужой id снаружи неотличим от несуществующего. */
export function cancelFollowup(id: string, chatId: number): { ok: true; id: string } | { ok: false; error: string } {
  const res = db
    .prepare(`UPDATE followups SET status = 'cancelled', finished_at = ? WHERE id = ? AND chat_id = ? AND status = 'scheduled'`)
    .run(Date.now(), id, chatId);
  if (res.changes === 1) return { ok: true, id };
  const own = db.prepare(`SELECT status FROM followups WHERE id = ? AND chat_id = ?`).get(id, chatId) as
    | { status: FollowupStatus }
    | undefined;
  if (own) {
    return {
      ok: false,
      error: own.status === "running" ? "проверка уже идёт, снять поздно" : `проверка уже '${own.status}', снимать нечего`,
    };
  }
  return { ok: false, error: "no active followup with this id in this chat" };
}

/** Короткий вид для модели. */
export function followupView(r: FollowupRow) {
  return { id: r.id, at: isoMsk(r.due_at), at_msk: formatMsk(r.due_at), status: r.status, task: r.task };
}

// ─── Инструменты ────────────────────────────────────────────────────────────

export function scheduleFollowupTool(input: Record<string, unknown>, ctx: FollowupCaller): { ok: boolean } & Record<string, unknown> {
  const refusal = followupRefusal(ctx);
  if (refusal) return { ok: false, error: refusal };
  const made = createFollowup({
    chatId: ctx.chatId,
    userId: ctx.triggerUserId!,
    agentKey: ctx.agentKey,
    task: input.task,
    inMin: input.in_min,
  });
  if (!made.ok) return made;
  return {
    ok: true,
    followup: followupView(made.followup),
    active: activeFollowups(ctx.chatId).map(followupView),
    note: "в срок сервер разбудит тебя с этой задачей; владельцу напоминать не нужно",
  };
}

export function cancelFollowupTool(input: Record<string, unknown>, ctx: FollowupCaller): { ok: boolean } & Record<string, unknown> {
  const refusal = followupRefusal(ctx);
  if (refusal) return { ok: false, error: refusal };
  const id = typeof input.id === "string" ? input.id.trim() : "";
  if (!id) return { ok: false, error: "id is required" };
  const out = cancelFollowup(id, ctx.chatId);
  return out.ok ? { ...out, active: activeFollowups(ctx.chatId).map(followupView) } : out;
}

// ─── Запуск в срок ──────────────────────────────────────────────────────────

/** Сообщение владельцу перед ходом: он видит, откуда взялся ответ. */
export function renderFollowupNotice(r: Pick<FollowupRow, "task">): string {
  return `Проверяю, как обещал: ${r.task}`;
}

/** Текст хода. Задача — пометка агента, не слова владельца. */
export function renderFollowupTurn(r: Pick<FollowupRow, "task" | "created_at" | "due_at">, now: number): string {
  const late = now - r.due_at > 3 * MINUTE_MS ? ` (с опозданием, срок был ${formatMsk(r.due_at)} МСК)` : "";
  return (
    `[Отложенная проверка, которую ты сам поставил ${formatMsk(r.created_at)} МСК${late}. ` +
    `Это не новое сообщение владельца.] Задача: ${r.task}\n` +
    `Сделай это сейчас и коротко напиши владельцу итог. Если снова не вышло и есть смысл ждать — ` +
    `поставь новую проверку SCHEDULE_FOLLOWUP, а не проси владельца напомнить. Деньги — только через обычную подпись владельца.`
  );
}

export type FollowupRunner = {
  /** Вступление владельцу; ошибка = ход не начат. Возвращает id сообщения. */
  notify: (r: FollowupRow, text: string) => Promise<number>;
  /** Ход агента ответом на вступление. */
  run: (r: FollowupRow, turnText: string, noticeMessageId: number) => Promise<void>;
};

let runner: FollowupRunner | null = null;
/** Задаётся из orchestrator-team.ts, где живёт обработчик ходов оркестратора. */
export function configureFollowupRunner(r: FollowupRunner | null): void {
  runner = r;
}

export interface FollowupStats {
  ran: number;
  retried: number;
  failed: number;
  stale: number;
}

/** Один проход. Экспортирован ради тестов: `now` и `runner` подменяемы. */
export async function runDueFollowups(opts: { runner?: FollowupRunner | null; now?: () => number; batch?: number } = {}): Promise<FollowupStats> {
  const clock = opts.now ?? (() => Date.now());
  const r = opts.runner === undefined ? runner : opts.runner;
  const stats: FollowupStats = { ran: 0, retried: 0, failed: 0, stale: 0 };

  const stale = db
    .prepare(
      `UPDATE followups SET status = 'failed', finished_at = ?,
         error = 'interrupted during the turn (process restart); not retried'
       WHERE status = 'running' AND claimed_at < ?`,
    )
    .run(clock(), clock() - RUNNING_STALE_MS);
  if (stale.changes > 0) {
    stats.stale = stale.changes;
    log.error("[followups] проверки застряли в ходе — помечены failed", { count: stale.changes });
  }
  // Некому будить (оркестратор не поднялся) — ждём, строки остаются в очереди.
  if (!r) return stats;

  const due = db
    .prepare(`SELECT id FROM followups WHERE status = 'scheduled' AND due_at <= ? ORDER BY due_at ASC, id ASC LIMIT ?`)
    .all(clock(), opts.batch ?? 10) as Array<{ id: string }>;
  const claim = db.prepare(
    `UPDATE followups SET status = 'running', claimed_at = ?, attempts = attempts + 1 WHERE id = ? AND status = 'scheduled'`,
  );
  const finish = db.prepare(`UPDATE followups SET status = ?, finished_at = ?, error = ? WHERE id = ? AND status = 'running'`);
  const retry = db.prepare(`UPDATE followups SET status = 'scheduled', error = ? WHERE id = ? AND status = 'running'`);

  for (const { id } of due) {
    if (claim.run(clock(), id).changes !== 1) continue;
    const row = getFollowup(id)!;
    let noticeId: number;
    try {
      noticeId = await r.notify(row, renderFollowupNotice(row));
    } catch (e) {
      const err = getErrorMessage(e).slice(0, 300);
      if (row.attempts >= MAX_ATTEMPTS) {
        finish.run("failed", clock(), `notice failed after ${row.attempts} attempts: ${err}`, id);
        stats.failed++;
        log.error("[followups] вступление не ушло, попытки исчерпаны", { id, error: err });
      } else {
        retry.run(`attempt ${row.attempts} failed: ${err}`, id);
        stats.retried++;
        log.warn("[followups] вступление не ушло, повтор на следующем тике", { id, error: err });
      }
      continue;
    }
    // Вступление ушло — дальше ход; его сбой не повторяем, он мог что-то сделать.
    try {
      await r.run(row, renderFollowupTurn(row, clock()), noticeId);
      finish.run("done", clock(), null, id);
      stats.ran++;
      log.info("[followups] проверка отработала", { id, lateMs: Math.max(0, clock() - row.due_at) });
    } catch (e) {
      const err = getErrorMessage(e).slice(0, 300);
      finish.run("failed", clock(), `turn failed: ${err}`, id);
      stats.failed++;
      log.error("[followups] ход проверки упал", { id, error: err });
    }
  }
  return stats;
}

export interface FollowupSchedulerHandle {
  stop(): void;
  tickNow(): Promise<FollowupStats | null>;
}

export function startFollowupScheduler(opts: { intervalMs?: number; now?: () => number } = {}): FollowupSchedulerHandle {
  let running = false;
  const tick = async (): Promise<FollowupStats | null> => {
    // Ход агента длится минуты — второй проход поверх первого не нужен.
    if (running) return null;
    running = true;
    try {
      return await runDueFollowups({ now: opts.now });
    } finally {
      running = false;
    }
  };
  const interval = setInterval(safeTick("followups", tick), opts.intervalMs ?? DEFAULT_TICK_MS);
  (interval as unknown as { unref?: () => void }).unref?.();
  return { stop: () => clearInterval(interval), tickNow: tick };
}
