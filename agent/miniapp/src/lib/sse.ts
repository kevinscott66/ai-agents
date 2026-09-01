/**
 * Mini App SSE client (M2).
 *
 * Wraps native EventSource against `/api/events`. Auto-reconnects with
 * 1s → 2s → 5s backoff capped at 10s. Listeners are global by event name —
 * the same handler can be added once and survives reconnects.
 */
declare global {
  interface Window {
    Telegram?: { WebApp?: any };
  }
}

/**
 * `unauthorized` — терминальное состояние: сервер отказал в билете по
 * аутентификации (401/403), и повторять запрос бессмысленно до тех пор, пока
 * приложение не откроют заново. Все остальные состояния временные.
 */
export type ConnState =
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed"
  | "unauthorized";

type Handler = (payload: unknown) => void;

const handlers = new Map<string, Set<Handler>>();
const stateListeners = new Set<(s: ConnState) => void>();
/**
 * Имена, на которые уже навешан нативный слушатель ТЕКУЩЕГО `es`.
 *
 * Аудит 2026-08-11: без этого учёта подписка на живом соединении вешала по
 * слушателю на каждый цикл. Отписка при опустевшем наборе делает
 * `handlers.delete(name)`, поэтому следующая подписка на то же имя снова
 * считалась первой — а слушатели с соединения не снимаются. Оба ходят в один
 * набор обработчиков, то есть одно событие вызывало `load()` дважды, трижды,
 * N раз. Tasks.tsx пересобирает подписку на каждое изменение фильтра, Dashboard
 * — на каждый вход на страницу (там семь имён).
 *
 * Привязка именно к соединению, а не к процессу: после обрыва создаётся новый
 * EventSource, у него слушателей нет, и их надо навесить заново — иначе
 * события перестанут доходить совсем.
 */
const attached = new Set<string>();

let es: EventSource | null = null;
let state: ConnState = "closed";
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let backoffStep = 0;
let connecting = false;
/**
 * Аудит 2026-08-20: билет не выдан по аутентификации — переподключаться
 * нечем. См. комментарий у `fetchTicket`.
 */
let authFailed = false;
/** Растёт на close(): подключение, начатое до него, не должно ожить после. */
let generation = 0;
const BACKOFF_MS = [1000, 2000, 5000, 10000];

function setState(next: ConnState) {
  if (state === next) return;
  state = next;
  for (const fn of stateListeners) {
    try {
      fn(next);
    } catch {}
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
 * Билет на подключение. EventSource не умеет заголовки, а тащить initData в
 * query нельзя: это суточный ключ ко всем /api/*, а query-строку пишет
 * access-лог nginx. Поэтому обычным POST'ом (initData едет заголовком) берём
 * одноразовый токен на 30 секунд и его уже кладём в URL.
 */
type TicketResult =
  | { ok: true; ticket: string }
  | { ok: false; terminal: boolean };

async function fetchTicket(): Promise<TicketResult> {
  try {
    const r = await fetch("/api/sse-ticket", {
      method: "POST",
      headers: { "X-Telegram-Init-Data": getInitData() },
    });
    // Аудит 2026-08-20: раньше здесь было `if (!r.ok) return null` — статус
    // выбрасывался, и отказ навсегда становился неотличим от секундной
    // сетевой ошибки. Ручка стоит ЗА стеной аутентификации, а initData живёт
    // сутки: у вкладки, провисевшей ночь, каждая попытка получает 401. Дальше
    // цикл упирался в потолок бэкоффа и стучался в сервер каждые 10 секунд до
    // закрытия приложения, а пользователь всё это время видел
    // «Переподключение…» без единого намёка на причину.
    //
    // 401 — подпись/срок initData, 403 — аллоу-лист или origin. Ни то, ни
    // другое не чинится повтором того же запроса с тем же initData.
    // 429 и 5xx — временные, их ретраим как раньше. Исключение внутри 401 —
    // гонка анти-реплея, разобрана ниже (аудит 2026-08-28).
    // Аудит 2026-08-28: 401 бывает двух разных природ, а считался одной.
    //
    // `/api/sse-ticket` — POST, то есть для сервера это мутация, и он гоняет её
    // через анти-реплей (auth-middleware.ts): отпечаток initData помечается
    // израсходованным в момент ВЫДАЧИ сессии, а cookie с токеном уезжает лишь
    // в хвосте ответа. Пока она не вернулась в браузер, второй одновременный
    // POST с тем же initData делает `issue()` ещё раз и получает 401
    // «replayed initData» — при том что его initData совершенно валиден.
    // Проигравшим оказывается и билет по таймеру переподключения, и обычная
    // мутация от пользователя: кто пришёл вторым, тот и получил отказ.
    //
    // Дальше отказ трактовался как терминальный: `authFailed = true` снимается
    // только `close()`, которого в miniapp/src никто не зовёт. То есть живые
    // обновления умирали на весь сеанс, а App.tsx показывал «Сессия Telegram
    // истекла» — диагноз, к происходящему отношения не имеющий.
    //
    // Этот 401 как раз повторяется с пользой: к следующей попытке cookie
    // победителя уже в браузере (тогда сработает `validate`), либо истёк
    // пятиминутный TTL отпечатка и `issue()` выдаст новую сессию. Терминальны
    // по-прежнему остальные 401 (подпись/срок initData) и все 403.
    if (!r.ok) {
      if (r.status === 401) {
        let replayRace = false;
        try {
          const body = await r.json();
          replayRace = body?.error === "replayed initData";
        } catch {}
        return { ok: false, terminal: !replayRace };
      }
      return { ok: false, terminal: r.status === 403 };
    }
    const body = await r.json();
    return typeof body?.ticket === "string"
      ? { ok: true, ticket: body.ticket }
      : { ok: false, terminal: false };
  } catch {
    // Сеть/парсинг — временное.
    return { ok: false, terminal: false };
  }
}

async function connect() {
  if (typeof EventSource === "undefined") {
    setState("closed");
    return;
  }
  // Между запросом билета и открытием потока есть await, и всё это время
  // `es === null` — то есть второй вызов connect() (из subscribe(), из
  // таймера бэкоффа) пролезет и заведёт вторую подписку. Флаг закрывает окно.
  if (connecting) return;
  // Билет уже отклонён по аутентификации. Пробовать снова — тот же 401 и та же
  // нагрузка на общее POST-ведро пользователя. Снимается только `close()`.
  if (authFailed) {
    setState("unauthorized");
    return;
  }
  connecting = true;
  const gen = generation;
  setState(es ? "reconnecting" : "connecting");
  try {
    const res = await fetchTicket();
    // За время запроса кто-то мог вызвать close() — тогда поднимать поток
    // уже нельзя, иначе он переживёт явное закрытие.
    if (gen !== generation) return;
    if (!res.ok) {
      if (res.terminal) {
        authFailed = true;
        setState("unauthorized");
      } else {
        scheduleReconnect();
      }
      return;
    }
    es = new EventSource(`/api/events?ticket=${encodeURIComponent(res.ticket)}`);
    attached.clear();
  } catch {
    scheduleReconnect();
    return;
  } finally {
    connecting = false;
  }

  es.onopen = () => {
    backoffStep = 0;
    setState("open");
  };
  es.onerror = () => {
    // EventSource has its own reconnect, but we tear down + back off to
    // avoid tight loops on auth/network failure.
    try {
      es?.close();
    } catch {}
    es = null;
    attached.clear();
    scheduleReconnect();
  };

  // Wire all known handlers as named listeners.
  for (const name of handlers.keys()) attachListener(name);
}

function attachListener(name: string) {
  if (!es || attached.has(name)) return;
  attached.add(name);
  es.addEventListener(name, (ev: MessageEvent) => {
    const set = handlers.get(name);
    if (!set || set.size === 0) return;
    let parsed: unknown = null;
    try {
      parsed = ev.data ? JSON.parse(ev.data) : null;
    } catch {
      parsed = ev.data;
    }
    for (const fn of set) {
      try {
        fn(parsed);
      } catch (e) {
        console.error("[sse] handler error:", e);
      }
    }
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  // Обрыв самого потока (`es.onerror`) приходит сюда же. Если билет уже
  // отклонён навсегда, ждать нечего — показываем причину сразу, а не через
  // очередные десять секунд «Переподключение…».
  if (authFailed) {
    setState("unauthorized");
    return;
  }
  const ms = BACKOFF_MS[Math.min(backoffStep, BACKOFF_MS.length - 1)];
  backoffStep++;
  setState("reconnecting");
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, ms);
}

export function subscribe(eventName: string, handler: Handler): () => void {
  let set = handlers.get(eventName);
  if (!set) {
    set = new Set();
    handlers.set(eventName, set);
  }
  set.add(handler);
  // Идемпотентно: если слушатель на это имя уже висит на текущем соединении,
  // второй не появится. Условие «первый обработчик» здесь и было багом.
  if (es) attachListener(eventName);

  if (!es && !reconnectTimer && !connecting) void connect();

  return () => {
    const s = handlers.get(eventName);
    if (!s) return;
    s.delete(handler);
    if (s.size === 0) handlers.delete(eventName);
  };
}

export function onState(fn: (s: ConnState) => void): () => void {
  stateListeners.add(fn);
  fn(state);
  return () => {
    stateListeners.delete(fn);
  };
}

export function currentState(): ConnState {
  return state;
}

/** Force-close the connection (rarely needed). */
export function close(): void {
  generation++;
  // `close()` — это «начать сначала», а не «выключить навсегда»: следующий
  // subscribe() имеет право на новую попытку. Иначе модуль оставался бы
  // отравленным до перезагрузки страницы.
  //
  // Шаг бэкоффа сбрасывается по той же причине. Он обнулялся только в
  // `es.onopen`, то есть после явного закрытия соединение, которое до этого
  // несколько раз не поднялось, начинало новую жизнь сразу с десятисекундной
  // паузы — хотя закрыли его мы сами и причина обрыва уже неизвестна.
  authFailed = false;
  backoffStep = 0;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (es) {
    try {
      es.close();
    } catch {}
    es = null;
  }
  attached.clear();
  setState("closed");
}
