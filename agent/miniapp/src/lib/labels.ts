/** Русские лейблы для значений с бэка (статусы, разрешения, уровни). */

/**
 * Аудит 2026-08-20: не хватало `awaiting_review`. Это полноценный статус FSM
 * (`TASK_TRANSITIONS.running` его содержит, `REQUEST_REVIEW` его выставляет —
 * lib/dispatch/tasks.ts:175), а `label()` при промахе молча отдаёт сырой ключ.
 * На экране Tasks он светился латиницей сразу в трёх местах: в фильтре, в
 * бейдже строки и в карточке. Набор проверяется тестом против
 * `TASK_TRANSITIONS`, так что следующий добавленный статус сюда не забудут.
 *
 * `blocked` статусом задачи не бывает — ключ мёртвый, но стоит он ничего и
 * страхует от расхождения в другую сторону (как в ACTION_STATUS_LABELS ниже).
 */
export const TASK_STATUS_LABELS: Record<string, string> = {
  pending: "в очереди",
  running: "выполняется",
  awaiting_approval: "ждёт аппрува",
  awaiting_review: "на ревью",
  done: "готово",
  failed: "ошибка",
  cancelled: "отменена",
  blocked: "заблокирована",
};

export const APPROVAL_STATUS_LABELS: Record<string, string> = {
  pending: "в ожидании",
  approved: "одобрено",
  rejected: "отклонено",
  failed: "одобрено, но упало",
  expired: "истекло",
};

/**
 * Аудит 2026-08-13: карта расходилась со словарём сервера. `ActionStatus` в
 * agent/lib/audit.ts — `attempted | ok | error | forbidden | pending_approval |
 * rate_limited`, то есть двух реальных статусов здесь не было, а `pending` и
 * `invalid` не приходят никогда. `label()` при промахе отдаёт сырой ключ, и в
 * «Последних событиях» сводки среди русских подписей светились латиницей
 * `attempted` и `pending_approval`. Logs.tsx патчил ровно эти два ключа
 * локально — теперь они здесь, и локальный патч не нужен.
 *
 * Мёртвые ключи оставлены: стоят они ничего, а страхуют от расхождения в
 * другую сторону.
 */
export const ACTION_STATUS_LABELS: Record<string, string> = {
  attempted: "попытка",
  ok: "ок",
  error: "ошибка",
  forbidden: "запрещено",
  pending_approval: "ждёт аппрув",
  rate_limited: "лимит",
  pending: "ждёт",
  invalid: "невалидно",
};

/**
 * `status` агента сервер отдаёт только как `paused | running`
 * (agent/lib/miniapp-server.ts); `alive` живёт отдельным булевым полем внутри
 * `health`. Не хватало именно `running` — самого частого значения, и карточка
 * работающей роли показывала английское слово среди русских подписей.
 */
export const AGENT_STATUS_LABELS: Record<string, string> = {
  running: "работает",
  paused: "на паузе",
  alive: "онлайн",
  silent: "молчит",
  unknown: "неизвестно",
  ok: "ок",
  error: "ошибка",
};

export const PERMISSION_LABELS: Record<string, string> = {
  allowed: "разрешено",
  forbidden: "запрещено",
  approval: "аппрув",
  requires_approval: "аппрув",
};

export const LOG_LEVEL_LABELS: Record<string, string> = {
  info: "инфо",
  warn: "предупреждение",
  error: "ошибка",
  debug: "дебаг",
};

/** Универсальный лукап: вернёт перевод или сам ключ. */
export function label(map: Record<string, string>, key: string | undefined | null): string {
  if (!key) return "";
  return map[key] ?? key;
}
