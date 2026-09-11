/**
 * C31 DB-maint: gigiena БД.
 *
 * - archiveOldRows: переносит старые строки `agent_actions` / `audit_logs`
 *   в `*_archive` таблицы (та же схема + archived_at), в одной транзакции
 *   на каждую таблицу: INSERT ... SELECT ... → DELETE (см. moveToArchive —
 *   удаляется только то, что доказуемо оказалось в архиве).
 * - gcStaleTasks: pending/running без обновлений > 24h → failed, error=gc_stale.
 *   Каскадно дёргает rollupParent у parent.
 * - compactDb: VACUUM + ANALYZE (логирует start/end).
 * - dbStats: {table, rows, size_bytes} для UI.
 */
import { getErrorMessage } from "./errors.ts";
import { statSync } from "node:fs";
import { db, DB_PATH } from "./db.ts";
import { log } from "./log.ts";
import { safeTick } from "./safe-timer.ts";
import { rollupParent } from "./tasks.ts";
import { approvalTtlMs } from "./approvals.ts";
import { closeAgentPromptProposals } from "./dispatch/agent-prompt.ts";
import { closeGatedActionRow } from "./audit.ts";
import { emit as busEmit } from "./events-bus.ts";
import { DAY_MS, HOUR_MS, MINUTE_MS } from "./time-constants.ts";
import {
  checkApprovalBacklog,
  checkRateLimitStorm,
  stormTickMs,
  emitAlert,
} from "./alerting.ts";
import { DEFAULT_ARCHIVE_DAYS } from "./constants.ts";
import { exportColdStorage } from "./cold-storage.ts";

/**
 * Ключ суточного маркера в `maint_state` (миграция 039).
 *
 * Аудит 2026-08-04: «уже сделано сегодня» жило в замыкании шедулера, то есть
 * умирало вместе с процессом. Окно суточного тика — «UTC-час ≥ dailyHourUTC»,
 * то есть весь остаток суток, поэтому ЛЮБОЙ рестарт после 04:00 UTC в
 * ближайшие 5 минут запускал archive + gcMessages + VACUUM заново. Деплой —
 * это рестарт: три деплоя за вечер = три полных VACUUM'а, каждый синхронный
 * на единственном потоке, который держит и 12 ботов, и HTTP Mini App.
 */
const DAILY_MARKER_KEY = "daily_ymd";

/**
 * Ключ месячного маркера («YYYY-MM») в том же `maint_state`. Заведён по той же
 * причине, что и суточный: расписание шага должно опираться на «сделано ли»,
 * а не на «какое сегодня число».
 */
const MONTHLY_MARKER_KEY = "cold_storage_ym";

function readMaintMarker(key: string): string | null {
  try {
    const row = db
      .prepare(`SELECT value FROM maint_state WHERE key = ?`)
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  } catch (e) {
    // Читать маркер не смогли — ведём себя как раньше (прогон состоится).
    // Пропустить обслуживание из-за сбоя чтения было бы хуже, чем повторить.
    log.warn("[db-maint] cannot read marker", { key, error: String(e) });
    return null;
  }
}

function writeMaintMarker(key: string, value: string): boolean {
  try {
    db.prepare(
      `INSERT INTO maint_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                      updated_at = excluded.updated_at`,
    ).run(key, value, Date.now());
    return true;
  } catch (e) {
    log.warn("[db-maint] cannot write marker", { key, error: String(e) });
    emitAlert("error", "db_maint.marker_write_failed", "db-maint: marker write failed", {
      key,
      error: getErrorMessage(e),
    });
    return false;
  }
}

/**
 * Исход попытки занять окно обслуживания.
 *
 * `taken` — окно уже за кем-то (нормальная конкуренция двух процессов).
 * `error` — маркер не удалось ЗАПИСАТЬ. Это принципиально другое: раньше оба
 * случая сворачивались в `false`, и любой отказ записи выключал весь суточный
 * прогон целиком.
 */
export type MaintClaim = "claimed" | "taken" | "error";

/**
 * Claim a maintenance window atomically across scheduler processes.
 * The read-before-run check is only a fast path; this write is authoritative.
 *
 * Аудит 2026-08-27: возвращался `boolean`, и `runDaily` выходил первой
 * строкой на любом `false`. Сценарий: раздел под БД заполнился, INSERT в
 * `maint_state` падает на ENOSPC → ни архивации, ни gcMessages, ни выгрузки в
 * холодное хранилище, ни VACUUM — то есть ровно те четыре шага, которые
 * освобождают место, не выполняются именно тогда, когда они нужны. Плюс тик
 * повторяется каждые 5 минут, `emitAlert` кулдауна не имеет, и каждая попытка
 * дописывает строку в `audit_logs`: 288 строк в сутки в таблицу, чью уборку
 * этот же отказ и отключил.
 */
export function claimMaintMarker(key: string, value: string): MaintClaim {
  try {
    const result = db.prepare(`
      INSERT INTO maint_state (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
      WHERE maint_state.value <> excluded.value
    `).run(key, value, Date.now());
    return result.changes > 0 ? "claimed" : "taken";
  } catch (e) {
    log.warn("[db-maint] cannot claim marker", { key, error: String(e) });
    emitAlert("error", "db_maint.marker_claim_failed", "db-maint: marker claim failed; steps run unmarked", {
      key,
      error: getErrorMessage(e),
    });
    return "error";
  }
}

/**
 * T-318: parse MESSAGES_RETENTION_DAYS with fail-closed default.
 * Default 90 days. Garbage and NEGATIVE integers fall back to default.
 *
 * Аудит 2026-08-21: здесь было «non-positive integers fall back to default»,
 * и это неправда — `n < 0` пропускает ноль, функция возвращает `0`. Причём
 * намеренно: докстринг `gcMessages` ниже документирует `retention=0 disables
 * (no-op)` как штатную ручку, и тест t318-messages-gc пинит `"0" -> 0`.
 * То есть врал докстринг, а не код.
 *
 * Ноль читается оператором как «без ограничения / по умолчанию», а означает
 * ровно обратное по последствиям: GC становится no-op, тела сообщений с
 * персональными данными лежат вечно, а лог при этом рапортует об успешном
 * прогоне (`{"deleted":0,"archived":0,"retention_days":0}`). Поэтому смысл
 * нуля теперь назван и здесь, и в .env.example — как у соседнего
 * COLD_STORAGE_DAYS.
 */
export const DEFAULT_MESSAGES_RETENTION_DAYS = 90;

export function parseMessagesRetentionDays(
  raw: string | undefined = process.env.MESSAGES_RETENTION_DAYS,
): number {
  if (raw == null || raw === "") return DEFAULT_MESSAGES_RETENTION_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    return DEFAULT_MESSAGES_RETENTION_DAYS;
  }
  return n;
}

export interface MessagesGcOpts {
  /** Override retention days (else read from env). */
  retentionDays?: number;
  /** Override "now" (ms epoch) for tests. */
  now?: number;
}

export interface MessagesGcResult {
  deleted: number;
  archived: number;
  retention_days: number;
}

/** Описание переноса «источник → его *_archive». Все поля — константы модуля. */
export interface ArchiveSpec {
  source: string;
  archive: string;
  /** Колонка отбора по времени: `created_at` либо `ts`. */
  cutoffColumn: string;
  /** Общие колонки источника и архива, без `archived_at`. */
  columns: readonly string[];
  /** Optional columns copied when present, but required in archive then. */
  optionalColumns?: readonly string[];
  /**
   * Дополнительное условие отбора (литерал модуля, не пользовательский ввод).
   * Одно и то же для COUNT / INSERT / DELETE — иначе удалится не то, что
   * скопировано. Нужно там, где по возрасту строку архивировать можно, а по
   * состоянию нельзя: незакрытая заявка обязана остаться в живой таблице.
   */
  extraWhere?: string;
}

interface MoveResult {
  /** Строк старше cutoff на входе. */
  selected: number;
  /** Строк, реально вставленных в архив этим прогоном. */
  inserted: number;
  /** Строк, удалённых из источника (каждая доказуемо есть в архиве). */
  deleted: number;
}

/**
 * Resolve the explicit column list only after checking both table schemas.
 * Any source column that is not copied, or is absent from the archive, makes
 * the move unsafe, so fail before opening a write transaction.
 */
function resolveArchiveColumns(spec: ArchiveSpec): string[] {
  const sourceColumns = (
    db.prepare(`PRAGMA table_info(${spec.source})`).all() as { name: string }[]
  ).map((column) => column.name);
  const archiveColumns = new Set(
    (
      db.prepare(`PRAGMA table_info(${spec.archive})`).all() as {
        name: string;
      }[]
    ).map((column) => column.name),
  );
  const sourceSet = new Set(sourceColumns);
  const optionalColumns = spec.optionalColumns ?? [];
  const declaredColumns = new Set([...spec.columns, ...optionalColumns]);
  const missingRequired = spec.columns.filter((column) => !sourceSet.has(column));
  const uncopied = sourceColumns.filter((column) => !declaredColumns.has(column));
  const columns = [...spec.columns, ...optionalColumns].filter((column) =>
    sourceSet.has(column),
  );
  const missingFromArchive = columns.filter(
    (column) => !archiveColumns.has(column),
  );

  if (
    missingRequired.length > 0 ||
    uncopied.length > 0 ||
    missingFromArchive.length > 0
  ) {
    const details = [
      missingRequired.length > 0
        ? `missing from source: ${missingRequired.join(", ")}`
        : null,
      uncopied.length > 0
        ? `not declared for archive: ${uncopied.join(", ")}`
        : null,
      missingFromArchive.length > 0
        ? `missing from archive: ${missingFromArchive.join(", ")}`
        : null,
    ].filter((detail): detail is string => detail !== null);
    throw new Error(
      `[db-maint] archive schema incompatible for ${spec.source}: ${details.join("; ")}`,
    );
  }

  return columns;
}

/**
 * Перенос строк старше cutoff в архив: INSERT ... SELECT + DELETE, одна
 * транзакция.
 *
 * Аудит 2026-08-04: DELETE был безусловным (`WHERE created_at < ?`) при
 * `INSERT OR IGNORE` выше. `OR IGNORE` на конфликте PRIMARY KEY не бросает — он
 * молча пропускает строку, и следующий стейтмент её всё равно удалял. Транзакция
 * от этого не спасает: откатывать нечего, сбоя не было. Поэтому DELETE теперь
 * привязан к факту наличия строки в архиве, а не к тому же предикату времени,
 * что и INSERT: удаляется ровно то, что доказуемо скопировано.
 *
 * Счётчик тоже врал: наружу шёл COUNT(*) отобранных строк, а не число вставок,
 * так что молчаливый пропуск отражался в логе как успешная архивация.
 *
 * `deleted > inserted` — это норма, а не ошибка: строку могли скопировать в
 * прошлый прогон, упавший между INSERT и DELETE. Тревожно обратное — когда после
 * прогона строки старше cutoff остались в источнике.
 *
 * Имена таблиц и колонок подставляются в SQL как есть; сюда приходят только
 * литералы из ARCHIVE_SPECS, никакого пользовательского ввода.
 */
function moveToArchive(
  spec: ArchiveSpec,
  cutoffMs: number,
  archivedAt: number,
): MoveResult {
  const columns = resolveArchiveColumns(spec);
  const cols = columns.join(", ");
  const where = spec.extraWhere
    ? `${spec.cutoffColumn} < ? AND (${spec.extraWhere})`
    : `${spec.cutoffColumn} < ?`;

  const countStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM ${spec.source} WHERE ${where}`,
  );
  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO ${spec.archive} (${cols}, archived_at)
     SELECT ${cols}, ? FROM ${spec.source} WHERE ${where}`,
  );
  const deleteStmt = db.prepare(
    `DELETE FROM ${spec.source} WHERE ${where}
       AND EXISTS (SELECT 1 FROM ${spec.archive} a WHERE a.id = ${spec.source}.id)`,
  );

  const tx = db.transaction((): MoveResult => {
    const selected = (countStmt.get(cutoffMs) as { n: number }).n;
    const inserted = Number(insertStmt.run(archivedAt, cutoffMs).changes);
    const deleted = Number(deleteStmt.run(cutoffMs).changes);
    return { selected, inserted, deleted };
  });

  // `.immediate()`, а не `tx()`. Транзакция открывается счётчиком, то есть
  // берёт read-снапшот, а write-лок просит только на INSERT. Чужой коммит,
  // легший между этими двумя шагами, даёт SQLITE_BUSY_SNAPSHOT — а его ждать
  // бессмысленно: busy_timeout здесь не спасает, снапшот уже устарел. Ровно это
  // разобрано в шапке `applyMigration` (migrations.ts) и там же починено; сюда
  // починка не доехала. BEGIN IMMEDIATE берёт write-лок сразу, и конфликт
  // превращается в ожидание вместо мгновенной ошибки.
  const res = tx.immediate();
  if (res.deleted !== res.selected) {
    log.warn("[db-maint] archive incomplete", {
      table: spec.source,
      ...res,
      stuck: res.selected - res.deleted,
    });
  }
  return res;
}

export const MESSAGES_SPEC: ArchiveSpec = {
  source: "messages",
  archive: "messages_archive",
  cutoffColumn: "ts",
  // Миграция 040 добавила в архив tg_message_id/transport — до неё они терялись
  // на каждом прогоне. `kind` есть только на некоторых production-схемах:
  // если она есть в source, resolveArchiveColumns требует её в archive и
  // переносит явно; при несовместимой схеме прогон останавливается до DELETE.
  columns: [
    "id",
    "chat_id",
    "agent_key",
    "is_bot",
    "from_user_id",
    "from_name",
    "text",
    "ts",
    "tg_message_id",
    "transport",
  ],
  optionalColumns: ["kind"],
};

export const AGENT_ACTIONS_SPEC: ArchiveSpec = {
  source: "agent_actions",
  archive: "agent_actions_archive",
  cutoffColumn: "created_at",
  columns: [
    "id",
    "agent_key",
    "task_id",
    "chat_id",
    "action_type",
    "payload",
    "status",
    "result",
    "error",
    "created_at",
    "tg_message_id",
    "request_id",
  ],
};

/**
 * Аудит 2026-08-14: у `approvals` не было ни архива, ни удаления. Суточный
 * прогон её не касался: `expireStaleApprovals` только переписывает `status`, в
 * archiveOldRows её не было, в ARCHIVE_TABLES холодного хранилища — тоже. Замер
 * (200 решённых заявок PUBLISH_TO_CHANNEL возрастом 400 суток, затем
 * archiveOldRows + gcMessages + expireStaleApprovals): было 200 → стало 200,
 * 852 КБ, самой старой строке 400 дней. Растёт она килобайтами, а не строками:
 * в `payload` лежит целиком тело поста, документа или промпта.
 *
 * `status <> 'pending'` — граница, которую возраст не отменяет: нерешённая
 * заявка остаётся в живой таблице, даже если ей год. Просрочку закрывает
 * expireStaleApprovals (сутки по умолчанию), и после неё строка уже 'expired',
 * то есть архивируемая. Если санитар месяц не работал — заявка дождётся его
 * здесь, а не исчезнет из очереди молча.
 *
 * Отсечка та же, что у agent_actions (один и тот же cutoff в одном прогоне),
 * поэтому пара «заявка + её действие» уезжает в архив вместе, а не половинками.
 */
export const APPROVALS_SPEC: ArchiveSpec = {
  source: "approvals",
  archive: "approvals_archive",
  cutoffColumn: "created_at",
  extraWhere: "status <> 'pending'",
  columns: [
    "id",
    "action_id",
    "chat_id",
    "requested_by",
    "action_type",
    "payload",
    "status",
    "decided_by",
    "decided_at",
    "reason",
    "created_at",
  ],
};

/**
 * Аудит 2026-08-27: у `role_runtime_queue` не было ни архива, ни удаления —
 * суточный прогон её не касался вовсе. Растёт она килобайтами, а не строками:
 * `system_prompt` хранит целиком системный промпт временной роли, и остаётся в
 * живой БД бессрочно после того, как роль отработала. (До аудита 2026-09-11
 * тот же текст дублировался в `tasks.input`; дубль убран — он сводил на нет
 * запрет на чтение этой таблицы через QUERY_DB, см. миграцию 052.)
 *
 * `state IN ('done','failed')` — граница, которую возраст не отменяет:
 * незавершённая работа остаётся в живой очереди, даже если ей год. Иначе
 * архивация вырывала бы у `claimNextRoleTask` строку прямо из-под аренды.
 */
export const ROLE_RUNTIME_QUEUE_SPEC: ArchiveSpec = {
  source: "role_runtime_queue",
  archive: "role_runtime_queue_archive",
  cutoffColumn: "created_at",
  extraWhere: "state IN ('done','failed')",
  columns: [
    "id",
    "task_id",
    "role_slug",
    "system_prompt",
    "task_hint",
    "provider",
    "state",
    "chat_id",
    "created_by",
    "created_at",
  ],
};

export const AUDIT_LOGS_SPEC: ArchiveSpec = {
  source: "audit_logs",
  archive: "audit_logs_archive",
  cutoffColumn: "created_at",
  columns: [
    "id",
    "agent_key",
    "chat_id",
    "event_type",
    "payload",
    "created_at",
  ],
};

/**
 * T-318: Archive (move) `messages` rows older than retention into
 * `messages_archive`, then delete from source. Mirrors archiveOldRows for
 * agent_actions/audit_logs (ADR-0007).
 *
 * retention=0 disables (no-op) — useful for dev/tests.
 */
export function gcMessages(opts: MessagesGcOpts = {}): MessagesGcResult {
  const retention = opts.retentionDays ?? parseMessagesRetentionDays();
  const now = opts.now ?? Date.now();
  if (retention <= 0) {
    log.info("messages-gc done", {
      deleted: 0,
      archived: 0,
      retention_days: retention,
    });
    return { deleted: 0, archived: 0, retention_days: retention };
  }
  const cutoff = now - retention * DAY_MS;

  const res = moveToArchive(MESSAGES_SPEC, cutoff, now);
  log.info("messages-gc done", {
    deleted: res.deleted,
    archived: res.inserted,
    retention_days: retention,
  });
  return {
    deleted: res.deleted,
    archived: res.inserted,
    retention_days: retention,
  };
}

export interface ArchiveOpts {
  /** rows older than N days are archived. Default 30. */
  olderThanDays?: number;
  /** Override "now" (ms epoch) for tests. */
  now?: number;
}

export interface ArchiveResult {
  agent_actions: number;
  audit_logs: number;
  approvals: number;
  role_runtime_queue: number;
  cutoff_ms: number;
}

/**
 * Перенос старых строк в archive-таблицы. INSERT...SELECT + DELETE в одной
 * транзакции на таблицу.
 */
export function archiveOldRows(opts: ArchiveOpts = {}): ArchiveResult {
  const days = opts.olderThanDays ?? 30;
  const now = opts.now ?? Date.now();
  const cutoff = now - days * DAY_MS;

  // Шаг на шаг, а не три вызова подряд без изоляции. `runDaily` ставит
  // суточный маркер ДО работы, поэтому упавший первый вызов уносил с собой два
  // оставшихся до следующих суток: agent_actions ловил блокировку — audit_logs
  // и approvals не архивировались вовсе. Соседние шаги в этом файле (`_gcTick`,
  // четыре шага `runDaily`) давно разведены именно так.
  //
  // Ошибку при этом НЕ проглатываем: наверху на ней висит алерт
  // `db_maint.archive_failed`, и молчаливый ноль означал бы растущую БД без
  // единого сигнала. Копим и бросаем в конце — после того, как отработали все
  // три шага.
  const failures: string[] = [];
  const moved = (spec: ArchiveSpec, table: string): number => {
    try {
      return moveToArchive(spec, cutoff, now).deleted;
    } catch (e) {
      const error = getErrorMessage(e);
      log.error("[db-maint] archive step failed", { table, error });
      failures.push(`${table}: ${error}`);
      return 0;
    }
  };

  const agentActionsMoved = moved(AGENT_ACTIONS_SPEC, "agent_actions");
  const auditLogsMoved = moved(AUDIT_LOGS_SPEC, "audit_logs");
  const approvalsMoved = moved(APPROVALS_SPEC, "approvals");
  const roleQueueMoved = moved(ROLE_RUNTIME_QUEUE_SPEC, "role_runtime_queue");

  log.info(
    `[db-maint] archive cutoff=${new Date(cutoff).toISOString()} ` +
      `agent_actions=${agentActionsMoved} audit_logs=${auditLogsMoved} ` +
      `approvals=${approvalsMoved} role_runtime_queue=${roleQueueMoved}`,
  );
  if (failures.length > 0) {
    // Бросаем ПОСЛЕ всех трёх шагов: до этой строки уцелевшие таблицы уже
    // заархивированы, а вызывающий (`runDaily`) поднимет алерт и спокойно
    // пойдёт к следующему шагу — он и раньше ловил исключение отсюда.
    throw new Error(`archive steps failed — ${failures.join("; ")}`);
  }
  return {
    agent_actions: agentActionsMoved,
    audit_logs: auditLogsMoved,
    approvals: approvalsMoved,
    role_runtime_queue: roleQueueMoved,
    cutoff_ms: cutoff,
  };
}

export interface GcStaleOpts {
  /** Stale threshold ms. Default 24h. */
  staleMs?: number;
  /** Override "now" for tests. */
  now?: number;
}

export interface GcStaleResult {
  failed: number;
  ids: string[];
}

/**
 * Помечает зависшие pending/running задачи без обновлений > staleMs как failed
 * с error='gc_stale'. Каскадит rollup на parent.
 *
 * Прямой UPDATE минует FSM (pending→failed запрещён по FSM, но это санитар-фолбэк).
 */
export function gcStaleTasks(opts: GcStaleOpts = {}): GcStaleResult {
  const staleMs = opts.staleMs ?? DAY_MS;
  const now = opts.now ?? Date.now();
  const cutoff = now - staleMs;

  const rows = db
    .prepare(
      // NB: awaiting_review/awaiting_approval сюда сознательно НЕ включены —
      // это ожидание человека, а не зависшая работа: ревью через выходные
      // легально длится дольше суток, а парковку делает админ руками, и
      // штамповать его решение как failed санитар не вправе. Делегат,
      // припаркованный админом в эти статусы, закрывается мостом обратно
      // через running в action-dispatch.ts (closeDelegatedTask).
      //
      // Аудит 2026-08-12: здесь стояло второе обоснование — «у
      // awaiting_approval своя строка в `approvals`, и пометить таск failed,
      // оставив действие исполнимым по одобрению, значило бы рассинхронизировать
      // два контура». Оно ложное: в `approvals` нет колонки под задачу вовсе
      // (миграция 004 — action_id, chat_id, requested_by, action_type, payload,
      // …), контуры не связаны ничем. Значит и обратное неверно: задачу в
      // awaiting_* не держит открытой никакой второй механизм — её не закроет
      // ни санитар, ни решение по одобрению. Единственное, что о ней сообщает,
      // — счётчик `tasks_open`, и он как раз awaiting_review не считал; см.
      // OPEN_TASK_STATUSES в tasks.ts и tests/task-open-statuses.test.ts.
      `SELECT id, parent_id FROM tasks
       WHERE status IN ('pending','running') AND updated_at < ?`,
    )
    .all(cutoff) as Array<{ id: string; parent_id: string | null }>;

  if (rows.length === 0) {
    return { failed: 0, ids: [] };
  }

  // Аудит 2026-08-04: UPDATE шёл по одному лишь `WHERE id=?`, то есть повторял
  // условие отбора на веру. Между SELECT'ом и транзакцией таск мог доехать до
  // 'done' (второе соединение на той же БД — tools/*, restore, mac-bridge), и
  // тогда санитар затирал успешный результат на failed/gc_stale. Условие
  // повторяется в самом UPDATE: строка меняется, только если она всё ещё
  // подходит под определение зависшей.
  const upd = db.prepare(
    `UPDATE tasks SET status='failed', error='gc_stale', updated_at=?
     WHERE id=? AND status IN ('pending','running') AND updated_at < ?`,
  );
  const failedRows: Array<{ id: string; parent_id: string | null }> = [];
  const tx = db.transaction((ts: number) => {
    for (const r of rows) {
      if (upd.run(ts, r.id, cutoff).changes > 0) failedRows.push(r);
    }
  });
  tx(now);

  if (failedRows.length !== rows.length) {
    log.info("[db-maint] gc-stale: часть задач успела уйти из зависших", {
      selected: rows.length,
      failed: failedRows.length,
    });
  }

  // Каскадим rollup на parent отдельно — не в одной транзакции с UPDATE,
  // чтобы rollupParent видел уже-применённые статусы детей. Только по реально
  // пересчитанным детям: у остальных статус менял не мы.
  const seenParents = new Set<string>();
  for (const r of failedRows) {
    if (!r.parent_id || seenParents.has(r.parent_id)) continue;
    seenParents.add(r.parent_id);
    try {
      rollupParent(r.parent_id);
    } catch (e) {
      log.warn(`[db-maint] rollupParent(${r.parent_id}) error`, { error: String(e) });
    }
  }

  log.info(`[db-maint] gc-stale failed=${failedRows.length}`);
  return { failed: failedRows.length, ids: failedRows.map((r) => r.id) };
}

export interface ExpireApprovalsOpts {
  /** Срок годности заявки. По умолчанию approvalTtlMs(). */
  ttlMs?: number;
  /** Подмена «сейчас» для тестов. */
  now?: number;
}

export interface ExpireApprovalsResult {
  expired: number;
  cutoff_ms: number;
}

/**
 * Переводит нерешённые заявки старше TTL в терминальный 'expired'.
 *
 * Аудит 2026-08-12: срока годности у `approvals` не было вовсе, и это ломало
 * очередь с двух концов. listPendingApprovals отдаёт `ORDER BY created_at ASC
 * LIMIT 20` — правильный FIFO для очереди, которую разгребают, и голодание для
 * очереди, из которой ничего не выбывает: двадцать старых карточек занимают всю
 * выдачу, а сегодняшняя заявка в Mini App не появляется. С другого конца —
 * «Approve» на карточке трёхмесячной давности исполняет необратимое действие с
 * трёхмесячным payload'ом.
 *
 * Строки не удаляем и в 'rejected' не переводим: отказ — это решение человека, а
 * здесь решения как раз не было. `decided_by='system:gc'` и текст в reason
 * говорят, что произошло.
 *
 * Аудит 2026-08-13: у decideApproval есть заметка «место, где строка меняет
 * статус, ровно одно — здесь ему и место [busEmit]». Мест оказалось два, и
 * второе — это. Открытая вкладка Mini App узнаёт об изменениях только из SSE:
 * без события карточка остаётся «ожидает решения» сколько угодно долго, а
 * «Approve» по ней возвращает 400 `already expired` — то есть у владельца
 * ломается ровно тот сценарий, ради которого TTL и заводился (не давать
 * нажимать на протухшее). Поэтому истечение тоже поднимает `approval.decided`.
 *
 * Событие — ПО СТРОКЕ на заявку, в общей форме `{ id, status }`: её же шлют
 * `decideApproval` и `markApprovalFailed`, и подписчики (Approvals.tsx,
 * Dashboard.tsx) читают именно `id`. Разбор — у самого `busEmit` ниже.
 *
 * (Аудит 2026-09-11: здесь стояло обратное — «событие ОДНО на весь проход, в
 * payload все id разом». Так было до того, как форму свели к общей; докблок с
 * тех пор описывал не этот код, а его предыдущую редакцию, причём с
 * обоснованием, прямо противоречащим комментарию у самой строки.)
 */
export function expireStaleApprovals(
  opts: ExpireApprovalsOpts = {},
): ExpireApprovalsResult {
  const ttl = opts.ttlMs ?? approvalTtlMs();
  const now = opts.now ?? Date.now();
  const cutoff = now - ttl;
  const hours = Math.round(ttl / HOUR_MS);
  // RETURNING, а не отдельный SELECT: id'ы нужны для события, а два запроса по
  // одному предикату — это окно, в котором строка успевает быть решённой
  // человеком между выборкой и апдейтом.
  const rows = db
    .prepare(
      `UPDATE approvals
       SET status='expired', decided_by='system:gc', decided_at=?,
           reason=?
       WHERE status='pending' AND created_at < ?
       RETURNING id, action_id`,
    )
    .all(now, `не решён за ${hours} ч — заявка просрочена`, cutoff) as Array<{
    id: string;
    action_id: string;
  }>;
  const expired = rows.length;
  if (expired > 0) {
    // Аудит 2026-09-10: истечение меняло статус заявки и на строку версии
    // промпта не смотрело. Строка с обоими NULL — маркер «ждёт решения», по
    // которому одобрение выбирает, что применять, так что протухшая версия
    // оставалась кандидатом навсегда (докблок `closeAgentPromptProposals`).
    // Заявок не по промптам это не касается: у них в agent_prompts строки нет,
    // и UPDATE по approval_id ничего не находит.
    closeAgentPromptProposals(rows.map((r) => r.id), now);
    // Аудит 2026-09-11: строка ДЕЙСТВИЯ оставалась в `pending_approval` и
    // после протухания — санитайзера по этому статусу не было вовсе (докблок
    // `closeGatedActionRow`). Здесь тот же случай, что при отказе: наружу
    // ничего не ушло, а журнал сутками показывал ожидание решения, которого
    // уже не будет.
    for (const r of rows) {
      closeGatedActionRow(r.action_id, `заявка просрочена: решения не было ${hours} ч`);
    }
    log.info("[db-maint] approvals expired", { expired, ttl_hours: hours });
    // Аудит 2026-08-13: протухание было единственной сменой статуса апрува без
    // события — `decideApproval` и `markApprovalFailed` его шлют оба. Открытая
    // вкладка Mini App ничего не узнавала: карточка так и висела «ожидает
    // решения», а нажатие «Approve» упиралось в `WHERE status='pending'`,
    // давало `changes === 0` и ошибку «уже не pending» — без всякого намёка,
    // почему. Владельцу, который держит Mini App открытым сутки, это и
    // достаётся: UI врёт о состоянии очереди.
    // По событию на заявку, а не одно на проход: форма `{ id, status }` —
    // общий контракт `approval.decided`, его же шлют `decideApproval` и
    // `markApprovalFailed`, и подписчики (Approvals.tsx, Dashboard.tsx) читают
    // именно `id`. Расходовать здесь на пакетную форму значит завести второй
    // диалект одного события ради экономии на перезапросах списка — а
    // перезапрос дешёвый, санитар ходит раз в час, и просрочек за проход
    // единицы. Если шквал перезагрузок когда-нибудь станет заметен, лечить его
    // надо дебаунсом на стороне подписчика, а не формой события.
    for (const r of rows) {
      busEmit("approval.decided", { id: r.id, status: "expired" });
    }
  }
  return { expired, cutoff_ms: cutoff };
}

/**
 * Сколько строка `agent_actions` имеет право висеть «в полёте».
 *
 * Взято с запасом от самого долгого действия: MAC_RUN_CLAUDE идёт минутами, а
 * при большом задании — десятками минут. Санитар не должен закрывать живое,
 * поэтому порог намеренно грубый: его задача — не точность, а гарантия, что
 * брошенная строка не висит вечно.
 */
export const DEFAULT_INFLIGHT_ACTION_TTL_MS = 6 * HOUR_MS;

export interface ExpireAttemptsOpts {
  /** Срок, после которого строка «в полёте» считается брошенной. */
  ttlMs?: number;
  /** Подмена «сейчас» для тестов. */
  now?: number;
}

export interface ExpireAttemptsResult {
  expired: number;
  cutoff_ms: number;
}

/**
 * Закрывает строки, застрявшие в `attempted`.
 *
 * Аудит 2026-08-29. `dispatchAndAudit` теперь заводит строку ДО обращения к
 * внешнему миру и закрывает её после (см. `finalizeActionRow` в audit.ts).
 * Смысл ровно в том, чтобы пережить смерть процесса между этими моментами — но
 * пережившая её строка так и останется `attempted`, а `toMacSession` в Mini App
 * трактует любой нетерминальный статус как «выполняется». Без санитара панель
 * показывала бы вечно бегущую сессию, которой давно нет.
 *
 * По времени, а не по «строки старше запуска процесса»: транзакция создания
 * апрува в action-dispatch.ts заводится с расчётом на несколько процессов
 * agent-team, и брать «моё время старта» за границу чужой работы нельзя.
 *
 * Статус — `error`, а не `ok`: чем кончилось действие, никто не знает, и
 * записать успех значило бы придумать результат. Текст ошибки говорит именно
 * то, что известно: результат не был записан.
 */
export function expireStaleAttempts(
  opts: ExpireAttemptsOpts = {},
): ExpireAttemptsResult {
  const ttl = opts.ttlMs ?? DEFAULT_INFLIGHT_ACTION_TTL_MS;
  const now = opts.now ?? Date.now();
  const cutoff = now - ttl;
  const hours = Math.round(ttl / HOUR_MS);
  const rows = db
    .prepare(
      `UPDATE agent_actions
       SET status='error', error=?
       WHERE status='attempted' AND created_at < ?
       RETURNING id, agent_key, action_type, chat_id, request_id`,
    )
    .all(
      `результат не был записан: процесс не вернулся за ${hours} ч`,
      cutoff,
    ) as Array<{
    id: string;
    agent_key: string;
    action_type: string;
    chat_id: number | null;
    request_id: string | null;
  }>;
  if (rows.length > 0) {
    log.warn("[db-maint] in-flight actions expired", {
      expired: rows.length,
      ttl_hours: hours,
    });
    // Событие на строку: `action.executed` — общий контракт ленты действий, и
    // подписчик отличает завершение одного действия от завершения другого
    // только по нему. Пакетной формы у этого события нет, и заводить её ради
    // санитара, который в норме не находит ничего, незачем.
    for (const r of rows) {
      try {
        busEmit("action.executed", {
          id: r.id,
          agent: r.agent_key,
          action_type: r.action_type,
          status: "error",
          chat_id: r.chat_id,
          request_id: r.request_id,
          ts: now,
        });
      } catch {
        /* шина не должна влиять на уборку */
      }
    }
  }
  return { expired: rows.length, cutoff_ms: cutoff };
}

/** VACUUM + ANALYZE. Запускать, когда нет активных транзакций. */
export function compactDb(): { ok: true; ms: number } {
  const t0 = Date.now();
  log.info("[db-maint] compact start");
  try {
    db.exec("VACUUM;");
    db.exec("ANALYZE;");
  } catch (e) {
    log.warn("[db-maint] compact error", { error: String(e) });
    throw e;
  }
  const ms = Date.now() - t0;
  log.info(`[db-maint] compact done in ${ms}ms`);
  return { ok: true, ms };
}

export interface TableStat {
  table: string;
  rows: number;
  size_bytes: number;
}

const STAT_TABLES = [
  "tasks",
  "approvals",
  "approvals_archive",
  "agent_actions",
  "agent_actions_archive",
  "audit_logs",
  "audit_logs_archive",
  "messages",
  "messages_archive",
  "agent_token_usage",
  "permissions",
  "autonomy_modes",
  "agent_states",
  // Аудит 2026-08-08: три таблицы, которые растут со временем, но в статистике
  // не показывались вовсе — то есть по экрану «БД» нельзя было понять, откуда
  // взялся размер файла. Ни одна из них не архивируется, и это осознанно:
  // расписание постов и история system prompt'ов — рабочие данные, а
  // processed_triggers чистит себя сам по TTL (trigger-anti-dup.ts).
  "content_calendar",
  "agent_prompts",
  "processed_triggers",
  // Аудит 2026-08-27: очередь ролей и её архив не показывались на вкладке «БД»
  // вовсе, хотя `system_prompt NOT NULL` хранит целиком системный промпт роли —
  // килобайты на строку. Это единственная пара таблиц, которую суточный прогон
  // теперь архивирует (спека ниже), а увидеть результат было негде: до этой
  // строки их вес молча уезжал в `__other__`, то есть в графу «неизвестно
  // откуда». Смотреть, работает ли архивация, нужно именно здесь.
  "role_runtime_queue",
  "role_runtime_queue_archive",
] as const;

/**
 * Страницы по владельцам: индекс приписывается своей таблице.
 *
 * Аудит 2026-08-12: в `dbstat` строка на КАЖДОЕ btree — и на таблицу, и
 * отдельно на каждый её индекс, под собственным именем. Запрос `WHERE name = ?`
 * по имени таблицы индексы не видел, а в STAT_TABLES индексов нет, то есть их
 * страницы не приписывались никому. На реальной БД (856 КБ) индексы `tasks`
 * весили больше самой таблицы, и сумма столбца давала ~300 КБ при файле 856 КБ.
 *
 * Заодно один проход вместо запроса на таблицу: `dbstat` — полный скан БД.
 *
 * Возвращает null, если vtable не скомпилирована.
 */
function dbstatByOwner(): { byOwner: Map<string, number>; total: number } | null {
  try {
    const rows = db
      .prepare(
        `SELECT COALESCE(m.tbl_name, d.name) AS owner, SUM(d.pgsize) AS s
         FROM dbstat d LEFT JOIN sqlite_master m ON m.name = d.name
         GROUP BY owner`,
      )
      .all() as { owner: string; s: number | null }[];
    const byOwner = new Map<string, number>();
    let total = 0;
    for (const r of rows) {
      const s = r.s ?? 0;
      byOwner.set(r.owner, s);
      total += s;
    }
    return { byOwner, total };
  } catch {
    // dbstat не скомпилирована — размеры честно нулевые.
    return null;
  }
}

/**
 * Per-table row counts + общий размер БД-файла.
 *
 * SQLite не хранит per-table size дёшево, поэтому size_bytes ≈ грубая оценка:
 * `(sum of page sizes for table)` через `dbstat`-vtable, если доступна; иначе 0,
 * а общий файловый размер кладём в запись с table='__db_file__'.
 *
 * Всё, что не попало ни в одну таблицу из STAT_TABLES (shadow-таблицы FTS,
 * sqlite_schema, таблицы вне списка), уходит одной строкой `__other__`: столбец
 * должен сходиться с файлом, иначе по нему нельзя ответить на единственный
 * вопрос, ради которого он есть, — откуда взялся размер.
 */
export function dbStats(): TableStat[] {
  const out: TableStat[] = [];
  const stat = dbstatByOwner();
  let attributed = 0;
  for (const t of STAT_TABLES) {
    const exists = db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`)
      .get(t);
    if (!exists) {
      out.push({ table: t, rows: 0, size_bytes: 0 });
      continue;
    }
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as {
      n: number;
    };
    const size = stat?.byOwner.get(t) ?? 0;
    attributed += size;
    out.push({ table: t, rows: row.n, size_bytes: size });
  }
  if (stat) {
    out.push({
      table: "__other__",
      rows: 0,
      size_bytes: Math.max(0, stat.total - attributed),
    });
  }
  // Общий размер БД-файла.
  try {
    // Аудит 2026-08-27: было `process.env.MEMORY_DB_PATH ?? "data/memory.db"`
    // — при пустом `MEMORY_DB_PATH=` (`.env.example:55`) `statSync("")` бросал,
    // и вкладка «БД» в Mini App показывала размер файла 0 байт. Берём
    // `DB_PATH`: это ровно тот файл, который открыт под `db` выше, а не
    // независимая догадка о нём.
    const st = statSync(DB_PATH);
    out.push({ table: "__db_file__", rows: 0, size_bytes: st.size });
  } catch {
    out.push({ table: "__db_file__", rows: 0, size_bytes: 0 });
  }
  return out;
}

/**
 * T-411 — last successful scheduler tick (gcStaleTasks). Updated by the
 * scheduler whenever a tick completes without throwing. Read by /readyz to
 * detect a wedged process (interval timer never fires, GC never runs).
 *
 * `null` until the first tick completes. Tests can override via
 * `setSchedulerLastRunForTests` to simulate stale state.
 */
let _schedulerLastRun: number | null = null;

export function getSchedulerLastRun(): number | null {
  return _schedulerLastRun;
}

/**
 * Обслуживание выключено оператором (`DB_MAINT_ENABLED=false`), а не заклинило.
 *
 * Аудит 2026-08-20: `_schedulerLastRun` ставится ровно в одном месте — внутри
 * `startMaintScheduler`. При `DB_MAINT_ENABLED=false` планировщик не стартует
 * вовсе (services.ts), метка остаётся `null` НАВСЕГДА, и `/readyz` уходит в
 * бессрочный 503 на здоровом процессе: боты работают, БД отвечает, Mini App
 * отдаёт данные. То есть документированный в `.env.example` флаг «выключить
 * ночное обслуживание» заодно и молча гасил readiness — а объяснения наружу не
 * идёт, детали `checks` с 2026-08-08 видны только предъявителю METRICS_TOKEN.
 *
 * Смысл проверки в /readyz — «интервальный таймер не сработал, GC не идёт».
 * К выключенному планировщику она неприменима по определению, поэтому «нет
 * метки» надо уметь отличать от «нет планировщика». Отказ САМОГО старта
 * (`catch` в services.ts) сюда намеренно не попадает: это настоящая поломка,
 * и 503 там по делу.
 */
let _schedulerDisabled = false;

export function isSchedulerDisabled(): boolean {
  return _schedulerDisabled;
}

/** Вызывается из services.ts, когда планировщик сознательно не запускается. */
export function setSchedulerDisabled(v: boolean): void {
  _schedulerDisabled = v;
}

/** Test-only helper: override the last-run timestamp. */
export function setSchedulerLastRunForTests(ts: number | null): void {
  _schedulerLastRun = ts;
}

export interface MaintSchedulerOptions {
  /** Interval for gcStaleTasks. Default 30 min. */
  gcIntervalMs?: number;
  /** UTC hour for daily archive+compact. Default 4. */
  dailyHourUTC?: number;
  /** Poll interval for daily-window check. Default 5 min. */
  dailyPollMs?: number;
  /** Days threshold for archiving. Default 30. */
  archiveDays?: number;
  /** Override now-provider for tests. */
  nowProvider?: () => Date;
  /**
   * Test seam: период часового тика алертов. Отдельно от штормового —
   * именно их разделение и проверяется.
   */
  alertingTickMs?: number;
  /**
   * Подменяемая месячная выгрузка. Шов ровно того же назначения, что
   * `nowProvider`: расписание шага — это правило, и проверять его чтением
   * `getUTCDate() === 1` глазами мы уже пробовали.
   */
  exportColdStorageImpl?: typeof exportColdStorage;
  /**
   * Швы под шаги gc-тика — того же назначения, что `exportColdStorageImpl`.
   * Проверять «падение одного шага не отменяет другой» можно только уронив
   * шаг, а настоящий `gcStaleTasks` роняется лишь порчей таблицы `tasks` в
   * общей тестовой БД.
   */
  gcStaleTasksImpl?: () => unknown;
  expireStaleApprovalsImpl?: () => unknown;
  /** Шов под шаг закрытия брошенных строк «в полёте» — назначение то же. */
  expireStaleAttemptsImpl?: () => unknown;
  /**
   * Шов под шаг retention'а сообщений. Настоящий `gcMessages` роняется только
   * порчей схемы `messages`/`messages_archive` в общей тестовой БД, а инвариант
   * «каждый шаг суточного прогона сигналит о СВОЁМ отказе» иначе не проверить.
   */
  gcMessagesImpl?: () => unknown;
}

export interface MaintSchedulerHandle {
  stop: () => void;
  _runDailyNow: () => void;
  _gcTick: () => void;
  _alertingHourlyTick: () => void;
  _alertingStormTick: () => void;
}

/**
 * Аудит 2026-08-08: оба значения приходят из env через голый `Number(...)`
 * (orchestrator/services.ts), а принимались через `??`, который ловит только
 * null/undefined.
 *
 *  - `DB_MAINT_HOUR_UTC=утро` → NaN → сравнение часа всегда ложно, суточный
 *    archive+compact не запускается никогда. Тихо.
 *  - `DB_MAINT_ARCHIVE_DAYS=0` — правдоподобный ввод оператора в смысле «не
 *    архивировать». Строка "0" истинна, Number("0") = 0, cutoff = now: за один
 *    проход в архив уезжают ВСЕ agent_actions и audit_logs, включая
 *    сегодняшние. Отрицательное значение делает то же самое.
 *
 * Негодное значение откатываем к дефолту и говорим об этом в лог — как
 * readPerChatMax и readUserbotFloodMax в rate-limits.ts.
 */
function sanitizeMaintOpt(
  v: number | undefined,
  fallback: number,
  min: number,
  max: number,
  what: string,
): number {
  if (v === undefined) return fallback;
  if (!Number.isInteger(v) || v < min || v > max) {
    log.warn(`[db-maint] некорректный ${what} — берём дефолт`, { got: v, fallback });
    return fallback;
  }
  return v;
}

/**
 * Шедулер: gcStaleTasks каждые 30 мин, archive+compact один раз в сутки в
 * `dailyHourUTC`. По аналогии с digest: tick каждые `dailyPollMs`, флаг
 * "уже сделано сегодня".
 */
export function startMaintScheduler(
  opts: MaintSchedulerOptions = {},
): MaintSchedulerHandle {
  const gcIntervalMs = opts.gcIntervalMs ?? 30 * MINUTE_MS;
  const dailyHourUTC = sanitizeMaintOpt(opts.dailyHourUTC, 4, 0, 23, "dailyHourUTC");
  const dailyPollMs = opts.dailyPollMs ?? 5 * MINUTE_MS;
  const archiveDays = sanitizeMaintOpt(
    opts.archiveDays,
    DEFAULT_ARCHIVE_DAYS,
    1,
    3650,
    "archiveDays",
  );
  const nowProvider = opts.nowProvider ?? (() => new Date());
  const exportCold = opts.exportColdStorageImpl ?? exportColdStorage;
  const gcMessagesStep = opts.gcMessagesImpl ?? (() => gcMessages());

  let stopped = false;
  let lastDailyYmd: string | null = null;

  const ymd = (d: Date) => d.toISOString().slice(0, 10);

  const runDaily = (today: string, force = false): boolean => {
    // Маркер ставится ДО работы, как в digest: если один из шагов бросит, мы
    // не хотим, чтобы следующий тик через 5 минут повторял VACUUM по кругу.
    // Каждый шаг инкрементальный — пропуск одних суток догоняется следующими.
    // Обычный тик claim'ит окно атомарно; ручной force сохраняет прежнюю
    // семантику и запускается даже при уже существующем маркере.
    if (force) {
      if (!writeMaintMarker(DAILY_MARKER_KEY, today)) return false;
    } else {
      const claim = claimMaintMarker(DAILY_MARKER_KEY, today);
      // Окно занято другим процессом — уходим, это штатно.
      if (claim === "taken") return false;
      // А вот `error` шаги не отменяет: см. докстринг claimMaintMarker. Работу
      // делаем, но возвращаем true — иначе тик через 5 минут повторит её же (в
      // том числе VACUUM) до полуночи, потому что маркер записать не удалось.
      if (claim === "error") {
        runDailySteps(today);
        return true;
      }
    }
    runDailySteps(today);
    return true;
  };

  const runDailySteps = (today: string): void => {
    try {
      archiveOldRows({ olderThanDays: archiveDays });
    } catch (e) {
      log.warn("[db-maint] archive error", { error: String(e) });
      emitAlert(
        "error",
        "db_maint.archive_failed",
        "db-maint: archive step failed",
        { error: getErrorMessage(e) },
      );
    }
    try {
      // T-318: GC + archive `messages` table (PII retention).
      gcMessagesStep();
    } catch (e) {
      log.warn("[db-maint] messages-gc error", { error: String(e) });
      // Аудит 2026-08-20: это был ЕДИНСТВЕННЫЙ шаг суточного прогона без
      // алерта — три соседа (archive, cold-storage, compact) зовут emitAlert,
      // а перенос `messages` → `messages_archive` растворялся в log.warn на
      // VPS. Между тем это единственный шаг, отвечающий за retention
      // персональных данных: тихо упавший gcMessages означает, что
      // MESSAGES_RETENTION_DAYS перестал действовать и тексты сообщений
      // пользователей копятся в живой БД неограниченно долго. Уронить его
      // есть чем — расхождение схемы с архивом (ровно это чинила миграция
      // 040), SQLITE_BUSY от второго соединения в момент .immediate(),
      // ENOSPC. Заметить без алерта можно было только по строке `messages` на
      // вкладке «БД» или по размеру файла — то есть месяцы спустя.
      emitAlert(
        "error",
        "db_maint.messages_gc_failed",
        "db-maint: messages retention step failed",
        { error: getErrorMessage(e) },
      );
    }
    try {
      // T-113: раз в месяц перекладываем очень старые строки *_archive в
      // сжатые файлы холодного хранилища и убираем их из живой БД.
      //
      // Аудит 2026-08-12: условием было `getUTCDate() === 1`, то есть шаг
      // выполнялся, только если суточный прогон случился ИМЕННО первого числа.
      // Комментарий выше обещает, что «пропуск одних суток догоняется
      // следующими» — для остальных шагов так и есть, а этот один пропущенный
      // день стоил месяца: замер на шедулере с подменённым nowProvider (32
      // суточных прогона с 30 августа по 1 октября, процесс лежал ровно сутки
      // 1 сентября) дал единственный запуск — 1 октября. Ровно то же чинили
      // 2026-08-04 суточному маркеру: календарь помнит день, а сделанную
      // работу помнит только маркер. Теперь — первый прогон месяца, какого бы
      // числа он ни случился.
      const thisMonth = ymd(nowProvider()).slice(0, 7);
      // Месячному шагу «маркер не записался» тоже не повод пропускать работу:
      // он пишет и удаляет файлы, повтор дороже, но пропуск — это ещё месяц
      // роста *_archive. При `error` выгрузку делаем (маркер останется чужим
      // или отсутствующим — следующий прогон попробует снова).
      if (claimMaintMarker(MONTHLY_MARKER_KEY, thisMonth) !== "taken") {
        // Маркер до работы — из тех же соображений, что у суточного: шаг
        // пишет и удаляет файлы на диске, и повторять его каждые сутки после
        // неудачи дороже, чем подождать следующего месяца. О неудаче говорит
        // алерт ниже.
        // `writeMaintMarker` здесь не нужен: окно уже занято атомарным
        // `claimMaintMarker` в условии выше — он и есть запись маркера.
        const results = exportCold();
        const moved = results.reduce((a, r) => a + r.pruned, 0);
        if (moved > 0) log.info("[db-maint] cold-storage pruned old archive rows", { moved });
        // Аудит 2026-08-21: `catch` ниже обещает алерт о неудаче, но получить
        // его было неоткуда. Отказ по таблице `exportColdStorage`
        // обрабатывает У СЕБЯ — пишет log.error, снимает недописанный файл и
        // идёт к следующей таблице, — а наружу возвращает обычный результат.
        // То есть исключения на этом шаге не бывает вовсе, и самый вероятный
        // сбой (кончился раздел, каталог не каталог, короткая запись) уходил
        // одной строкой в лог. Замер: подменённый файлом каталог холодного
        // хранилища даёт ENOTDIR и ноль строк `alert.db_maint.cold_storage_failed`.
        //
        // Читаем причины из результата. Маркер при этом СОХРАНЯЕТСЯ — политика
        // «не повторять ежедневно то, что пишет и удаляет файлы» осознанная и
        // остаётся; чинилась ровно немота.
        const failed = results.filter((r) => r.error !== null);
        if (failed.length > 0) {
          emitAlert(
            "error",
            "db_maint.cold_storage_failed",
            "db-maint: cold-storage step failed",
            {
              tables: failed.map((r) => r.table).join(", "),
              error: failed.map((r) => `${r.table}: ${r.error}`).join("; "),
            },
          );
        }
      }
    } catch (e) {
      log.warn("[db-maint] cold-storage error", { error: String(e) });
      // Соседние шаги (archive, compact) при исключении зовут emitAlert, этот —
      // нет. Тихо упавшая выгрузка означает БД, которая растёт без ограничения,
      // и следующая попытка — только через месяц.
      emitAlert(
        "error",
        "db_maint.cold_storage_failed",
        "db-maint: cold-storage step failed",
        { error: getErrorMessage(e) },
      );
    }
    try {
      compactDb();
    } catch (e) {
      log.warn("[db-maint] compact error", { error: String(e) });
      emitAlert(
        "error",
        "db_maint.compact_failed",
        "db-maint: compact step failed",
        { error: getErrorMessage(e) },
      );
    }
  };

  // T-325: часовой тик — только backlog одобрений.
  //
  // Аудит 2026-08-29: правка 2026-08-08 вынесла проверку шторма на свой
  // таймер (см. `_alertingStormTick` ниже) и объяснила почему, но часовой тик
  // продолжал звать агрегатор `checkBacklogAlerts()`, который дёргал ОБЕ
  // проверки. Комментарий соседнего тика утверждал обратное — а лишний вызов
  // не просто тратил один COUNT(*) в час: `takeCooldown("rate_limit.storm")`
  // не различает, кто взял кулдаун. Часовой тик, попавший на конец окна,
  // выбирал кулдаун на пустом месте, и настоящий алерт от штормового таймера
  // в следующую минуту глушился. То есть разделение таймеров, которое чинило
  // «наблюдаем 1/12 часа», подтачивалось этим же вызовом.
  const _alertingHourlyTick = () => {
    try {
      checkApprovalBacklog();
    } catch (e) {
      log.warn("[db-maint] alerting tick error", { error: String(e) });
    }
  };

  // Аудит 2026-08-08: проверка шторма смотрит в окно (по умолчанию 5 минут), а
  // жила на часовом тике вместе с backlog — то есть наблюдала 1/12 каждого
  // часа. Период опроса не может быть длиннее окна, иначе проверка видит лишь
  // его долю. Backlog остаётся часовым: он считает возраст, а не частоту, и от
  // редкого опроса не страдает.
  const _alertingStormTick = () => {
    try {
      checkRateLimitStorm();
    } catch (e) {
      log.warn("[db-maint] storm tick error", { error: String(e) });
    }
  };

  // T-411: mark last-run on scheduler boot too, so /readyz doesn't flap
  // immediately after startup before the first 30-min interval has elapsed.
  _schedulerLastRun = Date.now();
  // Планировщик всё-таки поднялся — снимаем флаг «выключено» (важно для
  // тестов и для повторного старта в одном процессе).
  _schedulerDisabled = false;

  const gcStale = opts.gcStaleTasksImpl ?? (() => gcStaleTasks());
  const expireApprovals = opts.expireStaleApprovalsImpl ?? (() => expireStaleApprovals());
  const expireAttempts = opts.expireStaleAttemptsImpl ?? (() => expireStaleAttempts());

  const _gcTick = () => {
    // Аудит 2026-08-13: шаг на шаг. Один общий try накрывал оба, и падение
    // gcStaleTasks отменяло просрочку заявок — та вообще ни разу не выполнялась
    // бы, пока не починят соседа. Сосед по файлу (runDaily) давно так и делает:
    // четыре шага — четыре try, «пропуск одних суток догоняется следующими».
    try {
      gcStale();
    } catch (e) {
      log.warn("[db-maint] stale-tasks gc error", { error: String(e) });
      emitAlert(
        "error",
        "db_maint.gc_stale_tasks_failed",
        "db-maint: stale-task GC failed",
        { error: getErrorMessage(e) },
      );
    }
    try {
      // Тот же тик, что и у зависших задач: и там, и здесь — строки, которые
      // ждут человека и без срока висят вечно.
      expireApprovals();
    } catch (e) {
      log.warn("[db-maint] approvals expiry error", { error: String(e) });
      emitAlert(
        "error",
        "db_maint.expire_approvals_failed",
        "db-maint: approval expiry failed",
        { error: getErrorMessage(e) },
      );
    }
    try {
      // Третий шаг того же рода: строка «в полёте», за которой никто не
      // вернулся, — это тоже запись, ждущая события, которого не будет.
      expireAttempts();
    } catch (e) {
      log.warn("[db-maint] in-flight actions expiry error", { error: String(e) });
      emitAlert(
        "error",
        "db_maint.expire_attempts_failed",
        "db-maint: in-flight action expiry failed",
        { error: getErrorMessage(e) },
      );
    }
    // Метка живости — про то, что тик СОСТОЯЛСЯ, а не про то, что все шаги
    // прошли. Читает её /readyz, чтобы поймать заклинивший процесс (таймер не
    // сработал вовсе); падающая уборка — это не заклинивший процесс, а через
    // два часа она гасила readiness, то есть health-гейт деплоя откатывал
    // выкладку по чужой причине. Тише от этого не стало: раньше отказ был
    // одним log.warn, теперь у каждого шага свой алерт.
    _schedulerLastRun = Date.now();
  };

  const gcTimer = setInterval(safeTick("db-maint.gc", () => {
    if (stopped) return;
    _gcTick();
  }), gcIntervalMs);

  // Голая граница: nowProvider/ymd и оба обращения к маркеру (здесь и первой
  // строкой runDaily) лежат ВНЕ try. SQLITE_BUSY на маркере — рядовое событие
  // для планировщика, а не неизвестное состояние процесса, и ронять сервис из-за
  // него нельзя. Внутренние шаги как ловили сами, так и ловят.
  const dailyTimer = setInterval(safeTick("db-maint.daily", () => {
    if (stopped) return;
    const now = nowProvider();
    if (now.getUTCHours() < dailyHourUTC) return;
    const today = ymd(now);
    // Память процесса — только кэш. Правда лежит в БД, иначе рестарт после
    // dailyHourUTC (а деплой — это рестарт) начинает сутки заново.
    if (lastDailyYmd === today) return;
    if (readMaintMarker(DAILY_MARKER_KEY) === today) {
      lastDailyYmd = today;
      return;
    }
    // Кэш ставится по РЕЗУЛЬТАТУ: если суточный прогон не занял окно (маркер
    // уже чужой или claim упал), помнить сегодняшний день нельзя — иначе
    // процесс до полуночи считает сутки закрытыми. Обёртка `safeTick` — от
    // main: исключение из тика не должно ронять таймер.
    if (runDaily(today)) lastDailyYmd = today;
    else lastDailyYmd = null;
  }), dailyPollMs);

  // T-325: Hourly alerting tick (independent of daily archive window).
  const alertTimer = setInterval(
    safeTick("db-maint.alerting", _alertingHourlyTick),
    opts.alertingTickMs ?? 60 * MINUTE_MS,
  );

  // Тик шторма — с периодом его же окна, но не чаще раза в минуту: опрос
  // дешёвый (один COUNT(*) по индексу), а повторный алерт держит кулдаун.
  const stormTimer = setInterval(safeTick("db-maint.storm", _alertingStormTick), stormTickMs());

  log.info(
    `[db-maint] scheduler started: gc=${Math.round(gcIntervalMs / 1000)}s ` +
      `dailyHourUTC=${dailyHourUTC} archiveDays=${archiveDays}`,
  );

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(gcTimer);
      clearInterval(dailyTimer);
      clearInterval(alertTimer);
      clearInterval(stormTimer);
    },
    _runDailyNow() {
      // Форс: маркер игнорируется на чтении, но проставляется — работа-то
      // сделана, и очередной тик не обязан повторять её ещё раз.
      const today = ymd(nowProvider());
      lastDailyYmd = today;
      runDaily(today, true);
    },
    _gcTick,
    _alertingHourlyTick,
    _alertingStormTick,
  };
}
