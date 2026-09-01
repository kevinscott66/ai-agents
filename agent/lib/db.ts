/**
 * SQLite (bun:sqlite) — короткая память (диалог) + FTS5-индекс по wiki-страницам.
 *
 * Файл: data/memory.db. Создаётся при первом старте.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { runMigrations } from "./migrations.ts";

/**
 * Разбор `MEMORY_DB_PATH` живёт в `./db-path.ts` — модуле без побочных
 * эффектов. Здесь он переэкспортирован, потому что этот файл на top-level
 * открывает базу и гоняет миграции: `lib/backup.ts` и
 * `orchestrator/services.ts` не могут импортировать `db.ts` ради одного пути.
 */
export { DEFAULT_DB_PATH, resolveDbPath } from "./db-path.ts";
import { resolveDbPath } from "./db-path.ts";

export const DB_PATH = resolveDbPath(process.env.MEMORY_DB_PATH);
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH, { create: true });
// Performance pragmas — WAL for concurrent reads/writes, NORMAL sync for speed
// while remaining crash-safe, large negative cache_size = KiB, mmap for fast
// page access, MEMORY temp store and a busy_timeout so writers don't bail
// immediately under contention.
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA synchronous = NORMAL;");
db.exec("PRAGMA cache_size = -64000;");
db.exec("PRAGMA mmap_size = 268435456;");
db.exec("PRAGMA temp_store = MEMORY;");
db.exec("PRAGMA busy_timeout = 5000;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    agent_key TEXT,        -- роль агента, если ответил наш бот; null если человек
    is_bot INTEGER NOT NULL,
    from_user_id TEXT NOT NULL,
    from_name TEXT,
    text TEXT NOT NULL,
    ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_id, ts DESC);

  CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts USING fts5(
    -- scope и slug — идентификаторы строки, а не текст, в котором ищут.
    -- Аудит 2026-08-12: scope был индексируемым, и запрос со словом «backend»
    -- матчился каждой страницей области backend. Отбор по области делает
    -- WHERE scope IN (...), участие в MATCH давало только шум в пяти хитах,
    -- которые уходят в промпт роли. Смена опции требует пересоздания таблицы —
    -- см. миграцию 041_wiki_fts_scope_unindexed.
    scope UNINDEXED,   -- '_team' | '<role_key>'
    slug UNINDEXED,
    title,
    content,
    tokenize='unicode61'
  );
`);

runMigrations(db);

export interface ChatRow {
  id: number;
  chat_id: string;
  agent_key: string | null;
  is_bot: number;
  from_user_id: string;
  from_name: string | null;
  text: string;
  ts: number;
  tg_message_id?: number | null;
  transport?: string;
}
