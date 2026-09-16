/**
 * Напоминания в чат: CREATE_REMINDER / LIST_REMINDERS / CANCEL_REMINDER и
 * таймер доставки.
 *
 * Почему свой таймер, а не чужой. Подходящего планировщика в процессе нет:
 * SCHEDULE_POST только пишет строку в content_calendar и ничего не отправляет
 * (см. handleSchedulePost), а живые таймеры — watchdog и дайджест раз в 5
 * минут, db-maint раз в 30 — со своей работой, частотой и флагами выключения.
 * Подвесить доставку на них значило бы опаздывать до пяти минут и выключать
 * напоминания вместе с дайджестом. Поэтому один setInterval здесь — по тому же
 * шаблону, что у соседей (safeTick, unref, stop()).
 *
 * Гарантии доставки.
 *  - Адресат — только чат, в котором напоминание создано (ctx.chatId через
 *    pinnedChatId в хендлере). Из payload чат не берётся никогда.
 *  - Канал DeLabs отвергается дважды: при создании и при отправке (id канала
 *    мог поменяться в env между ними).
 *  - Строка захватывается атомарно: `UPDATE … SET status='sending' WHERE id=?
 *    AND status='scheduled'`. Отправляет только тот, у кого `changes === 1`,
 *    поэтому ни второй тик, ни второй процесс, ни рестарт повторно не шлют.
 *  - Рестарт посреди отправки оставляет строку в 'sending'. Повторять её
 *    нельзя — сообщение могло уйти. Такие строки старше SENDING_STALE_MS
 *    переводятся в 'failed' с внятной причиной, и LIST_REMINDERS их показывает.
 *  - Ошибка Bot API (исключение из sendMessage) означает «не доставлено»:
 *    строка возвращается в 'scheduled', всего до MAX_ATTEMPTS попыток.
 *  - Просроченное за время простоя уходит один раз, с пометкой об опоздании.
 */
import { db } from "./db.ts";
import { log } from "./log.ts";
import { safeTick } from "./safe-timer.ts";
import { delabsChannelId } from "./delabs-env.ts";
import { getErrorMessage } from "./errors.ts";
import { DAY_MS, MINUTE_MS, SECOND_MS } from "./time-constants.ts";
import { checkReminderWindow, formatMsk, REMINDER_TEXT_MAX } from "./reminder-time.ts";

export {
  MSK_OFFSET_MINUTES,
  REMINDER_TEXT_MAX,
  parseReminderAt,
  checkReminderWindow,
  formatMsk,
  isoMsk,
} from "./reminder-time.ts";

/** Больше активных напоминаний на чат не держим — защита от зацикленного агента. */
export const MAX_ACTIVE_REMINDERS_PER_CHAT = 100;
export const MAX_ATTEMPTS = 3;
/** Опоздание больше этого — пишем в тексте, что напоминание запоздало. */
export const LATE_THRESHOLD_MS = 3 * MINUTE_MS;
/** Строка в 'sending' дольше этого — процесс умер посреди отправки. */
export const SENDING_STALE_MS = 10 * MINUTE_MS;
export const DEFAULT_TICK_MS = 30 * SECOND_MS;

export type ReminderStatus = "scheduled" | "sending" | "sent" | "cancelled" | "failed";

export interface ReminderRow {
  id: string;
  chat_id: number;
  agent_key: string;
  text: string;
  remind_at: number;
  status: ReminderStatus;
  attempts: number;
  created_at: number;
  claimed_at: number | null;
  sent_at: number | null;
  error: string | null;
}

// ─── Хранилище ──────────────────────────────────────────────────────────────

/** Канал DeLabs — публичная витрина, напоминаниям туда нельзя. */
export function isBlockedReminderChat(chatId: number): boolean {
  return chatId === delabsChannelId();
}

export function createReminder(opts: {
  chatId: number;
  agentKey: string;
  text: string;
  remindAt: number;
  now?: number;
}): { ok: true; reminder: ReminderRow } | { ok: false; error: string } {
  const now = opts.now ?? Date.now();
  const text = opts.text.trim();
  if (!text) return { ok: false, error: "text is required" };
  if (text.length > REMINDER_TEXT_MAX) {
    return { ok: false, error: `text is too long (max ${REMINDER_TEXT_MAX} chars)` };
  }
  if (!Number.isFinite(opts.chatId) || opts.chatId === 0) {
    return { ok: false, error: "no chat to deliver the reminder to" };
  }
  if (isBlockedReminderChat(opts.chatId)) {
    return { ok: false, error: "reminders cannot target the public channel" };
  }
  const win = checkReminderWindow(opts.remindAt, now);
  if (!win.ok) return win;
  const active = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM reminders WHERE chat_id = ? AND status IN ('scheduled','sending')`,
      )
      .get(opts.chatId) as { n: number }
  ).n;
  if (active >= MAX_ACTIVE_REMINDERS_PER_CHAT) {
    return {
      ok: false,
      error: `too many active reminders in this chat (max ${MAX_ACTIVE_REMINDERS_PER_CHAT}); cancel some first`,
    };
  }
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO reminders (id, chat_id, agent_key, text, remind_at, status, attempts, created_at)
     VALUES (?, ?, ?, ?, ?, 'scheduled', 0, ?)`,
  ).run(id, opts.chatId, opts.agentKey, text, opts.remindAt, now);
  return { ok: true, reminder: getReminder(id)! };
}

export function getReminder(id: string): ReminderRow | null {
  return (db.prepare(`SELECT * FROM reminders WHERE id = ?`).get(id) as ReminderRow | null) ?? null;
}

/** Показываемые записи: активные и неудачные за последнюю неделю. */
export function listReminders(
  chatId: number,
  now: number = Date.now(),
  limit = 50,
): { total: number; rows: ReminderRow[] } {
  const where = `chat_id = ? AND (status IN ('scheduled','sending') OR (status = 'failed' AND remind_at >= ?))`;
  const since = now - 7 * DAY_MS;
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM reminders WHERE ${where}`).get(chatId, since) as {
      n: number;
    }
  ).n;
  const rows = db
    .prepare(
      `SELECT * FROM reminders WHERE ${where}
       ORDER BY (status = 'failed') ASC, remind_at ASC, id ASC LIMIT ?`,
    )
    .all(chatId, since, limit) as ReminderRow[];
  return { total, rows };
}

export type CancelOutcome =
  | { ok: true; id: string }
  | {
      ok: false;
      error: string;
      status?: ReminderStatus;
      cause: "not_found" | "other_chat" | "not_active";
    };

/**
 * Отмена в пределах своего чата. Чужой чат снаружи выглядит как
 * несуществующий id (как у CANCEL_SCHEDULED_POST); точная причина — в `cause`,
 * для журнала.
 */
export function cancelReminder(id: string, chatId: number): CancelOutcome {
  const res = db
    .prepare(
      `UPDATE reminders SET status = 'cancelled' WHERE id = ? AND chat_id = ? AND status = 'scheduled'`,
    )
    .run(id, chatId);
  if (res.changes === 1) return { ok: true, id };
  const own = db
    .prepare(`SELECT status FROM reminders WHERE id = ? AND chat_id = ?`)
    .get(id, chatId) as { status: ReminderStatus } | undefined;
  if (own) {
    const msg =
      own.status === "sending"
        ? "reminder is being sent right now, too late to cancel"
        : `reminder is already '${own.status}', nothing to cancel`;
    return { ok: false, error: msg, status: own.status, cause: "not_active" };
  }
  const elsewhere = db.prepare(`SELECT 1 FROM reminders WHERE id = ?`).get(id);
  return {
    ok: false,
    error: "no active reminder with this id in this chat",
    cause: elsewhere ? "other_chat" : "not_found",
  };
}

// ─── Доставка ───────────────────────────────────────────────────────────────

export type ReminderSender = (
  chatId: number,
  text: string,
  agentKey: string,
) => Promise<unknown>;

/** Текст сообщения в чат. Опоздание называем вместе с исходным временем. */
export function renderReminderMessage(
  r: Pick<ReminderRow, "text" | "remind_at">,
  now: number,
): string {
  if (now - r.remind_at > LATE_THRESHOLD_MS) {
    return `Напоминание (с опозданием: должно было прийти ${formatMsk(r.remind_at)} МСК):\n${r.text}`;
  }
  return `Напоминание:\n${r.text}`;
}

export interface DeliverStats {
  sent: number;
  late: number;
  retried: number;
  failed: number;
  stale: number;
}

/** Один проход доставки. Экспортирован ради тестов: `now` и `send` подменяемы. */
export async function deliverDueReminders(opts: {
  send: ReminderSender;
  now?: () => number;
  batch?: number;
}): Promise<DeliverStats> {
  const clock = opts.now ?? (() => Date.now());
  const stats: DeliverStats = { sent: 0, late: 0, retried: 0, failed: 0, stale: 0 };

  // Строки, застрявшие в 'sending': процесс умер между захватом и итогом.
  // Сообщение могло уйти — повтор дал бы дубль, поэтому только 'failed'.
  const staleRes = db
    .prepare(
      `UPDATE reminders SET status = 'failed',
         error = 'interrupted during delivery (process restart); delivery unknown, not retried'
       WHERE status = 'sending' AND claimed_at < ?`,
    )
    .run(clock() - SENDING_STALE_MS);
  if (staleRes.changes > 0) {
    stats.stale = staleRes.changes;
    log.error("[reminders] напоминания застряли в отправке — помечены failed", {
      count: staleRes.changes,
    });
  }

  const due = db
    .prepare(
      `SELECT id FROM reminders WHERE status = 'scheduled' AND remind_at <= ?
       ORDER BY remind_at ASC, id ASC LIMIT ?`,
    )
    .all(clock(), opts.batch ?? 50) as Array<{ id: string }>;

  const claim = db.prepare(
    `UPDATE reminders SET status = 'sending', claimed_at = ?, attempts = attempts + 1
     WHERE id = ? AND status = 'scheduled'`,
  );
  const markSent = db.prepare(
    `UPDATE reminders SET status = 'sent', sent_at = ?, error = NULL WHERE id = ? AND status = 'sending'`,
  );
  const markRetry = db.prepare(
    `UPDATE reminders SET status = 'scheduled', error = ? WHERE id = ? AND status = 'sending'`,
  );
  const markFailed = db.prepare(
    `UPDATE reminders SET status = 'failed', error = ? WHERE id = ? AND status = 'sending'`,
  );

  for (const { id } of due) {
    const t = clock();
    // Забрал другой тик/процесс или напоминание успели отменить.
    if (claim.run(t, id).changes !== 1) continue;
    const r = getReminder(id)!;
    if (isBlockedReminderChat(r.chat_id)) {
      markFailed.run("blocked: public channel is not a reminder target", id);
      stats.failed++;
      log.warn("[reminders] адресат — публичный канал, доставка отменена", { id });
      continue;
    }
    const message = renderReminderMessage(r, t);
    try {
      await opts.send(r.chat_id, message, r.agent_key);
      markSent.run(clock(), id);
      stats.sent++;
      if (t - r.remind_at > LATE_THRESHOLD_MS) stats.late++;
      log.info("[reminders] доставлено", {
        id,
        chatId: r.chat_id,
        lateMs: Math.max(0, t - r.remind_at),
      });
    } catch (e) {
      const err = getErrorMessage(e);
      if (r.attempts >= MAX_ATTEMPTS) {
        markFailed.run(`send failed after ${r.attempts} attempts: ${err}`, id);
        stats.failed++;
        log.error("[reminders] доставка не удалась, попытки исчерпаны", {
          id,
          chatId: r.chat_id,
          error: err,
        });
      } else {
        markRetry.run(`attempt ${r.attempts} failed: ${err}`, id);
        stats.retried++;
        log.warn("[reminders] доставка не удалась, повтор на следующем тике", { id, error: err });
      }
    }
  }
  return stats;
}

export interface ReminderSchedulerHandle {
  stop(): void;
  /** Один проход прямо сейчас (для тестов). `null` — проход уже идёт. */
  tickNow(): Promise<DeliverStats | null>;
}

export function startReminderScheduler(opts: {
  send: ReminderSender;
  intervalMs?: number;
  now?: () => number;
}): ReminderSchedulerHandle {
  let running = false;
  const tick = async (): Promise<DeliverStats | null> => {
    // Проход с медленным Telegram может пережить интервал. Захват и так
    // атомарный, но второй параллельный проход — лишние запросы и шум в логе.
    if (running) return null;
    running = true;
    try {
      return await deliverDueReminders({ send: opts.send, now: opts.now });
    } finally {
      running = false;
    }
  };
  const interval = setInterval(safeTick("reminders", tick), opts.intervalMs ?? DEFAULT_TICK_MS);
  (interval as unknown as { unref?: () => void }).unref?.();
  // Первый проход сразу: после простоя просроченное не должно ждать интервал.
  safeTick("reminders", tick)();
  return {
    stop: () => clearInterval(interval),
    tickNow: tick,
  };
}
