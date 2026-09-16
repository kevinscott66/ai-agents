/**
 * Время напоминаний: разбор `at`, окно «в будущем и не дальше года», формат
 * МСК. Отдельный лист без БД — его импортируют buildPayload и карточки
 * апрувов, которым хранилище (lib/reminders.ts) не нужно.
 */
import { MINUTE_MS } from "./time-constants.ts";

/** Смещение Europe/Moscow. Летнего времени в РФ нет с 2014 года. */
export const MSK_OFFSET_MINUTES = 180;
export const REMINDER_TEXT_MAX = 2000;

const AT_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?$/i;

/**
 * Разобрать `at`: ISO-дата со смещением (`2026-03-05T09:30:00+03:00`, `…Z`)
 * или локальное время без смещения (`2026-03-05 09:30`) — оно читается как
 * московское (UTC+3). Возвращает Unix-время в мс.
 *
 * `Date.parse` не используется намеренно: строку без смещения он читает в
 * часовом поясе ПРОЦЕССА, то есть на сервере в UTC «20:00» стало бы 23:00 МСК.
 */
export function parseReminderAt(
  raw: unknown,
): { ok: true; at: number } | { ok: false; error: string } {
  if (typeof raw !== "string" || !raw.trim()) {
    return {
      ok: false,
      error:
        "at is required: ISO datetime, e.g. 2026-03-05T09:30:00+03:00 or 2026-03-05 09:30 (Moscow time)",
    };
  }
  const m = raw.trim().match(AT_RE);
  if (!m) {
    return {
      ok: false,
      error: `at: unrecognized datetime '${raw}'; use YYYY-MM-DDTHH:MM[:SS][±HH:MM|Z] (no offset = Moscow time, UTC+3)`,
    };
  }
  const [, y, mo, d, h, mi, s, tz] = m;
  const Y = Number(y), M = Number(mo), D = Number(d);
  const H = Number(h), MI = Number(mi), S = s ? Number(s) : 0;
  const local = Date.UTC(Y, M - 1, D, H, MI, S);
  // Круговая проверка ловит 2026-02-30 и 25:00: Date.UTC их молча переносит.
  const back = new Date(local);
  if (
    back.getUTCFullYear() !== Y ||
    back.getUTCMonth() !== M - 1 ||
    back.getUTCDate() !== D ||
    back.getUTCHours() !== H ||
    back.getUTCMinutes() !== MI ||
    back.getUTCSeconds() !== S
  ) {
    return { ok: false, error: `at: invalid calendar date/time '${raw}'` };
  }
  let offsetMin = MSK_OFFSET_MINUTES;
  if (tz) {
    if (tz.toUpperCase() === "Z") {
      offsetMin = 0;
    } else {
      const sign = tz[0] === "-" ? -1 : 1;
      const digits = tz.slice(1).replace(":", "");
      const oh = Number(digits.slice(0, 2));
      const om = Number(digits.slice(2, 4));
      if (oh > 14 || om > 59) return { ok: false, error: `at: invalid offset '${tz}'` };
      offsetMin = sign * (oh * 60 + om);
    }
  }
  return { ok: true, at: local - offsetMin * MINUTE_MS };
}

/** Верхняя граница: ровно год вперёд по календарю. */
function oneYearAhead(now: number): number {
  const d = new Date(now);
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.getTime();
}

/**
 * «В будущем и не дальше года». Зовётся и в buildPayload, и в хендлере:
 * между ними может пройти апрув, и к исполнению время уже истечёт.
 */
export function checkReminderWindow(
  at: number,
  now: number,
): { ok: true } | { ok: false; error: string } {
  if (!Number.isFinite(at)) return { ok: false, error: "at: invalid time" };
  if (at <= now) {
    return {
      ok: false,
      error: `at is in the past (${formatMsk(at)} МСК, сейчас ${formatMsk(now)} МСК)`,
    };
  }
  if (at > oneYearAhead(now)) {
    return { ok: false, error: "at is more than 1 year ahead" };
  }
  return { ok: true };
}

/** «05.03.2026 09:30» по Москве. */
export function formatMsk(ms: number): string {
  const d = new Date(ms + MSK_OFFSET_MINUTES * MINUTE_MS);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** ISO со смещением +03:00 — для выдачи модели. */
export function isoMsk(ms: number): string {
  const d = new Date(ms + MSK_OFFSET_MINUTES * MINUTE_MS);
  return d.toISOString().replace(/\.\d{3}Z$/, "+03:00");
}

