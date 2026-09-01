/**
 * Типы действий, которые знает гейт прав, — зеркало для Mini App.
 *
 * Матрица прав рисовала колонки по тем строкам, что вернул сервер, то есть по
 * тому, что кто-то уже успел выдать. Пять типов не засеяны ни одной строкой
 * (`GRANT_PERMISSION`, `UPDATE_AGENT_PROMPT`, `CHANGE_AGENT_STATUS`,
 * `REVIEW_AND_MERGE_PR`, `SPAWN_ROLE`) — гейт из-за этого отказывает по ним
 * всем ролям, а в матрице у них не было даже колонки. Выдать их через Mini App
 * было нельзя, и что они вообще существуют, из интерфейса не следовало никак.
 * Ровно этот выход и называет докблок `unseededActionTypes()` в
 * `lib/permissions.ts`: «нужен сид-миграция или выдача через Mini App».
 *
 * Список продублирован, а не импортирован: `lib/permissions.ts` тянет за собой
 * `bun:sqlite`, которому в браузерном бандле делать нечего. От расхождения
 * страхует тест `tests/audit-2026-08-20-permission-columns.test.ts` — он читает
 * `ACTION_TYPES` из исходника гейта и сверяет посписочно.
 */
export const KNOWN_ACTION_TYPES = [
  "SEND_MESSAGE",
  "CREATE_TASK",
  "ASSIGN_TASK",
  "UPDATE_TASK_STATUS",
  "REQUEST_REVIEW",
  "COMMENT_TASK",
  "SET_REACTION",
  "EDIT_MESSAGE",
  "PIN_MESSAGE",
  "DELETE_MESSAGE",
  "FORWARD_MESSAGE",
  "CREATE_POLL",
  "SEND_PHOTO",
  "SEND_DOCUMENT",
  "CREATE_TEAM_CHANNEL",
  "PUBLISH_TO_CHANNEL",
  "GENERATE_SVG_IMAGE",
  "GENERATE_IMAGE",
  "DELEGATE_TO_ROLE",
  "WRITE_WIKI",
  "SPLIT_TASK",
  "LIST_RECENT_MESSAGES",
  "MAC_RUN_CLAUDE",
  "MAC_STOP",
  "SCHEDULE_POST",
  "GRANT_PERMISSION",
  "UPDATE_AGENT_PROMPT",
  "CHANGE_AGENT_STATUS",
  "REVIEW_AND_MERGE_PR",
  "CREATE_DIAGNOSTIC_TASK",
  "SPAWN_ROLE",
] as const;

/**
 * Колонки матрицы: все известные типы плюс всё, что пришло с сервера.
 *
 * Пришедшее не отбрасываем — сервер может оказаться новее клиента, и тогда
 * незнакомый тип честнее показать, чем спрятать. Порядок алфавитный: он и был,
 * и по нему ищут глазами.
 */
export function permissionColumns(
  perms: readonly { actionType: string }[],
): string[] {
  const s = new Set<string>(KNOWN_ACTION_TYPES);
  for (const p of perms) s.add(p.actionType);
  return Array.from(s).sort();
}
