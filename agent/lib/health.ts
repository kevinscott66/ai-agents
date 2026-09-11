/**
 * C22: active health checks for running bots.
 *
 * Periodically calls `bot.telegram.getMe()` for each RunningBot and caches
 * the result. Unlike the passive watchdog (which only watches for silence),
 * this actively confirms each bot's Telegram session is alive.
 *
 * Telegram's getMe is rate-limited; 60s is the floor for the interval.
 */
import { getErrorMessage } from "./errors.ts";
import type { RunningBot } from "./types.ts";
import { log, scrubbedHead } from "./log.ts";

export interface HealthDeps {
  bots: RunningBot[];
  /** Period between ticks. Default 60_000 (60s). Floor enforced at 60_000. */
  intervalMs?: number;
  /** Test seam. */
  now?: () => number;
  /** Потолок ожидания одного getMe. Default HEALTH_GETME_TIMEOUT_MS. */
  getMeTimeoutMs?: number;
  /** Optional callback fired after each tick with the latest snapshot (M2 SSE). */
  onSnapshot?: (snap: HealthSnapshot[]) => void;
}

export interface HealthSnapshot {
  agentKey: string;
  username: string;
  alive: boolean;
  lastOkAt: number | null;
  lastErrorAt: number | null;
  lastError?: string;
  consecutiveFailures: number;
}

/**
 * Что health-снапшот показывает наружу. Ровно те поля, которые уже отдаёт
 * `/api/agents` (buildAgentsList в lib/miniapp-server.ts), плюс ключ агента.
 *
 * Существует потому, что к этим данным ведут две двери, и вторая была открыта:
 * REST проецировал снапшот и `lastError` выбрасывал, а SSE-шина в
 * orchestrator/services.ts публиковала внутренний тип целиком — всем, кто в
 * allowlist, без admin-проверки. `lastError` при этом содержал текст ошибки
 * node-fetch с токеном бота в URL. Проекция здесь, а не на месте отправки:
 * иначе следующий потребитель снапшота повторит ту же ошибку.
 */
export interface PublicHealthInfo {
  agentKey: string;
  alive: boolean;
  lastOkAt: number | null;
  consecutiveFailures: number;
}

export function publicHealth(snap: HealthSnapshot[]): PublicHealthInfo[] {
  return snap.map((s) => ({
    agentKey: s.agentKey,
    alive: s.alive,
    lastOkAt: s.lastOkAt,
    consecutiveFailures: s.consecutiveFailures,
  }));
}

export interface HealthMonitorHandle {
  stop: () => void;
  snapshot: () => HealthSnapshot[];
  _tick: () => Promise<void>;
}

const MIN_INTERVAL_MS = 60_000;

/**
 * Потолок ожидания одного getMe. Меньше MIN_INTERVAL_MS специально: зависший
 * тик обязан завершиться раньше, чем таймер попробует запустить следующий,
 * иначе защита от наложения превратилась бы в «проверок больше нет».
 *
 * Без потолка зависший сокет — это не ошибка, а отсутствие события: catch в
 * tickOne не срабатывает никогда, снапшот остаётся `alive: true` с протухшим
 * lastOkAt, и pickAvailableAgent продолжает слать делегирования в бота, до
 * которого не достучаться.
 */
export const HEALTH_GETME_TIMEOUT_MS = 15_000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${what} timeout after ${ms}ms`)),
      ms,
    );
    if (typeof (t as any).unref === "function") (t as any).unref();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * Process-global registry of latest per-agent health snapshots. Наполняет его
 * `runTick` напрямую, БЕЗУСЛОВНО — не `onSnapshot`, как тут было написано.
 * Разница не косметическая: `onSnapshot` необязателен, и читатель, поверив
 * прежней формулировке, искал бы причину залипшего фолбэка в его проводке
 * (orchestrator/services.ts), а не в тике. Спрашивает реестр логика фолбэка
 * делегирования — `isAgentAvailable` в lib/role-skills.ts.
 *
 * Аудит 2026-09-11: реестр ПЕРЕЖИВАЛ `stop()`. `isAgentAvailable` держит
 * fail-open ровно на отсутствии записи («No health info → treat as
 * available (monitor may not be running)»), а после остановки монитора запись
 * оставалась — с последним, уже неопровержимым `alive: false`. Замер: три
 * неудачных тика по ключу `backend`, затем `stop()` — и
 * `isAgentAvailable("backend")` навсегда `false`, `pickAvailableAgent("backend")`
 * навсегда уводит в `tgdev`. Монитора, который мог бы это опровергнуть, уже
 * нет; чинить нечего и некому. То есть остановка монитора не возвращала
 * систему в состояние «о здоровье ничего не известно», а фиксировала худший
 * из виденных снимков навсегда.
 *
 * Второй адресат правки — прогон тестов: реестр процессный, `bun test` гоняет
 * все файлы в одном процессе, а хука сброса тут не было вовсе (у такой же
 * модульной карты в watchdog.ts он есть — `_resetWatchdogState`). Сегодня не
 * стреляет случайно: файлы, где бот падает, берут синтетические ключи
 * (`beta`, `gamma`, `hung`, `flaky`), а единственный настоящий ключ с отказом
 * — `orchestrator` в health-error-token-leak — набирает ровно один
 * consecutiveFailure на свежем мониторе, и порог `> 2` его не ловит. Один
 * лишний `_tick()` в той фикстуре сделал бы `pickAvailableAgent` в любом
 * последующем файле зависящим от порядка прогона.
 */
const HEALTH_REGISTRY = new Map<string, HealthSnapshot>();

export function getHealthSnapshot(agentKey: string): HealthSnapshot | undefined {
  return HEALTH_REGISTRY.get(agentKey);
}

/**
 * Только для тестов: чистит реестр целиком. В отличие от `_resetWatchdogState`,
 * сбрасывает ВСЁ состояние, переживающее экземпляр: другого у монитора нет —
 * `state`, `inFlight` и таймер живут внутри `startHealthMonitor`.
 */
export function _resetHealthRegistry(): void {
  HEALTH_REGISTRY.clear();
}

export function startHealthMonitor(deps: HealthDeps): HealthMonitorHandle {
  const { bots, now = () => Date.now() } = deps;
  const intervalMs = Math.max(
    MIN_INTERVAL_MS,
    deps.intervalMs ?? 60_000,
  );
  const getMeTimeoutMs = deps.getMeTimeoutMs ?? HEALTH_GETME_TIMEOUT_MS;

  const state = new Map<string, HealthSnapshot>();
  for (const b of bots) {
    state.set(b.def.key, {
      agentKey: b.def.key,
      username: b.username,
      alive: false,
      lastOkAt: null,
      lastErrorAt: null,
      consecutiveFailures: 0,
    });
  }

  const tickOne = async (b: RunningBot): Promise<void> => {
    const key = b.def.key;
    const prev = state.get(key)!;
    try {
      await withTimeout(
        Promise.resolve(b.bot.telegram.getMe()),
        getMeTimeoutMs,
        "getMe",
      );
      state.set(key, {
        ...prev,
        username: b.username,
        alive: true,
        lastOkAt: now(),
        consecutiveFailures: 0,
        lastError: undefined,
      });
    } catch (e: any) {
      // Скрабим ДО обрезки: текст ошибки от node-fetch@2 начинается с
      // `request to https://api.telegram.org/bot<ТОКЕН>/getMe failed…`, то есть
      // токен стоит в первых же символах и никакой slice его не срежет. Отсюда
      // он уезжал в SSE (см. publicHealth ниже) — то есть всем пользователям
      // Mini App, при первом же ECONNREFUSED до Telegram.
      const msg = scrubbedHead(e?.message ?? String(e), 200);
      state.set(key, {
        ...prev,
        username: b.username,
        alive: false,
        lastErrorAt: now(),
        lastError: msg,
        consecutiveFailures: prev.consecutiveFailures + 1,
      });
    }
  };

  const snapshotNow = (): HealthSnapshot[] =>
    bots.map((b) => state.get(b.def.key)!).filter(Boolean);

  const runTick = async (): Promise<void> => {
    await Promise.allSettled(bots.map(tickOne));
    // Publish into process-global registry for delegation-fallback queries.
    for (const b of bots) {
      const s = state.get(b.def.key);
      if (s) HEALTH_REGISTRY.set(b.def.key, s);
    }
    if (deps.onSnapshot) {
      try {
        deps.onSnapshot(snapshotNow());
      } catch (e) {
        log.error("[health] onSnapshot err", {
          error: getErrorMessage(e),
        });
      }
    }
  };

  /**
   * Один тик за раз. Таймер бьёт каждые 60 секунд и раньше не ждал предыдущий:
   * если проверка затянулась, поверх неё стартовала следующая, и getMe'шки
   * копились вместе со своими промисами. Тот, кто позвал во время полёта,
   * получает текущий тик, а не пропуск: свежесть данных та же, а вызывающему
   * не приходится гадать, отработала проверка или её молча съели.
   */
  let inFlight: Promise<void> | null = null;
  const tick = (): Promise<void> => {
    if (inFlight) return inFlight;
    const p = runTick().finally(() => {
      if (inFlight === p) inFlight = null;
    });
    inFlight = p;
    return p;
  };

  // Immediate first tick (fire-and-forget; tests use _tick).
  tick().catch((e) =>
    log.error("[health] initial tick err", {
      error: getErrorMessage(e),
    }),
  );

  const timer = setInterval(() => {
    tick().catch((e) =>
      log.error("[health] tick err", {
        error: getErrorMessage(e),
      }),
    );
  }, intervalMs);
  if (typeof (timer as any).unref === "function") (timer as any).unref();

  return {
    // Снимаем СВОИ ключи, а не весь реестр: чужие записи не наши, чтобы их
    // отменять. Смысл — вернуть fail-open из `isAgentAvailable`: монитора
    // больше нет, значит о здоровье этих ботов снова ничего не известно.
    stop: () => {
      clearInterval(timer);
      for (const b of bots) HEALTH_REGISTRY.delete(b.def.key);
    },
    snapshot: snapshotNow,
    _tick: tick,
  };
}
