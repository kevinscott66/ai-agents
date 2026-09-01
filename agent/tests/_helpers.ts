/**
 * Общие хелперы для тестов C2..C6B.
 *
 * Цель: убрать дубли cleanup() и save/restore autonomy между файлами.
 * Конкретный TEST_CHAT по-прежнему задаётся в каждом тесте — они разные.
 */
import { db } from "../lib/db.ts";
import {
  getAutonomy,
  getPermission,
  setAutonomy,
  setPermission,
  type ActionType,
  type AutonomyMode,
} from "../lib/permissions.ts";

/**
 * Удаляет из БД тестовые данные по chat_id:
 *   approvals, agent_actions, tasks, autonomy_modes(scope='chat'),
 *   processed_triggers.
 * Дополнительно — agent_actions по agent_key, если передан.
 */
export function cleanupChat(chatId: number, agentKey?: string): void {
  db.prepare(`DELETE FROM approvals WHERE chat_id = ?`).run(chatId);
  if (agentKey !== undefined) {
    db.prepare(
      `DELETE FROM agent_actions WHERE agent_key = ? OR chat_id = ?`,
    ).run(agentKey, chatId);
  } else {
    db.prepare(`DELETE FROM agent_actions WHERE chat_id = ?`).run(chatId);
  }
  db.prepare(`DELETE FROM tasks WHERE chat_id = ?`).run(chatId);
  // Аудит 2026-08-28: дедуп триггеров держит (chat_id, tg_message_id) минуту.
  // Пока его звал только текстовый путь, тесты в это не упирались; голосовой
  // путь его теперь тоже зовёт, а тесты переиспользуют message_id между
  // случаями в одном чате. chat_id тут строка — так его пишет
  // shouldProcessTrigger.
  db.prepare(`DELETE FROM processed_triggers WHERE chat_id = ?`).run(String(chatId));
  db.prepare(
    `DELETE FROM autonomy_modes WHERE scope = 'chat' AND scope_id = ?`,
  ).run(String(chatId));
}

/** Снять снимок глобального autonomy-режима. */
export function saveAutonomy(): AutonomyMode {
  return getAutonomy();
}

/** Восстановить ранее снятый снимок глобального autonomy. */
export function restoreAutonomy(mode: AutonomyMode): void {
  setAutonomy("global", "*", mode);
}

/**
 * Снимок строк `permissions` с восстановлением одним вызовом.
 *
 * Зачем отдельный хелпер, а не `getPermission` + `setPermission` руками:
 * `getPermission` на ОТСУТСТВУЮЩЕЙ строке отдаёт `{allowed:false,
 * requires_approval:false}` — то есть наивное «прочитал, поменял, записал
 * обратно» СОЗДАЁТ строку там, где её не было, и следующий тест видит явный
 * запрет вместо дефолта, посеянного миграцией. Здесь наличие строки снимается
 * отдельно, и восстановление отсутствия — это DELETE, а не запись нулей.
 *
 * Зачем вообще: инцидент T-812 повторяется одинаково. Тест делает
 * `setPermission(agent, ACTION, { allowed: true, requires_approval: false })`,
 * чтобы дойти до проверяемой ветки, и не возвращает как было. Таблица
 * `permissions` — не per-chat, `cleanupChat` её не трогает, и разоружённый гейт
 * переживает файл: соседний тест, который проверяет «здесь нужна карточка
 * approval», видит уже снятое требование и зеленеет вхолостую. Порядок файлов у
 * `bun test` не фиксирован, поэтому ловится это не всегда — то есть худший сорт
 * протечки (так упал PR #435: пять тестов из четырёх файлов, `rerun --failed`
 * на том же коммите — зелёный).
 *
 * Глобальная сетка в `_setup.ts` восстанавливает таблицу по подписи перед
 * КАЖДЫМ тестом; этот хелпер — прицельный слой внутри файла, чтобы соседний
 * тест в том же файле не зависел от порядка.
 *
 *     const restore = savePermissions([["qa", "SET_REACTION"]]);
 *     try { … } finally { restore(); }
 */
export function savePermissions(
  pairs: Array<[string, ActionType]>,
): () => void {
  const has = db.prepare(
    `SELECT 1 AS x FROM permissions WHERE agent_key = ? AND action_type = ?`,
  );
  const before = pairs.map(([agent, action]) => ({
    agent,
    action,
    existed: !!has.get(agent, action),
    perm: getPermission(agent, action),
  }));
  return () => {
    for (const b of before) {
      if (b.existed) setPermission(b.agent, b.action, b.perm);
      else
        db.prepare(
          `DELETE FROM permissions WHERE agent_key = ? AND action_type = ?`,
        ).run(b.agent, b.action);
    }
  };
}
