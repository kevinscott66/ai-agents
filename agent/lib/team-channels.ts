/**
 * Реестр каналов, СОЗДАННЫХ командой через CREATE_TEAM_CHANNEL. Постинг
 * (PUBLISH_TO_CHANNEL) разрешён ТОЛЬКО в эти каналы — это сохраняет anti-exfil
 * (агент не может опубликовать контент в произвольный/чужой чат), но даёт
 * команде наполнять свои каналы.
 */
import { db } from "./db.ts";

export function registerTeamChannel(
  channelId: number,
  title: string,
  createdByChat: number,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO team_channels(channel_id, title, created_by_chat, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(channelId, title, createdByChat, Date.now());
}

/**
 * Аудит 2026-08-04: проверка была глобальной — `WHERE channel_id = ?`, колонка
 * created_by_chat игнорировалась. Для всех остальных исходящих действий чат
 * жёстко пинится к чату-триггеру (dispatch/helpers.ts), у публикации — нет.
 * Значит инъекция в чате B заставляла роль опубликовать в канал, заведённый из
 * чата A, к которому инициатор отношения не имеет.
 *
 * `createdByChat` опционален только ради вызовов без контекста чата (тесты,
 * ручные проверки реестра); на пути диспатча он передаётся всегда.
 */
export function isTeamChannel(
  channelId: number,
  createdByChat?: number,
): boolean {
  const row =
    createdByChat == null
      ? (db
          .prepare(`SELECT 1 AS x FROM team_channels WHERE channel_id = ?`)
          .get(channelId) as { x: number } | undefined)
      : (db
          .prepare(
            `SELECT 1 AS x FROM team_channels WHERE channel_id = ? AND created_by_chat = ?`,
          )
          .get(channelId, createdByChat) as { x: number } | undefined);
  return !!row;
}

export interface TeamChannel {
  channel_id: number;
  title: string;
  created_by_chat: number;
  created_at: number;
}

/** Каналы, созданные из данного чата (для подсказки агенту). */
export function listTeamChannels(createdByChat?: number): TeamChannel[] {
  if (createdByChat != null) {
    return db
      .prepare(
        `SELECT * FROM team_channels WHERE created_by_chat = ? ` +
          `ORDER BY created_at DESC, channel_id DESC LIMIT 50`,
      )
      .all(createdByChat) as TeamChannel[];
  }
  return db
    // channel_id — это rowid таблицы, то есть полный ключ. Без него потолок в
    // 50 отрезает произвольные строки из созданных в одну миллисекунду.
    .prepare(
      `SELECT * FROM team_channels ORDER BY created_at DESC, channel_id DESC LIMIT 50`,
    )
    .all() as TeamChannel[];
}
