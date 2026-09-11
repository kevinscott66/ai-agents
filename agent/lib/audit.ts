/**
 * Аудит действий агентов (этап 3, C2).
 *
 * Таблица agent_actions хранит все попытки действий (ok/error/forbidden/...).
 * JSON-поля payload/result сериализуются в TEXT.
 */
import { db } from "./db.ts";
import type { ActionType } from "./permissions.ts";
import { emit as busEmit } from "./events-bus.ts";

export type { ActionType };

export const ACTION_STATUSES = [
  "attempted",
  "ok",
  "error",
  "forbidden",
  "pending_approval",
  "rate_limited",
] as const;

export type ActionStatus = (typeof ACTION_STATUSES)[number];

/** Рантайм-проверка для внешнего ввода (GET_LOGS, /audit и т.п.). */
export function isActionStatus(v: string): v is ActionStatus {
  return (ACTION_STATUSES as readonly string[]).includes(v);
}

export interface AgentAction {
  id: string;
  agent_key: string;
  task_id: string | null;
  chat_id: number | null;
  tg_message_id: number | null;
  action_type: string;
  payload: unknown | null;
  status: ActionStatus;
  result: unknown | null;
  error: string | null;
  created_at: number;
  // T-410 (T-303 HIGH #2): correlation id for end-to-end tracing.
  // NULL for rows written before migration 026.
  request_id: string | null;
}

export interface AgentActionRow {
  id: string;
  agent_key: string;
  task_id: string | null;
  chat_id: number | null;
  tg_message_id: number | null;
  action_type: string;
  payload: string | null;
  status: ActionStatus;
  result: string | null;
  error: string | null;
  created_at: number;
  request_id: string | null;
}

function parseJSON(v: string | null): unknown | null {
  if (v == null) return null;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/**
 * Строка аудита без тел: ровно то, что показывают `/audit` и `GET_LOGS`.
 *
 * Аудит 2026-08-28: `listActions` брала `SELECT *`, то есть читала и парсила
 * JSON'ом `payload`/`result` каждой строки — а оба её потребителя эти поля
 * выбрасывают намеренно (у GET_LOGS это записано в комментарии: «БЕЗ
 * payload/result — там могла быть переписка»). Тела при этом не игрушечные:
 * `SEND_DOCUMENT` пропускает до 2 МБ в `payload.content`, `WRITE_WIKI` кладёт
 * туда страницу целиком, а `/audit 100` берёт сто строк.
 *
 * Инвариант: список — метаданные, точечное чтение (`getAction`) — с телами.
 * Так «контент не показываем» держится строением кода, а не дисциплиной
 * каждого следующего вызывающего.
 */
export type AgentActionSummary = Omit<AgentAction, "payload" | "result">;

/** Колонки `AgentActionSummary` — всё, кроме payload/result. */
const SUMMARY_COLUMNS = [
  "id",
  "agent_key",
  "task_id",
  "chat_id",
  "tg_message_id",
  "action_type",
  "status",
  "error",
  "created_at",
  "request_id",
].join(", ");

/**
 * Колонки списка для Mini App: сводка плюс два признака «тело было».
 *
 * `GET /api/actions` и блок «последние действия» на дашборде собирают список
 * не через `listActions` — у них свои фильтры и курсор. Инвариант выше от
 * этого действовать не перестаёт: список остаётся списком метаданных. Но
 * наблюдателю надо показать, что тело есть и скрыто, а не что его нет, —
 * отсюда 0/1 вместо самих тел.
 *
 * Сравнение с `'null'` и `'""'` повторяет `parseJSON` плюс правило «пустое не
 * прячем»: `JSON.stringify(null)` пишет в колонку четыре символа, а не NULL,
 * и такое поле всегда приезжало наружу как `null`. Значение при этом остаётся
 * внутри SQLite — в ответ едет число.
 */
export const ACTION_LIST_COLUMNS = [
  SUMMARY_COLUMNS,
  `(payload IS NOT NULL AND payload NOT IN ('null', '""')) AS has_payload`,
  `(result IS NOT NULL AND result NOT IN ('null', '""')) AS has_result`,
].join(", ");

/** Строка, которую отдаёт `ACTION_LIST_COLUMNS`. */
export interface AgentActionListRow extends AgentActionSummary {
  has_payload: number;
  has_result: number;
}

export function rowToAction(row: AgentActionRow): AgentAction {
  return {
    ...row,
    payload: parseJSON(row.payload),
    result: parseJSON(row.result),
  };
}

export interface LogActionInput {
  agentKey: string;
  taskId?: string | null;
  chatId?: number | string | null;
  tgMessageId?: number | null;
  actionType: ActionType;
  payload?: unknown;
  status: ActionStatus;
  result?: unknown;
  error?: string | null;
  // T-410: correlation id propagated from DispatchCtx.requestId. NULL when
  // caller has no request context (legacy paths). Stored in agent_actions
  // for "show me everything in this request" queries.
  requestId?: string | null;
}

export function logAction(input: LogActionInput): { id: string } {
  const inserted = insertActionRow(input.actionType, input);
  emitActionEvents(inserted);
  return { id: inserted.id };
}

/**
 * Аудит инлайновых тулзов, которых нет в ACTION_TYPES.
 *
 * Аудит 2026-08-04: QUERY_DB — произвольный SELECT по операционной БД, без
 * chat-скоупа (таблицы с перепиской и аудитом закрыты денилистом, но `tasks`,
 * `permissions`, `chat_settings` читаются по всем чатам). При этом он не
 * оставлял в agent_actions НИ ОДНОЙ строки: кто, когда и какой SQL выполнил,
 * узнать было неоткуда — ни в Mini App, ни в БД, только в текстовом логе
 * процесса, который ротируется. Любое другое действие с последствиями строку
 * пишет; читающий всю базу — не писал.
 *
 * Отдельная функция, а не расширение ACTION_TYPES: ACTION_TYPES — это список
 * ДИСПАТЧЕРА (permissions, гейт, разбор команд), и добавить туда тулзу значило
 * бы объявить её вызываемым действием. `agent_actions.action_type` — TEXT, а
 * читающая сторона работает со строкой, так что запись корректна.
 */
export function logToolCall(
  toolName: string,
  input: Omit<LogActionInput, "actionType">,
): { id: string } {
  const inserted = insertActionRow(toolName, input);
  emitActionEvents(inserted);
  return { id: inserted.id };
}

export interface InsertedAction {
  id: string;
  event: {
    id: string;
    agent: string;
    action_type: string;
    status: ActionStatus;
    chat_id: number | null;
    request_id: string | null;
    ts: number;
  } | null;
}

/**
 * Статусы, на которых действие считается завершённым: только они поднимают
 * `action.executed`, и только в них `finalizeActionRow` закрывает строку.
 */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["ok", "error"]);

/** Insert only; callers that open a larger transaction emit after commit. */
export function insertActionRow(
  actionType: string,
  input: Omit<LogActionInput, "actionType">,
): InsertedAction {
  const id = crypto.randomUUID();
  const now = Date.now();
  const chatId =
    input.chatId == null
      ? null
      : typeof input.chatId === "string"
        ? Number(input.chatId)
        : input.chatId;
  db.prepare(
    `INSERT INTO agent_actions(
      id, agent_key, task_id, chat_id, tg_message_id, action_type, payload, status, result, error, created_at, request_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.agentKey,
    input.taskId ?? null,
    chatId,
    input.tgMessageId ?? null,
    actionType,
    input.payload === undefined ? null : JSON.stringify(input.payload),
    input.status,
    input.result === undefined ? null : JSON.stringify(input.result),
    input.error ?? null,
    now,
    input.requestId ?? null,
  );
  return {
    id,
    event: TERMINAL_STATUSES.has(input.status)
      ? {
      id,
      agent: input.agentKey,
      action_type: actionType,
      status: input.status,
      chat_id: chatId,
      request_id: input.requestId ?? null,
      ts: now,
        }
      : null,
  };
}

export interface FinalizeActionInput {
  /** Терминальный статус. Нетерминальный здесь запрещён — см. проверку ниже. */
  status: ActionStatus;
  /** Известен только после исполнения; NULL оставляет прежнее значение. */
  taskId?: string | null;
  result?: unknown;
  error?: string | null;
}

/**
 * Закрывает строку, заведённую в статусе `attempted`, терминальным статусом.
 *
 * Аудит 2026-08-29. `dispatchAndAudit` писал в `agent_actions` РОВНО ОДНУ
 * строку и делал это ПОСЛЕ `await dispatchAction`, то есть после того, как
 * действие уже ушло наружу — в Telegram, в GitHub, на Mac. Смерть процесса в
 * промежутке (рестарт по деплою, OOM, `systemctl restart`) оставляла
 * последствие без всякого следа: сообщение отправлено, а в базе о нём нет
 * ничего — ни в ленте Mini App, ни в GET_LOGS, ни в `/audit`. Разбирать такой
 * случай постфактум не по чему.
 *
 * Отсюда две записи вместо одной: `attempted` до вызова («собираемся») и
 * перевод в `ok`/`error` после («вот чем кончилось»). Статус `attempted` в
 * вокабуляре был с самого начала (ACTION_STATUSES), но не писался никем —
 * теперь у него появился ровно тот смысл, под который он и заводился.
 *
 * `WHERE status='attempted'` — не украшение: уже терминальную строку никто
 * переписать не может, ни санитар, ни повторный вызов. Возврат `null` означает
 * «строки в полёте нет» — вызывающий пишет обычную одиночную строку, как
 * раньше.
 *
 * `created_at` не трогаем: он отвечает на вопрос «когда действие началось», и
 * для длинных действий (MAC_RUN_CLAUDE идёт минутами) это единственная честная
 * отметка начала. Событие в шину несёт своё `ts` — момент завершения.
 */
export function finalizeActionRow(
  id: string,
  input: FinalizeActionInput,
): InsertedAction | null {
  if (!TERMINAL_STATUSES.has(input.status)) {
    throw new Error(`finalizeActionRow: нетерминальный статус ${input.status}`);
  }
  const now = Date.now();
  const row = db
    .prepare(
      `UPDATE agent_actions
       SET status=?, result=?, error=?, task_id=COALESCE(?, task_id)
       WHERE id=? AND status='attempted'
       RETURNING agent_key, action_type, chat_id, request_id`,
    )
    .get(
      input.status,
      input.result === undefined ? null : JSON.stringify(input.result),
      input.error ?? null,
      input.taskId ?? null,
      id,
    ) as
    | { agent_key: string; action_type: string; chat_id: number | null; request_id: string | null }
    | undefined;
  if (!row) return null;
  return {
    id,
    event: {
      id,
      agent: row.agent_key,
      action_type: row.action_type,
      status: input.status,
      chat_id: row.chat_id,
      request_id: row.request_id,
      ts: now,
    },
  };
}

/**
 * Закрывает строку, заведённую в статусе `pending_approval`, когда решение по
 * её заявке принято НЕ в пользу исполнения: отказ человека или истечение TTL.
 *
 * Аудит 2026-09-11. `agent_actions.status='pending_approval'` пишется ровно в
 * одном месте (`action-dispatch.ts`, ветка `gate.decision === "approval"`), а
 * снимался ниоткуда: два единственных UPDATE по этой таблице —
 * `finalizeActionRow` выше и `expireStaleAttempts` в db-maint.ts — оба сужены
 * до `attempted`. Отказ и протухание меняли только таблицу `approvals`. То
 * есть после «Reject» строка ДЕЙСТВИЯ навсегда оставалась «ждёт аппрув»: и в
 * `/audit`, и в ленте Mini App (`ACTION_STATUS_LABELS` в
 * miniapp/src/lib/labels.ts), и в GET_LOGS, который читает
 * сама модель. Роль, переспросившая журнал «одобрили мою публикацию?», видела
 * ожидание вместо состоявшегося отказа, а человек — очередь, которой в
 * `/approvals` уже нет. Комментарий в той ветке описывал только вариант с
 * крашем между двумя коммитами и прямо говорил, что санитайзера по
 * `pending_approval` нет вовсе; отказ же — обычный будний день, без всякого
 * краша. Санитар — эта самая функция; оговорку в ту ветку дописали тем же
 * аудитом.
 *
 * `forbidden` — не новое слово, а ровно то, что в этом вокабуляре значит
 * «наружу не ушло, потому что не разрешили»: тем же статусом пишет свои отказы
 * гейт. Отличает отказ от истечения текст в `error`. Заводить `rejected` и
 * `expired` пришлось бы вместе с enum'ом в схеме инструментов, а он живёт под
 * отдельным PR; ни один счётчик (`alerting.ts` — `rate_limited`, `digest.ts` —
 * `error`) на `forbidden` не смотрит, так что метрики правка не двигает.
 *
 * Одобрение сюда не заходит: у него последствие уже записано СВОЕЙ строкой —
 * `executeApproved` идёт через `dispatchAndAudit`, а тот заводит пару
 * `attempted` → `ok`/`error` с тем же `request_id`. Перевести здесь и её
 * значило бы посчитать одно действие дважды в том же статусе.
 *
 * Событие в шину не поднимаем: `forbidden` не терминален в смысле
 * TERMINAL_STATUSES (гейт пишет свои отказы молча), а открытая вкладка про
 * смену состояния и так узнаёт из `approval.decided` — его шлют оба
 * вызывающих. `WHERE status='pending_approval'` — тот же приём, что у
 * `finalizeActionRow`: уже закрытую строку не перепишет ни повторное решение,
 * ни санитар.
 */
export function closeGatedActionRow(actionId: string, error: string): boolean {
  const res = db
    .prepare(
      `UPDATE agent_actions SET status='forbidden', error=?
       WHERE id=? AND status='pending_approval'`,
    )
    .run(error.slice(0, 2000), actionId);
  return res.changes > 0;
}

/** Emit events only after the transaction containing insertActionRow committed. */
export function emitActionEvents(inserted: InsertedAction): void {
  if (!inserted.event) return;
  try {
    busEmit("action.executed", inserted.event);
  } catch {
    /* шина не должна влиять на запись аудита */
  }
}

export function getAction(id: string): AgentAction | null {
  const row = db.prepare(`SELECT * FROM agent_actions WHERE id = ?`).get(id) as
    | AgentActionRow
    | undefined;
  return row ? rowToAction(row) : null;
}

export interface ListActionsFilter {
  agentKey?: string;
  taskId?: string;
  /** Фильтр по статусу (например 'error' — последние сбои). */
  status?: string;
  /** SEC-audit F4 (T-725): ограничить выборку чатом вызывающего. */
  chatId?: number;
  limit?: number;
}

export function listActions(filter: ListActionsFilter = {}): AgentActionSummary[] {
  const limit = filter.limit ?? 50;
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filter.agentKey) {
    where.push("agent_key = ?");
    args.push(filter.agentKey);
  }
  if (filter.taskId) {
    where.push("task_id = ?");
    args.push(filter.taskId);
  }
  if (filter.status) {
    where.push("status = ?");
    args.push(filter.status);
  }
  if (filter.chatId != null) {
    where.push("chat_id = ?");
    args.push(filter.chatId);
  }
  const sql =
    `SELECT ${SUMMARY_COLUMNS} FROM agent_actions` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    // rowid замыкает ключ: одна реплика агента пишет несколько строк в ту же
    // миллисекунду (действие в полёте + закрытие, фан-аут по ролям), и без
    // тай-брейка на границе LIMIT выдача плавает от вызова к вызову — GET_LOGS
    // и Mini App показывали бы разное на одном и том же запросе. Индекс по
    // created_at продолжает работать: SQLite досортировывает только внутри
    // группы с одинаковым временем («USE TEMP B-TREE FOR LAST TERM OF ORDER BY»).
    ` ORDER BY created_at DESC, rowid DESC LIMIT ?`;
  args.push(limit);
  // Тела не запрашиваются вовсе — см. AgentActionSummary. Нужна одна строка
  // с payload/result (diagnostic-action по упавшему действию) — getAction(id).
  return db.prepare(sql).all(...args) as AgentActionSummary[];
}
