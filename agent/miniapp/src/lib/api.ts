import { ellipsize } from "./text";
import type {
  AgentInfo,
  Approval,
  AgentAction,
  Permission,
  Task,
  TaskStatus,
  AutonomyMode,
} from "./types";

declare global {
  interface Window {
    Telegram?: {
      WebApp?: any;
    };
  }
}

function getInitData(): string {
  try {
    return window.Telegram?.WebApp?.initData ?? "";
  } catch {
    return "";
  }
}

/**
 * Машинные коды, которыми сервер отвечает вместо человеческого текста.
 *
 * `mac_offline` — код от моста Mac. Показывать его как есть некому, а общая
 * строка про недоступный сервер панели тут прямо неверна: панель ответила, не
 * на связи Mac.
 *
 * Аудит 2026-08-29: `internal error` — единственная непрозрачная константа,
 * которую пишет сам сервер (два места в lib/miniapp-server.ts, обработчик
 * необработанного исключения). Ветка `status >= 400` ниже отдавала её
 * дословно и тем самым перехватывала управление у ветки `status >= 500`:
 * пользователь получал английское `internal error` вместо русской строки о
 * временной недоступности. Строка непустая, поэтому общий порог её не ловил —
 * лечится здесь, точечно, а не запретом на весь 5xx.
 *
 * Именно точечно: 502/503 несут `result.error` от моста, и этот текст
 * осмысленный. Глушить весь 5xx означало бы стереть его вместе с шумом.
 */
const SERVER_CODES: Record<string, string> = {
  mac_offline: "Mac не на связи: мост не подключён. Проверьте, что демон запущен.",
  "internal error": "Сервер панели временно недоступен. Повторите попытку позже.",
};

/** Потолок на текст с сервера: он идёт в тост, а не в отдельный экран. */
const MAX_SERVER_TEXT = 300;

/**
 * Текст отказа, который сервер написал сам.
 *
 * `apiRequest` кладёт разобранное тело в `err.body`; тело может оказаться и
 * строкой (не-JSON ответ nginx), поэтому читаем только объектное `error`.
 */
function serverErrorText(error: unknown): string {
  const raw = (error as any)?.body?.error;
  if (typeof raw !== "string") return "";
  const text = raw.trim();
  if (!text) return "";
  const known = SERVER_CODES[text];
  if (known) return known;
  return ellipsize(text, MAX_SERVER_TEXT);
}

export function formatApiError(error: unknown): string {
  // Аудит 2026-08-28: ветки ниже разбирают только `status` (у таймаута его
  // нет — ноль) и регексп сетевых сообщений, под который «Сервер не ответил»
  // не попадает. Поэтому собственный текст таймаута никуда не доходил: в
  // ErrorBox уезжало общее «Не удалось загрузить панель», а причину — сервер
  // молчит — пользователь не видел ни разу. Флаг ставит apiRequest, и кроме
  // него `timeout` никто не выставляет.
  if ((error as any)?.timeout === true) {
    const message = String((error as any)?.message ?? "");
    if (message) return message;
  }
  const status = typeof (error as any)?.status === "number" ? (error as any).status : 0;
  if (status === 401) {
    return "Telegram-сессия не передана. Откройте панель через Telegram Mini App.";
  }
  if (status === 403) {
    return "У пользователя нет доступа к панели или прав администратора.";
  }
  if (status === 404) {
    return "Маршрут панели не найден. Проверьте версию backend и URL Mini App.";
  }
  if (status === 429) return "Слишком много запросов. Повторите через несколько секунд.";

  // Аудит 2026-08-28: сюда доходили все отказы записи — 409 «строка не
  // подействует» от POST /api/permissions, 400 «bad body: …» и сообщения FSM
  // от задач, 502/503 от моста — и заменялись на «Не удалось загрузить
  // панель». Для мутации это ещё и неправда: панель загрузилась, отказала
  // запись. Текст сервер написал сам, и он лежал в `err.body` нетронутым.
  //
  // Ветки выше остаются жёсткими: 401/403/404/429 — про сессию и маршрут,
  // там тело («forbidden») ничего не добавляет.
  if (status >= 400) {
    const fromServer = serverErrorText(error);
    if (fromServer) return fromServer;
  }
  if (status >= 500) return "Сервер панели временно недоступен. Повторите попытку позже.";

  const message = String((error as any)?.message ?? "");
  if (/failed to fetch|load failed|networkerror/i.test(message)) {
    return "Панель недоступна. Проверьте URL, DNS и соединение с сервером.";
  }
  return "Не удалось загрузить панель. Повторите попытку.";
}

/**
 * Потолок ожидания одного запроса.
 *
 * Аудит 2026-08-20: его не было вовсе. Страницы устроены как
 * `setLoading(true) → await api.X() → finally setLoading(false)`, поэтому
 * запрос, на который сервер не отвечает, оставляет вкладку в скелетоне
 * навсегда — без текста ошибки и без кнопки «Повторить» (ErrorBox рисуется
 * только по пойманной ошибке). Браузер такой сокет сам не рвёт: соединение
 * принято и живо, просто молчит.
 *
 * Это не абстрактный риск: сервер Mini App живёт на том же единственном потоке
 * `Bun.serve`, что SQLite и все 12 ботов (см. докблок lib/coalesce.ts), а
 * ночной бэкап делает `VACUUM INTO` по всей базе и `tar` по вики синхронно
 * (lib/backup.ts).
 *
 * 20 секунд: заметно больше самого тяжёлого живого ответа (/api/dashboard —
 * порядка 45 синхронных запросов к SQLite) и заметно меньше того молчания в
 * несколько минут, которым закончится ожидание у браузера.
 */
export const API_TIMEOUT_MS = 20_000;

export interface ApiRequestOptions extends RequestInit {
  /** Переопределение потолка (тесты). */
  timeoutMs?: number;
}

export async function apiRequest<T>(
  path: string,
  opts: ApiRequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = {
    "X-Telegram-Init-Data": getInitData(),
    ...((opts.headers as Record<string, string>) ?? {}),
  };
  if (opts.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const { timeoutMs, ...init } = opts;
  const limit = timeoutMs ?? API_TIMEOUT_MS;
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, limit);
  let r: Response;
  let text: string;
  try {
    r = await fetch(path, { ...init, headers, signal: ctl.signal });
    // Аудит 2026-08-28: чтение тела раньше стояло ЗА `finally`, то есть уже
    // без таймера и с отработавшим signal. А `fetch` завершается на
    // заголовках: тело, вставшее посреди потока, не обрывал никто, и промис
    // не завершался — ровно та вечная загрузка, ради которой потолок и
    // заводили. Ожидание одно на весь запрос, значит и таймер один.
    text = await r.text();
  } catch (e: any) {
    if (timedOut) {
      // Наружу — текст для человека: он идёт прямо в ErrorBox рядом с
      // кнопкой «Повторить». "AbortError" там читать некому.
      const err: any = new Error(
        `Сервер не ответил за ${Math.round(limit / 1000)} с`,
      );
      err.timeout = true;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!r.ok) {
    const err: any = new Error(
      (body && body.error) || `HTTP ${r.status}`,
    );
    err.status = r.status;
    err.body = body;
    throw err;
  }
  return body as T;
}

const req = apiRequest;

export interface DashboardPayload {
  /**
   * Счётчики для карточек — числа с сервера, а не длины списков ниже.
   * Списки намеренно обрезаны (10/10/20), и до аудита 2026-08-12 карточки
   * считались по ним: «Задач в очереди» не могло показать больше десяти.
   */
  counts?: {
    tasksPending: number;
    approvalsPending: number;
    actionsSince: number;
    since: number;
  };
  agents: AgentInfo[];
  recentTasks: Task[];
  pendingApprovals: Approval[];
  recentActions: AgentAction[];
  budgets: {
    agentKey: string;
    usedTokens: number;
    outputTokens: number;
    limit: number | null;
    resetAt: number;
  }[];
}

export const api = {
  health: () => req<{ ok: boolean; ts: number; mac_online?: boolean }>("/api/health"),
  macStop: () =>
    req<{ ok: true; result: { stopped: true } }>("/api/mac/stop", {
      method: "POST",
    }),
  dashboard: (since?: number) =>
    req<DashboardPayload>(
      since === undefined
        ? "/api/dashboard"
        : `/api/dashboard?since=${encodeURIComponent(String(since))}`,
    ),
  agents: () => req<{ agents: AgentInfo[] }>("/api/agents"),
  budgets: () =>
    req<{
      budgets: {
        agentKey: string;
        usedTokens: number;
        outputTokens: number;
        limit: number | null;
        resetAt: number;
      }[];
      /** Разрешит ли сервер POST. Не выводить из кодов ошибок — GET открыт всем. */
      admin?: boolean;
    }>("/api/budgets"),

  budgetSettings: () =>
    req<{
      settings: {
        agentKey: string;
        dailyInputTokens: number;
        updatedAt: number;
        updatedBy: string;
      }[];
    }>("/api/budget-settings"),
    
  // `null` очищает override (сервер: "positive number or null"). Тип был
  // `number`, из-за чего «убрать лимит» из UI не выражалось вовсе.
  updateBudget: (body: {
    agentKey: string;
    dailyInputTokens: number | null;
  }) =>
    req<{ ok: true; agentKey: string; dailyInputTokens: number | null }>("/api/budgets", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  tasks: (params: {
    chat_id?: number;
    assignee?: string;
    status?: TaskStatus;
    limit?: number;
  } = {}) => {
    const q = new URLSearchParams();
    if (params.chat_id != null) q.set("chat_id", String(params.chat_id));
    if (params.assignee) q.set("assignee", params.assignee);
    if (params.status) q.set("status", params.status);
    if (params.limit) q.set("limit", String(params.limit));
    const qs = q.toString();
    return req<{ tasks: Task[]; truncated: boolean }>(
      `/api/tasks${qs ? "?" + qs : ""}`,
    );
  },
  task: (id: string) => req<{ task: Task }>(`/api/tasks/${id}`),
  createTask: (body: {
    title: string;
    chat_id: number;
    assignee?: string;
    type?: string;
    input?: unknown;
    description?: string;
  }) =>
    req<{ task: Task }>(`/api/tasks`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  pauseAgent: (key: string) =>
    req<{ ok: boolean; paused: boolean }>(`/api/agents/${encodeURIComponent(key)}/pause`, {
      method: "POST",
    }),
  resumeAgent: (key: string) =>
    req<{ ok: boolean; paused: boolean }>(`/api/agents/${encodeURIComponent(key)}/resume`, {
      method: "POST",
    }),
  taskStatus: (
    id: string,
    body: { status: TaskStatus; by?: string; output?: unknown; error?: string },
  ) =>
    req<{ task: Task }>(`/api/tasks/${id}/status`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  wikiList: (scope?: string) => {
    const q = new URLSearchParams();
    if (scope) q.set("scope", scope);
    const qs = q.toString();
    return req<{
      pages: { scope: string; slug: string; title: string }[];
      // Сервер режет выдачу по потолку. Молча обрезанный список неотличим от
      // полного, а Wiki-вью фильтрует клиентски: без флага «страницы нет»
      // показывалось бы вместо «не влезла в выдачу».
      truncated?: boolean;
      // Полный список разделов — считается по всей вике, а не по выдаче.
      // Выведённый из обрезанной выдачи он терял ровно те разделы, ради
      // которых фильтр и нужен (аудит 2026-08-21).
      scopes?: string[];
    }>(`/api/wiki/list${qs ? "?" + qs : ""}`);
  },
  wikiPage: (scope: string, slug: string) => {
    const q = new URLSearchParams({ scope, slug });
    return req<{ scope: string; slug: string; content: string }>(
      `/api/wiki/page?${q.toString()}`,
    );
  },

  approvals: (params: {
    status?: string;
    chat_id?: number;
    limit?: number;
  } = {}) => {
    const q = new URLSearchParams();
    if (params.status) q.set("status", params.status);
    if (params.chat_id != null) q.set("chat_id", String(params.chat_id));
    if (params.limit) q.set("limit", String(params.limit));
    const qs = q.toString();
    return req<{ approvals: Approval[] }>(
      `/api/approvals${qs ? "?" + qs : ""}`,
    );
  },
  decideApproval: (
    id: string,
    body: { decision: "approved" | "rejected"; reason?: string },
  ) =>
    req<{ approval: Approval }>(`/api/approvals/${id}/decide`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  actions: (params: {
    agent?: string;
    chat_id?: number;
    status?: string;
    type?: string;
    limit?: number;
    before_id?: string;
  } = {}) => {
    const q = new URLSearchParams();
    if (params.agent) q.set("agent", params.agent);
    if (params.chat_id != null) q.set("chat_id", String(params.chat_id));
    if (params.status) q.set("status", params.status);
    if (params.type) q.set("type", params.type);
    if (params.limit) q.set("limit", String(params.limit));
    if (params.before_id) q.set("before_id", params.before_id);
    const qs = q.toString();
    return req<{ actions: AgentAction[] }>(
      `/api/actions${qs ? "?" + qs : ""}`,
    );
  },

  permissions: (agent?: string) => {
    const qs = agent ? `?agent=${encodeURIComponent(agent)}` : "";
    return req<{ permissions: Permission[] }>(`/api/permissions${qs}`);
  },
  setPermission: (body: {
    agentKey: string;
    actionType: string;
    allowed: boolean;
    requires_approval: boolean;
  }) =>
    // `caveat` — строка записана, но действует не везде (SEMI_AUTO_RISKY в
    // чатах с автономией semi_auto). Не ошибка: показывать вместе с успехом.
    req<{ permission: Permission; caveat: string | null }>(`/api/permissions`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  autonomy: (params: { chat_id?: number; agent?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.chat_id != null) q.set("chat_id", String(params.chat_id));
    if (params.agent) q.set("agent", params.agent);
    const qs = q.toString();
    return req<{
      mode: AutonomyMode;
      chat_id: number | null;
      agent: string | null;
      /** Тот же гейт, что у POST /api/autonomy. */
      admin?: boolean;
      /**
       * Роли со СВОЕЙ строкой режима. Она сильнее чатовой и глобальной, так что
       * `mode` выше — эффективный режим, а не признак переопределения: без этого
       * списка их не отличить (аудит 2026-08-21).
       */
      agent_overrides?: Array<{ agent: string; mode: AutonomyMode }>;
    }>(`/api/autonomy${qs ? "?" + qs : ""}`);
  },
  setAutonomy: (body: {
    /** `inherit` снимает переопределение роли; допустим только вместе с `agent`. */
    mode: AutonomyMode | "inherit";
    chat_id?: number;
    agent?: string;
  }) =>
    req<{
      ok: boolean;
      /**
       * Что легло в БД. Для `inherit` — `null`: строка роли снята, режима
       * после неё нет никакого (аудит 2026-09-11; раньше сюда эхом уходил
       * `"inherit"` — значение, которого нет ни в одной строке autonomy_modes).
       */
      mode: AutonomyMode | null;
      /** true — строку сняли, роль снова наследует чат и глобальный режим. */
      inherit: boolean;
      chat_id: number | null;
      agent: string | null;
    }>(`/api/autonomy`, { method: "POST", body: JSON.stringify(body) }),
};
