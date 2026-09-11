/**
 * Approvals workflow (этап 3, C4).
 *
 * Хранит запросы на одобрение действий, требующих гейта.
 * payload — JSON-сериализуемый, действие зависит от action_type.
 */
import { db } from "./db.ts";
import { HOUR_MS } from "./time-constants.ts";
import { emit as busEmit } from "./events-bus.ts";
import type { Database } from "bun:sqlite";
import { closeAgentPromptProposals } from "./dispatch/agent-prompt.ts";
import { crossChatRequested } from "./dispatch/helpers.ts";
import { closeGatedActionRow } from "./audit.ts";
import { ruDateTime } from "./delabs-text.ts";

/**
 * `failed` — человек одобрил, но исполнение упало (см. markApprovalFailed).
 * Терминальный статус: авто-ретрая нет, потому что действия здесь необратимые
 * (пост в канал, сообщение от лица владельца) и «повторить на всякий случай»
 * дороже, чем не повторить.
 *
 * `expired` — человек НЕ решил за отведённый срок (аудит 2026-08-12). Это не
 * отказ: отказ — это решение, и подделывать его санитар не вправе. Строка
 * остаётся в таблице, чтобы было видно, что заявка была и чем кончилась.
 */
export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "failed"
  | "expired";

/**
 * Тот же приём, что у `TASK_STATUSES` в types.ts: рантайм-список выводится из
 * объекта, ключи которого проверяет компилятор, а не пишется руками вторым
 * экземпляром рядом с union'ом.
 *
 * Нужен затем, что `GET /api/approvals?status=…` до аудита 2026-08-28 клал
 * параметр прямо в SQL без проверки: опечатка `?status=aproved` давала пустой
 * список с кодом 200, неотличимый от «решений не было». В соседнем
 * `/api/tasks` этот же класс уже закрыт через `TASK_STATUSES`.
 */
const APPROVAL_STATUS_KEYS: Record<ApprovalStatus, true> = {
  pending: true,
  approved: true,
  rejected: true,
  failed: true,
  expired: true,
};

export const APPROVAL_STATUSES = Object.keys(
  APPROVAL_STATUS_KEYS,
) as ApprovalStatus[];

/**
 * Сколько живёт нерешённая заявка. Сутки — тот же порядок, что у gcStaleTasks.
 *
 * Аудит 2026-08-12: срока не было вовсе. Последствий два, и оба про то, что
 * очередь, из которой ничего не выбывает, перестаёт быть очередью:
 * listPendingApprovals отдаёт `ORDER BY created_at ASC LIMIT 20`, то есть
 * двадцать старых карточек намертво вытесняют сегодняшнюю; а «Approve» на
 * трёхмесячной карточке исполняет действие с трёхмесячным payload'ом.
 *
 * Переменную читаем при обращении, а не на импорте: тесты и прод-рестарт
 * должны видеть одно и то же значение без порядковых сюрпризов.
 */
export function approvalTtlMs(): number {
  const raw = Number(process.env.APPROVAL_TTL_HOURS);
  const hours = Number.isFinite(raw) && raw > 0 ? raw : 24;
  return hours * HOUR_MS;
}

/** Значение по умолчанию — для тестов и вызывающих, которым нужен порядок. */
export const APPROVAL_TTL_MS = 24 * HOUR_MS;

/**
 * Сколько нерешённых заявок агент может держать в очереди одновременно.
 *
 * Аудит 2026-08-14: постановка в очередь одобрения не стоила агенту ничего.
 * `gateOrDispatch` возвращается на ветке `approval` РАНЬШЕ, чем резервирует
 * слот rate-limit'а (проверка наверху ничего не тратит), а слот списывается
 * только при исполнении — то есть после нажатия человека, которого может не
 * быть. Цикл роли, упирающийся в гейт, наполнял очередь бесплатно и без
 * предела.
 *
 * Бьёт это по видимости чужих заявок: `listPendingApprovals` отдаёт двадцать
 * САМЫХ СТАРЫХ (`ORDER BY created_at ASC LIMIT 20`), и `/approvals` в чате
 * показывает ровно их. Сотня заявок одной роли вытесняет из выдачи всех
 * остальных на сутки — до срабатывания TTL.
 *
 * Предел на роль, а не на всю таблицу: одна зациклившаяся роль не должна
 * закрывать очередь одиннадцати другим.
 *
 * Аудит 2026-09-10: предел на роль считался по ВСЕЙ таблице, без чата, — хотя
 * вред, которым он обоснован абзацем выше, чат-локальный: `/approvals`
 * показывает `listPendingApprovals(chatId, 20, …)`, то есть очередь одного
 * чата. Заявки роли `smm` в чате A не вытесняют из выдачи никого в чате B, но
 * счётчик их складывал: набрав десять неразобранных заявок на одной доске,
 * роль получала отказ на всех остальных. Отказ этот — не «встань в очередь», а
 * `kind: "error"`: работа теряется, а причина указывает на очередь, которой в
 * этом чате нет и которую отсюда не видно. Чат в счёте — `chat_id` заявки, тот
 * же ключ, по которому её потом покажут человеку.
 *
 * Глобальный рост таблицы это не оголяет: за ним следит отдельная проверка
 * `checkApprovalBacklog` (alerting.ts), считающая pending по всем чатам.
 */
export function maxPendingApprovals(): number {
  const raw = Number(process.env.MAX_PENDING_APPROVALS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 10;
}

/** Значение по умолчанию — для тестов и вызывающих, которым нужен порядок. */
export const MAX_PENDING_APPROVALS = 10;

/**
 * Сколько нерешённых заявок сейчас висит на агенте.
 *
 * `chatId` не задан — считаем по всем чатам (так смотрят на роль целиком).
 * Предел очереди зовёт с чатом: см. докблок `maxPendingApprovals`.
 */
export function countPendingApprovals(
  agentKey: string,
  chatId?: number,
  database: Database = db,
): number {
  const conds = ["status = 'pending'", "requested_by = ?"];
  const args: unknown[] = [agentKey];
  if (chatId !== undefined && chatId !== null) {
    conds.push("chat_id = ?");
    args.push(chatId);
  }
  const row = database
    .prepare(`SELECT COUNT(*) AS n FROM approvals WHERE ${conds.join(" AND ")}`)
    .get(...args as never[]) as { n: number };
  return row.n;
}

/** Run approval-queue writes under the same immediate lock used by the gate. */
export function withApprovalTransaction<T>(
  callback: (database: Database) => T,
  database: Database = db,
): T {
  const tx = database.transaction(() => callback(database));
  return tx.immediate();
}

export interface Approval {
  id: string;
  action_id: string;
  chat_id: number;
  requested_by: string;
  action_type: string;
  payload: unknown;
  status: ApprovalStatus;
  decided_by: string | null;
  decided_at: number | null;
  reason: string | null;
  created_at: number;
  /** T-546: request_id of the originating agent turn (from agent_actions),
   *  used to group approvals that came from one logical command. May be null
   *  for older rows or when the action row is gone. */
  request_id: string | null;
}

interface ApprovalRow {
  id: string;
  action_id: string;
  chat_id: number;
  requested_by: string;
  action_type: string;
  payload: string;
  status: ApprovalStatus;
  decided_by: string | null;
  decided_at: number | null;
  reason: string | null;
  created_at: number;
  request_id?: string | null;
}

function parseJSON(v: string): unknown {
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function rowToApproval(row: ApprovalRow): Approval {
  return { ...row, payload: parseJSON(row.payload), request_id: row.request_id ?? null };
}

export interface CreateApprovalInput {
  actionId: string;
  chatId: number;
  requestedBy: string;
  actionType: string;
  payload: unknown;
}

export function createApproval(input: CreateApprovalInput): Approval {
  const id = insertApprovalRow(input);
  const a = getApproval(id);
  if (!a) throw new Error("failed to create approval");
  emitApprovalCreated(a);
  return a;
}

/** Insert only; the outer action transaction owns the commit boundary. */
export function insertApprovalRow(
  input: CreateApprovalInput,
  database: Database = db,
): string {
  const id = crypto.randomUUID();
  database.prepare(
    `INSERT INTO approvals(
       id, action_id, chat_id, requested_by, action_type, payload,
       status, decided_by, decided_at, reason, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?)`,
  ).run(
    id,
    input.actionId,
    input.chatId,
    input.requestedBy,
    input.actionType,
    JSON.stringify(input.payload ?? null),
    Date.now(),
  );
  return id;
}

export function emitApprovalCreated(a: Pick<Approval, "id" | "chat_id" | "action_type">): void {
  busEmit("approval.created", { id: a.id, chat_id: a.chat_id, action_type: a.action_type });
}

/**
 * Аудит 2026-08-12: `request_id` в `Approval` подтягивался ровно одним
 * запросом — `listPendingApprovals` (путь Mini App). `getApproval` и
 * `resolveApproval` делали `SELECT * FROM approvals`, а колонки `request_id`
 * в этой таблице нет вовсе (миграция 004): она живёт в `agent_actions`.
 * Замер:
 *   createApproval → null | getApproval → null | resolveApproval → null
 *   listPendingApprovals → req-исходный
 * То есть заявка, одобренная через `/approve` в чате, теряла связь с ходом
 * агента, который её породил, и в аудит уходил свежий request_id. Джойн
 * общий, чтобы третий путь чтения не появился снова без него.
 */
/**
 * Аудит 2026-08-14 (продолжение той же находки): джойн смотрел только в живую
 * `agent_actions`, а её строки уезжают в `agent_actions_archive` по тому же
 * 30-суточному отсечению, что и всё остальное (ADR-0007). Как только действие
 * заархивировано, `request_id` у заявки снова становится null — тем же
 * способом, от которого джойн и заводился, только с задержкой.
 *
 * После архивации самих заявок (миграция 042) окно узкое: заявка и её действие
 * уезжают в одном прогоне. Но «узкое» — не «пустое»: прогон может оборваться
 * между двумя переносами, а `expireStaleApprovals` не трогает заявки, у которых
 * TTL отключён. Второй LEFT JOIN стоит COALESCE'ом, а не заменой: живая таблица
 * остаётся первым источником, архив — запасным.
 */
const APPROVAL_SELECT =
  `SELECT a.*, COALESCE(aa.request_id, ar.request_id) AS request_id ` +
  `FROM approvals a ` +
  `LEFT JOIN agent_actions aa ON aa.id = a.action_id ` +
  `LEFT JOIN agent_actions_archive ar ON ar.id = a.action_id`;

export function getApproval(id: string): Approval | null {
  const row = db
    .prepare(`${APPROVAL_SELECT} WHERE a.id = ?`)
    .get(id) as ApprovalRow | undefined;
  return row ? rowToApproval(row) : null;
}

/**
 * Resolve an approval by full id OR unique prefix. Orchestrator announces a
 * short prefix (e.g. `1921d74e`) in chat, but the stored id is a full UUID — a
 * bare `WHERE id = ?` made `/approve <prefix>` fail with «не найден». Tries
 * exact first, then a prefix match that is UNIQUE among PENDING approvals.
 * Returns null if not found or the prefix is ambiguous.
 */
/**
 * Найти заявку по полному id или однозначному префиксу.
 *
 * `chatId` сужает поиск по префиксу до одного чата — и это не удобство.
 * Очередь заявок чат-локальна: `/approvals` печатает
 * `listPendingApprovals(chatId, …)`, предел на роль считается по чату
 * (см. докблок `maxPendingApprovals`), и человек, набирающий `/approve ab12`,
 * называет строку ИЗ ТОГО СПИСКА, который перед ним. Без фильтра тот же
 * префикс мог совпасть с единственной подходящей заявкой ЧУЖОГО чата — и
 * тогда команда молча решала не ту заявку, которую назвали, ровно как
 * `/approve ____` до аудита 2026-08-08. Разница лишь в том, что там угадывал
 * шаблон, а здесь — соседняя доска.
 *
 * Без `chatId` (Mini App, инструменты, тесты) поведение прежнее: по всем чатам.
 */
export function resolveApproval(
  idOrPrefix: string,
  chatId?: number,
): Approval | null {
  const exact = getApproval(idOrPrefix);
  if (exact) return exact;
  const p = (idOrPrefix ?? "").trim();
  if (p.length < 4) return null; // too short → refuse to guess
  // Аудит 2026-08-08: `%` и `_` уходили в LIKE как шаблон, а не как текст.
  // `/approve ____` подходил к любому id разом: при единственном pending это
  // ровно один ряд, то есть команда решала не ту заявку, которую назвали, —
  // «одобрить хоть что-нибудь». Команда админская, но угадывать она не должна.
  const like = p.replace(/[\\%_]/g, "\\$&");
  const scoped = chatId === undefined ? "" : " AND a.chat_id = ?";
  const params: unknown[] = [`${like}%`];
  if (chatId !== undefined) params.push(chatId);
  const rows = db
    .prepare(
      `${APPROVAL_SELECT}
        WHERE a.id LIKE ? ESCAPE '\\' AND a.status = 'pending'${scoped} LIMIT 2`,
    )
    .all(...(params as never[])) as ApprovalRow[];
  if (rows.length !== 1) return null; // none or ambiguous
  return rowToApproval(rows[0]);
}

/**
 * Поля payload'а, по которым видно суть действия. Порядок — от «что увидят
 * люди» к «куда это уйдёт»: текст поста важнее имени канала.
 */
const PREVIEW_FIELDS = [
  "text",
  "caption",
  "message",
  // `content` — поле текста у SCHEDULE_POST. Без него выжимка отложенного
  // поста скатывалась к имени канала (аудит 2026-08-20).
  "content",
  "title",
  "filename",
  "name",
  "prompt",
  "query",
  "url",
];

/** Строковое поле payload'а, либо пустая строка. Payload приходит от LLM. */
function str(p: Record<string, unknown>, key: string): string {
  const v = p[key];
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Момент времени из payload'а — «когда: 11.09.2026 10:00 (Europe/Moscow)».
 *
 * Значение приходит от модели, поэтому проверяется как чужое: не число, не
 * конечное, вне разумного диапазона — печатаем «когда: не указано», и это тоже
 * содержательно. Верхняя граница отсекает секунды, принятые за миллисекунды,
 * и мусор вроде 1e30: `new Date` на таком отдаёт Invalid Date, а Intl на нём
 * бросает RangeError — падение рендера карточки схлопнуло бы весь список
 * заявок, а не одну строку.
 */
function whenLabel(p: Record<string, unknown>, key: string): string {
  const v = p[key];
  if (typeof v !== "number" || !Number.isFinite(v) || v < 1e11 || v > 1e14) {
    return "когда: не указано";
  }
  return `когда: ${ruDateTime(new Date(v))}`;
}

/** Числовое поле payload'а, либо "?" — payload приходит от LLM. */
function num(p: Record<string, unknown>, key: string): string {
  const v = p[key];
  return typeof v === "number" && Number.isFinite(v) ? String(v) : "?";
}

/**
 * Аудит 2026-08-29: `via_userbot` — не деталь реализации, а смена личности
 * отправителя. Ради него аппрув и требуется: `payloadForcesApproval` заносит
 * действие в USERBOT_FORCE_APPROVAL именно потому, что сообщение уйдёт с
 * НАСТОЯЩЕГО аккаунта владельца, а не от роль-бота. Но причина гейта в строку
 * approvals не попадала (в строке заявки reason пишется NULL), и карточка
 * получалась байт-в-байт как у рядовой, которых в semi_auto десятки в день.
 * Владелец, привыкший штамповать /approve, публиковал «официальное заявление»
 * от своего имени.
 */
const OWNER_VOICE = "ОТ ЛИЦА ВЛАДЕЛЬЦА";
const ownerVoice = (p: Record<string, unknown>): string | false =>
  p.via_userbot === true && OWNER_VOICE;

/** Части выжимки склеиваем, пропуская пустые — payload бывает неполным. */
function join(parts: Array<string | false | null | undefined>): string {
  return parts.filter((x): x is string => !!x).join(" · ");
}

/**
 * Аудит 2026-08-20: у структурных payload'ов решающее лежит НЕ в строковом
 * поле, а общий путь ниже выбрасывает всё нестроковое — каждый boolean и
 * каждое число. Владелец видел «smm» и жал /approve, не зная ни какое право
 * выдают, ни что `requires_approval: false` убирает человека из петли; у
 * REVIEW_AND_MERGE_PR (мёрдж в main, а из main идёт прод-деплой) строк в
 * payload'е нет вовсе — выжимка была пустой.
 *
 * Поэтому — по рендереру на тип действия. Каждый ставит вперёд то, ради чего
 * аппрув и существует. Неизвестный тип идёт прежним общим путём.
 *
 * Экранировать нечего: карточку шлют `ctx.reply(text)` без `parse_mode`
 * (admin-commands.ts), Mini App вставляет её текстом.
 */
/**
 * Чем к посту приложат картинку — и приложат ли готовым чужим файлом.
 *
 * Порядок ветвей повторяет `dispatch/publish.ts:231-298` дословно: `photoUrl`
 * перебивает всё, дальше `coverTitle → photoBase64 → coverPrompt`, и если не
 * дали ничего — баннер рисуется по заголовку поста. Расходиться этим двум
 * местам нельзя: карточка обязана называть ту картинку, которая реально
 * уйдёт в канал, а не ту, которую владелец домыслит по набору полей.
 */
function coverNote(p: Record<string, unknown>): string {
  if (str(p, "photoUrl")) return `картинка по ссылке: ${str(p, "photoUrl")}`;
  if (str(p, "coverTitle")) return `баннер «${str(p, "coverTitle")}»`;
  if (str(p, "photoBase64")) return "картинка: готовый файл от роли";
  if (str(p, "coverPrompt")) return `картинка по промпту: ${str(p, "coverPrompt")}`;
  return "баннер по заголовку поста";
}

/**
 * Чат, в котором заявка будет ИСПОЛНЕНА, — и пометка, если payload просит
 * другой.
 *
 * Аудит 2026-09-11: карточка печатала `payload.chatId` как цель, а исполнение
 * пинит чат к чату-источнику — `pinnedChatId(payload.chatId, ctx.chatId, …)`
 * (dispatch/helpers.ts) ВСЕГДА возвращает `ctx.chatId`, и это защита от
 * увода данных, а не редкая ветка. То есть карточка называла чат, в котором
 * ничего не произойдёт, — и хуже всего у `DELETE_MESSAGE`: id сообщений
 * нумеруются в каждом чате отдельно, так что «удалить 8231 в чате B»,
 * одобренное как безобидная уборка в соседнем чате, необратимо удаляет
 * ЧУЖОЕ сообщение 8231 в этом. У `FORWARD_MESSAGE` пиннингу подчинены оба
 * конца: пересылка всегда внутри своего чата, «из чата B» — выдумка.
 *
 * Предикат берём общий (`crossChatRequested`), а не `!==` по месту: его
 * докстрока прямо просит не разводить копии условия, иначе заметка окажется
 * не про тот случай, который сработал.
 */
function pinnedChatPart(
  p: Record<string, unknown>,
  field: string,
  ctx: PreviewCtx,
  label: string,
): string {
  // Без контекста (старый вызывающий) чужой чат не называем вовсе: солгать
  // молчанием безопаснее, чем назвать чат, в котором ничего не случится.
  if (ctx.chatId === undefined) return "";
  const requested = typeof p[field] === "number" ? (p[field] as number) : undefined;
  return crossChatRequested(requested, ctx.chatId)
    ? `${label} ${ctx.chatId} (запрошен ${requested} — игнорируется)`
    : `${label} ${ctx.chatId}`;
}

/** Что карточка знает о заявке помимо payload'а. */
export interface PreviewCtx {
  /** `approvals.chat_id` — чат, в котором заявка будет исполнена. */
  chatId?: number;
}

const PREVIEW_BY_ACTION: Record<
  string,
  (p: Record<string, unknown>, ctx: PreviewCtx) => string
> = {
  GRANT_PERMISSION: (p) =>
    join([
      `${str(p, "target_agent_key") || "?"} ← ${str(p, "action_type") || "?"}`,
      p.allowed === false ? "ОТОЗВАТЬ право" : "выдать право",
      // Самое важное в этой заявке: аппрув на действие снимается насовсем.
      p.requires_approval === false
        ? "дальше БЕЗ АППРУВА"
        : "с аппрувом на каждое действие",
      str(p, "reason"),
    ]),
  CHANGE_AGENT_STATUS: (p) =>
    join([
      str(p, "target_agent_key") || "?",
      str(p, "new_status") && `статус → ${str(p, "new_status")}`,
      str(p, "new_autonomy_mode") &&
        `автономия → ${str(p, "new_autonomy_mode")}`,
      str(p, "reason"),
    ]),
  UPDATE_AGENT_PROMPT: (p) =>
    join([
      `${str(p, "target_agent_key") || "?"} ← новый system prompt`,
      str(p, "new_prompt") && `${str(p, "new_prompt").length} симв.`,
      str(p, "new_prompt"),
    ]),
  REVIEW_AND_MERGE_PR: (p) =>
    join([
      `PR #${typeof p.pr_number === "number" ? p.pr_number : str(p, "pr_number") || "?"} → merge в main`,
      str(p, "reason"),
    ]),
  MAC_RUN_CLAUDE: (p) =>
    join([
      str(p, "mode") && `mode=${str(p, "mode")}`,
      str(p, "project") && `project=${str(p, "project")}`,
      str(p, "prompt"),
    ]),
  SPAWN_ROLE: (p) =>
    join([
      `новая роль «${str(p, "name") || "?"}»`,
      str(p, "system_prompt"),
    ]),
  /*
   * Аудит 2026-09-11: карточка отложенного поста не показывала, КОГДА он
   * выйдет. Печатались канал и текст, а `scheduledAt` — число, и общий путь
   * ниже (PREVIEW_FIELDS, затем «первое непустое строковое поле») числа
   * выбрасывает. Владельцу предлагали одобрить публикацию, не назвав срока:
   * «завтра в 10» и «через три недели» выглядели в очереди одинаково, а
   * ошибка модели в единицах времени была ненаблюдаема до самой публикации.
   * Тот же дефект, что у DELETE/PIN/FORWARD чуть ниже, и лечится так же.
   *
   * Срок идёт ПЕРВЫМ: выжимка режется по общему потолку длины с конца, и
   * длинный текст поста вытеснял бы именно его.
   */
  SCHEDULE_POST: (p) =>
    join([
      whenLabel(p, "scheduledAt"),
      str(p, "channel"),
      str(p, "content") || str(p, "text"),
    ]),
  // Аудит 2026-08-29: у DELETE/PIN/FORWARD в payload'е строк нет вовсе —
  // только числа и boolean'ы, а общий путь ниже берёт лишь строковые поля. То
  // есть карточка печаталась одной головой: «<uuid> orchestrator
  // DELETE_MESSAGE (создано 29.08 12:00)». Владельца просили одобрить
  // необратимое удаление, не назвав ни сообщения, ни чата. Ровно тот случай,
  // который шапка PREVIEW_BY_ACTION описывает для REVIEW_AND_MERGE_PR —
  // рендерер тогда добавили одному типу, а три с такой же формой пропустили.
  SEND_MESSAGE: (p) => join([ownerVoice(p), str(p, "text")]),
  EDIT_MESSAGE: (p) =>
    join([`правка сообщения ${num(p, "messageId")}`, str(p, "text")]),
  DELETE_MESSAGE: (p, c) =>
    join([
      ownerVoice(p),
      `удалить сообщение ${num(p, "messageId")}`,
      pinnedChatPart(p, "chatId", c, "в чате"),
    ]),
  PIN_MESSAGE: (p, c) =>
    join([
      `закрепить сообщение ${num(p, "messageId")}`,
      pinnedChatPart(p, "chatId", c, "в чате"),
    ]),
  FORWARD_MESSAGE: (p, c) =>
    join([
      `переслать сообщение ${num(p, "messageId")}`,
      // Оба конца пересылки пиннятся к чату заявки (dispatch/telegram.ts:441-442),
      // поэтому источник и назначение — один и тот же чат.
      pinnedChatPart(p, "fromChatId", c, "внутри чата"),
    ]),
  SET_REACTION: (p) =>
    join([
      ownerVoice(p),
      `реакция ${str(p, "emoji") || "?"} на сообщение ${num(p, "messageId")}`,
    ]),
  // Аудит 2026-09-10: та же форма и тот же разбор, что у DELETE/PIN/FORWARD
  // выше. `channelId` — число, а общий путь берёт только строковые поля,
  // поэтому в карточку попадал ровно текст поста: владелец видел, ЧТО
  // публикуют, и не видел, КУДА. Публикация необратима (правка — другое
  // действие, удаление — третье), каналов у команды несколько, и промах
  // мимо канала виден только постфактум подписчикам.
  //
  // Картинка — вторая половина той же дыры. К посту она идёт всегда, одним
  // сообщением: либо отрисованный баннер, либо чужой файл из `photoUrl` /
  // `photoBase64`. Ни одно из этих полей в общий список не входит («url»
  // входит, но ключ здесь `photoUrl`), так что в канал под именем команды
  // уходило изображение, о котором в заявке не было ни слова — включая
  // произвольный URL и произвольный base64, пришедшие от модели.
  //
  // Канал и картинка стоят ПЕРЕД текстом намеренно, вопреки общему правилу
  // «текст важнее адреса»: выжимка режется на 120 символах, а объём поста по
  // описанию тула — «полноценный, без искусственного ужимания». При обратном
  // порядке ни канал, ни картинка не влезут в карточку никогда. Соседний
  // SCHEDULE_POST печатает канал первым по той же причине.
  PUBLISH_TO_CHANNEL: (p) =>
    join([
      typeof p.channelId === "number" ? `канал ${p.channelId}` : "канал ?",
      coverNote(p),
      str(p, "text"),
    ]),
};

/**
 * Одна строка о том, что именно одобряют. Аппрув существует затем, чтобы
 * человек посмотрел на содержимое до необратимого действия; список без
 * содержимого («1a2b3c smm PUBLISH_TO_CHANNEL») делает его формальностью —
 * владелец жал /approve, не увидев ни строки будущего поста (аудит 2026-08-12).
 *
 * Переводы строк схлопываем: список построчный, и многострочная выжимка
 * ломала бы его формат.
 */
export function approvalPreview(
  actionType: string,
  payload: unknown,
  limit = 120,
  ctx: PreviewCtx = {},
): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "";
  }
  const p = payload as Record<string, unknown>;
  const pick = (): string => {
    const byAction = PREVIEW_BY_ACTION[actionType];
    if (byAction) {
      const s = byAction(p, ctx);
      if (s.trim()) return s;
    }
    for (const f of PREVIEW_FIELDS) {
      const v = p[f];
      if (typeof v === "string" && v.trim()) return v;
    }
    // Ничего знакомого — берём первую непустую строку, какая есть.
    for (const v of Object.values(p)) {
      if (typeof v === "string" && v.trim()) return v;
    }
    return "";
  };
  const flat = pick().replace(/\s+/g, " ").trim();
  if (!flat) return "";
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/**
 * Сколько нерешённых заявок висит в чате (или вообще, без chatId).
 *
 * Аудит 2026-08-20: `/approvals` печатал `listPendingApprovals` как есть, а тот
 * отдаёт двадцать самых старых. Потолок очереди — 10 на роль при двенадцати
 * ролях, то есть до 120 в одном чате; человек, глядя на ровно двадцать строк,
 * не мог отличить «это вся очередь» от «это её шестая часть», а невидимая
 * заявка тихо истекала по TTL.
 */
export function countPendingApprovalsInChat(
  chatId?: number,
  /** Роль-заказчик (`approvals.requested_by`). Аудит 2026-08-27: счётчик и
   * выдача обязаны фильтроваться ОДИНАКОВО, иначе хвост «и ещё N» считает не
   * ту очередь, которую показал. */
  requestedBy?: string,
): number {
  const conds = ["status = 'pending'"];
  const args: unknown[] = [];
  if (chatId !== undefined && chatId !== null) {
    conds.push("chat_id = ?");
    args.push(chatId);
  }
  if (requestedBy) {
    conds.push("requested_by = ?");
    args.push(requestedBy);
  }
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM approvals WHERE ${conds.join(" AND ")}`)
    .get(...args as never[]) as { n: number };
  return row.n;
}

/**
 * Момент создания самой старой нерешённой заявки (ms) или null, если очередь пуста.
 *
 * Аудит 2026-08-28: дайджест считал и то и другое через
 * `listPendingApprovals(undefined, 1000)` — то есть тянул до тысячи полных
 * строк с JOIN, чтобы взять из них длину массива и минимум по created_at.
 * Счётчик при этом упирался в 1000 и переставал расти ровно тогда, когда
 * очередь становится проблемой: в отчёте владельцу «pending: 1000» и на
 * тысяче, и на пяти тысячах. Фильтры те же, что у счётчика рядом.
 */
export function oldestPendingApprovalAt(chatId?: number, requestedBy?: string): number | null {
  const conds = ["status = 'pending'"];
  const args: unknown[] = [];
  if (chatId !== undefined && chatId !== null) {
    conds.push("chat_id = ?");
    args.push(chatId);
  }
  if (requestedBy) {
    conds.push("requested_by = ?");
    args.push(requestedBy);
  }
  const row = db
    .prepare(`SELECT MIN(created_at) AS at FROM approvals WHERE ${conds.join(" AND ")}`)
    .get(...args as never[]) as { at: number | null };
  return row.at ?? null;
}

export function listPendingApprovals(
  chatId?: number,
  limit = 20,
  /** Роль-заказчик (`approvals.requested_by`); см. countPendingApprovalsInChat. */
  requestedBy?: string,
): Approval[] {
  // T-546: LEFT JOIN agent_actions to surface request_id so the Mini App can
  // group approvals that came from one logical agent turn into one card.
  let sql = `${APPROVAL_SELECT} WHERE a.status = 'pending'`;
  const args: unknown[] = [];
  if (chatId !== undefined && chatId !== null) {
    sql += ` AND a.chat_id = ?`;
    args.push(chatId);
  }
  if (requestedBy) {
    sql += ` AND a.requested_by = ?`;
    args.push(requestedBy);
  }
  // Тай-брейк по rowid — см. listActions в audit.ts. Здесь он особенно нужен:
  // один ход агента заводит несколько карточек согласования подряд, а владелец
  // видит только первые `limit`.
  sql += ` ORDER BY a.created_at ASC, a.rowid ASC LIMIT ?`;
  args.push(limit);
  const rows = db.prepare(sql).all(...args as never[]) as ApprovalRow[];
  return rows.map(rowToApproval);
}

export function decideApproval(
  id: string,
  decision: "approved" | "rejected",
  decidedBy: string,
  reason?: string,
): Approval {
  const a = getApproval(id);
  if (!a) throw new Error(`approval not found: ${id}`);
  if (a.status !== "pending") {
    throw new Error(`approval ${id} already ${a.status}`);
  }
  const now = Date.now();
  // Аудит 2026-08-07: SELECT-проверка выше и UPDATE — два разных стейтмента.
  // Гейт `status = 'pending'` продублирован в WHERE, чтобы решение переводило
  // строку из pending ровно один раз. Иначе два одновременных «Approve»
  // (Telegram + Mini App) могли оба пройти проверку и оба дойти до
  // executeApproved — то есть выполнить необратимое действие дважды.
  const res = db.prepare(
    `UPDATE approvals
     SET status = ?, decided_by = ?, decided_at = ?, reason = ?
     WHERE id = ? AND status = 'pending'`,
  ).run(decision, decidedBy, now, reason ?? null, id);
  if (res.changes === 0) {
    const cur = getApproval(id);
    throw new Error(`approval ${id} already ${cur?.status ?? "gone"}`);
  }
  const updated = getApproval(id);
  if (!updated) throw new Error("failed to decide approval");
  // Аудит 2026-08-08: событие поднимал только HTTP-роут Mini App, то есть один
  // из двух входов. Решение через Telegram (`/approve`, `/reject` → commands.ts)
  // до открытой вкладки не доезжало: карточка оставалась «ожидает решения», и
  // владелец, нажав в ней Approve, получал «already approved». Место, где
  // строка меняет статус, ровно одно — здесь ему и место, как у
  // markApprovalFailed ниже.
  // Аудит 2026-09-11: решение меняло ТОЛЬКО эту таблицу. Строка действия,
  // заведённая гейтом в `pending_approval`, после отказа так и читалась «ждёт
  // аппрув» — навсегда (докблок `closeGatedActionRow`). Одобрение сюда не
  // входит: у него исход пишет своя строка через `dispatchAndAudit`.
  if (updated.status === "rejected") {
    closeGatedActionRow(
      updated.action_id,
      `отклонено: ${decidedBy}${reason ? ` — ${reason}` : ""}`,
    );
  }
  busEmit("approval.decided", { id: updated.id, status: updated.status });
  return updated;
}

/**
 * Одобрение прошло, исполнение упало → status='failed' + текст ошибки в reason.
 *
 * Аудит 2026-08-07: решение коммитилось ДО исполнения (и это правильно —
 * иначе краш между отправкой и записью дал бы повторную отправку), но при
 * падении строка так и оставалась `approved` с `reason=NULL`. То есть в БД
 * «одобрено и выполнено» и «одобрено, но не выполнено» выглядели одинаково:
 * ошибку видел только тот, кто в этот момент смотрел в чат или на 502 в
 * Mini App. Теперь провал виден в строке — `?status=failed` в /api/approvals.
 *
 * Возвращает null, если строка не в состоянии `approved` (гонка/повторный
 * вызов) — вызывающий уже возвращает ошибку пользователю, ронять его незачем.
 */
export function markApprovalFailed(id: string, error: string): Approval | null {
  const res = db.prepare(
    `UPDATE approvals SET status = 'failed', reason = ? WHERE id = ? AND status = 'approved'`,
  ).run(error.slice(0, 2000), id);
  if (res.changes === 0) return null;
  // Аудит 2026-09-10: у UPDATE_AGENT_PROMPT одобрение и применение — разные
  // шаги. Если исполнение упало ДО того, как обработчик проставил applied_at,
  // строка версии оставалась с обоими NULL, то есть неотличимой от ждущей
  // решения, и следующее одобрение того же текста стамповало её вместо новой
  // (докблок `closeAgentPromptProposals`). Если applied_at уже стоит, UPDATE
  // внутри ничего не меняет: условие требует обоих NULL.
  closeAgentPromptProposals([id]);
  const updated = getApproval(id);
  if (updated) {
    busEmit("approval.decided", { id: updated.id, status: updated.status });
  }
  return updated;
}
