/**
 * Разбор FLOOD_WAIT-ошибки gramjs. Отдельный листовой модуль — БЕЗ импортов.
 *
 * Жило это внутри userbot-flood.ts и переехало сюда 2026-08-13, когда
 * `userbot.ts` понадобилось отличать FLOOD_WAIT от прочих отказов внутри цикла
 * приглашений (createTeamChannel). Импорт `userbot-flood.ts` тянет за собой
 * rate-limits → db, а `lib/db.ts` создаёт базу и гоняет миграции НА УРОВНЕ
 * МОДУЛЯ. То есть один такой импорт добавил бы боевую БД в граф каждого, кто
 * грузит userbot, — включая oneshot-скрипты публикации, ради которых написан
 * tests/approve-poll-no-db.test.ts (он это и поймал).
 *
 * Здесь только чистые функции над формой ошибки, поэтому граф остаётся пустым.
 * userbot-flood.ts их реэкспортирует — все прежние места импорта работают как
 * работали.
 */

const FLOOD_WAIT_SECONDS = /FLOOD_WAIT_(\d+)/i;

/**
 * Slow mode — НЕ flood wait, хотя у gramjs это соседние классы одного предка
 * (`FloodError`) с одинаковым числовым полем `.seconds`.
 *
 * Аудит 2026-08-19: `parseFloodWaitSeconds` считала FLOOD_WAIT'ом любой объект
 * с числовым `.seconds`, а кулдаун наверху (`armFloodCooldown`) заведён на
 * characterId БЕЗ чата. То есть слоумод в одной группе — штатная настройка,
 * которую владелец включает сам, — затыкал роли юзербот во ВСЕХ чатах на
 * запрошенное время. Различаются они надёжно: имя класса, а в запасе — хвост
 * сообщения («…before sending another message in this chat» против «…is
 * required»).
 *
 * Разница не косметическая: FLOOD_WAIT относится к аккаунту и ждать положено
 * везде, слоумод относится к чату и ждать положено только в нём.
 */
const SLOW_MODE_MARKERS =
  /SLOWMODE_WAIT|SlowModeWaitError|before sending another message in this chat/i;

/** Ошибка — это слоумод конкретного чата, а не бан аккаунта. */
export function isSlowModeWaitError(err: unknown): boolean {
  if (err == null || typeof err !== "object") {
    return typeof err === "string" && SLOW_MODE_MARKERS.test(err);
  }
  const e = err as { message?: unknown; constructor?: { name?: unknown } };
  if (e.constructor?.name === "SlowModeWaitError") return true;
  return typeof e.message === "string" && SLOW_MODE_MARKERS.test(e.message);
}

/** Сколько просит подождать слоумод, если это он. */
export function parseSlowModeWaitSeconds(err: unknown): number | undefined {
  if (!isSlowModeWaitError(err)) return undefined;
  if (err !== null && typeof err === "object") {
    const secs = (err as { seconds?: unknown }).seconds;
    if (typeof secs === "number" && secs > 0) return secs;
  }
  const msg = typeof err === "string" ? err : String((err as { message?: unknown })?.message ?? "");
  const m = msg.match(/(\d+)\s*seconds?/i) ?? msg.match(/SLOWMODE_WAIT_(\d+)/i);
  return m ? Number(m[1]) : undefined;
}

/**
 * Extract seconds from a gramjs FLOOD_WAIT error.
 *
 * gramjs can throw in two forms:
 *  1. Error with message "FLOOD_WAIT_<N>" (N seconds)
 *  2. Error object with a numeric `.seconds` property
 *
 * Returns undefined if the error is not a FLOOD_WAIT.
 */
export function parseFloodWaitSeconds(err: unknown): number | undefined {
  if (err == null) return undefined;
  // Слоумод отсекаем ДО всех веток: у него и `.seconds`, и «seconds» в тексте.
  if (isSlowModeWaitError(err)) return undefined;

  if (typeof err === "string") {
    const m = err.match(FLOOD_WAIT_SECONDS);
    if (m) return Number(m[1]);
    return undefined;
  }

  if (typeof err !== "object") return undefined;

  const e = err as Record<string, unknown>;

  // Pattern 1: .seconds numeric field (gramjs FloodWaitError)
  if (typeof e.seconds === "number" && e.seconds > 0) {
    return e.seconds;
  }

  // Pattern 2: .message contains FLOOD_WAIT_<N>
  if (typeof e.message === "string") {
    const m = e.message.match(FLOOD_WAIT_SECONDS);
    if (m) return Number(m[1]);
  }

  return undefined;
}

export function isFloodWaitError(err: unknown): boolean {
  if (isSlowModeWaitError(err)) return false;
  if (parseFloodWaitSeconds(err) !== undefined) return true;
  if (typeof err === "object" && err !== null) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === "string" && /FLOOD_WAIT/i.test(msg)) return true;
  }
  return false;
}
