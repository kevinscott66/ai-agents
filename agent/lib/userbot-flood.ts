/**
 * T-402: Userbot FLOOD_WAIT handling + anti-flood gate.
 *
 * Provides:
 *  - `floodBackoffMs(attempt, serverSeconds?)` — pure, testable backoff calculator.
 *  - `withUserbotFloodGuard(...)` — wraps a userbot send call with:
 *      1. Pre-send per-(account, chatId) sliding-window rate-limit check (via rate-limits.ts).
 *      2. On FLOOD_WAIT error from gramjs: exponential backoff, respects server-provided seconds, capped.
 *      3. Optional episode incident recorder (injectable for testability).
 */

import {
  parseFloodWaitSeconds,
  isFloodWaitError,
  isSlowModeWaitError,
  parseSlowModeWaitSeconds,
} from "./flood-wait-error.ts";
import {
  checkUserbotFloodLimit,
  commitUserbotFloodLimit,
  userbotAccountKey,
} from "./rate-limits.ts";
import { emitAlert } from "./alerting.ts";
import { log } from "./log.ts";

// ─── Backoff calculator ────────────────────────────────────────────────────

/** Первая пауза; дальше удваивается до MAX_BACKOFF_MS — см. `floodBackoffMs`. */
export const INITIAL_BACKOFF_MS = 1_000;
export const MAX_BACKOFF_MS = 60_000;

/**
 * Calculate delay in ms before the next attempt after a FLOOD_WAIT.
 *
 * Strategy: take the larger of (server-provided wait, exponential base),
 * then add jitter, then cap at MAX_BACKOFF_MS.
 *
 *   base = min(INITIAL_BACKOFF_MS * 2^attempt, MAX_BACKOFF_MS)
 *   serverMs = serverSeconds * 1000 (if provided)
 *   result = min(max(base, serverMs) + jitter, MAX_BACKOFF_MS)
 *
 * Keeping this as a pure function (no side-effects) makes it easy to unit-test.
 *
 * @param attempt   0-based retry attempt number
 * @param serverSeconds  seconds requested by Telegram (from FLOOD_WAIT_<N>), optional
 * @param _jitter   override jitter for deterministic tests (default: random 0-1000ms)
 */
export function floodBackoffMs(
  attempt: number,
  serverSeconds?: number,
  _jitter?: number,
): number {
  const jitter = _jitter ?? Math.floor(Math.random() * 1_000);
  const exp = Math.min(INITIAL_BACKOFF_MS * Math.pow(2, attempt), MAX_BACKOFF_MS);
  const serverMs = serverSeconds != null && serverSeconds > 0 ? serverSeconds * 1_000 : 0;
  const base = Math.max(exp, serverMs);
  return Math.min(base + jitter, MAX_BACKOFF_MS);
}

/**
 * Требует ли Telegram паузу длиннее той, что мы вообще готовы проспать.
 *
 * Аудит 2026-08-09: сам по себе потолок в floodBackoffMs правильный — держать
 * вызов открытым сутки из-за FLOOD_WAIT_86400 нельзя. Неправильным было то, что
 * следовало за обрезкой: цикл ретраев спал урезанные 60 секунд и стучался
 * снова — то есть ТРИ раза внутри окна, которое Telegram попросил переждать.
 * Сервер сказал «молчи 300 секунд», мы отвечали четырьмя попытками за первые
 * пять минут. Ровно так временная пауза превращается в длинную блокировку
 * отправки, и это аккаунт ВЛАДЕЛЬЦА, а не бот: бана здесь стоит не сообщение,
 * а личный Telegram.
 *
 * Поэтому потолок теперь означает не «спим меньше, чем просили», а «столько
 * ждать мы не будем — и повторять тоже не будем». Действие возвращается наверх
 * ошибкой (dispatchAction запишет status='error'), инцидент уходит в audit_logs.
 * Ретраи остаются там, где они безопасны: когда сервер просит паузу короче
 * нашего потолка, мы её честно выдерживаем целиком.
 */
export function exceedsMaxFloodWait(serverSeconds: number | undefined): boolean {
  return serverSeconds != null && serverSeconds * 1_000 > MAX_BACKOFF_MS;
}

// ─── Server-mandated cooldown ──────────────────────────────────────────────

/**
 * Пауза, которую ПОТРЕБОВАЛ Telegram, — она переживает конкретный вызов.
 *
 * Аудит 2026-08-09, вторая половина той же дыры. Отменить ретраи внутри одного
 * вызова мало: про FLOOD_WAIT не помнил вообще никто. Локальное ведро
 * (rate-limits.ts) коммитится ТОЛЬКО при успехе, так что после отказа оно
 * считало, что мы не отправляли ничего, — и следующее действие любого агента
 * через минуту снова стучалось в аккаунт внутри того же окна бана. Молотьба
 * просто переезжала из цикла в соседние вызовы.
 *
 * Ключ — characterId, как и у ведра: у роутера сессии по агентам (T-541).
 * Если несколько ролей делят одну сессию через singleton-fallback, покрытие
 * получается неполным — это ограничение существующей гранулярности, а не
 * этого кулдауна; лучше недоблокировать чужую роль, чем глушить одиннадцать
 * аккаунтов из-за одного.
 */
const floodCooldownUntil = new Map<string, number>();

/** Сброс между тестами. */
export function _resetFloodCooldowns(): void {
  floodCooldownUntil.clear();
}

/** Сколько ещё молчать по требованию сервера, мс. 0 — можно слать. */
export function floodCooldownRemainingMs(
  characterId: string | number,
  now: number = Date.now(),
): number {
  const key = userbotAccountKey(characterId);
  const until = floodCooldownUntil.get(key);
  if (until === undefined) return 0;
  if (until <= now) {
    floodCooldownUntil.delete(key);
    return 0;
  }
  return until - now;
}

/** Запомнить требование сервера. Продлевать можно, укорачивать — нет. */
function armFloodCooldown(
  characterId: string | number,
  seconds: number,
  now: number,
): number {
  const key = userbotAccountKey(characterId);
  const until = now + seconds * 1_000;
  const prev = floodCooldownUntil.get(key) ?? 0;
  floodCooldownUntil.set(key, Math.max(prev, until));
  return until; // ровно наша заявка, а не то, что уже лежало
}

/**
 * Снять кулдаун, который взвели МЫ и который с тех пор никто не продлил.
 *
 * Аудит 2026-08-20: в ветке успеха стоял безусловный `delete` — укорачивание
 * требования сервера сразу до нуля, мимо всей арифметики armFloodCooldown
 * («продлевать можно, укорачивать — нет»). Проверка на входе гарантирует, что
 * в начале вызова активного кулдауна не было, значит дошедший до успеха
 * взведён, пока мы летали, и он либо наш собственный короткий FLOOD_WAIT
 * (снять правильно — сервер только что принял отправку), либо чужой:
 * параллельный вызов с FLOOD_WAIT дольше потолка или noteFloodWait из
 * createTeamChannel. Чужой снимать нельзя — аккаунт владельца обязан молчать,
 * и следующее действие любой из 12 ролей иначе снова бьёт в тот же бан.
 */
function clearOwnFloodCooldown(
  characterId: string | number,
  ownUntil: number | undefined,
  now: number,
): void {
  if (ownUntil === undefined) return; // мы ничего не взводили — не наше
  const key = userbotAccountKey(characterId);
  const stored = floodCooldownUntil.get(key);
  if (stored === undefined) return;
  if (stored > ownUntil) {
    // Молча оставлять нельзя: снаружи это выглядит как «отправка прошла, а
    // юзербот всё равно молчит», и без строки в логе причину искать негде.
    log.info("[userbot-flood] успех, но кулдаун взведён не нами — оставляем", {
      account: key,
      characterId: String(characterId),
      standingInMs: stored - now,
    });
    return;
  }
  floodCooldownUntil.delete(key);
}

/**
 * Взвести кулдаун по FLOOD_WAIT, который случился ВНЕ обёртки гварда.
 *
 * Аудит 2026-08-13: `createTeamChannel` — это `1 + 2N` RPC внутри одного
 * вызова (CreateChannel, затем getInputEntity + EditAdmin на каждого бота), и
 * FLOOD_WAIT с середины цикла приглашений гвард увидеть не может: цикл ловит
 * ошибку сам и складывает бота в `failed`. Обёртка вокруг всего вызова тут
 * помогает только на входе — про уже случившийся бан узнать неоткуда. Отсюда
 * явная точка «запомни требование сервера»: канал уже создан, ретраить вызов
 * целиком нельзя (получится второй канал), но следующие действия юзербота
 * обязаны молчать положенное время.
 */
export function noteFloodWait(
  characterId: string | number,
  seconds: number,
  now: number = Date.now(),
): void {
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  armFloodCooldown(characterId, seconds, now);
}

// ─── FLOOD_WAIT error parsing ──────────────────────────────────────────────

/**
 * Разбор формы ошибки переехал в листовой lib/flood-wait-error.ts (2026-08-13):
 * его импортирует userbot.ts, а этот модуль через rate-limits тянет lib/db.ts,
 * который создаёт базу на уровне модуля. Реэкспорт — чтобы прежние места
 * импорта не переписывать.
 */
export {
  parseFloodWaitSeconds,
  isFloodWaitError,
  isSlowModeWaitError,
  parseSlowModeWaitSeconds,
};

// ─── Episode recorder interface (injectable) ──────────────────────────────

export type EpisodeRecorder = (line: string) => void;

/**
 * Дефолтный приёмник инцидента.
 *
 * Аудит 2026-08-08: он писал строку в `.claude/memory/episodes/<today>.md`
 * относительно cwd. На проде cwd — `/opt/agent-team`, куда деплой везёт только
 * `agent/` (deploy.sh: SRC=agent/, REMOTE=/opt/agent-team); каталога
 * `.claude/memory/` там нет вовсе. `appendFileSync` падал, `catch {}` глотал —
 * то есть единственная долговечная запись о том, что аккаунт ВЛАДЕЛЬЦА словил
 * FLOOD_WAIT, на проде не появлялась никогда. Ровно то событие, ради которого
 * весь гвард и написан.
 *
 * Пишем через emitAlert → audit_logs. Файл в репозитории тут был бы вреден и в
 * рабочем случае — рантайм-процесс не должен дописывать git-версионируемые
 * файлы под собой.
 *
 * Уточнение 2026-08-09: прошлая версия этого комментария обещала двух
 * читателей — «GET_LOGS и вкладка аудита в Mini App». Оба обещания неточны.
 * GET_LOGS (tools-schema.ts) читает agent_actions, а не audit_logs, и алертов
 * не видит вовсе. Endpoint `/api/audit-logs` существует, но в miniapp/src его
 * не зовёт никто — вкладки нет. Плюс сама alerting.ts честно пишет в шапке,
 * что внешние приёмники (Telegram/Slack) не подключены. То есть строка
 * долговечна и её видно в БД, но САМА она оператору не приедет: чтобы узнать
 * про FLOOD_WAIT на аккаунте владельца, надо пойти и посмотреть. Это разрыв
 * доставки алертов целиком, а не этого гварда, — чинить его надо в alerting.ts
 * и с ведома владельца (новый исходящий поток сообщений в его чат).
 */
export function makeDefaultEpisodeRecorder(): EpisodeRecorder {
  return (line: string) => {
    try {
      emitAlert("warn", "userbot.flood_wait", line);
    } catch {
      // Best-effort; never throw.
    }
  };
}

// ─── Guard result type ────────────────────────────────────────────────────

export interface FloodGuardResult<T> {
  /** Whether the call ultimately succeeded (possibly after retries). */
  ok: boolean;
  /** Result from the wrapped fn (if ok). */
  value?: T;
  /** Rejection reason if rate-limited before even calling the fn. */
  rateLimited?: { retryInMs: number; reason: string };
  /** Error if fn threw and all retries exhausted. */
  error?: unknown;
  /** How many FLOOD_WAIT retries were performed. */
  floodRetries?: number;
}

export interface FloodGuardOpts {
  /** Max number of FLOOD_WAIT retries before giving up (default 3). */
  maxFloodRetries?: number;
  /** Override sleep fn for tests (default: real setTimeout). */
  _sleep?: (ms: number) => Promise<void>;
  /** Override episode recorder for tests (default: writes file). */
  _recorder?: EpisodeRecorder | null;
  /** Override clock for tests (default: Date.now). */
  _now?: () => number;
  /**
   * Слоты ведра уже заняты вызывающим через `reserveUserbotFloodSlots` —
   * не проверять и не коммитить их повторно.
   *
   * Нужно для многочастных отправок: ёмкость на ВСЕ части занимается одной
   * синхронной операцией до первой отправки, иначе между проверкой и первым
   * коммитом успевает влезть соседний ход и сообщение владельца обрывается на
   * середине (см. `reserveUserbotFloodSlots`). Если бы части при этом ещё и
   * коммитили сами, ведро расходовалось бы вдвое и обрывало отправку уже по
   * нашей вине.
   *
   * Кулдаун от сервера (FLOOD_WAIT) и бэкофф это НЕ отключает — они про бан
   * аккаунта, а не про наш темп.
   *
   * Аудит 2026-08-29: резерв покрывает ровно ОДНУ попытку на часть — столько
   * их и планировалось (`splitForTelegram(...).length`). Повторы внутри цикла
   * ниже он не оплачивал, а они такие же обращения к аккаунту: часть может
   * постучаться до четырёх раз (`DEFAULT_MAX_RETRIES`) плюс сколько угодно
   * ожиданий слоумода. Ответ на пять частей с одним FLOOD_WAIT в каждой — это
   * десять реальных обращений против пяти списанных слотов, то есть потолок
   * «20 за 60s» пропускал вдвое больше. Поэтому `skipBucket` гасит коммит
   * только на первой попытке; каждый повтор списывается как обычно.
   */
  skipBucket?: boolean;
}

const DEFAULT_MAX_RETRIES = 3;

/**
 * Wrap a userbot action with:
 *  0. Server-mandated cooldown check (см. floodCooldownRemainingMs).
 *  1. Pre-flight per-(characterId, chatId) rate limit check.
 *  2. FLOOD_WAIT detection + exponential backoff retry — но только пока
 *     запрошенная сервером пауза укладывается в MAX_BACKOFF_MS.
 *  3. Episode incident line on first FLOOD_WAIT.
 *
 * @param characterId  Character/agent identifier
 * @param chatId       Telegram chat identifier
 * @param fn           The actual async call to execute (e.g. handle.setReaction(...))
 * @param opts         Configurable overrides (mostly for testing)
 */
export async function withUserbotFloodGuard<T>(
  characterId: string | number,
  chatId: string | number,
  fn: () => Promise<T>,
  opts: FloodGuardOpts = {},
): Promise<FloodGuardResult<T>> {
  const {
    maxFloodRetries = DEFAULT_MAX_RETRIES,
    _sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms)),
    _recorder,
    _now = () => Date.now(),
  } = opts;

  // 0. Требование сервера с прошлого раза. Идёт ПЕРЕД локальным ведром: это не
  //    наш темп, это бан, и тратить на него слот ведра незачем.
  const cooling = floodCooldownRemainingMs(characterId, _now());
  if (cooling > 0) {
    return {
      ok: false,
      rateLimited: {
        retryInMs: cooling,
        reason: `Telegram FLOOD_WAIT: аккаунт молчит ещё ~${Math.ceil(cooling / 1_000)}s`,
      },
    };
  }

  // 1. Pre-flight rate limit check (check-then-commit pattern).
  const check = opts.skipBucket
    ? ({ ok: true } as const)
    : checkUserbotFloodLimit(characterId, chatId);
  if (!check.ok) {
    return {
      ok: false,
      rateLimited: {
        retryInMs: check.retryInMs ?? 0,
        reason: check.reason ?? "userbot flood limit",
      },
    };
  }

  // 2. Execute with FLOOD_WAIT retry loop.
  let floodRetries = 0;
  /** Самая дальняя пауза, которую в этом вызове потребовали ИМЕННО у нас. */
  let ownCooldownUntil: number | undefined;
  for (let attempt = 0; attempt <= maxFloodRetries; attempt++) {
    try {
      // Слот занимаем ДО обращения к серверу, а не после успеха.
      //
      // Аудит 2026-08-20: было наоборот — «commit only on success», — и ведро
      // считало удачные отправки вместо обращений к аккаунту. Занижало оно
      // втрое:
      //   — между проверкой и коммитом стоял await, так что пока первая
      //     отправка в полёте, вторая и третья видели то же свободное ведро и
      //     проходили все разом (12 ролей делят одну сессию юзербота);
      //   — цикл ниже обращается к серверу до четырёх раз, а коммит был один;
      //   — таймаут или RPC-ошибка приходит и тогда, когда запрос до Telegram
      //     уже дошёл, — такая попытка не считалась вовсе.
      // Ведро защищает личный аккаунт владельца, а не бота, поэтому округлять
      // надо в сторону «мы уже постучались»: лишний неотправленный слот стоит
      // задержки, лишняя отправка — блокировки аккаунта.
      //
      // `skipBucket` тут значит ровно то же, что и при проверке выше: слоты на
      // все части уже заняты одним резервом (`reserveUserbotFloodSlots`), и
      // коммитить их повторно — расходовать ведро вдвое.
      //
      // Но резерв оплатил по одной попытке на часть, а не весь цикл: повтор
      // (`attempt > 0` — FLOOD_WAIT или переждатый слоумод) это ещё одно
      // обращение к аккаунту владельца, ничем не покрытое. Списываем его так
      // же, как в обычном режиме, — см. докблок `skipBucket`.
      if (!opts.skipBucket || attempt > 0) {
        commitUserbotFloodLimit(characterId, chatId);
      }
      const value = await fn();
      // Сервер принял отправку — снимаем кулдаун, если ради этой попытки мы
      // только что честно переждали короткий FLOOD_WAIT внутри цикла. Чужой
      // кулдаун при этом не трогаем (см. clearOwnFloodCooldown).
      //
      // Коммита слота тут больше нет: он переехал ДО обращения к серверу
      // (ведро считает обращения к аккаунту, а не успехи).
      clearOwnFloodCooldown(characterId, ownCooldownUntil, _now());
      return { ok: true, value, floodRetries };
    } catch (err) {
      // Слоумод — свойство ЧАТА, а не аккаунта: ждём и повторяем, но кулдаун
      // на characterId не взводим (он молчит во всех чатах сразу). Аудит
      // 2026-08-19: раньше сюда не доходило — `.seconds` у SlowModeWaitError
      // делал его неотличимым от FLOOD_WAIT.
      const slowSecs = parseSlowModeWaitSeconds(err);
      if (slowSecs !== undefined) {
        if (attempt >= maxFloodRetries || exceedsMaxFloodWait(slowSecs)) {
          log.warn("[userbot-flood] слоумод дольше потолка или ретраи исчерпаны", {
            characterId: String(characterId),
            chatId: String(chatId),
            attempt,
            serverSeconds: slowSecs,
          });
          return { ok: false, error: err, floodRetries };
        }
        log.info("[userbot-flood] слоумод чата — ждём и повторяем", {
          characterId: String(characterId),
          chatId: String(chatId),
          attempt,
          serverSeconds: slowSecs,
        });
        await _sleep(slowSecs * 1_000);
        continue;
      }

      const secs = parseFloodWaitSeconds(err);
      if (secs !== undefined || isFloodWaitError(err)) {
        floodRetries++;
        if (secs !== undefined) {
          const until = armFloodCooldown(characterId, secs, _now());
          ownCooldownUntil = Math.max(ownCooldownUntil ?? 0, until);
        }

        // Сервер попросил паузу длиннее нашего потолка — не ретраим вовсе
        // (см. exceedsMaxFloodWait). Раньше здесь спалось урезанные 60s и
        // делалось ещё до трёх попыток внутри запрошенного окна.
        if (exceedsMaxFloodWait(secs)) {
          const incident = `- [${new Date().toISOString()}] FLOOD_WAIT_${secs} for characterId=${characterId} chatId=${chatId} — дольше потолка ${MAX_BACKOFF_MS / 1000}s, ретраи отменены`;
          if (_recorder !== null) {
            const recorder = _recorder ?? makeDefaultEpisodeRecorder();
            recorder(incident);
          }
          log.error("[userbot-flood] FLOOD_WAIT дольше потолка — без ретраев", {
            characterId: String(characterId),
            chatId: String(chatId),
            attempt,
            serverSeconds: secs,
            maxBackoffMs: MAX_BACKOFF_MS,
          });
          return { ok: false, error: err, floodRetries };
        }

        if (attempt >= maxFloodRetries) {
          log.error("[userbot-flood] FLOOD_WAIT: max retries exhausted", {
            characterId: String(characterId),
            chatId: String(chatId),
            attempt,
          });
          return { ok: false, error: err, floodRetries };
        }

        // Record episode incident on first FLOOD_WAIT.
        if (attempt === 0) {
          const incident = `- [${new Date().toISOString()}] FLOOD_WAIT${secs != null ? `_${secs}` : ""} for characterId=${characterId} chatId=${chatId} — backing off`;
          if (_recorder !== null) {
            const recorder = _recorder ?? makeDefaultEpisodeRecorder();
            recorder(incident);
          }
        }

        const delay = floodBackoffMs(attempt, secs, 0); // jitter=0 in real path for predictability; tests override _sleep anyway
        log.warn("[userbot-flood] FLOOD_WAIT — backing off", {
          characterId: String(characterId),
          chatId: String(chatId),
          attempt,
          delayMs: delay,
          serverSeconds: secs,
        });
        await _sleep(delay);
        continue;
      }

      // Non-FLOOD_WAIT error — propagate immediately.
      return { ok: false, error: err, floodRetries };
    }
  }

  // Should not reach here.
  return { ok: false, floodRetries };
}

/**
 * Throwing-обёртка над withUserbotFloodGuard для боевых вызовов.
 *
 * Аудит 2026-08-07: withUserbotFloodGuard был написан (T-402), покрыт тестами —
 * и не импортировался НИГДЕ, кроме собственного теста. То есть у юзербота не
 * было ни pre-flight лимита, ни бэкоффа: FLOOD_WAIT от Telegram прилетал сырой
 * ошибкой, действие терялось, а следующая попытка агента била в тот же лимит.
 * Для аккаунта-владельца это дорога к временной блокировке отправки.
 *
 * Форма result-объекта у гварда неудобна на call-site (три ветки на каждый
 * вызов), поэтому здесь она сворачивается в throw: dispatchAction ловит
 * исключения хендлеров и пишет их в agent_actions как status='error'.
 */
export async function guardedUserbotCall<T>(
  characterId: string | number,
  chatId: string | number,
  fn: () => Promise<T>,
  opts: FloodGuardOpts = {},
): Promise<T> {
  const res = await withUserbotFloodGuard(characterId, chatId, fn, opts);
  if (res.ok) return res.value as T;
  if (res.rateLimited) {
    const secs = Math.ceil(res.rateLimited.retryInMs / 1000);
    throw new Error(
      `userbot rate limit: ${res.rateLimited.reason} (повтор через ~${secs}s)`,
    );
  }
  if (res.error !== undefined) throw res.error;
  throw new Error("userbot call failed (flood guard)");
}
