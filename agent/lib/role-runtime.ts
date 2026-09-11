/**
 * Local role queue and provider boundary for SPAWN_ROLE.
 *
 * GitHub is deliberately absent from this module. The queue is shared through
 * the agent SQLite database, while a local runtime decides when and how to
 * execute a claimed item. Provider selection is explicit and fail-closed.
 */
import type { Database } from "bun:sqlite";
import { emitAlert } from "./alerting.ts";
import { db } from "./db.ts";
import { log } from "./log.ts";

export const ROLE_PROVIDERS = ["internal", "claude", "codex"] as const;
export type RoleProvider = (typeof ROLE_PROVIDERS)[number];

export const ROLE_QUEUE_STATES = ["queued", "running", "done", "failed"] as const;
export type RoleQueueState = (typeof ROLE_QUEUE_STATES)[number];

export const DEFAULT_ROLE_LEASE_TIMEOUT_MS = 120_000;
export const DEFAULT_ROLE_HEARTBEAT_MS = 30_000;
/**
 * Потолок на один прогон роли по часам.
 *
 * Без него зависший провайдер держит задачу вечно: heartbeat исправно
 * продлевает аренду, поэтому восстановление её не подберёт — «живой» и
 * «сдвинувшийся» для очереди было одно и то же. Полчаса — заведомо больше
 * любого нормального прогона и заведомо меньше «навсегда».
 */
export const DEFAULT_ROLE_MAX_RUN_MS = 30 * 60_000;
export const DEFAULT_ROLE_MAX_ATTEMPTS = 3;

export class UnknownRoleProviderError extends Error {
  readonly provider: string;

  constructor(provider: unknown) {
    const value = String(provider ?? "").trim() || "(empty)";
    super(`unknown role provider: ${value}`);
    this.name = "UnknownRoleProviderError";
    this.provider = value;
  }
}

export class UnavailableRoleProviderError extends Error {
  readonly provider: RoleProvider;

  constructor(provider: RoleProvider) {
    super(`role provider is unavailable: ${provider}`);
    this.name = "UnavailableRoleProviderError";
    this.provider = provider;
  }
}

export interface ProviderSelectionOptions {
  /** Tests and local supervisors may provide a deterministic availability check. */
  codexAvailable?: boolean;
}

/** Resolve only the three supported providers; never silently fall back. */
export function selectRoleProvider(
  raw: unknown,
  options: ProviderSelectionOptions = {},
): RoleProvider {
  const value = String(raw ?? "internal").trim().toLowerCase();
  if (!(ROLE_PROVIDERS as readonly string[]).includes(value)) {
    throw new UnknownRoleProviderError(raw);
  }
  const provider = value as RoleProvider;
  if (provider === "codex" && options.codexAvailable !== true) {
    throw new UnavailableRoleProviderError(provider);
  }
  return provider;
}

/** Safe slug used for queue identity and display only, never for shell syntax. */
export function toRoleSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export interface EnqueueRoleTaskInput {
  name: string;
  systemPrompt: string;
  taskHint?: string;
  chatId: number;
  createdBy: string;
  provider?: unknown;
  codexAvailable?: boolean;
}

export interface RoleQueueItem {
  id: string;
  taskId: string;
  roleSlug: string;
  systemPrompt: string;
  taskHint: string;
  provider: string;
  state: RoleQueueState;
  chatId: number;
  createdBy: string;
  createdAt: number;
  leaseId?: string;
  workerId?: string;
  heartbeatAt?: number;
  attempt?: number;
}

interface RoleQueueRow {
  id: string;
  task_id: string;
  role_slug: string;
  system_prompt: string;
  task_hint: string;
  provider: string;
  state: RoleQueueState;
  chat_id: number;
  created_by: string;
  created_at: number;
  input?: string | null;
  updated_at?: number;
}

interface RoleRuntimeLease {
  leaseId: string;
  workerId: string;
  heartbeatAt: number;
  startedAt: number;
  attempt: number;
  /**
   * Момент, когда попытка ушла исполнителю (`execute(item)`), — durable-метка
   * «за этот прогон уже заплачено».
   *
   * Аудит 2026-08-29: подметание брошенных аренд возвращало задачу в очередь по
   * одному только протухшему heartbeat'у и не могло отличить «процесс умер, не
   * дойдя до модели» от «процесс умер посреди прогона». Второй случай — прогон
   * через Agent SDK, уже списанный в `agent_token_usage`; повтор списывает его
   * заново, и до трёх раз (`maxAttempts`) молча. Тот же приём, что у
   * `markDiagDispatched` в `self-diag`: метку ставим ПЕРЕД вызовом, и она
   * переживает падение процесса, потому что лежит в строке задачи.
   *
   * Необязательное: строки, принятые до появления метки, читаются как «не
   * дошло до исполнителя», и это безопасная сторона — она не поднимает лишний
   * алерт, а не наоборот.
   */
  dispatchedAt?: number;
}

interface RoleTaskInput {
  _role_runtime?: Partial<RoleRuntimeLease>;
  [key: string]: unknown;
}

export interface RoleRuntimeOptions {
  workerId?: string;
  leaseTimeoutMs?: number;
  heartbeatMs?: number;
  maxAttempts?: number;
  /** Wall-clock cap for one provider run; see DEFAULT_ROLE_MAX_RUN_MS. */
  maxRunMs?: number;
  now?: () => number;
  /** Подмена приёмника алерта — тесты, чтобы не писать в audit_logs. */
  alert?: typeof emitAlert;
}

function rowToItem(row: RoleQueueRow): RoleQueueItem {
  const runtime = readRuntimeLease(row.input);
  return {
    id: row.id,
    taskId: row.task_id,
    roleSlug: row.role_slug,
    systemPrompt: row.system_prompt,
    taskHint: row.task_hint,
    provider: row.provider,
    state: row.state,
    chatId: row.chat_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    ...(runtime?.leaseId ? { leaseId: runtime.leaseId } : {}),
    ...(runtime?.workerId ? { workerId: runtime.workerId } : {}),
    ...(typeof runtime?.heartbeatAt === "number" ? { heartbeatAt: runtime.heartbeatAt } : {}),
    attempt: runtime?.attempt ?? readAttempt(row.input),
  };
}

function readTaskInput(input: string | null | undefined): RoleTaskInput {
  try {
    const parsed: unknown = JSON.parse(input ?? "{}");
    return parsed && typeof parsed === "object" ? parsed as RoleTaskInput : {};
  } catch {
    return {};
  }
}

function readRuntimeLease(input: string | null | undefined): RoleRuntimeLease | null {
  const runtime = readTaskInput(input)._role_runtime;
  if (!runtime || typeof runtime !== "object") return null;
  if (
    typeof runtime.leaseId !== "string" ||
    typeof runtime.workerId !== "string" ||
    typeof runtime.heartbeatAt !== "number" ||
    typeof runtime.startedAt !== "number" ||
    typeof runtime.attempt !== "number"
  ) return null;
  return runtime as RoleRuntimeLease;
}

function readAttempt(input: string | null | undefined): number {
  const attempt = readTaskInput(input)._role_runtime?.attempt;
  return typeof attempt === "number" && Number.isFinite(attempt) ? attempt : 0;
}

function encodeTaskInput(input: string | null | undefined, runtime: Partial<RoleRuntimeLease>): string {
  const parsed = readTaskInput(input);
  return JSON.stringify({ ...parsed, _role_runtime: runtime });
}

function positiveOption(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? value as number : fallback;
}

function queueItemById(taskId: string, database: Database): RoleQueueItem | null {
  const row = database
    .prepare(`SELECT * FROM role_runtime_queue WHERE task_id = ?`)
    .get(taskId) as RoleQueueRow | undefined;
  return row ? rowToItem(row) : null;
}

/** Insert the task row and queue row under one BEGIN IMMEDIATE transaction. */
export function enqueueRoleTask(
  input: EnqueueRoleTaskInput,
  database: Database = db,
): RoleQueueItem {
  const roleSlug = toRoleSlug(input.name.trim());
  if (!roleSlug) throw new Error("role name produces an empty slug");
  const systemPrompt = input.systemPrompt.trim();
  if (!systemPrompt) throw new Error("system prompt must be non-empty");
  const taskHint = input.taskHint?.trim() ?? "";
  const provider = selectRoleProvider(input.provider ?? "internal", {
    codexAvailable: input.codexAvailable,
  });
  const id = crypto.randomUUID();
  const now = Date.now();
  // Аудит 2026-09-11: `system_prompt` отсюда убран, и это не косметика.
  // `role_runtime_queue` стоит в денилисте QUERY_DB (query-db.ts) как «тот же
  // класс данных, что agent_prompts», а `tasks` намеренно читаема — её
  // читаемость закреплена тестом. Дубль промпта в `tasks.input` сводил запрет
  // на нет: `SELECT input FROM tasks WHERE input LIKE '%_spawn_role%'` отдавал
  // ровно то, что денилист прячет, и запрос проходил валидацию целиком.
  //
  // Терять нечего: единственным читателем этой копии была миграция 044,
  // разово перенёсшая легаси-строки в очередь; живой код берёт промпт из
  // `role_runtime_queue.system_prompt` (`rowToItem`). `queue_version: 2` — метка
  // формата без промпта, чтобы старую строку было видно по данным, а не по
  // догадке. Старые строки чистит миграция 052.
  const queueInput = JSON.stringify({
    _spawn_role: true,
    queue_version: 2,
    role_slug: roleSlug,
    task_hint: taskHint,
    provider,
  });

  const tx = database.transaction(() => {
    database
      .prepare(
        `INSERT INTO tasks(
          id, parent_id, depth, chat_id, created_by, assigned_to,
          title, description, status, priority, deadline,
          input, output, error, created_at, updated_at
        ) VALUES (?, NULL, 0, ?, ?, NULL, ?, ?, 'pending', 0, NULL, ?, NULL, NULL, ?, ?)`,
      )
      .run(
        id,
        input.chatId,
        input.createdBy,
        `Spawn role: ${roleSlug}`,
        taskHint || null,
        queueInput,
        now,
        now,
      );
    database
      .prepare(
        `INSERT INTO role_runtime_queue(
          id, task_id, role_slug, system_prompt, task_hint, provider,
          state, chat_id, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
      )
      .run(id, id, roleSlug, systemPrompt, taskHint, provider, input.chatId, input.createdBy, now);
  });
  tx.immediate();

  const item = queueItemById(id, database);
  if (!item) throw new Error("role queue insert did not commit");
  return item;
}

/** Claim one item atomically and recover leases abandoned by a crashed worker. */
export function claimNextRoleTask(
  database: Database = db,
  options: RoleRuntimeOptions = {},
): RoleQueueItem | null {
  // Аудит 2026-08-27: воркер дёргает claim каждые 5 с, и на пустой очереди
  // BEGIN IMMEDIATE брал RESERVED-блокировку ~17 280 раз в сутки просто чтобы
  // ничего не найти. Все три подметания ниже трогают только строки в
  // 'queued'/'running' — если таких нет, транзакция гарантированно пустая.
  const active = database
    .prepare(
      `SELECT EXISTS(
         SELECT 1 FROM role_runtime_queue WHERE state IN ('queued','running')
       ) AS present`,
    )
    .get() as { present: number } | undefined;
  if (!active?.present) return null;

  let claimedId: string | null = null;
  // Собираем здесь, а шлём после коммита: `emitAlert` пишет в audit_logs, и
  // алерт, отправленный изнутри `tx.immediate()`, при откате остался бы
  // рассказом о событии, которого не было.
  const recovered: Array<{
    taskId: string;
    attempt: number;
    paid: boolean;
    gaveUp: boolean;
  }> = [];
  const now = options.now?.() ?? Date.now();
  const leaseTimeoutMs = positiveOption(options.leaseTimeoutMs, DEFAULT_ROLE_LEASE_TIMEOUT_MS);
  const maxAttempts = Math.max(1, Math.floor(positiveOption(options.maxAttempts, DEFAULT_ROLE_MAX_ATTEMPTS)));
  const workerId = options.workerId?.trim() || `role-runtime-${crypto.randomUUID()}`;
  const tx = database.transaction(() => {
    const stale = database
      .prepare(
        `SELECT q.task_id, q.id, t.input, t.updated_at
         FROM role_runtime_queue q
         JOIN tasks t ON t.id = q.task_id
         WHERE q.state='running' AND t.status='running'`,
      )
      .all() as Array<{ task_id: string; id: string; input: string | null; updated_at: number }>;
    for (const row of stale) {
      const runtime = readRuntimeLease(row.input);
      const heartbeatAt = runtime?.heartbeatAt ?? row.updated_at;
      if (heartbeatAt > now - leaseTimeoutMs) continue;
      const attempt = (runtime?.attempt ?? readAttempt(row.input)) || 1;
      const paid = typeof runtime?.dispatchedAt === "number";
      recovered.push({
        taskId: row.task_id,
        attempt,
        paid,
        gaveUp: attempt >= maxAttempts,
      });
      if (attempt >= maxAttempts) {
        database.prepare(`UPDATE role_runtime_queue SET state='failed' WHERE id=? AND state='running'`).run(row.id);
        database.prepare(
          `UPDATE tasks SET status='failed', error=?, updated_at=? WHERE id=? AND status='running'`,
        ).run(`role runtime lease expired after ${attempt} attempt(s)`, now, row.task_id);
      } else {
        database.prepare(`UPDATE role_runtime_queue SET state='queued' WHERE id=? AND state='running'`).run(row.id);
        database.prepare(
          `UPDATE tasks SET status='pending', error=?, input=?, updated_at=? WHERE id=? AND status='running'`,
        ).run(
          `role runtime lease expired; recovered for attempt ${attempt + 1}`,
          encodeTaskInput(row.input, { attempt }),
          now,
          row.task_id,
        );
      }
    }

    // A task can be cancelled by another local path after enqueue. Retire its
    // queue item before claiming the next pending task so it cannot linger.
    database
      .prepare(
        `UPDATE role_runtime_queue SET state='failed'
         WHERE state='queued'
           AND task_id IN (SELECT id FROM tasks WHERE status <> 'pending')`,
      )
      .run();
    database
      .prepare(
        `UPDATE role_runtime_queue SET state='failed'
         WHERE state='running'
           AND task_id IN (SELECT id FROM tasks WHERE status <> 'running')`,
      )
      .run();
    const row = database
      .prepare(
        // Аудит 2026-08-27: task_id берём явно. Ниже UPDATE tasks шёл по q.id
        // и работал только потому, что enqueueRoleTask пишет их равными.
        `SELECT q.id, q.task_id, t.input FROM role_runtime_queue q
         JOIN tasks t ON t.id = q.task_id
         WHERE q.state = 'queued' AND t.status = 'pending'
         ORDER BY q.created_at ASC LIMIT 1`,
      )
      .get() as { id: string; task_id: string; input: string | null } | undefined;
    if (!row) return;
    const leaseId = crypto.randomUUID();
    const previous = readRuntimeLease(row.input);
    const attempt = (previous?.attempt ?? readAttempt(row.input)) + 1;
    const changed = database
      .prepare(`UPDATE role_runtime_queue SET state='running' WHERE id=? AND state='queued'`)
      .run(row.id);
    if (changed.changes !== 1) return;
    const taskChanged = database.prepare(
      `UPDATE tasks SET status='running', input=?, updated_at=? WHERE id=? AND status='pending'`,
    ).run(
      encodeTaskInput(row.input, {
        leaseId,
        workerId,
        heartbeatAt: now,
        startedAt: now,
        attempt,
      }),
      now,
      row.task_id,
    );
    if (taskChanged.changes !== 1) throw new Error("role queue task is no longer pending");
    // Аудит 2026-08-27 (второй заход): возвращали `row.id` — идентификатор
    // СТРОКИ ОЧЕРЕДИ, а `getRoleQueueItem` ищет `WHERE q.task_id = ?`. Комментарий
    // выше объявил эту подмену снятой, но снял её только для UPDATE tasks. Сейчас
    // не стреляет ровно по той же причине, что и раньше: `enqueueRoleTask` и
    // миграция 044 пишут id и task_id равными. Первый же путь, создавший строку
    // очереди с собственным id, получил бы здесь `null` — задача осталась бы
    // 'running' до истечения аренды, хотя claim прошёл успешно.
    claimedId = row.task_id;
  });
  tx.immediate();
  // Аудит 2026-08-29: подметание было полностью немым. Строка `tasks.error`
  // («lease expired; recovered for attempt N») видна только тому, кто пришёл
  // смотреть именно эту задачу, а платит за повтор владелец. Отличаем оплаченный
  // повтор от бесплатного: без `dispatchedAt` прогон до модели не дошёл, и
  // подбирать его — просто продолжение работы.
  const alert = options.alert ?? emitAlert;
  for (const rec of recovered) {
    if (rec.gaveUp) {
      alert(
        "warn",
        "role_runtime.lease_expired",
        `role-runtime: задача брошена после ${rec.attempt} попыт(ки/ок) — аренда не продлевалась`,
        { taskId: rec.taskId, attempt: rec.attempt, dispatched: rec.paid },
      );
    } else if (rec.paid) {
      alert(
        "warn",
        "role_runtime.rerun_after_crash",
        `role-runtime: попытка ${rec.attempt} успела уйти модели — повтор оплачивается заново`,
        { taskId: rec.taskId, attempt: rec.attempt, nextAttempt: rec.attempt + 1 },
      );
    } else {
      log.warn("[role-runtime] аренда протухла до вызова модели — подбираем бесплатно", {
        taskId: rec.taskId,
        attempt: rec.attempt,
      });
    }
  }
  return claimedId ? getRoleQueueItem(claimedId, database) : null;
}

/**
 * Ставит `dispatchedAt` перед вызовом исполнителя — durable-след того, что за
 * попытку уже заплачено. Ограждение по leaseId такое же, как у heartbeat'а:
 * если аренду успели отобрать, метку не ставим и возвращаем false.
 */
export function markRoleTaskDispatched(
  taskId: string,
  leaseId: string,
  database: Database = db,
  now = Date.now(),
): boolean {
  let ok = false;
  const tx = database.transaction(() => {
    const row = database
      .prepare(`SELECT input FROM tasks WHERE id=? AND status='running'`)
      .get(taskId) as { input: string | null } | undefined;
    const runtime = readRuntimeLease(row?.input);
    if (!runtime || runtime.leaseId !== leaseId) return;
    if (typeof runtime.dispatchedAt === "number") {
      ok = true;
      return;
    }
    const changed = database.prepare(
      `UPDATE tasks SET input=?, updated_at=?
       WHERE id=? AND status='running'
         AND json_extract(input, '$._role_runtime.leaseId') = ?`,
    ).run(
      encodeTaskInput(row?.input, { ...runtime, dispatchedAt: now }),
      now,
      taskId,
      leaseId,
    );
    ok = changed.changes === 1;
  });
  tx.immediate();
  return ok;
}

export function getRoleQueueItem(taskId: string, database: Database = db): RoleQueueItem | null {
  const row = database
    .prepare(
      `SELECT q.*, t.input, t.updated_at FROM role_runtime_queue q
       JOIN tasks t ON t.id=q.task_id WHERE q.task_id=?`,
    )
    .get(taskId) as RoleQueueRow | undefined;
  return row ? rowToItem(row) : null;
}

/** Refresh the lease; a recovered task has a different leaseId and is fenced. */
export function heartbeatRoleTask(
  taskId: string,
  leaseId: string,
  database: Database = db,
  now = Date.now(),
): boolean {
  // Аудит 2026-08-27: read-modify-write шёл вне транзакции и без ограждения по
  // leaseId в самом UPDATE. Между SELECT и UPDATE подметание в
  // claimNextRoleTask успевало отобрать аренду и выдать её другому воркеру, а
  // этот UPDATE затирал новую аренду своей — и одну роль исполняли двое.
  let ok = false;
  const tx = database.transaction(() => {
    const row = database
      .prepare(`SELECT input FROM tasks WHERE id=? AND status='running'`)
      .get(taskId) as { input: string | null } | undefined;
    const runtime = readRuntimeLease(row?.input);
    if (!runtime || runtime.leaseId !== leaseId) return;
    const changed = database.prepare(
      `UPDATE tasks SET input=?, updated_at=?
       WHERE id=? AND status='running'
         AND json_extract(input, '$._role_runtime.leaseId') = ?`,
    ).run(
      encodeTaskInput(row?.input, { ...runtime, heartbeatAt: now }),
      now,
      taskId,
      leaseId,
    );
    ok = changed.changes === 1;
  });
  tx.immediate();
  return ok;
}

export function completeRoleTask(
  taskId: string,
  output: unknown,
  database: Database = db,
  leaseId?: string,
): void {
  const now = Date.now();
  const encoded = JSON.stringify(output);
  const tx = database.transaction(() => {
    const queue = database
      .prepare(`SELECT state FROM role_runtime_queue WHERE task_id=?`)
      .get(taskId) as { state: RoleQueueState } | undefined;
    const task = database
      .prepare(`SELECT status, input FROM tasks WHERE id=?`)
      .get(taskId) as { status: string; input: string | null } | undefined;
    if (queue?.state === "done" && task?.status === "done") return;
    if (queue?.state !== "running" || task?.status !== "running") {
      throw new Error("role task completion raced with another state transition");
    }
    const activeLease = readRuntimeLease(task.input);
    if (leaseId && activeLease?.leaseId !== leaseId) throw new Error("role task lease lost");
    database.prepare(`UPDATE role_runtime_queue SET state='done' WHERE task_id=? AND state='running'`).run(taskId);
    database.prepare(`UPDATE tasks SET status='done', output=?, error=NULL, updated_at=? WHERE id=? AND status='running'`).run(encoded, now, taskId);
  });
  tx.immediate();
}

export function failRoleTask(
  taskId: string,
  error: string,
  database: Database = db,
  leaseId?: string,
): void {
  const now = Date.now();
  const tx = database.transaction(() => {
    const queue = database
      .prepare(`SELECT state FROM role_runtime_queue WHERE task_id=?`)
      .get(taskId) as { state: RoleQueueState } | undefined;
    const task = database
      .prepare(`SELECT status, input FROM tasks WHERE id=?`)
      .get(taskId) as { status: string; input: string | null } | undefined;
    if (queue?.state === "failed" && task?.status === "failed") return;
    if (queue?.state !== "running") {
      throw new Error("role task failure raced with another queue transition");
    }
    const activeLease = readRuntimeLease(task?.input);
    if (leaseId && activeLease?.leaseId !== leaseId) throw new Error("role task lease lost");
    database.prepare(`UPDATE role_runtime_queue SET state='failed' WHERE task_id=? AND state='running'`).run(taskId);
    if (task?.status === "running") {
      database.prepare(`UPDATE tasks SET status='failed', error=?, updated_at=? WHERE id=? AND status='running'`).run(error.slice(0, 4000), now, taskId);
    }
  });
  tx.immediate();
}

/**
 * Provider execution is injected by the local runtime. This keeps queue code
 * independent from Claude/Codex process launch and makes unknown providers
 * impossible to execute accidentally.
 */
export type RoleProviderExecutor = (item: RoleQueueItem) => Promise<unknown>;
export type RoleProviderExecutors = Partial<Record<RoleProvider, RoleProviderExecutor>>;

/**
 * Ограничение прогона по часам.
 *
 * Гонка, а не отмена: у провайдера нет ручки прерывания, и притворяться, что
 * есть, было бы хуже — задача помечается упавшей, аренда перестаёт
 * продлеваться (`clearInterval` в finally вызывающего). Зависший процесс
 * провайдера — забота его собственного таймаута.
 *
 * Аудит 2026-08-27: здесь стояло «и восстановление подберёт её штатно» — это
 * неправда и она вводила в заблуждение. Подметание в claimNextRoleTask ищет
 * `state='running' AND status='running'`, а после дедлайна обе метки уже
 * 'failed'. Дедлайн — терминальное состояние, повторов не будет: это
 * сознательный выбор (повтор означал бы заново оплатить тот же прогон), но
 * называть его восстановлением нельзя.
 */
function withRunDeadline<T>(work: Promise<T>, maxRunMs: number, taskId: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadlineFired = false;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      deadlineFired = true;
      reject(new Error(`role task exceeded ${maxRunMs} ms wall clock`));
    }, maxRunMs);
  });
  return Promise.race([work, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
    // Аудит 2026-08-27 (второй заход): здесь `work.catch` стоял без условия, а
    // `.finally()` выполняется на ОБЕИХ ветках гонки. Поэтому обычный отказ
    // провайдера на первой секунде (нет исполнителя, упал Anthropic,
    // BudgetExceededError) писал в прод warn «завершился после дедлайна» —
    // при потолке в 30 минут. Замер на чистой БД: провайдер бросил сразу,
    // в журнале строка про дедлайн. Дежурный по такому логу ищет зависший
    // прогон, а причина — первая же ошибка вызова.
    //
    // Прежнее обоснование («иначе unhandled rejection и смерть процесса») тоже
    // неверно: `Promise.race` подписывается на обе ветки, поэтому поздний
    // reject `work` уже обработан гонкой. Проверено отдельным замером —
    // без этого catch `unhandledRejection` не срабатывает.
    //
    // Строка нужна за другим: когда гонку выиграл дедлайн, отказ провайдера
    // больше нигде не виден, а он единственный называет настоящую причину.
    if (!deadlineFired) return;
    void work.catch((error) => {
      log.warn("[role-runtime] провайдер завершился после дедлайна", {
        taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }) as Promise<T>;
}

/**
 * Финальная проверка аренды перед записью результата. `false` от heartbeat'а —
 * это ограждение по leaseId, то есть настоящая потеря; исключение — отказ
 * хранилища, и по нему нельзя выбрасывать уже оплаченный прогон. Настоящее
 * ограждение всё равно стоит в completeRoleTask: та же транзакция сверяет
 * leaseId и бросит «role task lease lost», если аренда и правда ушла.
 */
function leaseFencedOut(taskId: string, leaseId: string, database: Database): boolean {
  try {
    return !heartbeatRoleTask(taskId, leaseId, database);
  } catch (error) {
    log.warn("[role-runtime] финальная проверка аренды не прошла, решает completeRoleTask", {
      taskId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function processNextRoleTask(
  executors: RoleProviderExecutors,
  database: Database = db,
  options: RoleRuntimeOptions = {},
): Promise<RoleQueueItem | null> {
  const item = claimNextRoleTask(database, options);
  if (!item) return null;
  const leaseId = item.leaseId;
  const leaseTimeoutMs = positiveOption(options.leaseTimeoutMs, DEFAULT_ROLE_LEASE_TIMEOUT_MS);
  const heartbeatMs = Math.min(
    positiveOption(options.heartbeatMs, DEFAULT_ROLE_HEARTBEAT_MS),
    Math.max(1, Math.floor(leaseTimeoutMs / 2)),
  );
  const maxRunMs = positiveOption(options.maxRunMs, DEFAULT_ROLE_MAX_RUN_MS);
  let leaseLost = false;
  // Аудит 2026-08-27: отказ записи (SQLITE_BUSY, полный диск) — не то же, что
  // потеря аренды. Раньше первый же busy объявлял аренду потерянной, и готовый
  // результат прогона выбрасывался. `false` от heartbeat'а — это ограждение по
  // leaseId, то есть настоящая потеря; исключение — проблема хранилища, и
  // сдаёмся только когда аренда и правда успела истечь.
  let heartbeatFailingSince: number | null = null;
  const timer = leaseId
    ? setInterval(() => {
        // Тело обработчика интервала — граница процесса: исключение отсюда
        // никто не ловит, и SQLITE_BUSY/переполненный диск в heartbeat'е
        // ронял бы весь agent-team, а не одну задачу.
        //
        // Аудит 2026-08-27 (второй заход): дальше здесь стояло «сбой продления —
        // ровно то же, что аренда потеряна». Это описание СТАРОГО тела
        // (`catch { leaseLost = true; }`), которое сам же фикс выше и объявил
        // багом: первый busy выбрасывал готовый оплаченный прогон. Комментарий
        // пережил переписанный код. Правда — в ветке ниже: `false` от
        // heartbeat'а это ограждение по leaseId (настоящая потеря), а
        // исключение копится в heartbeatFailingSince и становится потерей
        // только когда аренда успела истечь.
        try {
          if (heartbeatRoleTask(item.taskId, leaseId, database)) {
            heartbeatFailingSince = null;
            // Аудит 2026-08-28: сбрасывался только счётчик отказов, а сам флаг
            // оставался поднятым навсегда — база отвисала, аренда была наша, но
            // прогон всё равно объявлялся потерянным. Ниже флаг стоит первым в
            // `||` и коротким замыканием отменяет `leaseFencedOut`, то есть
            // отменяет единственную проверку, которая сходила бы в БД. Успешный
            // heartbeat — как раз такое обращение к БД: UPDATE фенсится по
            // leaseId и требует status='running', значит `true` ДОКАЗЫВАЕТ, что
            // аренда наша. Настоящее ограждение это не ослабляет: после отбора
            // аренды в строке лежит чужой leaseId, и `true` уже не вернётся.
            leaseLost = false;
          } else {
            leaseLost = true;
          }
        } catch (error) {
          const at = Date.now();
          if (heartbeatFailingSince === null) heartbeatFailingSince = at;
          const message = error instanceof Error ? error.message : String(error);
          if (at - heartbeatFailingSince >= leaseTimeoutMs) {
            leaseLost = true;
            log.error("[role-runtime] heartbeat не проходит дольше аренды — считаем её потерянной", {
              taskId: item.taskId,
              error: message,
            });
          } else {
            log.warn("[role-runtime] heartbeat не прошёл, пробуем снова", {
              taskId: item.taskId,
              error: message,
            });
          }
        }
      }, heartbeatMs)
    : undefined;
  try {
    // Аудит 2026-08-27: вызов без options всегда бросал UnavailableRoleProvider
    // для codex — задача, принятая enqueue'ом, гарантированно падала на
    // исполнении. На этом шаге «доступен» и означает «есть исполнитель».
    const provider = selectRoleProvider(item.provider, {
      codexAvailable: executors.codex !== undefined,
    });
    const execute = executors[provider];
    if (!execute) throw new Error(`role provider is not configured: ${provider}`);
    // Метку ставим ДО вызова: она отвечает на вопрос «успели ли заплатить»,
    // и после падения процесса ответить на него больше нечем. Отказ записи не
    // повод не исполнять принятую задачу — но и не повод молчать.
    //
    // Ошибку глотаем намеренно: запись метки — это учёт, а не условие работы.
    // Занятая на секунду база (SQLITE_BUSY) не должна валить уже принятую
    // задачу, ради которой всё и затевалось; худшее последствие потерянной
    // метки — что будущий повтор сочтут бесплатным, то есть недосказанность
    // в алерте, а не потерянный прогон.
    if (leaseId) {
      let marked = false;
      try {
        marked = markRoleTaskDispatched(item.taskId, leaseId, database);
      } catch (err) {
        log.warn("[role-runtime] запись метки отправки не прошла", {
          taskId: item.taskId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (!marked) {
        log.warn("[role-runtime] метка отправки не легла — повтор после падения будет считаться бесплатным", {
          taskId: item.taskId,
        });
      }
    }
    const output = await withRunDeadline(execute(item), maxRunMs, item.taskId);
    if (leaseLost || (leaseId && leaseFencedOut(item.taskId, leaseId, database))) {
      throw new Error("role task lease lost before completion");
    }
    completeRoleTask(item.taskId, output, database, leaseId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!leaseLost) {
      try {
        failRoleTask(item.taskId, message, database, leaseId);
      } catch (failure) {
        // Аудит 2026-08-27 (второй заход): здесь глотали ровно одно сообщение —
        // "role task lease lost". Но на потерянной аренде `failRoleTask` чаще
        // бросает другое: если задачу успел подобрать сосед, очередь уже не
        // 'running', и срабатывает "role task failure raced with another queue
        // transition". Такое исключение улетало наружу МИМО emitAlert ниже —
        // то есть возвращался ровно тот молчаливый провал, ради которого алерт
        // и добавляли: владелец ждёт результат SPAWN_ROLE, а в журнале только
        // обезличенное «worker tick failed».
        //
        // Наружу не выпускаем ничего: мы уже в обработчике отказа, и любой
        // сбой записи здесь — повод дополнить алерт, а не заменить его
        // исключением.
        log.error("[role-runtime] не смог записать отказ задачи", {
          taskId: item.taskId,
          error: failure instanceof Error ? failure.message : String(failure),
        });
      }
    }
    // Аудит 2026-08-27: терминальный отказ роли не выходил наружу вообще —
    // ни строчки в лог, ни строки в audit_logs. SPAWN_ROLE проходит ручное
    // одобрение владельца, и молча провалившийся прогон означал, что владелец
    // ждёт результат, которого уже никогда не будет.
    //
    // Аудит 2026-08-28: но код был один на два разных события. Потеря аренды
    // — не отказ задачи: `failRoleTask` мы намеренно пропустили (ветка
    // `if (!leaseLost)` выше), строка осталась `running`, и её либо уже держит
    // сосед, либо подберёт подметание в claimNextRoleTask. Задача, о которой
    // приходил `task_failed`, могла через минуту доехать успешной — а этот код
    // владелец читает как «результата не будет». Хуже того, он же единственный
    // терминальный сигнал по SPAWN_ROLE: разбавленный потерями аренды, он
    // перестаёт значить хоть что-нибудь. Разводим на два кода.
    const alertPayload = {
      taskId: item.taskId,
      roleSlug: item.roleSlug,
      provider: item.provider,
      chatId: item.chatId,
      error: message,
    };
    if (leaseLost) {
      emitAlert(
        "warn",
        "role_runtime.lease_lost",
        `role-runtime: прогон роли ${item.roleSlug} отброшен — аренда не подтверждена`,
        alertPayload,
      );
    } else {
      emitAlert(
        "warn",
        "role_runtime.task_failed",
        `role-runtime: роль ${item.roleSlug} завершилась отказом`,
        alertPayload,
      );
    }
  } finally {
    if (timer) clearInterval(timer);
  }
  return getRoleQueueItem(item.taskId, database);
}
