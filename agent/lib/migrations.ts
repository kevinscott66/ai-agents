/**
 * Идемпотентные миграции схемы для мультиагентной системы (этап 3).
 * Применяются по имени; уже применённые пропускаются.
 */
import { getErrorMessage } from "./errors.ts";
import type { Database } from "bun:sqlite";
import { CHARACTERS } from "../characters/index.ts";
// Note: Not importing ACTION_TYPES to avoid circular dependency

type Migration = { name: string; up: (db: Database) => void };

/**
 * Канонические правила сидинга прав по action_type (R-A).
 * Используется новой миграцией 008. Старые миграции 006/007 уже применены и
 * НЕ переписываются.
 */
const REQUIRES_APPROVAL: Record<string, 0 | 1> = {
  SEND_MESSAGE: 0,
  SET_REACTION: 0,
  FORWARD_MESSAGE: 0,
  CREATE_TASK: 0,
  ASSIGN_TASK: 0,
  UPDATE_TASK_STATUS: 0,
  REQUEST_REVIEW: 0,
  COMMENT_TASK: 0,
  EDIT_MESSAGE: 1,
  PIN_MESSAGE: 1,
  DELETE_MESSAGE: 1,
  CREATE_POLL: 1,
  SCHEDULE_POST: 1,
};

const ACTION_TYPES = [
  "SEND_MESSAGE",
  "CREATE_TASK",
  "ASSIGN_TASK",
  "UPDATE_TASK_STATUS",
  "REQUEST_REVIEW",
  "COMMENT_TASK",
] as const;

/**
 * Добавить колонку, стерпев «она уже есть».
 *
 * SQLite не умеет `ADD COLUMN IF NOT EXISTS`, поэтому глушим ровно одну
 * ошибку — дубль имени. Всё остальное (нет таблицы, кривой тип) летит дальше.
 *
 * Аудит 2026-08-12: правило жило тремя копиями внутри отдельных миграций, а
 * три другие миграции с ADD COLUMN (024, 030, 035) делали голый `db.exec`.
 * Разница видна только на базе, где колонка появилась раньше отметки в
 * schema_migrations: добавили руками по месту (в 040 ниже описан ровно такой
 * случай с `messages.kind`), восстановили из дампа, откатили отметку. Тогда
 * ALTER бросает — а runMigrations зовётся на уровне модуля из lib/db.ts, то
 * есть исключение летит из импорта и не поднимается вообще ничего.
 */
function addColumn(db: Database, table: string, decl: string): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${decl};`);
  } catch (e) {
    if (!/duplicate column name/i.test(getErrorMessage(e))) throw e;
  }
}

export type { Migration };

/** Экспортируется для точечных тестов отдельных миграций. */
export const MIGRATIONS: Migration[] = [
  {
    name: "001_tasks",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          parent_id TEXT,
          depth INTEGER NOT NULL DEFAULT 0,
          chat_id INTEGER NOT NULL,
          created_by TEXT NOT NULL,
          assigned_to TEXT,
          title TEXT NOT NULL,
          description TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          priority INTEGER NOT NULL DEFAULT 0,
          deadline INTEGER,
          input TEXT,
          output TEXT,
          error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY(parent_id) REFERENCES tasks(id)
        );
        CREATE INDEX IF NOT EXISTS idx_tasks_assigned_status ON tasks(assigned_to, status);
        CREATE INDEX IF NOT EXISTS idx_tasks_chat_status ON tasks(chat_id, status);
        CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
      `);
    },
  },
  {
    name: "002_permissions",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS permissions (
          agent_key TEXT NOT NULL,
          action_type TEXT NOT NULL,
          allowed INTEGER NOT NULL DEFAULT 1,
          requires_approval INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(agent_key, action_type)
        );
      `);
    },
  },
  {
    name: "003_autonomy_modes",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS autonomy_modes (
          scope TEXT NOT NULL,
          scope_id TEXT NOT NULL,
          mode TEXT NOT NULL CHECK(mode IN ('locked','manual','semi_auto','auto')),
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(scope, scope_id)
        );
      `);
      // Сид: глобальный дефолт semi_auto, если ещё нет
      db.prepare(
        `INSERT OR IGNORE INTO autonomy_modes(scope, scope_id, mode, updated_at)
         VALUES ('global','*','semi_auto', unixepoch())`,
      ).run();
    },
  },
  {
    name: "004_approvals",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS approvals (
          id TEXT PRIMARY KEY,
          action_id TEXT NOT NULL,
          chat_id INTEGER NOT NULL,
          requested_by TEXT NOT NULL,
          action_type TEXT NOT NULL,
          payload TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          decided_by TEXT,
          decided_at INTEGER,
          reason TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_approvals_status_chat ON approvals(status, chat_id);
      `);
    },
  },
  {
    name: "005_agent_actions",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_actions (
          id TEXT PRIMARY KEY,
          agent_key TEXT NOT NULL,
          task_id TEXT,
          chat_id INTEGER,
          action_type TEXT NOT NULL,
          payload TEXT,
          status TEXT NOT NULL,
          result TEXT,
          error TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_actions_agent_ts ON agent_actions(agent_key, created_at);
        CREATE INDEX IF NOT EXISTS idx_agent_actions_task ON agent_actions(task_id);
      `);
    },
  },
  {
    name: "006_seed_permissions",
    up: (db) => {
      const ins = db.prepare(
        `INSERT OR IGNORE INTO permissions(agent_key, action_type, allowed, requires_approval)
         VALUES (?, ?, 1, 0)`,
      );
      for (const c of CHARACTERS) {
        for (const at of ACTION_TYPES) {
          ins.run(c.key, at);
        }
      }
    },
  },
  {
    name: "007_seed_action_permissions",
    up: (db) => {
      // 7 новых action types для Telegram-действий (C6A).
      // requires_approval=0 для безопасных, =1 для рискованных/необратимых.
      const NEW_ACTIONS: Array<{ type: string; requiresApproval: 0 | 1 }> = [
        { type: "SEND_MESSAGE", requiresApproval: 0 },
        { type: "SET_REACTION", requiresApproval: 0 },
        { type: "FORWARD_MESSAGE", requiresApproval: 0 },
        { type: "EDIT_MESSAGE", requiresApproval: 1 },
        { type: "PIN_MESSAGE", requiresApproval: 1 },
        { type: "DELETE_MESSAGE", requiresApproval: 1 },
        { type: "CREATE_POLL", requiresApproval: 1 },
      ];
      const ins = db.prepare(
        `INSERT OR IGNORE INTO permissions(agent_key, action_type, allowed, requires_approval)
         VALUES (?, ?, 1, ?)`,
      );
      for (const c of CHARACTERS) {
        for (const a of NEW_ACTIONS) {
          ins.run(c.key, a.type, a.requiresApproval);
        }
      }
    },
  },
  {
    // R-A: единый идемпотентный сид всех action types из канонического списка at the time.
    // Старые миграции уже применены; INSERT OR IGNORE дозальёт всё, чего не хватает,
    // не трогая существующие настройки permissions.
    name: "008_unify_action_permissions_seed",
    up: (db) => {
      const ACTION_TYPES_008 = [
        "SEND_MESSAGE", "CREATE_TASK", "ASSIGN_TASK", "UPDATE_TASK_STATUS", 
        "REQUEST_REVIEW", "COMMENT_TASK", "SET_REACTION", "EDIT_MESSAGE",
        "PIN_MESSAGE", "DELETE_MESSAGE", "FORWARD_MESSAGE", "CREATE_POLL"
      ];
      const ins = db.prepare(
        `INSERT OR IGNORE INTO permissions(agent_key, action_type, allowed, requires_approval)
         VALUES (?, ?, 1, ?)`,
      );
      for (const c of CHARACTERS) {
        for (const at of ACTION_TYPES_008) {
          ins.run(c.key, at, REQUIRES_APPROVAL[at] ?? 0);
        }
      }
    },
  },
  {
    // C8: засеять права на новые action types — SEND_PHOTO и GENERATE_SVG_IMAGE.
    // Идём по тому же шаблону, что 008: INSERT OR IGNORE, allowed=1, requires_approval=0.
    name: "009_seed_send_photo_and_svg",
    up: (db) => {
      const NEW_TYPES = ["SEND_PHOTO", "GENERATE_SVG_IMAGE"] as const;
      const ins = db.prepare(
        `INSERT OR IGNORE INTO permissions(agent_key, action_type, allowed, requires_approval)
         VALUES (?, ?, 1, 0)`,
      );
      for (const c of CHARACTERS) {
        for (const at of NEW_TYPES) {
          ins.run(c.key, at);
        }
      }
    },
  },
  {
    // C9: засеять права на GENERATE_IMAGE (OpenAI gpt-image-1).
    // Тот же шаблон, что 009: INSERT OR IGNORE, allowed=1, requires_approval=0.
    name: "010_seed_generate_image",
    up: (db) => {
      const NEW_TYPES = ["GENERATE_IMAGE"] as const;
      const ins = db.prepare(
        `INSERT OR IGNORE INTO permissions(agent_key, action_type, allowed, requires_approval)
         VALUES (?, ?, 1, 0)`,
      );
      for (const c of CHARACTERS) {
        for (const at of NEW_TYPES) {
          ins.run(c.key, at);
        }
      }
    },
  },
  {
    // C10: seed DELEGATE_TO_ROLE permission for all 12 agents.
    // Тот же шаблон, что 009/010: INSERT OR IGNORE, allowed=1, requires_approval=0.
    name: "012_seed_delegate_to_role",
    up: (db) => {
      const NEW_TYPES = ["DELEGATE_TO_ROLE"] as const;
      const ins = db.prepare(
        `INSERT OR IGNORE INTO permissions(agent_key, action_type, allowed, requires_approval)
         VALUES (?, ?, 1, 0)`,
      );
      for (const c of CHARACTERS) {
        for (const at of NEW_TYPES) {
          ins.run(c.key, at);
        }
      }
    },
  },
  {
    // C11: seed WRITE_WIKI permission for all 12 agents.
    // SEARCH_WIKI / READ_WIKI are read-only and bypass the gate entirely.
    name: "013_seed_write_wiki",
    up: (db) => {
      const NEW_TYPES = ["WRITE_WIKI"] as const;
      const ins = db.prepare(
        `INSERT OR IGNORE INTO permissions(agent_key, action_type, allowed, requires_approval)
         VALUES (?, ?, 1, 0)`,
      );
      for (const c of CHARACTERS) {
        for (const at of NEW_TYPES) {
          ins.run(c.key, at);
        }
      }
    },
  },
  {
    // C16: per-agent daily token usage table. Date is part of the PK so
    // budgets reset automatically at UTC midnight.
    name: "014_agent_token_usage",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_token_usage (
          agent_key TEXT NOT NULL,
          date TEXT NOT NULL,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(agent_key, date)
        );
      `);
    },
  },
  {
    // C23 (M1): per-agent pause flag for Mini App control.
    name: "015_agent_states",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_states (
          agent_key TEXT PRIMARY KEY,
          paused INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL
        );
      `);
    },
  },
  {
    // C27: hot-path indexes for Mini App list endpoints.
    // Each CREATE INDEX is wrapped in a guard that checks the underlying
    // table exists, so this migration stays safe even if earlier migrations
    // have not created some table (defensive — they always have in practice).
    name: "016_miniapp_perf_indexes",
    up: (db) => {
      const tableExists = (name: string): boolean =>
        !!db
          .prepare(
            `SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`,
          )
          .get(name);

      if (tableExists("tasks")) {
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_tasks_status_created
             ON tasks(status, created_at DESC);`,
        );
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to
             ON tasks(assigned_to);`,
        );
      }
      if (tableExists("approvals")) {
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_approvals_status_chat_v2
             ON approvals(status, chat_id);`,
        );
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_approvals_created
             ON approvals(created_at DESC);`,
        );
      }
      if (tableExists("agent_actions")) {
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_agent_actions_agent_created
             ON agent_actions(agent_key, created_at DESC);`,
        );
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_agent_actions_status
             ON agent_actions(status);`,
        );
      }
      // audit_logs is not present in this codebase; skip.
    },
  },
  {
    // C29: seed SPLIT_TASK permission — only orchestrator may invoke it.
    // Other 11 agents get an explicit `allowed=0` row so the gate denies.
    name: "017_seed_split_task",
    up: (db) => {
      const ins = db.prepare(
        `INSERT OR IGNORE INTO permissions(agent_key, action_type, allowed, requires_approval)
         VALUES (?, 'SPLIT_TASK', ?, 0)`,
      );
      for (const c of CHARACTERS) {
        ins.run(c.key, c.key === "orchestrator" ? 1 : 0);
      }
    },
  },
  {
    // C31: seed LIST_RECENT_MESSAGES — read-only listing of recent messages
    // (incl. service-prefixed entries). Only orchestrator, tgdev and perm get
    // allowed=1; all other roles get an explicit allowed=0 row.
    name: "018_seed_list_recent_messages",
    up: (db) => {
      const ALLOWED_ROLES = new Set<string>(["orchestrator", "tgdev", "perm"]);
      const ins = db.prepare(
        `INSERT OR IGNORE INTO permissions(agent_key, action_type, allowed, requires_approval)
         VALUES (?, 'LIST_RECENT_MESSAGES', ?, 0)`,
      );
      for (const c of CHARACTERS) {
        ins.run(c.key, ALLOWED_ROLES.has(c.key) ? 1 : 0);
      }
    },
  },
  {
    // C31 DB-maint: archive tables for old agent_actions / audit_logs rows.
    // Same schema as source + archived_at INTEGER. audit_logs itself does not
    // exist in this codebase (agent_actions is the de-facto audit log), but
    // we create both source + archive idempotently so the maint module has
    // a stable target.
    name: "019_archive_tables",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_actions_archive (
          id TEXT PRIMARY KEY,
          agent_key TEXT NOT NULL,
          task_id TEXT,
          chat_id INTEGER,
          action_type TEXT NOT NULL,
          payload TEXT,
          status TEXT NOT NULL,
          result TEXT,
          error TEXT,
          created_at INTEGER NOT NULL,
          archived_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_actions_archive_created
          ON agent_actions_archive(created_at);

        CREATE TABLE IF NOT EXISTS audit_logs (
          id TEXT PRIMARY KEY,
          agent_key TEXT,
          chat_id INTEGER,
          event_type TEXT NOT NULL,
          payload TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_audit_logs_created
          ON audit_logs(created_at);

        CREATE TABLE IF NOT EXISTS audit_logs_archive (
          id TEXT PRIMARY KEY,
          agent_key TEXT,
          chat_id INTEGER,
          event_type TEXT NOT NULL,
          payload TEXT,
          created_at INTEGER NOT NULL,
          archived_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_audit_logs_archive_created
          ON audit_logs_archive(created_at);
      `);
    },
  },
  {
    // Stage A (Mac control): seed MAC_RUN_CLAUDE — only orchestrator may
    // invoke; gate requires approval in semi_auto. Other roles get an
    // explicit allowed=0 row so the gate denies.
    name: "020_seed_mac_run_claude",
    up: (db) => {
      const ins = db.prepare(
        `INSERT OR IGNORE INTO permissions(agent_key, action_type, allowed, requires_approval)
         VALUES (?, 'MAC_RUN_CLAUDE', ?, ?)`,
      );
      for (const c of CHARACTERS) {
        if (c.key === "orchestrator") {
          ins.run(c.key, 1, 1);
        } else {
          ins.run(c.key, 0, 0);
        }
      }
    },
  },
  {
    // Stage B (Mac control): seed MAC_STOP — only orchestrator may invoke;
    // gate requires approval in semi_auto. Other roles get an explicit
    // allowed=0 row so the gate denies.
    name: "021_seed_mac_stop",
    up: (db) => {
      const ins = db.prepare(
        `INSERT OR IGNORE INTO permissions(agent_key, action_type, allowed, requires_approval)
         VALUES (?, 'MAC_STOP', ?, ?)`,
      );
      for (const c of CHARACTERS) {
        if (c.key === "orchestrator") {
          ins.run(c.key, 1, 1);
        } else {
          ins.run(c.key, 0, 0);
        }
      }
    },
  },
  {
    // T-270 SMM: content calendar skeleton for scheduled posts
    name: "022_content_calendar",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS content_calendar (
          id TEXT PRIMARY KEY,
          channel TEXT NOT NULL,
          scheduled_at INTEGER NOT NULL,
          payload TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','sent','cancelled')),
          created_at INTEGER NOT NULL,
          sent_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_content_calendar_scheduled
          ON content_calendar(scheduled_at, status);
        CREATE INDEX IF NOT EXISTS idx_content_calendar_channel
          ON content_calendar(channel, status);
      `);
    },
  },
  {
    // T-270 SMM: seed SCHEDULE_POST permission
    name: "023_seed_schedule_post",
    up: (db) => {
      const ins = db.prepare(
        `INSERT OR IGNORE INTO permissions(agent_key, action_type, allowed, requires_approval)
         VALUES (?, 'SCHEDULE_POST', 1, 1)`,
      );
      for (const c of CHARACTERS) {
        ins.run(c.key);
      }
    },
  },
  {
    // T-520 (cherry-pick T-220): добавляем tg_message_id в agent_actions для
    // связки audit-записей с конкретными Telegram-сообщениями. chat_id уже есть
    // (миграция 005). Плюс view audit_log_telegram для Mini App Logs page.
    name: "024_add_tg_message_id",
    up: (db) => {
      addColumn(db, "agent_actions", "tg_message_id INTEGER");
      db.exec(`
        CREATE VIEW IF NOT EXISTS audit_log_telegram AS
        SELECT
          id,
          agent_key,
          chat_id,
          tg_message_id,
          action_type,
          payload,
          status,
          result,
          error,
          created_at
        FROM agent_actions
        WHERE chat_id IS NOT NULL
        ORDER BY created_at DESC;
      `);
    },
  },
  {
    // T-527: persistent per-agent daily token budget overrides (Mini App Settings page).
    // Overrides TOKEN_BUDGET_<KEY> env defaults at runtime.
    name: "025_budget_settings",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS budget_settings (
          agent_key TEXT PRIMARY KEY,
          daily_input_tokens INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          updated_by TEXT
        );
      `);
    },
  },
  {
    // T-410 (T-303 HIGH #2): request_id column for end-to-end tracing of
    // a single Telegram update / Mini App request / Mac bridge command /
    // scheduler tick through dispatch + audit_log. NULL-able for backward
    // compat with rows written before this migration.
    name: "026_add_request_id",
    up: (db) => {
      addColumn(db, "agent_actions", "request_id TEXT");
      // Index for "show me everything in one request" queries from the Mini
      // App Logs page / ad-hoc journalctl-style debugging.
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_agent_actions_request_id ON agent_actions(request_id);`,
      );
    },
  },
  {
    // T-703: add `status` column to agent_states ("active" | "disabled").
    // Idempotent: ADD COLUMN errors with "duplicate column name" are swallowed
    // so re-running the migration on an already-migrated DB is safe.
    name: "027_agent_states_status",
    up: (db) => {
      // Ensure agent_states exists (defensive — migration 015 creates it).
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_states (
          agent_key TEXT PRIMARY KEY,
          paused INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL
        );
      `);
      addColumn(db, "agent_states", "status TEXT NOT NULL DEFAULT 'active'");
    },
  },
  {
    // T-702: versioned per-agent system-prompt history. aieng proposes,
    // user approves; row is inserted at dispatch time with applied_at=NULL,
    // then applied_at is set when the approval lands. On reject the row
    // stays with applied_at=NULL as the audit trail. UNIQUE(agent_key,
    // version) makes version monotonic per agent.
    name: "028_agent_prompts",
    up: (db) => {
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS agent_prompts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            agent_key TEXT NOT NULL,
            version INTEGER NOT NULL,
            prompt TEXT NOT NULL,
            edited_by TEXT NOT NULL,
            edited_at INTEGER NOT NULL,
            applied_at INTEGER,
            reason TEXT NOT NULL,
            UNIQUE(agent_key, version)
          );
          CREATE INDEX IF NOT EXISTS idx_agent_prompts_key_version
            ON agent_prompts(agent_key, version);
        `);
      } catch (e) {
        const msg = getErrorMessage(e);
        if (!/already exists/i.test(msg)) throw e;
      }
    },
  },
  {
    // T-318: PII/retention GC for `messages` table. Mirrors the *_archive pattern
    // from migration 019 (agent_actions_archive / audit_logs_archive).
    // Renumbered from 026 to 029 during rebase — 026/027/028 were taken by
    // T-410 / T-703 / T-702 which landed on main first.
    name: "029_messages_archive",
    up: (db) => {
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS messages_archive (
            id INTEGER PRIMARY KEY,
            chat_id TEXT NOT NULL,
            agent_key TEXT,
            is_bot INTEGER NOT NULL,
            from_user_id TEXT NOT NULL,
            from_name TEXT,
            text TEXT NOT NULL,
            ts INTEGER NOT NULL,
            archived_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_messages_archive_ts
            ON messages_archive(ts);
        `);
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        if (!/already exists|duplicate/i.test(msg)) throw e;
      }
    },
  },
  {
    name: "030_messages_dedup",
    up: (db) => {
      // T-543: Add tg_message_id and transport columns for message deduplication
      // tg_message_id: Telegram message ID for deduplication across Bot API and MTProto
      // transport: 'bot_api' or 'userbot' to track source
      addColumn(db, "messages", "tg_message_id INTEGER");
      addColumn(db, "messages", "transport TEXT DEFAULT 'bot_api'");
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_dedup
        ON messages(chat_id, tg_message_id) 
        WHERE tg_message_id IS NOT NULL;
      `);
    },
  },
  {
    name: "031_processed_triggers",
    up: (db) => {
      // T-545: Add table to track processed trigger messages for anti-dup orchestrator triggers
      // Prevents the same (chat_id, tg_message_id) trigger from being processed twice within N seconds
      db.exec(`
        CREATE TABLE IF NOT EXISTS processed_triggers (
          id INTEGER PRIMARY KEY,
          chat_id TEXT NOT NULL,
          tg_message_id INTEGER NOT NULL,
          processed_at INTEGER NOT NULL,
          UNIQUE(chat_id, tg_message_id)
        );
        
        CREATE INDEX IF NOT EXISTS idx_processed_triggers_cleanup
        ON processed_triggers(processed_at);
      `);
    },
  },
  {
    // T-701: seed CREATE_DIAGNOSTIC_TASK for all 12 agents. Any role may
    // explicitly request a diagnostic investigation; allowed=1,
    // requires_approval=0 (creating a task is not an external side-effect).
    name: "032_seed_create_diagnostic_task",
    up: (db) => {
      const NEW_TYPES = ["CREATE_DIAGNOSTIC_TASK"] as const;
      const ins = db.prepare(
        `INSERT OR IGNORE INTO permissions(agent_key, action_type, allowed, requires_approval)
         VALUES (?, ?, 1, 0)`,
      );
      for (const c of CHARACTERS) {
        for (const at of NEW_TYPES) {
          ins.run(c.key, at);
        }
      }
    },
  },
  {
    // P1 (2026-06-09): seed SEND_DOCUMENT — агенты могут прислать текстовый файл
    // (отчёт/аудит/выгрузку) в чат. Тот же шаблон: allowed=1, requires_approval=0.
    name: "033_seed_send_document",
    up: (db) => {
      const NEW_TYPES = ["SEND_DOCUMENT"] as const;
      const ins = db.prepare(
        `INSERT OR IGNORE INTO permissions(agent_key, action_type, allowed, requires_approval)
         VALUES (?, ?, 1, 0)`,
      );
      for (const c of CHARACTERS) {
        for (const at of NEW_TYPES) {
          ins.run(c.key, at);
        }
      }
    },
  },
  {
    // P2 (2026-06-09): controlled discussion mode per chat. When ON, the
    // in-process handoff chain is allowed to traverse deeper (more roles weigh
    // in) — still bounded by the `visited` set (each role once → ≤12 hops).
    name: "034_chat_settings",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS chat_settings (
          chat_id TEXT PRIMARY KEY,
          discussion_mode INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL DEFAULT 0
        );
      `);
    },
  },
  {
    // T-722 (SEC-audit F2): scope scheduled posts to the chat that created them
    // so LIST/CANCEL can't enumerate/cancel another chat's posts (cross-tenant).
    // Legacy rows keep chat_id NULL (won't match a chat filter — safe default).
    name: "035_content_calendar_chat_scope",
    up: (db) => {
      addColumn(db, "content_calendar", "chat_id INTEGER");
    },
  },
  {
    // CREATE_TEAM_CHANNEL: разрешаем orchestrator'у (allowed=1, requires_approval=0
    // — в auto идёт сразу, в semi_auto уходит на approval через SEMI_AUTO_RISKY).
    name: "036_seed_create_team_channel",
    up: (db) => {
      db.prepare(
        `INSERT OR IGNORE INTO permissions(agent_key, action_type, allowed, requires_approval)
         VALUES ('orchestrator', 'CREATE_TEAM_CHANNEL', 1, 0)`,
      ).run();
    },
  },
  {
    // Реестр каналов, созданных командой — PUBLISH_TO_CHANNEL пускает только сюда.
    name: "037_team_channels",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS team_channels (
          channel_id INTEGER PRIMARY KEY,
          title TEXT NOT NULL,
          created_by_chat INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );
      `);
    },
  },
  {
    // PUBLISH_TO_CHANNEL: контентные роли могут постить в team-каналы.
    name: "038_seed_publish_to_channel",
    up: (db) => {
      for (const role of ["smm", "copy", "design", "orchestrator"]) {
        db.prepare(
          `INSERT OR IGNORE INTO permissions(agent_key, action_type, allowed, requires_approval)
           VALUES (?, 'PUBLISH_TO_CHANNEL', 1, 0)`,
        ).run(role);
      }
    },
  },
  {
    // Аудит 2026-08-04: «сделано сегодня» у суточного обслуживания жило только
    // в памяти процесса, поэтому каждый рестарт после dailyHourUTC запускал
    // archive+gc+VACUUM заново — три деплоя за день = три полных VACUUM'а, и
    // каждый синхронный, на том же потоке, где 12 ботов и HTTP Mini App.
    // Маркер переезжает в саму БД: digest решает ту же задачу файлом
    // `.digest-last`, но тот зависит от cwd, а обслуживанию БД доступна по
    // определению.
    name: "039_maint_state",
    up: (db) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS maint_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
    },
  },
  {
    // Аудит 2026-08-04: архивация теряла колонки. `messages_archive` и
    // `agent_actions_archive` создавались по схеме источника ТОГО времени, а
    // источник с тех пор оброс полями (migrations 026, 030): у agent_actions —
    // `request_id` и `tg_message_id`, у messages — `kind`, `tg_message_id`,
    // `transport`. INSERT...SELECT в db-maint перечисляет колонки явно, так что
    // новые поля молча не переносились, а следом шёл DELETE источника.
    //
    // Это не гипотетическая гонка, а гарантированная потеря на КАЖДОМ суточном
    // прогоне: `request_id` — ключ сквозной корреляции одного хода (по нему
    // группируются действия), `transport` отличает bot_api от userbot. Через 30
    // дней ответ на «через какой контур это ушло и что было в том же ходе»
    // переставал существовать — в аудит-следе, который для того и заводился.
    //
    // Колонки NULL-able: у строк, заархивированных до этой миграции, значения
    // уже не восстановить, и backfill'а тут быть не может.
    name: "040_archive_missing_columns",
    up: (db) => {
      addColumn(db, "agent_actions_archive", "tg_message_id INTEGER");
      addColumn(db, "agent_actions_archive", "request_id TEXT");
      addColumn(db, "messages_archive", "tg_message_id INTEGER");
      addColumn(db, "messages_archive", "transport TEXT");
      // NB: `messages.kind` сюда сознательно НЕ добавлен. На проде такая колонка
      // есть (вместе с idx_messages_kind), но её не создаёт ни одна миграция и
      // не читает ни одна строка кода — её добавили руками по месту. Свежая
      // установка и CI живут без неё, так что перенос `kind` уронил бы
      // архивацию везде, кроме прода. Дрейф схемы чинится отдельно и осознанно,
      // а не попутно здесь.

      // Отбор в архив идёт по одному предикату `created_at < ?` / `ts < ?`, а
      // покрывающих индексов на него не было: idx_agent_actions_agent_created
      // ведёт с agent_key, idx_messages_chat_ts — с chat_id, так что оба
      // суточных прогона читали таблицу целиком.
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_agent_actions_created ON agent_actions(created_at);`,
      );
      db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);`);
    },
  },
  {
    // Аудит 2026-08-12: `scope` в wiki_fts был индексируемой колонкой, то есть
    // имя области участвовало в полнотекстовом поиске. Запрос со словом
    // «backend» (или «team» — unicode61 режет `_team` по подчёркиванию)
    // матчился КАЖДОЙ страницей этой области, даже без самого слова внутри.
    // wikiSearch отдаёт пять хитов, и они идут в промпт роли: слоты забивались
    // страницами своей же области, вытесняя ту, где ответ. Отбор по области
    // делает WHERE scope IN (...), так что MATCH по ней не давал ничего.
    //
    // Опции колонок fts5 менять нельзя — только пересоздавать таблицу. Данные
    // здесь производные: источник правды — .md-файлы на диске, а
    // rebuildWikiIndex() зовётся при старте команды (orchestrator-team.ts).
    // Поэтому переносим содержимое как есть, а полный ребилд из файлов
    // случится штатно на ближайшем старте.
    name: "041_wiki_fts_scope_unindexed",
    up: (db) => {
      const row = db
        .prepare(
          `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'wiki_fts'`,
        )
        .get() as { sql?: string } | undefined;
      if (!row?.sql) return; // таблицы ещё нет — её создаст свежая схема
      if (/scope\s+UNINDEXED/i.test(row.sql)) return; // уже починено
      const rows = db
        .prepare(`SELECT scope, slug, title, content FROM wiki_fts`)
        .all() as Array<{
        scope: string;
        slug: string;
        title: string;
        content: string;
      }>;
      db.exec(`DROP TABLE wiki_fts;`);
      db.exec(`
        CREATE VIRTUAL TABLE wiki_fts USING fts5(
          scope UNINDEXED,
          slug UNINDEXED,
          title,
          content,
          tokenize='unicode61'
        );
      `);
      const ins = db.prepare(
        `INSERT INTO wiki_fts(scope, slug, title, content) VALUES (?, ?, ?, ?)`,
      );
      for (const r of rows) ins.run(r.scope, r.slug, r.title, r.content);
    },
  },
  {
    // Аудит 2026-08-14: `approvals` — единственная растущая таблица без архива.
    // Суточное обслуживание её не трогает вовсе: `expireStaleApprovals` только
    // переписывает `status`, в ARCHIVE_SPECS её нет, в ARCHIVE_TABLES холодного
    // хранилища — тоже. Замер (200 решённых заявок PUBLISH_TO_CHANNEL возрастом
    // 400 суток, прогон archiveOldRows + gcMessages + expireStaleApprovals):
    // было 200 → стало 200, 852 КБ, самой старой строке 400 дней. В `payload`
    // лежит целиком тело поста / документа / промпта, то есть таблица растёт
    // не счётчиком, а килобайтами на заявку.
    //
    // Схема — зеркало источника (миграция 004) плюс `archived_at`, как у
    // agent_actions_archive: moveToArchive перечисляет колонки явно и сверяет
    // их с PRAGMA источника, поэтому расхождение схемы будет видно в логе.
    name: "042_approvals_archive",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS approvals_archive (
          id TEXT PRIMARY KEY,
          action_id TEXT NOT NULL,
          chat_id INTEGER NOT NULL,
          requested_by TEXT NOT NULL,
          action_type TEXT NOT NULL,
          payload TEXT NOT NULL,
          status TEXT NOT NULL,
          decided_by TEXT,
          decided_at INTEGER,
          reason TEXT,
          created_at INTEGER NOT NULL,
          archived_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_approvals_archive_created
          ON approvals_archive(created_at);
      `);
    },
  },
  {
    // Аудит 2026-08-20: у всех четырёх архивов индекс стоит на столбце, по
    // которому их никто не спрашивает.
    //
    // 019 создала idx_agent_actions_archive_created и
    // idx_audit_logs_archive_created по `created_at`, 029 —
    // idx_messages_archive_ts по `ts`, 042 — idx_approvals_archive_created по
    // `created_at`. Это время события в ИСХОДНОЙ таблице. А единственный, кто
    // читает архивы диапазоном, — холодное хранилище, и оно фильтрует
    // исключительно по `archived_at`: `cold-storage.ts:151` (сколько выгружать),
    // `:163` (страница) и `:290` (удаление выгруженного). Всё остальное ходит
    // в архивы по первичному ключу (`approvals.ts:189`,
    // `miniapp-server.ts:1242`, `db-maint.ts:719`).
    //
    // Замер на копии схемы, 80k строк, совпадает 300:
    //   COUNT(*) WHERE archived_at < ?   SCAN 6.22ms  ->  COVERING INDEX 0.01ms
    //   DELETE   WHERE archived_at < ?   скан по rowid ->  поиск по индексу
    // Страничный SELECT план не меняет и после индекса: у него ORDER BY rowid,
    // и SQLite остаётся на обходе по первичному ключу. Составной
    // (archived_at, rowid) невозможен — rowid не индексируется.
    //
    // Миграция 040 починила ровно это на исходных таблицах, но до архивов не
    // дошла. Ничего не удаляем: старые индексы по created_at/ts безвредны,
    // а снос индекса на живой базе — отдельное решение владельца.
    name: "043_archive_archived_at_indexes",
    up: (db) => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_agent_actions_archive_archived_at
          ON agent_actions_archive(archived_at);
        CREATE INDEX IF NOT EXISTS idx_audit_logs_archive_archived_at
          ON audit_logs_archive(archived_at);
        CREATE INDEX IF NOT EXISTS idx_messages_archive_archived_at
          ON messages_archive(archived_at);
        CREATE INDEX IF NOT EXISTS idx_approvals_archive_archived_at
          ON approvals_archive(archived_at);
      `);
    },
  },
  {
    // T-512: local replacement for the former workflow-dispatch boundary.
    // Legacy pending SPAWN_ROLE task payloads are imported with provider=internal
    // when no provider was recorded. A legacy running task is deliberately not
    // imported: it may still belong to an older executor, while the new local
    // runtime can claim only pending tasks. Leaving it in tasks keeps the
    // uncertainty visible instead of presenting an unclaimable queue item.
    name: "044_role_runtime_queue",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS role_runtime_queue (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL UNIQUE,
          role_slug TEXT NOT NULL,
          system_prompt TEXT NOT NULL,
          task_hint TEXT NOT NULL DEFAULT '',
          provider TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('queued','running','done','failed')),
          chat_id INTEGER NOT NULL,
          created_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY(task_id) REFERENCES tasks(id)
        );
        CREATE INDEX IF NOT EXISTS idx_role_runtime_queue_state
          ON role_runtime_queue(state, created_at);
      `);

      const rows = db.prepare(
        `SELECT id, chat_id, created_by, input FROM tasks
        WHERE status = 'pending'
           AND input LIKE '%"_spawn_role":true%'`,
      ).all() as Array<{ id: string; chat_id: number; created_by: string; input: string | null }>;
      const insert = db.prepare(
        `INSERT OR IGNORE INTO role_runtime_queue(
          id, task_id, role_slug, system_prompt, task_hint, provider,
          state, chat_id, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
      );
      for (const row of rows) {
        try {
          const payload = JSON.parse(row.input ?? "{}");
          if (payload?._spawn_role !== true) continue;
          const roleSlug = typeof payload.role_slug === "string" && payload.role_slug.trim()
            ? payload.role_slug.trim().slice(0, 64)
            : `legacy-${row.id.slice(0, 8)}`;
          const systemPrompt = typeof payload.system_prompt === "string" ? payload.system_prompt : "";
          if (!systemPrompt) continue;
          const provider = typeof payload.provider === "string" && payload.provider.trim()
            ? payload.provider.trim().toLowerCase()
            : "internal";
          insert.run(
            row.id,
            row.id,
            roleSlug,
            systemPrompt,
            typeof payload.task_hint === "string" ? payload.task_hint : "",
            provider,
            row.chat_id,
            row.created_by,
            Date.now(),
          );
        } catch {
          // Invalid legacy payloads remain in tasks for operator inspection.
        }
      }    },
  },
  {
    /*
     * Аудит 2026-08-27: снять дрейф схемы, из-за которого суточная уборка
     * `messages` на проде падала бы КАЖДЫЙ день.
     *
     * `messages.kind` на проде есть (добавлена руками вместе с
     * idx_messages_kind), ни одной миграцией не создаётся и ни одной строкой
     * кода не читается. Пока `warnOnUncopiedColumns` только предупреждал, это
     * было терпимо: архивация шла, теряя неиспользуемую колонку. Затем
     * `resolveArchiveColumns` стал fail-closed — и любая колонка, объявленная
     * в `optionalColumns` и присутствующая в источнике, обязана быть в архиве.
     * `MESSAGES_SPEC.optionalColumns = ["kind"]`, в `messages_archive` её нет:
     * `gcMessages` бросает `archive schema incompatible ... missing from
     * archive: kind` ещё до транзакции, `runDaily` шлёт
     * `db_maint.messages_gc_failed`, и так каждые сутки бессрочно. Ретеншн
     * персональных данных (MESSAGES_RETENTION_DAYS) перестаёт действовать
     * вовсе, `messages` растёт без ограничения. В CI при этом зелено — там
     * колонки нет, и fail-closed не срабатывает.
     *
     * Миграция 040 сознательно не добавляла `kind` в архив, рассуждая, что
     * перенос уронит всех, кроме прода. Для СПИСКА КОПИРОВАНИЯ это было верно,
     * но `optionalColumns` уже решает ту задачу (копирует только при наличии в
     * обеих таблицах), а сама колонка в архиве безвредна везде: nullable, без
     * backfill'а, на свежей установке просто пустует.
     */
    name: "045_messages_archive_kind",
    up: (db) => {
      addColumn(db, "messages_archive", "kind TEXT");
    },
  },
  {
    /*
     * Аудит 2026-08-27: у `role_runtime_queue` не было ни архива, ни удаления.
     * Суточный прогон её не касался вовсе: в `archiveOldRows` три спеки
     * (agent_actions, audit_logs, approvals), `gcMessages` — про messages, а
     * `gcStaleTasks` переписывает `tasks`, но не очередь.
     *
     * Растёт она килобайтами, а не строками: `system_prompt NOT NULL` хранит
     * ЦЕЛИКОМ системный промпт временной роли, то есть дубль того же текста,
     * который уже лежит в `tasks.input`. Строк мало (SPAWN_ROLE проходит
     * ручное одобрение владельца), но каждая — это несколько килобайт текста,
     * который остаётся в живой БД бессрочно и после того, как роль отработала.
     *
     * Архив, а не DELETE: очередь — след одобренного владельцем действия, и
     * терять его нельзя. Терминальные состояния уезжают в холодную таблицу,
     * 'queued'/'running' остаются в живой (граница в extraWhere спеки).
     */
    name: "046_role_runtime_queue_archive",
    up: (db) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS role_runtime_queue_archive (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          role_slug TEXT NOT NULL,
          system_prompt TEXT NOT NULL,
          task_hint TEXT NOT NULL DEFAULT '',
          provider TEXT NOT NULL,
          state TEXT NOT NULL,
          chat_id INTEGER NOT NULL,
          created_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          archived_at INTEGER NOT NULL
        );
      `);
      db.run(`
        CREATE INDEX IF NOT EXISTS idx_role_runtime_queue_archive_created
          ON role_runtime_queue_archive(created_at);
      `);
    },
  },
  {
    /*
     * Аудит 2026-08-27: миграция 046 завела архиву индекс по `created_at` —
     * по колонке, которой её никто не читает. Единственный читатель холодной
     * таблицы — `cold-storage.ts`, и все три его запроса (счёт, страница,
     * прополка) отбирают по `archived_at`. Остальные четыре архива получили
     * такой индекс миграцией 043 ровно за этим; `role_runtime_queue_archive`
     * приехала позже и мимо неё.
     *
     * Цена ошибки — полный скан холодной таблицы на каждом суточном прогоне,
     * то есть ровно на той таблице, которую заводили, чтобы БД не росла:
     * чем дольше она копится, тем дороже проход, который должен её разгружать.
     *
     * Индекс по `created_at` остаётся: строк тут единицы (SPAWN_ROLE проходит
     * ручное одобрение владельца), лишняя запись при вставке не стоит ничего,
     * а `QUERY_DB` пускает в эту таблицу произвольный SELECT — сносить под
     * ним индекс ради нуля выигрыша не за что.
     */
    name: "047_role_runtime_queue_archive_archived_at_index",
    up: (db) => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_role_runtime_queue_archive_archived_at
          ON role_runtime_queue_archive(archived_at);
      `);
    },
  },
  {
    /*
     * Аудит 2026-08-27: `applied_at IS NULL` означал сразу две разные вещи —
     * «ещё не решено» и «владелец отказал». Различить их было нечем.
     *
     * Отказ (`handleUpdateAgentPromptRejected`) строку не трогал вовсе: она
     * оставалась висеть как pending. А одобрение ищет строку по СОДЕРЖИМОМУ
     * (agent_key + prompt + reason — id одобрение сюда не приносит) и берёт
     * `ORDER BY version ASC LIMIT 1`. Типичный сценарий — владелец отклонил
     * v5, автор переспросил тем же текстом, владелец одобрил v6: applied_at
     * ставился на v5, ОТКЛОНЁННУЮ, а одобренная v6 оставалась «не применена
     * никогда». `GET_PROMPT_HISTORY` показывал ровно перевёрнутую картину, и
     * это единственный след правок system prompt'ов, какой есть.
     *
     * Отдельная колонка, а не значение-маркер в applied_at: время отказа —
     * самостоятельный факт, и «отклонена» не должно читаться как «применена».
     */
    name: "048_agent_prompts_rejected_at",
    up: (db) => {
      addColumn(db, "agent_prompts", "rejected_at INTEGER");
    },
  },
  {
    /*
     * Аудит 2026-08-29: вкладка Tasks в Mini App без фильтра по статусу
     * читает таблицу целиком. `GET /api/tasks` строит
     * `SELECT id FROM tasks${where} ORDER BY created_at DESC LIMIT ?`
     * (`miniapp-server.ts:1211`), и когда `statuses` не переданы, `where`
     * пустой. Индекс idx_tasks_status_created(status, created_at DESC)
     * такой запрос не обслуживает: без равенства по первой
     * колонке вторая не даёт порядка. Замерено на реальной схеме:
     * EXPLAIN QUERY PLAN давал `SCAN tasks` + `USE TEMP B-TREE FOR ORDER BY`,
     * то есть весь сорт материализовался до того, как LIMIT отрежет
     * первые N строк; с индексом — `SCAN tasks USING INDEX idx_tasks_created`
     * без temp b-tree, то есть чтение обрывается на LIMIT.
     *
     * Почему это растёт, а не стоит на месте: `tasks` — единственная
     * lifecycle-таблица без архивации и без удаления (db-maint трогает
     * только agent_actions/audit_logs/messages, `DELETE FROM tasks` нет нигде
     * — см. докблок `listTasksByAssignee` в lib/tasks.ts). То есть цена
     * скана растёт всю жизнь деплоя, а ручка дёргается на каждом открытии
     * вкладки в том же процессе, где живут 12 ботов.
     *
     * Строго добавление индекса: ни один существующий план не меняется
     * (ветка с фильтром по-прежнему идёт через idx_tasks_status_created).
     */
    name: "049_tasks_created_index",
    up: (db) => {
      const tableExists = (name: string): boolean =>
        !!db
          .prepare(
            `SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`,
          )
          .get(name);

      if (tableExists("tasks")) {
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_tasks_created
             ON tasks(created_at DESC);`,
        );
      }
    },
  },
  {
    /*
     * Аудит 2026-09-10: строка версии промпта не знала, какая заявка её решает.
     *
     * Связи между `agent_prompts` и `approvals` не было вовсе: и одобрение
     * (`handleUpdateAgentPromptApproved`), и отказ
     * (`handleUpdateAgentPromptRejected`) искали строку ПО СОДЕРЖИМОМУ —
     * `agent_key + prompt + reason`, `applied_at IS NULL AND rejected_at IS
     * NULL`, `ORDER BY version ASC LIMIT 1`. Пока каждая заявка получает
     * решение, это работает: неразрешённая строка ровно одна.
     *
     * Но решение получает не каждая. `expireStaleApprovals` (TTL, db-maint.ts)
     * и `markApprovalFailed` (исполнение упало уже после одобрения) закрывают
     * заявку, НЕ трогая строку версии, — и та остаётся с обоими NULL, то есть
     * неотличимой от ждущей решения. Дальше повторяется развал, который аудит
     * 2026-08-27 уже чинил со стороны отказа: автор переспрашивает тем же
     * текстом (v6), владелец одобряет, а `ORDER BY version ASC` находит
     * ПРОТУХШУЮ v5 и стамповывает applied_at ей. Одобренная v6 навсегда
     * числится непринятой, `GET_PROMPT_HISTORY` показывает перевёрнутую
     * картину — а это единственный след правок system prompt'ов, какой есть.
     *
     * Колонка снимает не симптом, а способ сопоставления: закрыть строку по
     * `approval_id` можно там, где содержимого payload'а под рукой нет вовсе
     * (db-maint работает по таблице approvals), и без разбора JSON.
     * Заполняется с этой миграции вперёд; у строк, созданных раньше, остаётся
     * NULL, и для них работает прежний отбор по содержимому.
     */
    name: "050_agent_prompts_approval_id",
    up: (db) => {
      addColumn(db, "agent_prompts", "approval_id TEXT");
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_agent_prompts_approval
           ON agent_prompts(approval_id);`,
      );
    },
  },
];

/**
 * Применить одну миграцию. Возвращает `true`, если применили мы, и `false`,
 * если кто-то успел раньше.
 *
 * Аудит 2026-08-13: проверка «применена ли миграция» стояла СНАРУЖИ
 * транзакции — классический TOCTOU. Базу открывает не только `agent-team`:
 * любой `bun run tools/*.ts` импортирует `lib/db.ts`, а `runMigrations`
 * зовётся там на уровне модуля. После деплоя с новой миграцией
 * `systemctl restart agent-team` и любой запуск инструмента в ту же секунду
 * дают ровно это: оба процесса читают «не применена», первый применяет и
 * отмечает, второй падает на `UNIQUE constraint failed:
 * schema_migrations.name` — из импорта, то есть не поднимается вообще ничего.
 * Проверено зондом на двух соединениях к одному файлу.
 *
 * Две правки, и обе нужны:
 *
 * 1. Проверка перенесена ВНУТРЬ транзакции — теперь она авторитетна, а не
 *    подсказка из прошлого.
 * 2. `tx.immediate()` вместо `tx()`. Одной проверки внутри мало: транзакция
 *    по умолчанию DEFERRED, то есть берёт снапшот на первом чтении, а
 *    write-лок — только на первой записи. В WAL чужой коммит, попавший между
 *    этими двумя моментами, делает промоушен невозможным, и SQLite сразу
 *    отвечает «database is locked» — `busy_timeout` тут не помогает, ждать
 *    нечего. `BEGIN IMMEDIATE` берёт write-лок сразу, так что и `up()` идёт
 *    под ним: окно закрыто целиком, а не наполовину. (Тоже проверено зондом.)
 */
export function applyMigration(db: Database, m: Migration): boolean {
  const has = db.prepare(`SELECT 1 FROM schema_migrations WHERE name = ?`);
  const mark = db.prepare(
    `INSERT INTO schema_migrations(name, applied_at) VALUES (?, unixepoch())`,
  );
  let applied = false;
  const tx = db.transaction(() => {
    if (has.get(m.name)) return;
    m.up(db);
    mark.run(m.name);
    applied = true;
  });
  tx.immediate();
  return applied;
}

/** Таблица отметок. Вынесена, чтобы тесты не переписывали её DDL у себя. */
export function ensureMigrationsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
}

export function runMigrations(db: Database): void {
  ensureMigrationsTable(db);
  const has = db.prepare(`SELECT 1 FROM schema_migrations WHERE name = ?`);
  for (const m of MIGRATIONS) {
    // Быстрый путь: не брать write-лок на четыре десятка уже применённых
    // миграций при каждом старте. Авторитетная проверка — внутри applyMigration.
    if (has.get(m.name)) continue;
    applyMigration(db, m);
  }
}
