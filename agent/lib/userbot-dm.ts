/**
 * Личное сообщение человеку от аккаунта владельца через юзербот (USERBOT_SEND_DM).
 *
 * Модуль без побочек: разбор ввода модели, проверка перед отправкой и строка
 * для карточки подтверждения — одна и та же функция, чтобы владелец одобрял
 * ровно то, что уйдёт.
 *
 * Сознательно узко:
 *  - адресат — только публичный @username. Ни id, ни телефона, ни поиска по
 *    контактам: id модель может подсунуть из чужой переписки, а телефон — это
 *    персональные данные, которые не должны лежать в payload заявки;
 *  - одно сообщение без разметки. Текст уходит как есть (parseMode выключен),
 *    поэтому длина в карточке равна длине в Telegram, а `**` не превращается
 *    в жирный после одобрения;
 *  - невидимые символы (bidi, zero-width, управляющие, кроме перевода строки)
 *    — отказ: владелец не должен одобрять текст, который читается иначе, чем
 *    отправится.
 *
 * Подтверждение обязательно при любой автономии — категория
 * `third_party_message` в lib/approval-policy.ts.
 */

export const DM_TEXT_MAX = 4096;
const USERNAME = /^[a-z][a-z0-9_]{3,31}$/;
// Перевод строки разрешён, прочие управляющие (\p{Cc}) — нет.
const HIDDEN = /[\p{Cf}\p{Zl}\p{Zp}]|(?!\n)\p{Cc}/u;

export interface UserbotDm {
  username: string;
  text: string;
}

/** «@Ivan_Petrov», «t.me/ivan_petrov» → «ivan_petrov»; всё остальное — null. */
export function normalizeDmUsername(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw
    .trim()
    .replace(/^(https?:\/\/)?(www\.)?(t|telegram)\.me\//i, "")
    .replace(/^@/, "")
    .toLowerCase();
  // Username в Telegram не заканчивается подчёркиванием и не содержит двух подряд.
  if (!USERNAME.test(s) || s.endsWith("_") || s.includes("__")) return null;
  return s;
}

export function dmTextError(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return "text is required";
  if (raw.length > DM_TEXT_MAX) return `text is longer than ${DM_TEXT_MAX} chars: one message only, shorten it`;
  if (HIDDEN.test(raw)) return "text contains invisible or control characters";
  return null;
}

/** Строгий разбор: лишние поля, кроме служебных `_userId`/`_delegated`, — отказ. */
export function parseUserbotDm(raw: unknown): UserbotDm | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  const keys = Object.keys(m).filter((k) => k !== "_userId" && k !== "_delegated").sort().join(",");
  if (keys !== "text,username") return null;
  const username = normalizeDmUsername(m.username);
  if (!username || username !== m.username || dmTextError(m.text)) return null;
  return { username, text: m.text as string };
}

/** Карточка подтверждения: кому и весь текст. */
export function describeUserbotDm(dm: UserbotDm): string {
  return `личное сообщение от аккаунта владельца → @${dm.username}: ${dm.text}`;
}
