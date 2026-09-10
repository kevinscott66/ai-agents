/**
 * Mini App backend REST API (C13a).
 *
 * HTTP-сервер на Bun.serve. Защищённые маршруты под /api/ требуют заголовка
 * X-Telegram-Init-Data: <raw> — initData из Telegram WebApp, проверяется
 * HMAC-ом по lib/miniapp-auth.ts. Исключение ровно одно: /api/events (SSE)
 * идёт до этой стены и аутентифицируется одноразовым билетом в query —
 * EventSource в браузере заголовков не умеет. Здесь было сказано «все», и
 * аудит по этому описанию проходил мимо второго входа.
 *
 * Маршруты: см. README/спецификация C13a.
 *
 * Сервер ничего не исполняет сам — только читает/мутирует data-layer.
 * После approve approval-action НЕ запускается здесь: текущий
 * action-dispatch.ts хука "выполнить после approve" не имеет (см. отчёт C13a).
 */
import { getErrorMessage } from "./errors.ts";
import { HOUR_MS } from "./time-constants.ts";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";

/** Constant-time string compare (length-masked) for secret/token checks. */
function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // still do a compare to avoid an early-exit length oracle
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}
import {
  createTask,
  getTask,
  listTasksByAssignee,
  listTasksByChat,
  updateTaskStatus,
  type TaskStatus,
} from "./tasks.ts";
import {
  getApproval,
  listPendingApprovals,
  decideApproval,
  markApprovalFailed,
  APPROVAL_STATUSES,
} from "./approvals.ts";
import { wikiList, wikiRead, wikiScopes, WIKI_LIST_MAX, type Scope } from "./memory.ts";
import {
  ACTION_LIST_COLUMNS,
  ACTION_STATUSES,
  getAction,
  isActionStatus,
  listActions,
  rowToAction,
  type AgentActionListRow,
  type AgentActionRow,
} from "./audit.ts";
import {
  getPermission,
  grantCaveat,
  grantIneffectiveReason,
  setPermission,
  getAutonomy,
  setAutonomy,
  ACTION_TYPES,
  type ActionType,
  type AutonomyMode,
  listAgentAutonomyOverrides,
  clearAutonomy,
} from "./permissions.ts";
import { db } from "./db.ts";
import { CHARACTERS } from "../characters/index.ts";
import {
  getAllBudgetSettings,
  getBudget,
  getDailyUsage,
  setBudget,
  todayUTC,
} from "./token-budget.ts";
import { dbStats, getSchedulerLastRun, isSchedulerDisabled } from "./db-maint.ts";
import {
  getBotTokenForAuth,
  type MiniAppUser,
} from "./miniapp-auth.ts";
import { emit as busEmit, subscribe as busSubscribe } from "./events-bus.ts";
import { isMacOnline } from "./mac-bridge.ts";
import {
  json,
  corsHeaders,
  applyCompressionAndEtag,
  applyCorsToResponse,
  pickAllowedOrigin,
  parseIntOr,
  strictChatId,
  consumeRateToken,
  clientIpKey,
  _resetRateLimiter,
  type RateLimitBucket,
  type RateLimitOpts,
} from "./http-utils.ts";
import { authOr401 as authOr401Mw } from "./auth-middleware.ts";
import { MiniAppSessionStore } from "./miniapp-session.ts";
import {
  isAllowlisted,
  parseUserIdList,
  warnIfEmptyAllowlist,
} from "./allowlist.ts";
import { issueSseTicket, redeemSseTicket } from "./sse-ticket.ts";
import { TASK_STATUSES, AUTONOMY_MODES } from "./types.ts";
import { log, redactUserId } from "./log.ts";
import { DEFAULT_MINIAPP_PORT } from "./constants.ts";
import { executeApproved, type ApprovalExecDeps } from "./commands.ts";
import { auditRejectedApproval } from "./dispatch/agent-prompt.ts";
import { canonicalAssignee } from "./dispatch/tasks.ts";
import { dispatchAndAudit, type DispatchCtx } from "./action-dispatch.ts";
import type { PayloadFor } from "./action-payload.ts";
import type { MacBridge } from "./dispatch/mac.ts";
import { renderMetrics } from "./miniapp-metrics.ts";

// Re-exports kept for backward compatibility with existing test imports
// (tests/c26-miniapp-e2e.test.ts imports these from miniapp-server.ts).
export {
  consumeRateToken,
  _resetRateLimiter,
  type RateLimitBucket,
  type RateLimitOpts,
};

/**
 * Тайм-аут простоя сокета, в секундах. 255 — потолок, который принимает Bun.
 *
 * Аудит 2026-08-13: его не задавали вовсе, и дефолт Bun (10 секунд) убивал
 * каждое SSE-соединение — подробный разбор у самого `Bun.serve` ниже.
 */
export const MINIAPP_IDLE_TIMEOUT_S = 255;

/**
 * Период `:ping` в SSE. Обязан быть заметно меньше тайм-аута простоя: между
 * событиями шины пинг — единственная запись в поток, и только он не даёт
 * сокету считаться простаивающим. Инвариант проверяется тестом.
 */
export const SSE_KEEPALIVE_MS = 25_000;

// T-311 — origin allowlist is centralised in http-utils.ts
// (parseAllowedOriginsEnv + pickAllowedOrigin). Both POST gating and the
// outgoing CORS header now consult the same list.

export interface MiniappHealthInfo {
  agentKey: string;
  alive: boolean;
  lastOkAt: number | null;
  consecutiveFailures: number;
}

export interface StartMiniappOpts {
  port?: number;
  allowedUserIds?: number[];
  adminUserIds?: number[];
  botToken?: string;
  /** Optional getter for active health snapshots (C22). */
  getHealth?: () => MiniappHealthInfo[] | null;
  /**
   * Резолверы, которыми исполняется одобренное действие (T-547). Без них
   * апрув в Mini App только переключал статус и ничего не запускал.
   *
   * Аудит 2026-08-12: тут был один `resolveTg`, а dispatch'у нужен ещё и
   * `resolveAgent` — без него одобренные CREATE_TEAM_CHANNEL и
   * DELEGATE_TO_ROLE падали на пустом ctx (см. ApprovalExecDeps).
   * Проставляется из orchestrator-team.ts, где живут боты.
   */
  approvalDeps?: ApprovalExecDeps;
  /** Test seam for the fixed /api/mac/stop route; production uses the bridge singleton. */
  macBridge?: MacBridge;
}

export interface MiniappServerHandle {
  stop: () => void;
  port: number;
}

// Аудит 2026-08-12: разбор такого CSV жил в двух местах и расходился (см.
// lib/allowlist.ts). Теперь одна реализация на оба входа.
function parseAdminIds(env: string | undefined): number[] {
  return parseUserIdList(env);
}

export function parseAllowedIds(env: string | undefined): number[] {
  return parseAdminIds(env);
}

/**
 * JSON-колонка → объект, без падения на битой строке: отдаём сырой текст под
 * ключом `raw`. Один writer с кривым JSON не должен прятать весь журнал.
 */
function safeParseJson(s: string | null): unknown {
  if (s === null || s === "") return null;
  try {
    return JSON.parse(s);
  } catch {
    return { raw: s };
  }
}

/**
 * Разбор query-параметра `chat_id` для GET-эндпоинтов.
 *
 * Аудит 2026-08-28. Все шесть чтений (`/api/tasks`, `/api/approvals` —
 * обе ветки, `/api/actions`, `/api/audit-logs`, `/api/autonomy`) писали
 * `Number(chatIdParam)` без единой проверки, тогда как оба мутирующих
 * POST-обработчика рядом (строки с `strictChatId(chatIdRaw)` и
 * `strictChatId(body.chat_id)`) давно валидируют то же самое. Расхождение и
 * есть баг: `Number("abc")` — это `NaN`, а `NaN` в SQLite не равен ничему,
 * включая себя, поэтому `WHERE chat_id = NaN` возвращает ноль строк. Клиент
 * получает `200 {"tasks": []}` — ответ, по которому опечатку в параметре
 * невозможно отличить от честного «в этом чате пусто».
 *
 * Хуже всех был `/api/autonomy`: `getAutonomy(NaN, agent)` не падает и не
 * возвращает пусто — проверки `chatId !== undefined` он проходит, строк со
 * `scope_id = 'NaN'` не находит и спокойно доходит до agent- или глобального
 * режима. Ответ приходит с настоящим `mode` и с `chat_id: NaN`, который
 * JSON.stringify печатает как `null`. То есть на вопрос «какой режим у чата
 * X» отдавался режим совсем другой области — и выглядел он как валидный
 * ответ про глобальный scope.
 *
 * Возвращает `undefined` для отсутствующего параметра, число — для
 * корректного, и `Response` 400 — для мусора. Пустая строка (`?chat_id=`)
 * считается мусором: клиент из `miniapp/src/lib/api.ts` ставит параметр
 * только через `if (params.chat_id != null)`, так что пустым он не приходит
 * ни с одного боевого экрана.
 */
function chatIdParam(url: URL): number | undefined | Response {
  const raw = url.searchParams.get("chat_id");
  if (raw === null) return undefined;
  const parsed = strictChatId(raw);
  if (parsed === null) {
    // Значение эхом — чтобы было видно, ЧТО именно не разобралось; обрезка на
    // 64 символа, чтобы длинная строка из запроса не уезжала в тело ответа.
    return json(
      { error: `bad query: chat_id must be an integer, got: ${raw.slice(0, 64)}` },
      400,
    );
  }
  return parsed;
}

/**
 * Значение курсора пагинации: пустое и пробельное считаются НЕ заданными.
 *
 * Аудит 2026-09-11: два соседних докблока (`/api/actions` и `/api/audit-logs`)
 * объявляют класс «молчаливая потеря фильтра» закрытым, а пустая строка сквозь
 * обе проверки проходила. `?before=` давал `Number("") === 0` — конечное, то
 * есть мимо валидации, — а следом `if (before && …)` оказывался ложным, и
 * ОБА компонента курсора (`before` и `before_id`) исчезали без единого
 * признака в ответе: клиент получал самую свежую страницу и дописывал её к
 * списку. `?before=%20` доходил дальше и давал `created_at < 0`, то есть
 * пустую страницу и «конец списка» посреди журнала.
 *
 * Пустое значение — это отсутствие курсора, а не курсор в нуле, поэтому оно
 * нормализуется в `null` и дальше живёт по правилам «параметра не было».
 * Отвечать на него 400 нельзя: `?before_id=` — законный способ клиента сказать
 * «страница первая».
 */
function cursorParam(url: URL, name: string): string | null {
  const raw = url.searchParams.get(name);
  if (raw === null) return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Build the agents list (with health snapshots + paused flags) used by
 * /api/dashboard and /api/agents.
 */
/** Полночь UTC — запасной отсчёт «сегодня», когда клиент не прислал свой. */
function startOfUtcDay(): number {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function buildAgentsList(healthArr: MiniappHealthInfo[] | null) {
  const healthByKey = new Map<string, MiniappHealthInfo>();
  if (healthArr) {
    for (const h of healthArr) healthByKey.set(h.agentKey, h);
  }
  const pausedRows = db
    .prepare(`SELECT agent_key, paused FROM agent_states`)
    .all() as { agent_key: string; paused: number }[];
  const pausedByKey = new Map<string, boolean>();
  for (const r of pausedRows) pausedByKey.set(r.agent_key, !!r.paused);
  return CHARACTERS.map((c) => {
    const h = healthByKey.get(c.key);
    const paused = pausedByKey.get(c.key) ?? false;
    return {
      key: c.key,
      title: c.name,
      provider: "internal",
      execution_state: paused ? "paused" : h?.alive === false ? "unavailable" : "running",
      status: paused ? "paused" : "running",
      paused,
      health: h
        ? {
            alive: h.alive,
            lastOkAt: h.lastOkAt,
            consecutiveFailures: h.consecutiveFailures,
          }
        : null,
    };
  });
}

/**
 * Build the per-agent daily token-budget list used by /api/dashboard and
 * /api/budgets. Reset timestamp points at next UTC midnight.
 */
function buildBudgetsList() {
  const now = new Date();
  const tomorrow = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0, 0, 0, 0,
  ));
  const resetAt = tomorrow.getTime();
  const date = todayUTC();
  return CHARACTERS.map((c) => {
    const usage = getDailyUsage(c.key, date);
    const limit = getBudget(c.key);
    return {
      agentKey: c.key,
      usedTokens: usage.input,
      outputTokens: usage.output,
      limit: Number.isFinite(limit) ? limit : null,
      resetAt,
    };
  });
}

// T-320 Prometheus metrics rendering lives in ./miniapp-metrics.ts.
// Re-exported here for backward-compatible imports (tests/t320-metrics.test.ts).
export { renderMetrics };

export function startMiniappServer(
  opts: StartMiniappOpts = {},
): MiniappServerHandle {
  const port = opts.port ?? DEFAULT_MINIAPP_PORT;
  const allowedUserIds = opts.allowedUserIds ?? [];
  const adminUserIds =
    opts.adminUserIds ?? parseAdminIds(process.env.MINIAPP_ADMIN_USER_IDS);
  const botToken = opts.botToken ?? getBotTokenForAuth();
  const approvalDeps = opts.approvalDeps ?? {};
  const macBridge = opts.macBridge;
  const sessionStore = new MiniAppSessionStore();

  /**
   * Кто пришёл, когда заголовка нет. Строку лога uid=… собирает обёртка по
   * `x-telegram-init-data`, а поток теперь входит по билету — без этой подсказки
   * все SSE-подключения писались бы как `uid=-`, то есть аудит потерял бы
   * ровно тот канал, ради безопасности которого всё и затевалось.
   */
  const uidHint = new WeakMap<Request, number>();
  const pendingSession = new WeakMap<Request, string>();
  /**
   * Аудит 2026-08-20: запросы, отбитые СТЕНОЙ аутентификации, не попадали ни в
   * одно ведро, если стена вернула 403.
   *
   * Ретроспективный счёт ниже смотрит только на `resp.status === 401`, а
   * `authOr401` отдаёт 403, когда подпись верна, но пользователя нет в
   * аллоу-листе. Это ровно посторонний: initData ему выдаёт Telegram при
   * первом же открытии Mini App и живёт оно сутки. Ни анонимного ведра (для
   * /api/ путей `preAuth` false), ни пользовательского (вёдра стоят ЗА стеной)
   * — то есть неограниченный поток, каждый заход в котором считает два
   * HMAC-SHA256 в том же потоке, где живут SQLite и все 12 ботов. Это тот же
   * дефект, который уже чинили для 401, просто с другим кодом ответа.
   *
   * Обоснование «403 приходят уже от аутентифицированного клиента, у него своё
   * ведро» верно для отказов `requireAdmin` (тот пользователь аллоу-лист прошёл
   * и токен уже потратил) и неверно для отказа самого аллоу-листа. Поэтому
   * различаем не по коду, а по месту: помечаем именно отбой на стене.
   */
  const wallRejected = new WeakSet<Request>();

  /** Открытые SSE-потоки на пользователя — см. комментарий в /api/events. */
  const sseConns = new Map<number, number>();
  const SSE_MAX_PER_USER = 5;

  function authOr401(
    req: Request,
    url: URL,
  ):
    | { ok: true; user: MiniAppUser }
    | { ok: false; resp: Response } {
    const result = authOr401Mw(req, url, {
      botToken,
      allowedUserIds,
      mutation: req.method.toUpperCase() === "POST",
      sessionStore,
    });
    if (result.ok && result.sessionToken) pendingSession.set(req, result.sessionToken);
    // Аудит 2026-08-21: отказ по аллоу-листу уходит ДО строки uidHint.set()
    // ниже по маршруту, поэтому в access-логе стоял `uid=-` — неотличимо от
    // запроса с подделанной подписью. Но подпись тут как раз сошлась: это
    // отказ известному человеку. Ставим hint здесь, у самого решения.
    // На 401 поля `user` нет by design — правило «id только из проверенного
    // источника» (аудит 2026-08-13) остаётся в силе.
    if (!result.ok && result.user) uidHint.set(req, result.user.id);
    return result;
  }

  function isAdmin(user: MiniAppUser): boolean {
    // Аудит 2026-08-04: пустой список админов — fail-closed, и это правильно, но
    // молча. Все восемь мутирующих ручек отвечают 403 навсегда, а причина нигде
    // не видна: у allowlist предупреждение есть (warnIfEmptyAllowlist), у
    // админов не было. Плюс env-фоллбэк в самом сервере мёртв — services.ts
    // всегда передаёт массив, а `[] ?? …` оставляет `[]`.
    warnIfEmptyAllowlist("MINIAPP_ADMIN_USER_IDS", adminUserIds);
    return adminUserIds.length > 0 && adminUserIds.includes(user.id);
  }

  /**
   * Ключ роли из тела запроса. Роуты pause/resume и cmdGrant сверяли его с
   * CHARACTERS, а /api/permissions, /api/budgets и агентская ветка
   * /api/autonomy — нет. Опечатка возвращала 200 с эхом «право применено», а
   * evaluateGate искал agent_key='backend' и строки 'Backend' не видел никогда:
   * молчаливый no-op, который админу показывают как успех.
   */
  function badAgentKey(key: string): Response | null {
    if (CHARACTERS.some((c) => c.key === key)) return null;
    return json({ error: `unknown agentKey: ${key}` }, 400);
  }

  function requireAdmin(user: MiniAppUser): Response | null {
    if (!isAdmin(user)) {
      return json({ error: "admin only" }, 403);
    }
    return null;
  }

  /**
   * MINIAPP_ALLOWED_USER_IDS и MINIAPP_ADMIN_USER_IDS — разные списки, и код
   * это предполагает: мутирующие ручки требуют админа, читающие — только
   * allowlist. То есть «наблюдатель без прав» — предусмотренная роль.
   *
   * Проблема была в том, что наблюдателю доставался не метаданный, а
   * СОДЕРЖАТЕЛЬНЫЙ слой: agent_actions.payload/result и approvals.payload
   * никогда никем не редактировались. Конкретно оттуда читались тексты
   * исходящих SEND_MESSAGE по всем чатам, целиком тело WRITE_WIKI, промпты и
   * пути проектов MAC_RUN_CLAUDE, а из result у LIST_RECENT_MESSAGES —
   * дословная входящая переписка чатов, в которых наблюдателя нет.
   * chat_id при этом фильтр, а не ограничение: без параметра отдавалось всё.
   *
   * Резать роут целиком нельзя — Logs/Dashboard тогда пустеют у всех, кроме
   * админа, а это уже продуктовое решение. Поэтому режем ровно поля с
   * контентом: списки остаются видимы (кто, что, когда, чем кончилось),
   * тела — нет.
   *
   * Списки полей ниже — именованные константы, а не литералы по месту вызова.
   * Первый заход правил ровно два поля у двух роутов, и повторный аудит
   * 2026-08-04 нашёл ровно то, что списком литералов и ловится плохо:
   *   • `error` не редактировался нигде, хотя это свободный текст от
   *     хендлеров (Telegram эхом возвращает текст сообщения, SPLIT_TASK
   *     склеивает причины отказов, QUERY_DB — фрагменты SQL). Хуже: строка
   *     всё равно помечалась `redacted:true` и ВЫГЛЯДЕЛА очищенной;
   *   • задачи не редактировались вовсе, а C15 self-diag кладёт провалившийся
   *     payload в `inputPayload` → `tasks.input`. То есть payload, скрытый в
   *     /api/actions, отдавался целиком через /api/tasks двумя строками ниже.
   *
   * `description` у задач тоже режется: отличить осмысленное описание от
   * `description: res.error` (action-dispatch.ts, C15) на выходе невозможно.
   * Доска остаётся читаемой по title/status/assignee/срокам.
   */
  const REDACTED_NOTE = "(скрыто: доступно администратору)";
  const ACTION_CONTENT_FIELDS = ["payload", "result", "error"];
  const APPROVAL_CONTENT_FIELDS = ["payload", "reason"];
  const TASK_CONTENT_FIELDS = ["input", "output", "description", "error"];

  /**
   * Аудит 2026-08-21: кроме тел наружу уезжал сырой Telegram-ID человека.
   *
   * `tasks.created_by` и `approvals.decided_by` пишутся как
   * `miniapp:<telegram id>` (POST /api/tasks и /api/approvals/:id/decide
   * ниже), и в списках отдавались как есть — то есть наблюдатель, которому
   * тела уже закрыли, получал личный ID администратора. По нему открывается
   * профиль (`t.me/{id}`), это ровно та утечка, которую закрывает #457 для
   * `budget_settings.updated_by`.
   *
   * Резать поле целиком нельзя: политика модуля выше — «списки остаются
   * видимы (кто, что, когда, чем кончилось)». Поэтому не прячем, а
   * укорачиваем до последних четырёх цифр, как уже делает `redactUserId` в
   * lib/log.ts: «кто» различимо, восстановить ID нельзя.
   *
   * Правило по ЗНАЧЕНИЮ, а не по списку имён полей, и это осознанно. Список
   * полей ровно один раз уже отстал от кода (см. `error` и `tasks` в докблоке
   * выше), а формат `miniapp:<цифры>` однозначен: строка такого вида — всегда
   * актор-человек и никогда не содержательное поле. Ключи ролей (`smm`) и
   * системные акторы (`system:gc`) не совпадают с шаблоном и проходят
   * нетронутыми.
   *
   * Флаг `redacted` при этом НЕ ставится: он означает «тело скрыто», а тело
   * здесь на месте.
   *
   * Аудит 2026-09-11: у `approvals.decided_by` писателя ДВА, а шаблон знал
   * одного. Mini App кладёт `miniapp:<id>` (ручка decide ниже), а `/approve` и
   * `/reject` в Telegram — `deciderIdentity` (admin-commands.ts:172), то есть
   * `tg:<id> (@username)`. Второй формат проходил насквозь, и утечка
   * восстанавливалась целиком: `GET /api/approvals?status=approved` админа не
   * требует (читалки живут на allowlist, см. докблок про наблюдателя ниже),
   * так что наблюдатель, которому тела уже закрыли, читал сырой Telegram-ID
   * владельца — ровно то, что закрывал этот код для Mini App.
   *
   * Приписка `(@username)` уходит вместе с цифрами: `t.me/<username>`
   * открывает тот же профиль, что и `t.me/<id>`, и прятать одну половину
   * личности, оставляя вторую, смысла нет. `tg:unknown` (id у апдейта не
   * было) шаблону не соответствует и проходит как есть — прятать там нечего.
   */
  const RAW_MINIAPP_ACTOR = /^miniapp:(\d+)$/;
  const RAW_TG_ACTOR = /^tg:(\d+)(?: \(.*\))?$/;

  function shortenActor(v: unknown): string | null {
    if (typeof v !== "string") return null;
    const mini = v.match(RAW_MINIAPP_ACTOR);
    if (mini) return `miniapp:\u2026${mini[1].slice(-4)}`;
    const tg = v.match(RAW_TG_ACTOR);
    return tg ? `tg:\u2026${tg[1].slice(-4)}` : null;
  }

  function redactContent<T>(user: MiniAppUser, rows: T[], fields: string[]): T[] {
    if (isAdmin(user)) return rows;
    return rows.map((r) => {
      if (!r || typeof r !== "object") return r;
      const out = { ...(r as Record<string, unknown>) };
      let hit = false;
      for (const f of fields) {
        if (out[f] !== undefined && out[f] !== null && out[f] !== "") {
          out[f] = REDACTED_NOTE;
          hit = true;
        }
      }
      if (hit) out.redacted = true;
      for (const [k, v] of Object.entries(out)) {
        const short = shortenActor(v);
        if (short !== null) out[k] = short;
      }
      return out as T;
    });
  }

  /**
   * Строка списка действий: тело не читаем, но и не делаем вид, что его нет.
   *
   * Аудит 2026-08-29: оба списка действий — `GET /api/actions` и блок дашборда
   * — собирались как `SELECT id`, а следом `getAction` на КАЖДУЮ строку, то
   * есть `SELECT *` до двухсот раз за запрос. Тела при этом разбирались
   * `JSON.parse` и тут же затирались `redactContent` — работа ради
   * выброшенного результата, и ровно то, что запрещает инвариант
   * `lib/audit.ts` («список — метаданные, точечное чтение — с телами»). В
   * прошлый раз его починили только в `listActions`; здесь он остался.
   *
   * Заглушка встаёт ровно там, где раньше стояло непустое тело: дальше
   * `redactContent` делает с ней то же самое, что делал с настоящим payload,
   * поэтому ответ наблюдателя не меняется ни на байт — включая `redacted`.
   */
  function actionListItem(row: AgentActionListRow): Record<string, unknown> {
    const { has_payload, has_result, ...rest } = row;
    return {
      ...rest,
      payload: has_payload ? REDACTED_NOTE : null,
      result: has_result ? REDACTED_NOTE : null,
    };
  }

  /**
   * Bearer METRICS_TOKEN — предъявлен и совпал.
   *
   * Незаданный токен = «нет», а не «всем можно»: иначе забытая переменная
   * открывала бы детали наружу. Сравнение constant-time (SEC re-audit
   * 2026-06-10).
   *
   * Здесь было «единственное место в репо, где сравнивается секрет» — неверно:
   * второе живое сравнение у MAC_BRIDGE_SECRET (lib/mac-bridge.ts:secretsEqual,
   * своя реализация с другим поведением на разной длине). Обе корректны по
   * timing, но правка политики «в единственном месте» вторую не затронет.
   */
  function hasMetricsToken(req: Request): boolean {
    const token = process.env.METRICS_TOKEN;
    if (!token) return false;
    const m = (req.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
    return !!m && constantTimeEqual(m[1], token);
  }

  async function readJson(req: Request): Promise<any> {
    try {
      return await req.json();
    } catch {
      return null;
    }
  }

  /**
   * Потолок для того, что обслуживается ДО стены аутентификации: статика,
   * OPTIONS, /healthz, /readyz, /metrics. Рейт-лимит по user.id туда по
   * определению не дотягивается, и повторный аудит 2026-08-04 это подтвердил
   * живьём: 400 неаутентифицированных GET /assets/index-*.js → все 200, ни
   * одного 429, при том что каждый делает arrayBuffer + Bun.hash + gzipSync
   * синхронно в потоке, которому принадлежит SQLite. Те же 300 запросов на
   * /readyz — и каждый дёргает БД.
   *
   * Ведро широкое: холодная загрузка Mini App — это index.html плюс десяток
   * ассетов, а probe'ы systemd/nginx стучатся раз в несколько секунд.
   */
  /**
   * `denyOnOverflow` — только здесь: число ключей этого ведра задаёт тот, кто
   * шлёт запросы (ключ = адрес клиента), а у вёдер по user.id оно ограничено
   * allowlist'ом. Подробнее — HARD_MAX_BUCKETS в http-utils.ts.
   */
  const ANON_LIMIT: RateLimitOpts = {
    capacity: 300,
    refillPerSec: 20,
    denyOnOverflow: true,
  };

  /**
   * Ведро GET'ов, заведомо шире POST-ного: Dashboard шлёт 5 запросов одним
   * Promise.all, а страницы с живыми подписками перезагружаются по SSE. Их
   * всплески схлопывает коалесер (miniapp/src/lib/coalesce.ts), но ведущий
   * запрос каждого окна всё равно приходит сюда. Константа общая, потому что берут
   * из этого ведра два места — общая ветка ниже и /api/events, который стоит
   * выше стены и до той ветки не доходит.
   */
  const GET_LIMIT: RateLimitOpts = { capacity: 120, refillPerSec: 4 };

  function anonLimit(req: Request, peer: string | null): Response | null {
    const key = clientIpKey(req.headers.get("x-forwarded-for"), peer);
    const rl = consumeRateToken(key, ANON_LIMIT);
    if (rl.ok) return null;
    return json({ error: "rate_limited", retryAfter: rl.retryAfter }, 429, {
      "retry-after": String(rl.retryAfter),
    });
  }

  async function route(
    req: Request,
    url: URL,
    peer: string | null,
  ): Promise<Response> {
    const path = url.pathname;
    const method = req.method.toUpperCase();

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // T-411 — liveness probe. NEVER touches DB or external deps. Returns 200
    // as long as the event loop responds. Use this for systemd/Docker/nginx
    // restart decisions where a hung deep-check would cause flapping.
    if (path === "/healthz" && method === "GET") {
      return json({ ok: true, ts: Date.now() });
    }
    // Backward-compat alias. Keeps legacy `mac_online` field (T-411 design).
    //
    // Аудит 2026-08-12: `mac_online` — тот же факт, что `checks.mac_bridge`,
    // который 2026-08-08 убрали из публичного ответа /readyz (обоснование —
    // ниже, у самой ручки). Хардening применили к одному из двух путей к
    // одному сигналу: этот алиас так и отдавал «поднят ли мост к Mac
    // владельца» кому угодно одним GET без заголовков.
    //
    // `ok`/`ts` и код ответа не трогаем — на них построены зонды. Поле видит
    // тот, кто уже свой: Mini App шлёт initData на каждый запрос (см.
    // miniapp/src/lib/api.ts), мониторинг — METRICS_TOKEN, как в /metrics.
    if (path === "/api/health" && method === "GET") {
      const known =
        hasMetricsToken(req) || authOr401(req, url).ok;
      return json({
        ok: true,
        ts: Date.now(),
        ...(known ? { mac_online: isMacOnline() } : {}),
      });
    }

    // T-320: Prometheus metrics endpoint.
    // Auth: METRICS_TOKEN Bearer. Unset env → 503 fail-closed.
    //
    // Аудит 2026-08-27: заголовки кэша здесь ставятся руками, потому что это
    // единственный ответ сервера, зависящий от credential'а и НЕ проходящий
    // через json(). Аудит 2026-08-20 закрыл ровно эту дыру для JSON-ручек
    // (/readyz, /api/health, /api/actions отдают разное предъявителю токена и
    // анониму) — и мимо него прошла та, у которой разница максимальная: без
    // Bearer тут 401, с Bearer — вся телеметрия процесса. Ответ был GET+200
    // без cache-control, с ETag и `Vary: Origin`: общий кэш (перед nginx с
    // 2026-08-19 стоит Cloudflare) вправе сложить ответ монторинга и отдать
    // его следующему анониму — ключ совпал, про Authorization ему не сказали.
    // `Vary` дополняется в applyCorsToResponse через mergeVary, так что Origin
    // тут писать не нужно — он приедет сам и не затрёт Authorization.
    if (path === "/metrics" && method === "GET") {
      const METRICS_HEADERS = {
        "cache-control": "private, no-store",
        vary: "Authorization",
      };
      const token = process.env.METRICS_TOKEN;
      if (!token) {
        return new Response("metrics disabled: METRICS_TOKEN unset", {
          status: 503,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            ...METRICS_HEADERS,
          },
        });
      }
      if (!hasMetricsToken(req)) {
        return new Response("unauthorized", {
          status: 401,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            ...METRICS_HEADERS,
          },
        });
      }
      return new Response(renderMetrics(), {
        status: 200,
        headers: {
          "content-type": "text/plain; version=0.0.4; charset=utf-8",
          ...METRICS_HEADERS,
        },
      });
    }

    // T-411 — readiness probe with deep checks. Returns 503 if any subsystem
    // is degraded. Fail-closed: any uncertainty → not ready.
    if (path === "/readyz" && method === "GET") {
      const checks: Record<string, string> = {};
      let ok = true;

      // DB ping.
      try {
        const row = db.prepare("SELECT 1 AS v").get() as { v: number } | undefined;
        if (row && row.v === 1) {
          checks.db = "ok";
        } else {
          checks.db = "fail";
          ok = false;
        }
      } catch (e: any) {
        // /readyz отвечает БЕЗ аутентификации (проверка идёт до authOr401), а
        // ошибки bun:sqlite содержат абсолютный путь к файлу БД — то есть
        // раскладку деплоя. Наружу — константа, подробности в лог.
        log.warn("[readyz] db check failed", { err: getErrorMessage(e) });
        checks.db = "fail";
        ok = false;
      }

      // Mac bridge: best-effort env+presence check (no socket probe — see T-303).
      try {
        checks.mac_bridge = isMacOnline() ? "ok" : "offline";
        // Offline is informational, not a readiness failure: bridge is optional.
      } catch {
        checks.mac_bridge = "unknown";
      }

      // Scheduler last-run window — fail if > 2h ago (gcStaleTasks every 30 min).
      const STALE_THRESHOLD_MS = 2 * HOUR_MS;
      const last = getSchedulerLastRun();
      if (last == null && isSchedulerDisabled()) {
        // DB_MAINT_ENABLED=false — обслуживание выключено осознанно. Проверка
        // здесь означает «таймер заклинил»; при выключенном планировщике
        // заклинивать нечему, и держать процесс в бессрочном 503 не за что
        // (аудит 2026-08-20, подробности в db-maint.ts у _schedulerDisabled).
        // Значение видно в checks, так что «почему не идёт GC» не теряется.
        checks.scheduler = "disabled";
      } else if (last == null) {
        checks.scheduler = "never";
        ok = false;
      } else {
        const ageMs = Date.now() - last;
        if (ageMs > STALE_THRESHOLD_MS) {
          checks.scheduler = `stale-${Math.round(ageMs / 1000)}s`;
          ok = false;
        } else {
          checks.scheduler = "ok";
        }
      }

      // Anthropic API key — env presence only, no network call.
      checks.anthropic_key = process.env.ANTHROPIC_API_KEY ? "present" : "missing";
      if (!process.env.ANTHROPIC_API_KEY) ok = false;

      // OpenAI key — env presence (informational; designer has SVG fallback).
      checks.openai_key = process.env.OPENAI_API_KEY ? "present" : "missing";

      // Аудит 2026-08-08: /readyz отвечает БЕЗ аутентификации (иначе systemd и
      // nginx не смогут им пользоваться), а Mini App висит на публичном
      // https://agents.example.com:8443 — то есть `checks` читал кто угодно
      // из интернета. Наружу уходило: заведён ли ANTHROPIC_API_KEY и
      // OPENAI_API_KEY, поднят ли mac-bridge и сколько секунд назад отработал
      // планировщик. Это готовая карта для того, кто выбирает момент и цель.
      //
      // Код ответа остаётся прежним для всех — на нём построены решения о
      // рестарте, ломать их нельзя. Подробности — только предъявителю
      // METRICS_TOKEN, тем же ключом, что и /metrics.
      return json(hasMetricsToken(req) ? { ok, checks } : { ok }, ok ? 200 : 503);
    }

    // SSE stream (M2). EventSource не умеет заголовки, поэтому вход сюда — по
    // одноразовому билету из POST /api/sse-ticket (см. lib/sse-ticket.ts).
    // Раньше здесь принимался `?initData=`: суточный credential ко ВСЕМ /api/*
    // в query-строке, которую пишет access-лог nginx. Билет живёт 30 секунд,
    // гаснет при первом предъявлении и не открывает ничего, кроме потока.
    if (path === "/api/events" && method === "GET") {
      const sseUser = redeemSseTicket(url.searchParams.get("ticket"));
      if (sseUser === null) {
        return json({ error: "invalid or expired ticket" }, 401);
      }
      // Билет предъявлен и погашен — id проверен, ставим hint до любых
      // отказов ниже (аудит 2026-08-21: отказ по списку логировался как
      // `uid=-`, то есть как аноним).
      uidHint.set(req, sseUser);
      // Аллоу-лист мог измениться между выдачей билета и подключением, а поток
      // висит часами — проверяем на входе, а не только при выдаче.
      if (!isAllowlisted(sseUser, allowedUserIds)) {
        return json({ error: "user not allowed" }, 403);
      }

      // SSE идёт до auth-стены с рейт-лимитом (у него своя аутентификация),
      // поэтому счёт соединений держим здесь. Каждое соединение — слушатель в
      // глобальном Set шины и свой 25-секундный интервал, а emit() обходит
      // слушателей СИНХРОННО в том же потоке, что обслуживает HTTP и владеет
      // SQLite. Тысяча брошенных соединений (cleanup висит на req.signal,
      // клиент может его не закрывать) превращает каждое действие агента в
      // тысячу enqueue. Клиент открывает ровно один EventSource, так что
      // потолок нужен только на гонки переподключения.
      const sseUserId = sseUser;

      // Потолок соединений ограничивает ОДНОВРЕМЕННОСТЬ, но не частоту: цикл
      // open→abort проходит его насквозь, а каждый заход считает HMAC по
      // initData, подписывается на шину и заводит интервал. Замер при
      // повторном аудите: 500 последовательных циклов за 131 мс, все 200.
      // Поэтому здесь же снимаем токен из общего GET-ведра пользователя —
      // того самого, до которого маршрут не доходит, стоя выше стены.
      const sseRl = consumeRateToken(`get:${sseUserId}`, GET_LIMIT);
      if (!sseRl.ok) {
        return json({ error: "rate_limited", retryAfter: sseRl.retryAfter }, 429, {
          "retry-after": String(sseRl.retryAfter),
        });
      }

      const openNow = sseConns.get(sseUserId) ?? 0;
      if (openNow >= SSE_MAX_PER_USER) {
        log.warn("miniapp SSE: per-user connection cap hit", {
          // Аудит 2026-08-28: единственное место во всём файле, где telegram
          // user_id уезжал в лог целиком. Access-лог строкой ниже гонит его
          // через redactUserId, и вся остальная диагностика — тоже; здесь
          // достаточно тех же последних четырёх цифр, чтобы отличить упершегося
          // в лимит пользователя от соседа.
          userId: redactUserId(sseUserId),
          open: openNow,
        });
        return json({ error: "too_many_streams", retryAfter: 5 }, 429, {
          "retry-after": "5",
        });
      }
      sseConns.set(sseUserId, openNow + 1);

      // Уборка объявлена снаружи start(), потому что дёргать её должен не
      // только abort. Отписка от шины, интервал и счётчик соединений — это
      // ресурсы процесса, а `req.signal` — единственная ниточка, за которую
      // их держали: не сработал он (нет сигнала в этой сборке рантайма,
      // соединение оборвал не клиент, а прокси) — и подписка живёт до
      // рестарта, а пользователь навсегда упирается в потолок и получает
      // "too_many_streams" вместо живых обновлений. Теперь то же самое
      // вызывают cancel() потока и первая же неудачная запись.
      let cleanup = () => {};

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder();
          let closed = false;
          const safeEnqueue = (chunk: string) => {
            if (closed) return;
            try {
              controller.enqueue(enc.encode(chunk));
            } catch (e) {
              // Запись в закрытый поток означает, что читателя уже нет.
              // Молча проглотить — оставить мёртвую подписку, которая на
              // каждом действии агента будет сериализовать payload в никуда.
              //
              // Что этот catch НЕ ловит (проверено замером 2026-08-20, а не
              // рассуждением): клиента, который держит соединение открытым и
              // перестал читать — уснувший телефон, зависшая вкладка, прокси
              // с мёртвым апстримом. Поток при этом не закрыт, enqueue не
              // бросает, и увидеть отставание через `controller.desiredSize`
              // тоже нельзя: Bun вычитывает ReadableStream жадно в свой
              // сокетный буфер, так что при ByteLengthQueuingStrategy(1 МиБ)
              // desiredSize остаётся равным потолку даже после 8 МиБ,
              // отправленных не читающему клиенту. Так что «неудачная запись
              // снимает мёртвую подписку» верно ровно для честно
              // отвалившегося клиента; на застрявшего работают только
              // req.signal / cancel(), когда соединение действительно рвётся.
              log.debug("miniapp SSE: enqueue after stream closed", { e: String(e) });
              cleanup();
            }
          };
          const unsub = busSubscribe((e) => {
            const data = JSON.stringify(e.payload ?? null);
            safeEnqueue(`event: ${e.name}\ndata: ${data}\n\n`);
          });

          const keepalive = setInterval(() => {
            safeEnqueue(`:ping\n\n`);
          }, SSE_KEEPALIVE_MS);
          if (typeof (keepalive as any).unref === "function") {
            (keepalive as any).unref();
          }

          cleanup = () => {
            if (closed) return; // счётчик должен уменьшиться ровно один раз
            closed = true;
            const left = (sseConns.get(sseUserId) ?? 1) - 1;
            if (left > 0) sseConns.set(sseUserId, left);
            else sseConns.delete(sseUserId);
            clearInterval(keepalive);
            unsub();
            try {
              controller.close();
            } catch (e) {
              log.debug("miniapp SSE: controller.close() threw", { e: String(e) });
            }
          };

          // Первая запись идёт после того, как уборка собрана: клиенту она
          // нужна, чтобы флашнуть заголовки, но если поток уже мёртв, её
          // провал должен снять подписку и счётчик, а не заглушку.
          safeEnqueue(`:ok\n\n`);

          const signal = req.signal;
          if (signal) {
            if (signal.aborted) cleanup();
            else signal.addEventListener("abort", cleanup, { once: true });
          }
        },
        cancel() {
          // Читатель отвалился — рантайм говорит об этом здесь, даже когда
          // abort-сигнала не будет вовсе.
          cleanup();
        },
      });

      return new Response(stream, {
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
          ...corsHeaders(),
        },
      });
    }

    if (!path.startsWith("/api/")) {
      return json({ error: "not found" }, 404);
    }

    // Auth wall.
    const auth = authOr401(req, url);
    if (!auth.ok) {
      wallRejected.add(req);
      return auth.resp;
    }
    const user = auth.user;
    // Единственный проверенный источник id для строки access-лога (вторая
    // точка — SSE-билет выше). Ставится сразу за стеной, чтобы не зависеть от
    // того, какая ручка отработала дальше.
    uidHint.set(req, user.id);

    // M4 / T-311 — origin check on POST. If the request carries an Origin
    // header (browser-originated), it must be in the configured allowlist
    // (MINIAPP_ALLOWED_ORIGINS, or the localhost dev default). Telegram
    // WebApp's tgWebAppData flow does not send Origin, so non-browser
    // initData callers continue to work.
    if (method === "POST") {
      const reqOrigin = req.headers.get("origin");
      if (reqOrigin && pickAllowedOrigin(reqOrigin) === null) {
        return json({ error: "origin not allowed" }, 403);
      }
      // M4 — per-user rate limit on POST endpoints.
      const rl = consumeRateToken(user.id);
      if (!rl.ok) {
        return json(
          { error: "rate_limited", retryAfter: rl.retryAfter },
          429,
          { "retry-after": String(rl.retryAfter) },
        );
      }
    } else {
      // Лимит был только на POST, а дорогие ручки здесь как раз GET:
      // /api/tasks и /api/actions делают выборку до 200 строк с JSON.parse
      // каждой, а Bun.serve однопоточный и делит поток с SQLite — то есть
      // цикл GET'ов подвешивает и Mini App, и всех 12 ботов.
      //
      // Ведро отдельное (ключ с префиксом `get:`) и заведомо шире POST-ного:
      // Dashboard шлёт 5 запросов одним Promise.all, Agents — по одному на
      // каждую из 12 ролей, Tasks перезагружается на каждое SSE-событие.
      // С общим ведром на 20 токенов обычная навигация ловила бы 429.
      const rl = consumeRateToken(`get:${user.id}`, GET_LIMIT);
      if (!rl.ok) {
        return json(
          { error: "rate_limited", retryAfter: rl.retryAfter },
          429,
          { "retry-after": String(rl.retryAfter) },
        );
      }
    }

    // POST /api/sse-ticket — обменять initData (заголовком) на одноразовый
    // билет для EventSource. Стоит ПОСЛЕ стены осознанно: так билет наследует
    // и аллоу-лист, и origin-проверку, и POST-рейт-лимит — цикл
    // переподключения упрётся в общее ведро пользователя, а не заведёт себе
    // отдельный обход.
    if (path === "/api/sse-ticket" && method === "POST") {
      return json(issueSseTicket(user.id));
    }

    // POST /api/mac/stop — the Mini App's emergency Mac kill switch.
    // The action type and payload are fixed in code: HTTP cannot choose an
    // arbitrary dispatcher action or provide a different user identity.
    // Authentication is the Telegram HMAC session, authorization is both the
    // Mini App admin gate and handleMacStop's MAC_USER_IDS allowlist check.
    if (path === "/api/mac/stop" && method === "POST") {
      const adminErr = requireAdmin(user);
      if (adminErr) return adminErr;

      const payload = { _userId: String(user.id) } as PayloadFor<"MAC_STOP">;
      const result = await dispatchAndAudit("MAC_STOP", payload, {
        agentKey: "orchestrator",
        chatId: user.id,
        triggerUserId: String(user.id),
        macBridge,
      } satisfies DispatchCtx);

      if (result.ok) {
        return json({ ok: true, result: result.result });
      }
      if (result.error === "forbidden") {
        return json({ ok: false, error: result.error }, 403);
      }
      if (result.error === "mac_offline") {
        return json({ ok: false, error: result.error }, 503);
      }
      return json({ ok: false, error: result.error }, 502);
    }

    // GET /api/dashboard — aggregated dashboard payload (C27).
    if (path === "/api/dashboard" && method === "GET") {
      const healthArr = opts.getHealth ? opts.getHealth() : null;
      const agents = buildAgentsList(healthArr);

      // Recent tasks (10) — newest first.
      const taskRows = db
        .prepare(
          `SELECT id FROM tasks ORDER BY created_at DESC, rowid DESC LIMIT 10`,
        )
        .all() as { id: string }[];
      const recentTasks = taskRows.map((r) => getTask(r.id)).filter(Boolean);

      // Pending approvals (10).
      const pendingApprovals = listPendingApprovals(undefined, 10);

      // Recent actions (20).
      // Тот же список, что в /api/actions, и та же причина не читать тела.
      const dashAdmin = isAdmin(user);
      const actionRows = db
        .prepare(
          `SELECT ${dashAdmin ? "*" : ACTION_LIST_COLUMNS} FROM agent_actions` +
            ` ORDER BY created_at DESC, rowid DESC LIMIT 20`,
        )
        .all();
      const recentActions: unknown[] = dashAdmin
        ? (actionRows as AgentActionRow[]).map(rowToAction)
        : (actionRows as AgentActionListRow[]).map(actionListItem);

      const budgets = buildBudgetsList();

      // Аудит 2026-08-12: карточки на главной считались по этим самым превью —
      // `recentTasks.filter(pending).length`, `pendingApprovals.length`,
      // `recentActions.filter(созд. сегодня).length`. То есть «Задач в очереди»
      // физически не могло показать больше десяти, а «Действий сегодня» —
      // больше двадцати. Замер: карточка показывала 1, когда в очереди стояло
      // 200 задач (среди 10 последних по created_at pending была одна).
      // Карточка отвечает на вопрос «сколько ждёт сейчас», поэтому считаем по
      // всей таблице.
      //
      // `since` — начало суток по часам КЛИЕНТА: сервер живёт в UTC, и своя
      // полночь дала бы другой ответ, чем тот же экран показывает сейчас.
      const sinceRaw = Number(url.searchParams.get("since"));
      const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : startOfUtcDay();
      const counts = {
        tasksPending: (
          db
            .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status = 'pending'`)
            .get() as { n: number }
        ).n,
        approvalsPending: (
          db
            .prepare(`SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'`)
            .get() as { n: number }
        ).n,
        actionsSince: (
          db
            .prepare(`SELECT COUNT(*) AS n FROM agent_actions WHERE created_at >= ?`)
            .get(since) as { n: number }
        ).n,
        since,
      };

      return json({
        counts,
        agents,
        recentTasks: redactContent(user, recentTasks, TASK_CONTENT_FIELDS),
        pendingApprovals: redactContent(
          user,
          pendingApprovals,
          APPROVAL_CONTENT_FIELDS,
        ),
        recentActions: redactContent(user, recentActions, ACTION_CONTENT_FIELDS),
        budgets,
      });
    }

    // GET /api/agents
    if (path === "/api/agents" && method === "GET") {
      const healthArr = opts.getHealth ? opts.getHealth() : null;
      return json({ agents: buildAgentsList(healthArr) });
    }

    // POST /api/agents/:key/pause | /resume
    const agentPauseMatch = path.match(/^\/api\/agents\/([^/]+)\/(pause|resume)$/);
    if (agentPauseMatch && method === "POST") {
      const adminErr = requireAdmin(user);
      if (adminErr) return adminErr;
      const key = agentPauseMatch[1];
      const known = CHARACTERS.find((c) => c.key === key);
      if (!known) return json({ error: "agent not found" }, 404);
      const paused = agentPauseMatch[2] === "pause" ? 1 : 0;
      db.prepare(
        `INSERT INTO agent_states(agent_key, paused, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(agent_key) DO UPDATE SET
           paused = excluded.paused,
           updated_at = excluded.updated_at`,
      ).run(key, paused, Date.now());
      busEmit("agent.paused", { agent: key, paused: !!paused });
      return json({ ok: true, agent: key, paused: !!paused });
    }

    // GET /api/budgets — per-agent daily token usage + limit (M3).
    // `admin` — ответ на вопрос «дадут ли мне сохранить». Клиент не должен
    // выводить его из кодов ошибок: гейт стоит на POST, а GET открыт всем
    // пущенным, поэтому детект «403 на чтении → только просмотр» в
    // Settings.tsx не срабатывал никогда (аудит 2026-08-12).
    if (path === "/api/budgets" && method === "GET") {
      return json({ budgets: buildBudgetsList(), admin: isAdmin(user) });
    }

    // T-527: GET /api/budget-settings — DB-stored per-agent budget overrides.
    //
    // Аудит 2026-08-20: чтение было открыто любому допущенному, а отдаёт оно
    // колонку `updated_by` — её пишет POST ниже в виде `miniapp:<user.id>`,
    // то есть Telegram-ID того, кто менял бюджет, а менять его может только
    // админ. Получается, допущенный не-админ читает ID админа: ровно ту
    // величину, которую access-лог этажом ниже прогоняет через `redactUserId`.
    //
    // Гейт тот же, что на записи: у чтения и записи здесь один смысл — «кто
    // управляет бюджетами». Числа расхода видны всем допущенным по-прежнему,
    // их отдаёт GET /api/budgets, и он намеренно открыт (там же `admin:` —
    // ответ на вопрос «дадут ли мне сохранить»).
    //
    // Mini App этим эндпоинтом не пользуется: `api.budgetSettings()` в
    // miniapp/src/lib/api.ts объявлен, но не вызывается ни из одного
    // компонента — так что гейт ничего не ломает.
    if (path === "/api/budget-settings" && method === "GET") {
      const adminErr = requireAdmin(user);
      if (adminErr) return adminErr;
      return json({ settings: getAllBudgetSettings() });
    }

    // T-527: POST /api/budgets — upsert/clear per-agent override.
    // Body: { agentKey: string, dailyInputTokens: number | null }
    if (path === "/api/budgets" && method === "POST") {
      // T-313 fix (finding #6): mutating global budget state requires admin.
      const adminErr = requireAdmin(user);
      if (adminErr) return adminErr;
      const body = await readJson(req);
      if (!body || typeof body.agentKey !== "string" || !body.agentKey.trim()) {
        return json({ error: "bad body: agentKey required" }, 400);
      }
      const budgetKeyErr = badAgentKey(body.agentKey);
      if (budgetKeyErr) return budgetKeyErr;
      const raw = body.dailyInputTokens;
      let value: number | null;
      if (raw === null) {
        value = null;
      } else if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
        value = Math.floor(raw);
      } else {
        return json(
          { error: "bad body: dailyInputTokens must be positive number or null" },
          400,
        );
      }
      try {
        // Аудит 2026-08-13: актор брался из тела запроса (`body.updatedBy`), то
        // есть журнал «кто урезал бюджет роли» писал ту строку, которую выбрал
        // отправитель. Единственная мутирующая ручка, где так; соседние строят
        // актора сами (`miniapp:${user.id}` в задачах и заявках). Восстановить
        // настоящего автора из БД потом нельзя: `agent_actions` здесь не
        // пишется, а `GET /api/budget-settings` отдаёт колонку любому
        // allowlisted-пользователю. Клиент это поле и не слал — см.
        // miniapp/src/lib/api.ts:updateBudget.
        setBudget(body.agentKey, value, `miniapp:${user.id}`);
      } catch (e) {
        return json({ error: getErrorMessage(e) }, 400);
      }
      return json({
        ok: true,
        agentKey: body.agentKey,
        dailyInputTokens: value,
      });
    }

    // GET /api/db-stats — C31 DB maintenance / size dashboard.
    //
    // Аудит 2026-09-10: ручка была открыта любому допущенному, и это дороже,
    // чем выглядит. `dbStats` (db-maint.ts:930) делает `COUNT(*)` по всем 19
    // таблицам STAT_TABLES — включая `messages`, `messages_archive` и
    // `agent_actions_archive` — плюс `dbstatByOwner`, про который его же
    // комментарий говорит прямо: «`dbstat` — полный скан БД». `bun:sqlite`
    // синхронна, а поток у процесса один на 12 ботов, HTTP и SSE-раздачу, так
    // что скан блокирует не запросившего, а всех. GET-ведро здесь
    // `{ capacity: 120, refillPerSec: 4 }`, то есть четыре полных скана в
    // секунду — это ещё В ПРЕДЕЛАХ политики, а не злоупотребление.
    //
    // Гейт тот же, что у соседей по смыслу: `/api/audit-logs`,
    // `/api/permissions`, `/api/budget-settings` — операторская интроспекция
    // требует админа, наблюдателю остаются рабочие экраны. Заодно уходит
    // раскрытие размеров и числа строк по таблицам тому, кому `redactContent`
    // (487) не отдаёт ни одного тела.
    //
    // Mini App этим эндпоинтом не пользуется: экрана «БД» в miniapp/src/pages
    // нет вовсе, вызова `db-stats` во фронтенде нет — гейт ничего не ломает.
    if (path === "/api/db-stats" && method === "GET") {
      const adminErr = requireAdmin(user);
      if (adminErr) return adminErr;
      return json({ stats: dbStats() });
    }

    // /api/tasks
    if (path === "/api/tasks" && method === "GET") {
      const chatId = chatIdParam(url);
      if (chatId instanceof Response) return chatId;
      const assignee = url.searchParams.get("assignee");
      const status = url.searchParams.get("status") as TaskStatus | null;
      const limit = parseIntOr(url.searchParams.get("limit"), 50, 200);
      // Аудит 2026-08-20: незнакомый статус молча ронял фильтр, и вместо
      // «задач в статусе X» приходила ВСЯ доска — с ответом 200, по которому
      // отличить одно от другого невозможно. Тот же класс уже чинили для
      // before_id в /api/actions. Опечатка в статусе — это ошибка запроса, а
      // не запрос без фильтра.
      if (status !== null && !TASK_STATUSES.includes(status)) {
        // `allowed` в теле — чтобы клиент чинил опечатку по ответу, а не лазил
        // в исходник за списком: канонический `in-progress` легко пишут как
        // `in_progress`, и без перечня 400 отвечает «неверно» не говоря чем.
        return json(
          { error: `bad query: unknown status: ${status}`, allowed: TASK_STATUSES },
          400,
        );
      }
      // Аудит 2026-09-10: тот же класс, что у `status` выше, — последний
      // непроверенный фильтр этой ручки. `listTasksByAssignee` (tasks.ts:842)
      // сравнивает `assigned_to = ?` точным равенством, без LOWER и без
      // нормализации, а канонический вид ключа гарантируют ВСЕ семь писателей:
      // dispatch/tasks.ts:132,166, action-dispatch.ts:630 (роль делегата),
      // :1418 («aieng»), diagnostic.ts:598 (pickResponsibleRole), а в
      // dispatch/diagnostic-action.ts:236 явный `target_agent_key` пропущен
      // через `VALID_AGENT_KEYS`. То есть неканоническое значение в колонке
      // взяться неоткуда — и запрос по нему не может совпасть НИКОГДА.
      //
      // Читающая ветка при этом отвечала на «Backend» и на «devops» ровно тем
      // же, чем на пустую очередь: 200 и `{"tasks": []}`. Пишущая ветка ниже
      // (:1362) ту же опечатку отклоняет 400-м и своим докблоком объясняет
      // почему — «`assigned_to` — адрес очереди». У чтения та же цена: по
      // ответу нельзя отличить опечатку от «дел нет».
      //
      // `allowed` в теле — как у `status`: чинить опечатку по ответу, а не по
      // исходнику.
      // Условие ровно как у ветки-потребителя ниже: пустой `?assignee=` до
      // фильтра не доходит вовсе, это «без фильтра», а не опечатка. Так же
      // устроен сосед `/api/autonomy?agent=`.
      //
      // `canonicalAssignee` не проверяет, а НОРМАЛИЗУЕТ (`trim` + `toLowerCase`
      // по CHARACTERS), и пишущая ветка ниже (:1362) кладёт в колонку именно
      // её результат. Поэтому читающей мало пропустить значение — ей нужно
      // спрашивать тем же ключом, каким писали: иначе `?assignee=Backend`
      // проходит проверку и всё равно не совпадает ни с чем. Отказ остаётся
      // только для того, чего в CHARACTERS нет вовсе.
      let assigneeKey: string | null = null;
      if (assignee) {
        assigneeKey = canonicalAssignee(assignee);
        if (assigneeKey === null) {
          return json(
            {
              error: `bad query: unknown assignee: ${assignee}`,
              allowed: CHARACTERS.map((c) => c.key),
            },
            400,
          );
        }
      }
      const statuses: TaskStatus[] | undefined = status ? [status] : undefined;
      // Аудит 2026-08-28: выдача резалась молча. Ответ на сто задач из ста и
      // ответ на сто задач из трёхсот выглядели одинаково — код 200, массив
      // ровно по лимиту, ни поля, ни «показать ещё». Tasks.tsx просит
      // `limit: 100` и рисует полученное как всю доску, а `limit` тут вообще
      // не может быть больше 200. Соседняя ручка `/api/wiki/list` эту же
      // ситуацию давно подписывает флагом `truncated` — делаем так же:
      // спрашиваем на строку больше лимита и по ней узнаём, есть ли что-то за
      // краем окна.
      const probe = limit + 1;
      let tasks;
      let truncated = false;
      if (assigneeKey) {
        // Аудит 2026-08-28: `chat_id` сюда не доезжал вовсе — ветка assignee
        // выигрывала и молча теряла сужение области, отвечая 200 с задачами
        // роли из всех чатов сразу.
        const rows = listTasksByAssignee(assigneeKey, statuses, probe, chatId);
        truncated = rows.length > limit;
        // Очередь роли отсортирована `priority DESC`: лишняя строка последняя.
        tasks = truncated ? rows.slice(0, limit) : rows;
      } else if (chatId !== undefined) {
        const rows = listTasksByChat(chatId, statuses, probe);
        truncated = rows.length > limit;
        // А здесь порядок ВОЗРАСТАЮЩИЙ, хотя `limit` берёт N свежайших (F1
        // того же аудита). Лишняя строка в такой выборке — самая старая, то
        // есть первая: `slice(0, limit)` выбросил бы самую свежую задачу,
        // ровно ту, ради которой доску и открывают.
        tasks = truncated ? rows.slice(rows.length - limit) : rows;
      } else {
        // Без chat_id и assignee — прямой скан. Аудит 2026-08-20: статус здесь
        // не применялся вовсе. Две других ветки принимают `statuses`, а эта
        // молча возвращала всю доску — то есть ?status=pending без chat_id
        // работал как запрос вообще без фильтра, отвечая 200.
        //
        // Это не гипотетика: Dashboard.tsx:166 зовёт ровно
        // `api.tasks({ status: "pending", limit: 200 })` — без chat_id. Список
        // «в очереди» на главной показывал задачи в любом статусе, включая
        // done и cancelled.
        const where = statuses?.length
          ? ` WHERE status IN (${statuses.map(() => "?").join(",")})`
          : "";
        const rows = db
          .prepare(
            // Без тай-брейка произвольной становится не только выдача, но и
            // флаг truncated: лишняя строка probe берётся с плавающей границы.
            `SELECT id FROM tasks${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
          )
          .all(...(statuses ?? []), probe) as { id: string }[];
        truncated = rows.length > limit;
        // Режем по id, а не после getTask: лишняя строка тут самая старая по
        // `created_at DESC`, то есть последняя, и тянуть её целиком незачем.
        tasks = rows.slice(0, limit).map((r) => getTask(r.id)).filter(Boolean);
      }
      return json({
        tasks: redactContent(user, tasks, TASK_CONTENT_FIELDS),
        truncated,
      });
    }

    // GET /api/wiki/list — список wiki-страниц (scope, slug, title).
    // Доступно любому allowlisted-пользователю (read-only). Опц. ?scope=.
    if (path === "/api/wiki/list" && method === "GET") {
      const scopeRaw = url.searchParams.get("scope") ?? undefined;
      const validScopes = new Set<string>([
        "_team",
        ...CHARACTERS.map((c) => c.key),
      ]);
      if (scopeRaw && !validScopes.has(scopeRaw)) {
        return json({ error: "unknown scope" }, 400);
      }
      // limit+1, чтобы отличить «ровно потолок» от «обрезали».
      const rows = wikiList(scopeRaw, WIKI_LIST_MAX + 1);
      const truncated = rows.length > WIKI_LIST_MAX;
      // `scopes` считается по всей вике, а не по выдаче: список разделов,
      // выведенный из обрезанной выдачи, теряет ровно те разделы, ради
      // которых фильтр и нужен (аудит 2026-08-21, см. wikiScopes).
      return json({
        pages: rows.slice(0, WIKI_LIST_MAX),
        truncated,
        scopes: wikiScopes(),
      });
    }

    // GET /api/wiki/page?scope=&slug= — содержимое одной страницы.
    //
    // Аудит 2026-08-12: тело страницы — это КОНТЕНТ, и политика на него уже
    // написана выше, у redactContent: наблюдателю видны списки, но не тела, и
    // «целиком тело WRITE_WIKI» там названо поимённо. Для /api/actions payload
    // действительно скрывался — а этот роут отдавал ту же самую страницу
    // целиком любому из allowlist. Скрытие payload'а при этом не значило
    // ничего: scope и slug лежат в открытом /api/wiki/list двумя строками выше.
    // Пишет в вики не человек — компактор решает сам, без подтверждения, и
    // складывает туда выжимку переписки; `_team` один на все чаты.
    //
    // Закрываем тело, а не роут целиком: список остаётся открытым намеренно
    // (scope/slug/title — метаданные того же класса, что заголовки задач).
    if (path === "/api/wiki/page" && method === "GET") {
      const adminErr = requireAdmin(user);
      if (adminErr) return adminErr;
      const scopeRaw = url.searchParams.get("scope") ?? "";
      const slug = url.searchParams.get("slug") ?? "";
      const validScopes = new Set<string>([
        "_team",
        ...CHARACTERS.map((c) => c.key),
      ]);
      if (!validScopes.has(scopeRaw)) {
        return json({ error: "unknown scope" }, 400);
      }
      if (!slug) return json({ error: "slug required" }, 400);
      let content: string | null;
      try {
        content = wikiRead(scopeRaw as Scope, slug);
      } catch {
        // InvalidSlugError or path-traversal attempt → 400, not 500.
        return json({ error: "invalid slug" }, 400);
      }
      if (content === null) return json({ error: "not found" }, 404);
      return json({ scope: scopeRaw, slug, content });
    }

    // POST /api/tasks — create a new pending task.
    if (path === "/api/tasks" && method === "POST") {
      // T-313 fix (finding #6): task creation accepts arbitrary chat_id,
      // so a non-admin allowlisted viewer could spawn cross-chat tasks.
      const adminErr = requireAdmin(user);
      if (adminErr) return adminErr;
      const body = await readJson(req);
      if (!body || typeof body.title !== "string" || !body.title.trim()) {
        return json({ error: "bad body: title required" }, 400);
      }
      const chatIdRaw = body.chat_id ?? body.chatId;
      if (chatIdRaw === undefined || chatIdRaw === null || chatIdRaw === "") {
        return json({ error: "bad body: chat_id required" }, 400);
      }
      const chatIdNum = strictChatId(chatIdRaw);
      if (chatIdNum === null) {
        return json({ error: "bad body: chat_id must be an integer" }, 400);
      }
      // Аудит 2026-08-12: исполнитель клался в БД как есть. `assigned_to` —
      // адрес очереди (точное равенство в listTasksByAssignee), так что опечатка
      // в форме = задача, невидимая всем, при 201 в ответе.
      const assigneeRaw =
        typeof body.assignee === "string" && body.assignee
          ? body.assignee
          : typeof body.assigned_to === "string" && body.assigned_to
            ? body.assigned_to
            : null;
      const assignedTo = assigneeRaw === null ? null : canonicalAssignee(assigneeRaw);
      if (assigneeRaw !== null && assignedTo === null) {
        return json({ error: `bad body: unknown assignee: ${assigneeRaw}` }, 400);
      }
      try {
        const t = createTask({
          chatId: chatIdNum,
          createdBy: `miniapp:${user.id}`,
          assignedTo,
          title: body.title.trim(),
          description:
            typeof body.description === "string" ? body.description : null,
          inputPayload:
            body.input !== undefined
              ? body.input
              : body.type
                ? { type: body.type }
                : undefined,
        });
        busEmit("task.created", { id: t.id, chat_id: t.chat_id, status: t.status });
        return json({ task: t }, 201);
      } catch (e: any) {
        return json({ error: e?.message ?? String(e) }, 400);
      }
    }

    const taskIdMatch = path.match(/^\/api\/tasks\/([^/]+)$/);
    if (taskIdMatch && method === "GET") {
      const t = getTask(taskIdMatch[1]);
      if (!t) return json({ error: "task not found" }, 404);
      return json({ task: redactContent(user, [t], TASK_CONTENT_FIELDS)[0] });
    }

    const taskStatusMatch = path.match(/^\/api\/tasks\/([^/]+)\/status$/);
    if (taskStatusMatch && method === "POST") {
      // SEC re-audit 2026-06-10 (LOW): mutating route — require admin like the
      // other task/agent mutations (was missing).
      const adminErr = requireAdmin(user);
      if (adminErr) return adminErr;
      const body = await readJson(req);
      if (!body || typeof body.status !== "string") {
        return json({ error: "bad body: status required" }, 400);
      }
      if (!TASK_STATUSES.includes(body.status)) {
        return json({ error: "bad status" }, 400);
      }
      try {
        const t = updateTaskStatus(taskStatusMatch[1], body.status, {
          output: body.output,
          error: body.error,
        });
        busEmit("task.updated", { id: t.id, status: t.status });
        return json({ task: t });
      } catch (e: any) {
        const msg = e?.message ?? String(e);
        const code = /not found/i.test(msg) ? 404 : 400;
        return json({ error: msg }, code);
      }
    }

    // /api/approvals
    if (path === "/api/approvals" && method === "GET") {
      const status = url.searchParams.get("status") ?? "pending";
      // Тот же гейт, что у `/api/tasks` выше: неизвестный статус — это ошибка
      // запроса, а не запрос без фильтра. До аудита 2026-08-28 строка уходила
      // в `WHERE status = ?` как есть, и `?status=aproved` отвечал
      // `200 {"approvals": []}` — как будто решений действительно не было.
      if (!(APPROVAL_STATUSES as string[]).includes(status)) {
        return json(
          { error: `bad query: unknown status: ${status.slice(0, 64)}`, allowed: APPROVAL_STATUSES },
          400,
        );
      }
      const chatId = chatIdParam(url);
      if (chatId instanceof Response) return chatId;
      const limit = parseIntOr(url.searchParams.get("limit"), 50, 200);
      if (status === "pending") {
        const items = listPendingApprovals(chatId, limit);
        return json({ approvals: redactContent(user, items, APPROVAL_CONTENT_FIELDS) });
      }
      // Non-pending: direct query.
      const where: string[] = ["status = ?"];
      const args: unknown[] = [status];
      if (chatId !== undefined) {
        where.push("chat_id = ?");
        args.push(chatId);
      }
      args.push(limit);
      const rows = db
        .prepare(
          `SELECT id FROM approvals WHERE ${where.join(" AND ")} ` +
            `ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        )
        .all(...(args as never[])) as { id: string }[];
      const items = rows.map((r) => getApproval(r.id)).filter(Boolean);
      return json({ approvals: redactContent(user, items, APPROVAL_CONTENT_FIELDS) });
    }

    const approvalDecideMatch = path.match(/^\/api\/approvals\/([^/]+)\/decide$/);
    if (approvalDecideMatch && method === "POST") {
      // SECURITY (T-600): deciding an approval EXECUTES the risky action, so it
      // must be admin-only — same as every other mutating endpoint. Without this
      // any allowlisted (non-admin) Mini App user could approve/execute or
      // self-approve queued risky actions.
      const adminErr = requireAdmin(user);
      if (adminErr) return adminErr;
      const body = await readJson(req);
      if (
        !body ||
        (body.decision !== "approved" && body.decision !== "rejected")
      ) {
        return json({ error: "bad body: decision required" }, 400);
      }
      try {
        const decidedBy = `miniapp:${user.id}`;
        const a = decideApproval(
          approvalDecideMatch[1],
          body.decision,
          decidedBy,
          body.reason,
        );
        // approval.decided поднимает сама decideApproval — иначе решение из
        // Telegram проходило мимо шины (аудит 2026-08-08).
        // T-547: an approved decision must actually RUN the action. Previously
        // this route only flipped status, so Mini App approvals were a no-op
        // (action stuck in pending_approval forever). Mirror the Telegram
        // cmdApprove path: on "approved", execute via the requesting agent's
        // Telegram client. Rejections never execute.
        if (a.status === "approved") {
          try {
            const result = await executeApproved(a, approvalDeps);
            return json({ approval: a, executed: true, result });
          } catch (execErr: any) {
            const execMsg = execErr?.message ?? String(execErr);
            log.error("[miniapp] approved action failed to execute", {
              approvalId: a.id,
              actionType: a.action_type,
              error: execMsg,
            });
            // Decision is recorded; surface the execution failure so the UI
            // can show it instead of a false success. dispatchAndAudit has
            // already logged status='error' in agent_actions.
            // Аудит 2026-08-07: 502 живёт ровно один запрос — если вкладку
            // закрыли, провал терялся, а строка оставалась `approved`.
            // Помечаем её, чтобы «одобрено» и «одобрено, но упало» различались.
            const failed = markApprovalFailed(a.id, execMsg);
            return json(
              { approval: failed ?? a, executed: false, error: execMsg },
              502,
            );
          }
        }
        // Аудит 2026-08-08: отказ через Mini App не писал audit_logs вовсе —
        // handleUpdateAgentPromptRejected звался только из cmdReject. Отказ от
        // правки system prompt'а через веб не оставлял следа: кто отказал и
        // почему — нигде. Общая с Telegram-путём функция сама проверяет тип.
        if (a.status === "rejected") {
          auditRejectedApproval({
            actionType: a.action_type,
            payload: a.payload,
            decidedBy,
            chatId: a.chat_id,
            // См. тот же комментарий в cmdReject (аудит 2026-08-21).
            requestedBy: a.requested_by,
            approvalId: a.id,
            reason: body.reason,
          });
        }
        return json({ approval: a, executed: false });
      } catch (e: any) {
        const msg = e?.message ?? String(e);
        const code = /not found/i.test(msg) ? 404 : 400;
        return json({ error: msg }, code);
      }
    }

    // /api/actions — paginated audit (extended filter beyond listActions()).
    if (path === "/api/actions" && method === "GET") {
      const agent = url.searchParams.get("agent");
      const chatId = chatIdParam(url);
      if (chatId instanceof Response) return chatId;
      const status = url.searchParams.get("status");
      const type = url.searchParams.get("type");
      const taskId = url.searchParams.get("task_id");
      const beforeId = cursorParam(url, "before_id");
      const limit = parseIntOr(url.searchParams.get("limit"), 50, 200);

      const where: string[] = [];
      const args: unknown[] = [];
      if (agent) {
        // `agent_key` тоже без словаря — и тоже намеренно: ключ бывает
        // составным (`design:svg-fallback`, см. `budgetOwner`), в CHARACTERS
        // такой строки нет, а строки в таблице есть.
        where.push("agent_key = ?");
        args.push(agent);
      }
      if (chatId !== undefined) {
        where.push("chat_id = ?");
        args.push(chatId);
      }
      if (status) {
        // Аудит 2026-09-10: `status` — закрытое множество (ACTION_STATUSES), а
        // неизвестное значение уходило в WHERE как есть и давало `200
        // {"actions":[]}`. Тот же класс, что чинили в GET_LOGS
        // (tools-schema.ts): «модель по здравому смыслу пишет `failed` — и
        // получает count: 0, из которого докладывает „ошибок нет"». Через тул
        // тот же фильтр отвечает списком допустимых, через HTTP-ручку — пустым
        // списком; соседи по файлу (/api/tasks, /api/approvals) отвечают 400.
        if (!isActionStatus(status)) {
          return json(
            { error: `unknown status: ${status}`, allowed: ACTION_STATUSES },
            400,
          );
        }
        where.push("status = ?");
        args.push(status);
      }
      if (type) {
        // `action_type` словарём НЕ проверяется, и это не недосмотр: колонка —
        // открытый TEXT, `logToolCall` (lib/audit.ts:172) пишет туда имя любой
        // тулзы, а докблок там прямо объясняет, почему тулзы не заводят в
        // ACTION_TYPES. Закрытый словарь здесь отсекал бы существующие строки.
        where.push("action_type = ?");
        args.push(type);
      }
      if (taskId) {
        where.push("task_id = ?");
        args.push(taskId);
      }
      if (beforeId) {
        // Аудит 2026-08-13: курсор искали ТОЛЬКО в `agent_actions`, а
        // `archiveOldRows` строки старше 30 дней оттуда переносит и удаляет
        // (`db-maint.ts:243`). Не нашли — условие просто не добавлялось, при
        // HTTP 200 и без единого признака в ответе. Клиент (`Logs.tsx:130`)
        // берёт курсором последний из показанных и ДОПИСЫВАЕТ ответ к списку,
        // а сервер отдавал ему самую свежую страницу заново: дубликаты и
        // кнопка «Загрузить ещё», которая не кончается никогда. Молчаливая
        // потеря фильтра — тот же класс ошибки, что и строгий `<` ниже: обе
        // маскировались под нормальную работу пагинации.
        //
        // Курсор ищем и в архиве (нужен только `created_at`), а совсем
        // неизвестный id — это 400, а не «покажу с начала».
        const cursor =
          getAction(beforeId) ??
          (db
            .prepare(
              `SELECT created_at FROM agent_actions_archive WHERE id = ?`,
            )
            .get(beforeId) as { created_at: number } | undefined) ??
          null;
        if (!cursor) {
          return json({ error: "unknown before_id" }, 400);
        }
        // Аудит 2026-08-12: курсор был `created_at < ?`, а сортировка — по
        // одному created_at. Это миллисекунды Date.now(), и диспетчер за один
        // ход агента пишет несколько строк в одну и ту же. Всё, что делило
        // миллисекунду с последней строкой страницы, строгий `<` отсекал — и
        // такая строка не попадала НИ на одну страницу. Клиент видел короткую
        // страницу и считал её концом списка (Logs.tsx: hasMore = len === PAGE),
        // то есть потеря маскировалась под нормальный конец пагинации.
        // Тай-брейк по id и в ORDER BY, и в курсоре — тот же приём, что в
        // порядке сообщений (`ORDER BY ts DESC, id DESC`).
        where.push("(created_at < ? OR (created_at = ? AND id < ?))");
        args.push(cursor.created_at, cursor.created_at, beforeId);
      }
      // Админу тела нужны — это закреплено в `miniapp-viewer-scope`, — но и
      // ему они теперь приезжают одним запросом, а не двумястами точечными.
      const admin = isAdmin(user);
      const sql =
        `SELECT ${admin ? "*" : ACTION_LIST_COLUMNS} FROM agent_actions` +
        (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
        ` ORDER BY created_at DESC, id DESC LIMIT ?`;
      args.push(limit);
      const rows = db.prepare(sql).all(...(args as never[]));
      const items: unknown[] = admin
        ? (rows as AgentActionRow[]).map(rowToAction)
        : (rows as AgentActionListRow[]).map(actionListItem);
      return json({ actions: redactContent(user, items, ACTION_CONTENT_FIELDS) });
    }

    // /api/audit-logs — читалка security-журнала.
    //
    // Аудит 2026-08-08: у таблицы `audit_logs` было три писателя (emitAlert и
    // отказы UPDATE_AGENT_PROMPT) и НИ ОДНОГО читателя: ни ручки в API, ни
    // команды в Telegram. Журнал наполнялся, старые строки исправно уезжали в
    // архив по расписанию — и никто их никогда не видел. Хуже того, system
    // prompt роли `perm` прямым текстом велит «прочитай audit_logs» при
    // разборе денаев, то есть промпт обещал возможность, которой в рантайме
    // не существовало.
    //
    // Admin-only: тут алерты и отказы по правкам system prompt'ов — не то, что
    // показывают любому allowlisted-пользователю Mini App.
    if (path === "/api/audit-logs" && method === "GET") {
      const adminErr = requireAdmin(user);
      if (adminErr) return adminErr;
      const agent = url.searchParams.get("agent");
      const eventType = url.searchParams.get("event_type");
      const chatId = chatIdParam(url);
      if (chatId instanceof Response) return chatId;
      const before = cursorParam(url, "before"); // created_at (ms), курсор
      // Тай-брейк курсора: см. комментарий в /api/actions выше. Без него строки,
      // записанные в одну миллисекунду с границей страницы, терялись целиком.
      const beforeId = cursorParam(url, "before_id");
      const limit = parseIntOr(url.searchParams.get("limit"), 50, 200);

      const where: string[] = [];
      const args: unknown[] = [];
      if (agent) {
        where.push("agent_key = ?");
        args.push(agent);
      }
      if (eventType) {
        where.push("event_type = ?");
        args.push(eventType);
      }
      if (chatId !== undefined) {
        where.push("chat_id = ?");
        args.push(chatId);
      }
      // Аудит 2026-09-10: нечисловой `before` условие пагинации просто не
      // добавлял — вместе с ним пропадал и `beforeId`, который живёт только
      // внутри этого блока. Ответ 200 с самой свежей страницей; клиент
      // (Logs.tsx) дописывает её к списку и снова берёт курсором последний
      // показанный элемент — дубликаты и «Загрузить ещё», которая не
      // кончается. Соседняя /api/actions этот же класс закрыла явно
      // («неизвестный id — это 400, а не „покажу с начала"»), здесь осталась
      // молчаливая потеря фильтра. `before_id` без `before` бесполезен по той
      // же причине: тай-брейк без границы страницы не применяется.
      if (before !== null && !Number.isFinite(Number(before))) {
        return json({ error: `invalid before cursor: ${before}` }, 400);
      }
      if (beforeId && before === null) {
        return json({ error: "before_id requires before" }, 400);
      }
      if (before !== null) {
        if (beforeId) {
          where.push("(created_at < ? OR (created_at = ? AND id < ?))");
          args.push(Number(before), Number(before), beforeId);
        } else {
          where.push("created_at < ?");
          args.push(Number(before));
        }
      }
      const sql =
        `SELECT id, agent_key, chat_id, event_type, payload, created_at FROM audit_logs` +
        (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
        ` ORDER BY created_at DESC, id DESC LIMIT ?`;
      args.push(limit);
      const rows = db.prepare(sql).all(...(args as never[])) as {
        id: string;
        agent_key: string | null;
        chat_id: number | null;
        event_type: string;
        payload: string | null;
        created_at: number;
      }[];
      return json({
        logs: rows.map((r) => ({
          id: r.id,
          agentKey: r.agent_key,
          chatId: r.chat_id,
          eventType: r.event_type,
          // Строка в БД — JSON. Битую не роняем весь ответ: отдаём как есть,
          // иначе один кривой writer прячет весь журнал.
          payload: safeParseJson(r.payload),
          createdAt: r.created_at,
        })),
        nextBefore: rows.length === limit ? rows[rows.length - 1].created_at : null,
        // Курсор — пара (created_at, id); отдавать только время значит снова
        // терять строки, записанные в ту же миллисекунду.
        nextBeforeId: rows.length === limit ? rows[rows.length - 1].id : null,
      });
    }

    // /api/permissions — admin gated (read also gated, mutates definitely gated).
    if (path === "/api/permissions" && method === "GET") {
      const adminErr = requireAdmin(user);
      if (adminErr) return adminErr;
      const agent = url.searchParams.get("agent");
      let sql = `SELECT agent_key, action_type, allowed, requires_approval FROM permissions`;
      const args: unknown[] = [];
      if (agent) {
        sql += ` WHERE agent_key = ?`;
        args.push(agent);
      }
      sql += ` ORDER BY agent_key, action_type`;
      const rows = db.prepare(sql).all(...(args as never[])) as {
        agent_key: string;
        action_type: string;
        allowed: number;
        requires_approval: number;
      }[];
      return json({
        permissions: rows.map((r) => ({
          agentKey: r.agent_key,
          actionType: r.action_type,
          allowed: !!r.allowed,
          requires_approval: !!r.requires_approval,
        })),
      });
    }

    if (path === "/api/permissions" && method === "POST") {
      const adminErr = requireAdmin(user);
      if (adminErr) return adminErr;
      const body = await readJson(req);
      if (
        !body ||
        typeof body.agentKey !== "string" ||
        typeof body.actionType !== "string" ||
        typeof body.allowed !== "boolean" ||
        typeof body.requires_approval !== "boolean"
      ) {
        return json({ error: "bad body" }, 400);
      }
      if (!ACTION_TYPES.includes(body.actionType as ActionType)) {
        return json({ error: "unknown actionType" }, 400);
      }
      const permKeyErr = badAgentKey(body.agentKey);
      if (permKeyErr) return permKeyErr;
      // Аудит 2026-08-28: второй вход к той же таблице. `/grant` с 2026-08-27
      // отказывается писать строки, мёртвые по картам в коде, а этот маршрут
      // писал их беспрепятственно — та же мёртвая строка приходила через Mini
      // App и всплывала в `/perms` как выданное право. Рубеж общий с командой.
      const ineffective = grantIneffectiveReason(
        body.agentKey,
        body.actionType as ActionType,
        body.requires_approval ? "approval" : "auto",
      );
      if (body.allowed && ineffective) {
        return json({ error: `строка не подействует: ${ineffective}` }, 409);
      }
      setPermission(
        body.agentKey,
        body.actionType as ActionType,
        { allowed: body.allowed, requires_approval: body.requires_approval },
        { changedBy: `miniapp:${user.id}`, chatId: user.id, source: "miniapp" },
      );
      const p = getPermission(body.agentKey, body.actionType as ActionType);
      // Аудит 2026-08-28: строка законна (иначе был бы 409 выше), но действует
      // не везде — `SEMI_AUTO_RISKY` поднимает пол до апрува во всех чатах с
      // автономией semi_auto, а это дефолт. `/grant` про это пишет «Оговорка:
      // …»; здесь — второй и единственный другой одиночный вход к той же
      // таблице — ответ был просто 200, ячейка перекрашивалась в «авто», и
      // владелец узнавал правду только по неприходящим сообщениям.
      //
      // В отчёт `/perms` оговорка намеренно не идёт (commands.ts:586): там
      // множество большое и приписка к каждой второй строке — стена текста.
      // Здесь речь про одно конкретное действие, как в `/grant`.
      const caveat = body.allowed
        ? grantCaveat(
            body.actionType as ActionType,
            body.requires_approval ? "approval" : "auto",
          )
        : null;
      return json({
        permission: { agentKey: body.agentKey, actionType: body.actionType, ...p },
        caveat,
      });
    }

    // /api/autonomy
    if (path === "/api/autonomy" && method === "GET") {
      const agentParam = url.searchParams.get("agent");
      const chatId = chatIdParam(url);
      if (chatId instanceof Response) return chatId;
      // Аудит 2026-09-10: `badAgentKey` стоял на всех трёх ПИШУЩИХ ветках, а
      // на читающей — нет, хотя её докблок ниже как раз про «переопределение
      // роли осталось невидимым». `getAutonomy` по неизвестному ключу молча
      // спускается на чатовый и глобальный уровень, и ответ 200 показывал
      // ЧУЖОЙ режим рядом с эхом опечатки: `?agent=Backend` (ключ — `backend`)
      // отдавал `{"mode":"semi_auto","agent":"Backend"}`, пока у роли стоял
      // `full_auto`. Ровно то введение админа в заблуждение, которое чинили на
      // POST-ветках.
      // Пустая строка (`?agent=`) — это «без роли», ровно как её трактует сам
      // `getAutonomy` (`if (agentKey)`, permissions.ts:585); опечаткой она быть
      // не может, поэтому в словарь не идёт.
      if (agentParam) {
        const bad = badAgentKey(agentParam);
        if (bad) return bad;
      }
      const mode = getAutonomy(chatId, agentParam ?? undefined);
      return json({
        mode,
        chat_id: chatId ?? null,
        agent: agentParam ?? null,
        // Аудит 2026-08-21: строка scope='agent' сильнее чатовой и глобальной,
        // но не показывалась нигде — владелец ставил чат в `locked`, получал
        // подтверждение и не узнавал, что роль с переопределением продолжает
        // работать. Отдаём список всегда: он короткий (ролей 12) и нужен именно
        // тогда, когда его не запрашивали отдельно.
        agent_overrides: listAgentAutonomyOverrides(),
        // Тот же гейт, что и у POST /api/autonomy ниже: показывать
        // переключатель режима имеет смысл только тому, кому дадут сохранить.
        admin: isAdmin(user),
      });
    }

    if (path === "/api/autonomy" && method === "POST") {
      const adminErr = requireAdmin(user);
      if (adminErr) return adminErr;
      const body = await readJson(req);
      // `inherit` — не режим, а его отсутствие: снять переопределение роли,
      // чтобы она снова слушалась чатового и глобального. До аудита 2026-08-21
      // снять было нечем вовсе: setAutonomy умеет только upsert, а DELETE в
      // проде-коде не существовало. Строка создавалась Mini App'ом и одобренным
      // CHANGE_AGENT_STATUS и жила вечно, глуша будущий рубильник.
      const inherit = body?.mode === "inherit";
      if (
        !body ||
        typeof body.mode !== "string" ||
        (!inherit && !AUTONOMY_MODES.includes(body.mode as AutonomyMode))
      ) {
        return json({ error: "bad body: mode required" }, 400);
      }
      const wantsAgent = typeof body.agent === "string" && body.agent.length > 0;
      const wantsChat = body.chat_id !== undefined && body.chat_id !== null;
      // Аудит 2026-08-20: цепочка if/else-if молча выбирала agent, а ответ и
      // событие шины эхом отдавали ОБА поля — то есть админу показывали, что
      // применено и правило роли, и правило чата, хотя в БД легла одна строка.
      // Врал не только ответ: `agent.autonomy` уходит в SSE, и лента событий
      // фиксировала область, которой никто не записывал. Неоднозначный запрос
      // не сужаем — отбиваем, как badAgentKey отбивает опечатку в ключе.
      if (wantsAgent && wantsChat) {
        return json(
          {
            error:
              "bad body: agent и chat_id взаимоисключающи — область правила одна",
          },
          400,
        );
      }
      if (inherit && !wantsAgent) {
        // Наследовать чату и глобальному не от кого — это и есть корень.
        return json({ error: "bad body: inherit requires agent" }, 400);
      }
      // Что именно записали. Ниже отдаём в ответ и в шину только это, а не
      // то, что было в запросе.
      let scope: "agent" | "chat" | "global";
      let scopeKey: string;
      if (wantsAgent) {
        const autoKeyErr = badAgentKey(body.agent as string);
        if (autoKeyErr) return autoKeyErr;
        // `inherit` — не режим, а СНЯТИЕ строки роли: setAutonomy умеет только
        // upsert, поэтому исключение, однажды заведённое Mini App'ом или
        // одобренным CHANGE_AGENT_STATUS, жило вечно и глушило будущий
        // рубильник чата. clearAutonomy возвращает роль к наследованию.
        if (inherit) clearAutonomy("agent", body.agent as string);
        else setAutonomy("agent", body.agent as string, body.mode as AutonomyMode);
        scope = "agent";
        scopeKey = body.agent as string;
      } else if (wantsChat) {
        // Было `String(body.chat_id)` без проверки типа: `{}` превращался в
        // "[object Object]", `[1,2]` — в "1,2". Строка уходила в scope_key, а
        // getAutonomy ищет по точному ключу — правило записывалось в никуда и
        // молча не действовало.
        //
        // Аудит 2026-08-20: предикат переехал в strictChatId и стал общим с
        // POST /api/tasks — две копии одной проверки уже разошлись однажды.
        // Заодно ключ теперь канонизируется: строка "007" писалась в scope_key
        // как есть, а читатель ищет String(chatId) === "7" — правило снова
        // записывалось в никуда.
        const chatIdNum = strictChatId(body.chat_id);
        if (chatIdNum === null) {
          return json({ error: "bad body: chat_id must be an integer" }, 400);
        }
        const chatKey = String(chatIdNum);
        setAutonomy("chat", chatKey, body.mode as AutonomyMode);
        scope = "chat";
        scopeKey = chatKey;
      } else {
        setAutonomy("global", "*", body.mode as AutonomyMode);
        scope = "global";
        scopeKey = "*";
      }
      const applied = {
        mode: body.mode,
        scope,
        scope_key: scopeKey,
        chat_id: scope === "chat" ? Number(scopeKey) : null,
        agent: scope === "agent" ? scopeKey : null,
      };
      busEmit("agent.autonomy", applied);
      return json({ ok: true, ...applied });
    }

    return json({ error: "not found" }, 404);
  }

  async function serveStatic(url: URL, method: string): Promise<Response | null> {
    if (method !== "GET" && method !== "HEAD") return null;
    if (url.pathname.startsWith("/api/")) return null;
    // System routes — never served as static / SPA fallback.
    if (
      url.pathname === "/metrics" ||
      url.pathname === "/healthz" ||
      url.pathname === "/readyz"
    ) {
      return null;
    }

    // Resolve miniapp/dist relative to this file.
    const distDir = fileURLToPath(new URL("../miniapp/dist/", import.meta.url));

    // Аудит 2026-08-12: `url.pathname` отдаёт путь НЕ декодированным, и
    // `new URL(rel, distRoot)` на `%2f` внутри сегмента бросал
    // «URL must be a non-empty "file:" path» — обычный битый линк давал 500
    // вместо 404. Декодируем сами и сами же ловим кривую последовательность.
    let rel: string;
    try {
      rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    } catch {
      return null; // %zz и прочий мусор — это просто не файл
    }
    if (rel === "" || rel.endsWith("/")) rel += "index.html";

    // Prevent path traversal. Проверка идёт по РАЗОБРАННОМУ абсолютному пути:
    // раньше `rel.includes("..")` смотрела на закодированную строку и ловила
    // `..%2f`, но не `%2e%2e%2f`. Наружу это не выпускало только потому, что
    // парсер URL нормализует `%2e%2e` до pathname — то есть по удаче.
    if (rel.includes("\0")) return null;
    let filePath = resolvePath(distDir, rel);
    if (!filePath.startsWith(distDir)) return null;

    let file = Bun.file(filePath);
    let exists = await file.exists();
    if (!exists) {
      // SPA fallback: serve index.html for non-asset routes.
      const hasExt = /\.[a-zA-Z0-9]+$/.test(rel);
      if (!hasExt) {
        filePath = resolvePath(distDir, "index.html");
        file = Bun.file(filePath);
        exists = await file.exists();
      }
    }
    if (!exists) return null;
    const isHtml = rel.endsWith(".html") || !/\.[a-zA-Z0-9]+$/.test(rel);
    const isHashedAsset = /^assets\/.+-[A-Za-z0-9_-]{6,}\.[a-z]+$/.test(rel);
    const headers: Record<string, string> = {
      "content-type": file.type || "application/octet-stream",
      // Размер файла известен до чтения, а applyCompressionAndEtag решает по
      // Content-Length, буферизовать ли тело вообще. Без заголовка крупный
      // ассет сначала целиком въезжает в память и только потом отбраковывается
      // по размеру — то есть потолок срабатывает уже после того, как за него
      // заплатили.
      "content-length": String(file.size),
    };
    if (isHtml) {
      // HTML — never cache (so Telegram WebView always grabs fresh index.html).
      headers["cache-control"] = "no-store, must-revalidate";
    } else if (isHashedAsset) {
      // Vite-хэшированные ассеты — immutable.
      headers["cache-control"] = "public, max-age=31536000, immutable";
    }
    return new Response(file, { status: 200, headers });
  }

  const server = Bun.serve({
    port,
    // SEC re-audit 2026-06-10 (LOW-MED): bind to loopback by default so the app
    // fails SAFE even if the host firewall is misconfigured — nginx fronts it on
    // 127.0.0.1:8787. Override with MINIAPP_HOST only for a different topology.
    hostname: process.env.MINIAPP_HOST ?? "127.0.0.1",
    // Bun по умолчанию принимает 128 МБ. readJson делает await req.json() без
    // проверки длины, а парсинг идёт в том же треде, что держит SQLite и
    // обслуживает остальные запросы: пачка крупных POST'ов (rate-limit пускает
    // всплеск в 20) душит процесс.
    //
    // (Прежняя редакция комментария ссылалась на «5 МБ в http.ts» как на уже
    // существующий лимит исходящих. Это неверно: maxBytes в http.ts —
    // потолок на Content-Length ОТВЕТОВ, которые мы сами тянем с Figma/TGStat,
    // к нашим ответам он отношения не имеет. Исходящие ограничены лишь
    // потолком gzip в http-utils.ts и LIMIT'ами в самих запросах.)
    maxRequestBodySize: 2_000_000,
    // Аудит 2026-08-13. Дефолт Bun — 10 секунд, и он считает «простоем» в том
    // числе стрим без записи и хендлер, который ещё не ответил. Воспроизведено
    // на голом Bun.serve 1.3.14: `[Bun.serve]: request timed out after 10
    // seconds`, поток отменён, клиенту — обрыв сокета.
    //
    // Что это ломало:
    //  • SSE. Keepalive стоит на 25 с (ниже), то есть заведомо больше десяти:
    //    соединение молчит и умирает на 10-й секунде КАЖДЫЙ раз. Клиент на
    //    onerror переподключается, а onopen сбрасывает backoff в ноль
    //    (`miniapp/src/lib/sse.ts:118`), так что установившийся режим — новый
    //    /api/sse-ticket + /api/events каждые ~11 с на каждую вкладку, вечно.
    //    Реплея нет, поэтому событие, выпавшее в дыру между обрывом и
    //    переподключением, теряется навсегда — то есть «живой прогресс», ради
    //    которого SSE и делался, не работал по построению.
    //  • Апрувы дольше 10 с (MAC_RUN_CLAUDE, GENERATE_IMAGE): сокет рвётся,
    //    хендлер при этом ДОРАБАТЫВАЕТ до конца. Пользователь видит сетевую
    //    ошибку на действие, которое выполнилось, и узнать исход ему неоткуда —
    //    повторить нельзя, строка уже не pending.
    //
    // 255 — потолок, который принимает Bun. Он с запасом покрывает keepalive и
    // почти любой апрув, но НЕ делает ручку решения асинхронной: действие
    // длиннее четырёх минут упрётся в ту же стену. Настоящее лечение для таких —
    // отвечать сразу и отдавать исход событием шины.
    idleTimeout: MINIAPP_IDLE_TIMEOUT_S,
    async fetch(req, server) {
      const url = new URL(req.url);
      const started = Date.now();
      const peer = server.requestIP(req)?.address ?? null;
      let resp: Response;
      let uid: string | number = "-";
      try {
        // Аудит 2026-08-13: здесь id разбирался из `x-telegram-init-data` ДО
        // проверки HMAC — то есть подделывался кем угодно. Запрос без подписи
        // получал 401, но в журнал ложился произвольный чужой telegram-id, и
        // разбор инцидента «кто перебирал ручки» указывал на того, кого выбрал
        // атакующий. Проверенный источник теперь один — `uidHint`, куда пишут
        // обе аутентификации (initData за стеной и SSE-билет). Цена: у запросов,
        // не прошедших проверку, в логе стоит «-». Это и есть правда о них.
        // Всё, что обслуживается ДО стены аутентификации, не попадает ни в
        // одно пользовательское ведро — считаем такие запросы в анонимное, и
        // ДО того, как read файла с диска или ping БД уже случился. Ровно один
        // раз на запрос: /healthz, /readyz и /metrics — тоже не-/api/ пути,
        // и второй счёт внутри route() был бы двойным.
        const preAuth =
          !url.pathname.startsWith("/api/") ||
          url.pathname === "/api/health" ||
          req.method.toUpperCase() === "OPTIONS";
        if (preAuth) {
          const limited = anonLimit(req, peer);
          if (limited) return applyCorsToResponse(req, limited);
        }
        // Static serving for non-/api/ paths (no auth required for assets).
        if (!url.pathname.startsWith("/api/")) {
          const staticResp = await serveStatic(url, req.method.toUpperCase());
          if (staticResp) {
            const compressed = await applyCompressionAndEtag(req, staticResp);
            const finalStatic = applyCorsToResponse(req, compressed);
            const ms = Date.now() - started;
            log.info(
              `[miniapp] ${req.method} ${url.pathname} static -> ${finalStatic.status} (${ms}ms)`,
            );
            return finalStatic;
          }
        }
        resp = await route(req, url, peer);
        // Аудит 2026-08-12: провал аутентификации не стоил ничего. `preAuth`
        // выше false для /api/-путей, а пользовательские вёдра снимаются уже
        // ЗА стеной `authOr401` — то есть запрос с мусорным initData не
        // попадал ни в одно ведро. Замер: 500 × GET /api/tasks с битым
        // заголовком → 500 × 401, ни одного 429, и каждый заход считал
        // HMAC-SHA256 в потоке, которому принадлежит SQLite.
        //
        // Считаем ретроспективно: узнать «будет отказ» до маршрутизации нельзя,
        // а ведро на то и ведро — отказывает следующему. Считаем только отбои
        // ДО пользовательского ведра: отказы `requireAdmin` и origin-проверки
        // приходят от пользователя, который аллоу-лист прошёл и токен уже
        // потратил, — второй счёт наказывал бы соседей по NAT.
        // `wallRejected` добавлен к условию, а не заменил его: 401 отдаёт ещё
        // и обмен SSE-билета (он идёт до стены, по билету, а не по initData),
        // и его тоже нужно считать.
        if (!preAuth && (resp.status === 401 || wallRejected.has(req))) {
          const limited = anonLimit(req, peer);
          if (limited) {
            await resp.text().catch(() => {});
            resp = limited;
          }
        }
      } catch (e: any) {
        log.error("[miniapp] handler error", { error: (e as Error)?.message });
        resp = json({ error: "internal error" }, 500);
      }
      // C27: gzip + ETag pass for API responses (SSE is skipped inside).
      // T-311: then strip wildcard ACAO and echo origin only when allowed.
      //
      // Аудит 2026-08-28: весь этот хвост стоял ЗА `catch` выше, то есть без
      // защиты вообще, а `error`-опции у `Bun.serve` в этом сервере нет.
      // Любой бросок здесь — сжатие многомегабайтного тела, выдача cookie для
      // вычищенной по TTL сессии — уносил уже готовый и корректный ответ,
      // подменял его голым 500 и съедал строку access-лога: в логах на месте
      // запроса оставалась дырка. Собственный try/catch, а не расширение
      // верхнего: тот отдаёт `resp` в пост-обработку, а нам нужно поймать
      // саму пост-обработку.
      try {
        const compressed = await applyCompressionAndEtag(req, resp);
        const finalResp = applyCorsToResponse(req, compressed);
        const sessionToken = pendingSession.get(req);
        let response = finalResp;
        if (sessionToken) {
          // cookieFor, а не cookie: запись сессии могла уйти по TTL, пока
          // обработчик держал ответ. Без cookie клиент просто переоткроет
          // Mini App — это несравнимо мягче, чем 500 на готовом ответе.
          const cookie = sessionStore.cookieFor(sessionToken);
          if (cookie) {
            const headers = new Headers(finalResp.headers);
            headers.set("set-cookie", cookie);
            response = new Response(finalResp.body, {
              status: finalResp.status,
              statusText: finalResp.statusText,
              headers,
            });
          } else {
            log.warn("[miniapp] сессия истекла до выдачи cookie", {
              path: url.pathname,
            });
          }
        }
        const ms = Date.now() - started;
        const hinted = uidHint.get(req);
        if (hinted !== undefined) uid = redactUserId(hinted);
        log.info(
          `[miniapp] ${req.method} ${url.pathname} uid=${uid} -> ${finalResp.status} (${ms}ms)`,
        );
        return response;
      } catch (e) {
        log.error("[miniapp] post-processing error", {
          path: url.pathname,
          error: getErrorMessage(e),
        });
        return json({ error: "internal error" }, 500);
      }
    },
  });

  log.info(`[miniapp] listening on :${server.port}`);

  return {
    stop: () => server.stop(true),
    port: server.port ?? port,
  };
}
