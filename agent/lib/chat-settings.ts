/**
 * Per-chat настройки. Сейчас — только discussion_mode (P2, 2026-06-09).
 *
 * discussion_mode=ON разрешает более длинную handoff-цепочку между ботами
 * (несколько ролей высказываются по очереди). Цепочка остаётся конечной за счёт
 * `visited` в handoff.ts (каждая роль ≤1 раза → ≤12 хопов) + per-bot rate-limit.
 */
import { db } from "./db.ts";

export function getDiscussionMode(chatId: number | string): boolean {
  const row = db
    .prepare(`SELECT discussion_mode FROM chat_settings WHERE chat_id = ?`)
    .get(String(chatId)) as { discussion_mode: number } | undefined;
  return !!row && row.discussion_mode === 1;
}

export function setDiscussionMode(chatId: number | string, on: boolean): void {
  db.prepare(
    `INSERT INTO chat_settings(chat_id, discussion_mode, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET
       discussion_mode = excluded.discussion_mode,
       updated_at = excluded.updated_at`,
  ).run(String(chatId), on ? 1 : 0, Date.now());
}
