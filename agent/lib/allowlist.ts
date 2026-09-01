/**
 * T-603 / SEC-5: fail-closed allow-list helpers.
 *
 * Historically several call-sites used the pattern
 *   `if (allowed.length && !allowed.includes(id)) deny`
 * which means an *empty* allow-list silently allowed EVERYONE (fail-open). For
 * an auth/ingestion boundary that is dangerous: a missing or mis-parsed env var
 * silently opens the door. `isAllowlisted` makes the boundary fail *closed* —
 * an empty (or missing) list denies everyone — and `warnIfEmptyAllowlist` emits
 * a single loud warning so an operator notices the lock-down instead of a
 * silent open door.
 *
 * Prod is configured (MINIAPP_ALLOWED_USER_IDS / TELEGRAM_ALLOWED_GROUP_IDS are
 * set), so this changes nothing in prod — it only removes the fail-open default.
 */
import { log } from "./log.ts";

/** True iff `id` is explicitly present in `allowed`. Empty/missing → false. */
export function isAllowlisted<T>(id: T, allowed: readonly T[] | undefined | null): boolean {
  if (!allowed || allowed.length === 0) return false;
  return allowed.includes(id);
}

/**
 * CSV числовых Telegram-id из env → массив. Пустая/отсутствующая строка → [].
 *
 * Единственное место разбора таких списков. Аудит 2026-08-12: их было два —
 * Mini App читал через `Number()` + `n > 0`, а admin-команды Telegram через
 * `parseInt`, который разбирает ПРЕФИКС: `parseInt("12345x678")` = 12345. Один
 * и тот же .env давал два разных набора админов, причём в Telegram — более
 * широкий, и опечатка превращалась не в отказ, а в чужой валидный id.
 *
 * Строго: элемент, который не является целым положительным числом целиком,
 * отбрасывается. Telegram-id всегда положительный.
 */
export function parseUserIdList(raw: string | undefined | null): number[] {
  if (!raw) return [];
  const out: number[] = [];
  for (const part of raw.split(",")) {
    const s = part.trim();
    if (!/^\d+$/.test(s)) continue;
    const n = Number(s);
    if (Number.isSafeInteger(n) && n > 0) out.push(n);
  }
  return out;
}

/**
 * Как назвать состояние allow-list'а в стартовом логе.
 *
 * Аудит 2026-08-21: три точки входа печатали это по-разному, и две из трёх
 * врали. `orchestrator-team.ts` (прод, `bun run start`) и `orchestrator-bot.ts`
 * писали `ALLOWED.join(",") || "(any)"` — то есть при пустом списке в лог
 * уходило «(any)», читаемое как «ограничений нет». Настоящее поведение
 * обратное: `isAllowlisted` fail-closed, пустой список запрещает ВСЕМ, и
 * команда из 12 ботов молча перестаёт отвечать вообще везде. Правильную
 * формулировку знал только `orchestrator-userbot.ts` («none — fail-closed»);
 * она и взята за образец, а разбор списка уже сведён в `parseUserIdList` —
 * тем же приёмом и по той же причине.
 */
export function describeAllowlist(
  allowed: readonly unknown[] | undefined | null,
): string {
  if (!allowed || allowed.length === 0) {
    return "(пусто → fail-closed: не обслуживается ни один чат)";
  }
  return allowed.join(",");
}

const warnedLabels = new Set<string>();

/**
 * Emit a single loud warning (once per label) when an allow-list the caller
 * depends on is empty — so a fail-closed lock-down is visible in the logs.
 * Returns true iff the list is empty.
 */
export function warnIfEmptyAllowlist(
  label: string,
  allowed: readonly unknown[] | undefined | null,
): boolean {
  const empty = !allowed || allowed.length === 0;
  if (empty && !warnedLabels.has(label)) {
    warnedLabels.add(label);
    log.warn(
      `[security] ${label} is EMPTY → fail-closed: all requests denied until it is set.`,
    );
  }
  return empty;
}

/** Test helper — reset the once-per-label warning dedup. */
export function _resetAllowlistWarnings(): void {
  warnedLabels.clear();
}
