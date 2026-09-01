/**
 * Singleton Anthropic client + global concurrency limiter + 429/5xx retry.
 *
 * Все вызовы `messages.create` в проекте должны идти через `callAnthropic`,
 * чтобы:
 *  - не пробивать org-лимит на input tokens/min (концурентность),
 *  - корректно бэкоффить при 429 (с учётом `retry-after`) и 5xx.
 *
 * Конфигурация:
 *  - ANTHROPIC_API_KEY — нужен только для raw API-режима; основной продовый
 *    entrypoint может работать subscription-only через Claude Agent SDK.
 *  - ANTHROPIC_MAX_CONCURRENCY — максимум одновременных вызовов: целое
 *    1..16, по умолчанию 3. Всё остальное отвергается с log.warn.
 *  - ANTHROPIC_REQUEST_TIMEOUT_MS — потолок ожидания одного HTTP-запроса:
 *    целое 1000..600000, по умолчанию 120000. То же правило разбора.
 */
import { getErrorMessage } from "./errors.ts";
import Anthropic, { APIConnectionError } from "@anthropic-ai/sdk";
import {
  checkBudget,
  recordUsage,
  usageInputTokens,
  usageOutputTokens,
} from "./token-budget.ts";
import { log } from "./log.ts";

let _client: Anthropic | null = null;

/**
 * Потолок ожидания ОДНОГО HTTP-запроса к API.
 *
 * Аудит 2026-08-28: `new Anthropic({ apiKey, maxRetries: 0 })` не передавал
 * `timeout`, а дефолт SDK 0.98.1 — десять минут (`client.js:791`,
 * `BaseAnthropic.DEFAULT_TIMEOUT = 600000`). Слот конкурентности берётся ДО
 * запроса (`acquire()`) и отпускается только в `finally`, то есть висит всю
 * эту вилку целиком: три зависших сокета при дефолтных трёх слотах — и вся
 * команда из 12 ролей молчит десять минут, без единой строки в логе.
 *
 * Стандарт у модуля свой и записан ниже, в докблоке TRANSIENT_MAX_RETRIES:
 * держать слот МИНУТУ на упавшей сети там уже названо неприемлемым — «те же
 * «боты молчат»». Десять минут — тот же отказ, только в десять раз длиннее.
 *
 * Две минуты взяты не с потолка. Весь проект зовёт `messages.create` без
 * стрима (`MessageCreateParamsNonStreaming`) и с невысокими max_tokens: 1500
 * в tool-loop (`DEFAULT_MAX_REPLY_TOKENS`), 2500 в компакторе, 4000 в
 * svg-fallback и тот на Haiku. Самый длинный такой ответ укладывается в
 * десятки секунд — запас кратный, а зависший сокет перестаёт быть
 * десятиминутным.
 *
 * Ретраев от этого не прибавляется: таймаут прилетает как
 * `APIConnectionTimeoutError`, наследник `APIConnectionError`, то есть его
 * ловит ветка `isTransientFailure` — те же два ретрая, и спит она БЕЗ слота
 * (`backoffWithoutSlot`). Непрерывное удержание слота ограничено сверху одним
 * таймаутом — но по-настоящему только с 2026-08-29: клиентский `timeout`
 * считает ОДНИ заголовки, дедлайн на чтение тела даёт пер-запросный
 * `AbortSignal.timeout` в `callAnthropic`.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

/**
 * Границы настройки. Снизу секунда: короче не успевает и здоровый запрос, так
 * что меньшее значение — опечатка, а не намерение. Сверху прежний дефолт SDK:
 * выше него настройка ничего не чинит, а только возвращает ту самую
 * десятиминутную яму.
 */
export const MIN_REQUEST_TIMEOUT_MS = 1_000;
export const MAX_REQUEST_TIMEOUT_MS = 600_000;

/**
 * Разбор ANTHROPIC_REQUEST_TIMEOUT_MS — теми же правилами, что и
 * `_resolveMaxConcurrency`: только целое без знака, значение вне диапазона
 * даёт ДЕФОЛТ (а не зажатую границу), мусор пишется в лог. Читается это из
 * systemd EnvironmentFile, где опечатку никто не увидит.
 *
 * Экспортируется ради теста.
 */
export function _resolveRequestTimeout(raw: string | undefined): number {
  if (raw == null) return DEFAULT_REQUEST_TIMEOUT_MS;
  const s = raw.trim();
  if (!/^\d+$/.test(s)) {
    if (s !== "") warnBadTimeout(s, "ожидается целое число миллисекунд");
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }
  const n = Number(s);
  if (n < MIN_REQUEST_TIMEOUT_MS || n > MAX_REQUEST_TIMEOUT_MS) {
    warnBadTimeout(
      s,
      `допустимый диапазон ${MIN_REQUEST_TIMEOUT_MS}..${MAX_REQUEST_TIMEOUT_MS}`,
    );
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }
  return n;
}

function warnBadTimeout(raw: string, why: string): void {
  log.warn("[anthropic] ANTHROPIC_REQUEST_TIMEOUT_MS отвергнут, беру дефолт", {
    raw,
    why,
    fallback: DEFAULT_REQUEST_TIMEOUT_MS,
  });
}

/**
 * Тот же таймаут, но пригодный для вызова на каждый запрос.
 *
 * `_resolveRequestTimeout` на невалидном значении пишет `log.warn`, а
 * `callAnthropic` дёргает таймаут на каждой попытке — без памятки одна опечатка
 * в `.env` залила бы журнал. Кэш сбрасывается сам, когда меняется сырое
 * значение переменной: тестам не нужен отдельный ресеттер.
 */
let _timeoutRaw: string | undefined | symbol = Symbol("unset");
let _timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;
export function _requestTimeoutMs(): number {
  const raw = process.env.ANTHROPIC_REQUEST_TIMEOUT_MS;
  if (raw !== _timeoutRaw) {
    _timeoutRaw = raw;
    _timeoutMs = _resolveRequestTimeout(raw);
  }
  return _timeoutMs;
}

/**
 * Единственный способ создать клиента в проекте.
 *
 * Аудит 2026-08-13: `new Anthropic({ apiKey })` — это `maxRetries: 2` по
 * умолчанию, то есть три HTTP-запроса на каждый наш `messages.create`. Снаружи
 * их оборачивает цикл ниже (MAX_RETRIES = 5, шесть попыток), и слои
 * перемножаются: до 18 запросов на один логический вызов. Три следствия, все
 * наблюдаемые:
 *
 *  1. **429 усиливается.** Собственный бэкофф здесь аккуратный: `retry-after`,
 *     удвоение, потолок. SDK же на 429 ретраит через ~0.5 с — то есть между
 *     нашими вежливыми паузами он успевает дважды ударить в тот же лимит.
 *  2. **Потолок MAX_RETRY_AFTER_MS был фиктивным.** Мы режем `retry-after` до
 *     минуты именно потому, что спим, ДЕРЖА слот конкурентности. А SDK
 *     (`retryRequest`) спит по заголовку без какого-либо потолка, внутри нашей
 *     же попытки и внутри того же слота. Ограничение существовало только в
 *     комментарии.
 *  3. **Лог врал.** `attempt 1/5` в логе — это уже третий запрос к API.
 *
 * Поэтому ретраит ровно один слой — наш. Всё, что раньше ретраил SDK (429,
 * 5xx, 408, 409, обрывы соединения), цикл ниже покрывает сам: это перенос
 * ответственности, а не отказ от ретраев.
 */
export function createAnthropic(apiKey: string): Anthropic {
  return new Anthropic({
    apiKey,
    maxRetries: 0,
    timeout: _requestTimeoutMs(),
  });
}

export function getAnthropic(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  _client = createAnthropic(apiKey);
  return _client;
}

/** Тестовая лазейка: подменить клиента (для unit-тестов). */
export function __setAnthropicClientForTests(c: Anthropic | null): void {
  _client = c;
}

/** Значение, с которым модуль жил всё время до аудита 2026-08-28. */
const DEFAULT_CONCURRENCY = 3;

/**
 * Верхняя граница настройки.
 *
 * Ролей в команде 12 (`CHARACTERS`), больше одновременных вызовов взяться
 * неоткуда: каждый ход роли — один `callAnthropic`. Потолок стоит чуть выше,
 * чтобы оставить запас на служебные вызовы (компактор, дайджест) и при этом
 * ловить опечатку в лишнюю цифру — `30` вместо `3`.
 */
export const MAX_CONCURRENCY_CAP = 16;

/**
 * Разбор ANTHROPIC_MAX_CONCURRENCY.
 *
 * Аудит 2026-08-28: раньше здесь стояло
 * `Math.max(1, Number(raw ?? "3") || 3)` — единственная защита во всём модуле,
 * ради которого он и написан (не пробивать org-лимит input tokens/min).
 * Пропускала она три вещи:
 *
 *  - **дробное**: `"2.5"` доезжало как 2.5, а слот выдаётся строгим
 *    `active < MAX_CONCURRENCY` (:acquire) — при active=2 условие ещё истинно,
 *    и в полёте оказывается ТРИ запроса при настройке «2.5»;
 *  - **лишнюю цифру**: верхней границы не было вовсе, `"30"` снимало
 *    ограничение целиком;
 *  - **мусор**: `"abc"`, `" "`, `"0"` молча становились тройкой, а читается
 *    значение один раз при импорте из systemd EnvironmentFile, где опечатку
 *    никто не увидит.
 *
 * Значение вне диапазона даёт ДЕФОЛТ, а не зажатую границу: зажать `"30"` в 16
 * значило бы всё равно уйти в шестнадцать параллельных вызовов по опечатке.
 * Дефолт — единственное число, про которое точно известно, что оно работало.
 *
 * Экспортируется ради теста: подставлять env и переимпортировать модуль
 * нельзя, значение читается на верхнем уровне.
 */
export function _resolveMaxConcurrency(raw: string | undefined): number {
  if (raw == null) return DEFAULT_CONCURRENCY;
  const s = raw.trim();
  // Только ASCII-цифры: `Number` принимает и `"2.5"`, и `"1e1"`, и арабо-индийские
  // цифры, а нам нужно ровно целое без знака.
  if (!/^\d+$/.test(s)) {
    if (s !== "") warnBadConcurrency(s, "ожидается целое число");
    return DEFAULT_CONCURRENCY;
  }
  const n = Number(s);
  if (n < 1 || n > MAX_CONCURRENCY_CAP) {
    warnBadConcurrency(s, `допустимый диапазон 1..${MAX_CONCURRENCY_CAP}`);
    return DEFAULT_CONCURRENCY;
  }
  return n;
}

function warnBadConcurrency(raw: string, why: string): void {
  log.warn("[anthropic] ANTHROPIC_MAX_CONCURRENCY отвергнут, беру дефолт", {
    raw,
    why,
    fallback: DEFAULT_CONCURRENCY,
  });
}

/** Экспортируется, чтобы тест мог занять ровно все слоты, а не угадывать их число. */
export const MAX_CONCURRENCY = _resolveMaxConcurrency(process.env.ANTHROPIC_MAX_CONCURRENCY);
const MAX_RETRIES = 5;

/**
 * Бюджет на «запрос не доехал»: обрыв соединения, таймаут сокета, 408, 409.
 *
 * Отдельный от MAX_RETRIES и намеренно маленький. Эти отказы раньше ретраил
 * SDK — ровно два раза (`maxRetries: 2`), с паузами ~0.5 с и ~1 с. Забирая
 * ретраи себе (`createAnthropic`), мы обязаны сохранить покрытие, но не обязаны
 * его расширять: дать обрыву те же шесть попыток с потолком в 30 секунд
 * значило бы держать слот конкурентности минуту на упавшей сети, а слотов по
 * умолчанию три — те же «боты молчат», от которых уже лечили `retry-after`.
 * Два ретрая = три запроса = поведение до этого коммита, теперь с честным
 * логом.
 *
 * 429 и 5xx сюда не попадают: у них своя, длинная лестница ниже — там ждать
 * осмысленно, потому что сервер сам просит подождать.
 */
const TRANSIENT_MAX_RETRIES = 2;

/**
 * Коды сетевых отказов на случай, когда ошибка пришла не завёрнутой в
 * `APIConnectionError` (кастомный fetch, прокси-слой, тест с голой ошибкой).
 * Основная проверка — `instanceof`, это подстраховка.
 */
const TRANSIENT_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  // Аудит 2026-08-29: обрыв ПОСЛЕ заголовков SDK не заворачивает вовсе. В
  // `APIConnectionError` попадает только то, что упало внутри `makeRequest`;
  // тело читается позже (`internal/parse.js`), и его ошибка всплывает как
  // есть. Bun ставит code "ConnectionClosed", undici прячет "UND_ERR_SOCKET"
  // в `cause`, node-стрим даёт "ERR_STREAM_PREMATURE_CLOSE". До этого коммита
  // все три считались фатальными и не получали ни одного ретрая — притом что
  // соседний обрыв на полсекунды раньше, до заголовков, получал два.
  "ConnectionClosed",
  "UND_ERR_SOCKET",
  "ERR_STREAM_PREMATURE_CLOSE",
]);

/**
 * Отмена по дедлайну — тоже «запрос не доехал».
 *
 * `AbortSignal.timeout` в `callAnthropic` рвёт зависшее чтение тела, и SDK
 * прокидывает abort в fetch голым: `_makeAbort` (client.js:739) зовёт
 * `controller.abort()` без reason, поэтому наверх приходит DOMException
 * AbortError, а не `APIConnectionTimeoutError`. Без этих двух имён новый
 * дедлайн превратил бы вечный висяк в фатальную ошибку без ретраев — то есть
 * лечил бы молчание команды её же молчанием, только быстрее.
 *
 * Чужой отмены здесь быть не может: `callAnthropic` не принимает signal от
 * вызывающего, единственный источник abort — наш собственный таймаут.
 */
const TRANSIENT_ERROR_NAMES = new Set(["AbortError", "TimeoutError"]);

function transientByShape(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const o = e as { status?: number; code?: unknown; name?: unknown };
  // 408 Request Timeout и 409 (у Anthropic — lock timeout): ровно тот список,
  // что SDK считал ретраибельным помимо 429/5xx.
  if (o.status === 408 || o.status === 409) return true;
  if (typeof o.code === "string" && TRANSIENT_ERROR_CODES.has(o.code)) {
    return true;
  }
  return typeof o.name === "string" && TRANSIENT_ERROR_NAMES.has(o.name);
}

/**
 * «Запрос не доехал» — ретраить безопасно и нужно.
 *
 * `APIConnectionError` покрывает и таймауты (`APIConnectionTimeoutError` —
 * его наследник). По `err.name` их не различить: у обоих он «Error».
 */
export function isTransientFailure(err: unknown): boolean {
  if (err instanceof APIConnectionError) return true;
  // Спускаемся по `cause`: undici кладёт код именно туда — снаружи это
  // `TypeError: terminated` вообще без своего `code`, а "UND_ERR_SOCKET"
  // лежит на уровень глубже. Три уровня с запасом: реальные цепочки короче,
  // а ограничение защищает от самоссылающегося cause.
  let cur: unknown = err;
  for (let depth = 0; depth < 3 && cur != null; depth++) {
    if (transientByShape(cur)) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

let active = 0;
const queue: Array<() => void> = [];

function acquire(): Promise<void> {
  if (active < MAX_CONCURRENCY) {
    active++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    queue.push(() => {
      active++;
      resolve();
    });
  });
}

function release(): void {
  active--;
  const next = queue.shift();
  if (next) next();
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Пауза между попытками. Подменяема — и это не удобство, а починка гейта.
 *
 * Аудит 2026-08-20: tests/anthropic-retry-multiplier.test.ts ждал НАСТОЯЩИЕ
 * бэкоффы (500 → 1000 → 2000 мс на обрывах связи). В одиночку файл проходил, а
 * в полном прогоне на нагруженной машине упирался в пятисекундный таймаут теста
 * и краснел — то есть `bun test` перед push давал разный ответ на одном и том же
 * коде. Красный гейт, который краснеет от загрузки ноутбука, перестают читать.
 *
 * Прод-поведение не меняется: без вызова сеттера здесь настоящий setTimeout.
 */
let sleepImpl: (ms: number) => Promise<void> = realSleep;

function sleep(ms: number): Promise<void> {
  return sleepImpl(ms);
}

/** Только для тестов. `null` возвращает настоящий сон. */
export function __setSleepForTests(
  fn: ((ms: number) => Promise<void>) | null,
): void {
  sleepImpl = fn ?? realSleep;
}

/**
 * Пауза между попытками — БЕЗ слота конкурентности.
 *
 * Аудит 2026-08-13: `acquire()` стоит выше цикла ретраев, `release()` — в
 * `finally`, то есть `await sleep(waitMs)` спал, ДЕРЖА слот. Слотов по
 * умолчанию три на все 12 ролей, пауза на 429 доходит до минуты
 * (MAX_RETRY_AFTER_MS), попыток пять. Три невезучих запроса запирали поход в
 * API для всей команды на время, которое эти запросы вообще не используют:
 * снаружи это «боты молчат», причём молчат все, включая тех, кому лимит не
 * возвращали. Прошлая правка (2026-08-11) урезала верх паузы с суток до
 * минуты — то есть лечила глубину ямы, а не саму яму.
 *
 * Спящий запрос API не занимает. Отпускаем слот на время сна и берём заново
 * перед следующей попыткой: пока мы ждём, работают остальные.
 *
 * Цена — ретраящийся запрос встаёт в конец очереди и к паузе добавляется
 * ожидание слота. Это правильная цена: он уже получил отказ по лимиту, а тот,
 * кто ещё не пробовал, шанса не имел вовсе. Число попыток по-прежнему
 * ограничено MAX_RETRIES, так что ждать бесконечно нельзя.
 */
async function backoffWithoutSlot(ms: number): Promise<void> {
  release();
  try {
    await sleep(ms);
  } finally {
    // Не try/catch ради красоты: без re-acquire внешний finally сделал бы
    // второй release() на тот же слот и счётчик уехал бы в минус — а это
    // тихое расширение лимита конкурентности, худший из возможных исходов.
    await acquire();
  }
}

function jitter(): number {
  return Math.floor(Math.random() * 200);
}

interface MaybeHttpError {
  status?: number;
  headers?: Record<string, string> | { get?: (k: string) => string | null };
  response?: { headers?: Record<string, string> | { get?: (k: string) => string | null } };
}

function readHeader(h: unknown, name: string): string | undefined {
  if (!h) return undefined;
  if (typeof (h as { get?: unknown }).get === "function") {
    const v = (h as { get: (k: string) => string | null }).get(name);
    return v ?? undefined;
  }
  // Аудит 2026-08-20: было `rec[name] ?? rec[name.toLowerCase()]`, а зовут
  // функцию всегда с уже строчным именем — то есть обе половины искали один и
  // тот же ключ, и `{ "Retry-After": "30" }` не находился. Headers-объект
  // регистр игнорирует сам, простой объект — нет; сюда попадает именно он
  // (SDK кладёт `error.headers` как plain object, а капитализацию заголовка
  // определяет тот, кто отвечает, — включая прокси по дороге).
  const rec = h as Record<string, string>;
  const direct = rec[name] ?? rec[name.toLowerCase()];
  if (direct !== undefined) return direct;
  const want = name.toLowerCase();
  for (const k of Object.keys(rec)) {
    if (k.toLowerCase() === want) return rec[k];
  }
  return undefined;
}

/**
 * Потолок паузы из заголовка. Аудит 2026-08-11: своей догадке код не доверял
 * дольше 30 секунд (`Math.min(backoff429 * 2, 30_000)`), а числу из сети —
 * сколько угодно, вплоть до суток. Заголовок к тому же приходит не обязательно
 * от самого API: по дороге может стоять прокси.
 *
 * Тогдашнее обоснование — «спим, держа слот конкурентности, поэтому чужая
 * цифра запирает всю команду» — с 2026-08-13 неверно: сон идёт без слота
 * (`backoffWithoutSlot`). Потолок остаётся, но причина у него теперь одна и
 * скромнее: пользователь ждёт ответа в чате, и час тишины ему не объяснить.
 *
 * Минута, а не 30 секунд: лимиты Anthropic считаются в минутном окне, поэтому
 * осмысленная просьба подождать в неё укладывается — резать её до собственного
 * потолка значило бы жечь попытки впустую. Сверху при MAX_RETRIES выходит пять
 * минут ожидания вместо суток.
 */
export const MAX_RETRY_AFTER_MS = 60_000;

/**
 * Пол паузы из заголовка. Аудит 2026-08-20: `retry-after: 0` проходил проверку
 * `n >= 0` и возвращался как 0 мс. Дальше в 429-ветке два эффекта сразу:
 * `waitMs = 0 + jitter()` — это меньше 200 мс, — и `ra !== undefined`, из-за
 * чего собственная догадка `backoff429` не удваивается. Все шесть попыток
 * улетают в тот же перегруженный лимит за ~1 секунду, после чего ход падает с
 * 429 наверх. То есть заголовок, который должен был помочь, ровно выключал
 * защиту.
 *
 * Ноль (и любая просьба «подожди меньше секунды») информации не несёт: сервер
 * только что отказал по лимиту. Считаем такое отсутствием заголовка и
 * возвращаемся к собственному экспоненциальному отступу — он для этого и есть.
 */
export const MIN_RETRY_AFTER_MS = 1000;

export function parseRetryAfterMs(err: MaybeHttpError): number | undefined {
  const fromTop = readHeader(err.headers, "retry-after");
  const fromResp = readHeader(err.response?.headers, "retry-after");
  const raw = fromTop ?? fromResp;
  if (!raw) return undefined;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) {
    const ms = Math.round(n * 1000);
    if (ms < MIN_RETRY_AFTER_MS) return undefined;
    return Math.min(ms, MAX_RETRY_AFTER_MS);
  }
  // HTTP-date fallback
  const t = Date.parse(raw);
  if (!Number.isNaN(t)) {
    const diff = t - Date.now();
    // Дата в прошлом или «через полсекунды» — тот же ноль, см. шапку.
    if (diff >= MIN_RETRY_AFTER_MS) return Math.min(diff, MAX_RETRY_AFTER_MS);
  }
  return undefined;
}

export async function callAnthropic(
  params: Anthropic.MessageCreateParamsNonStreaming,
  override?: Anthropic | null,
  agentKey?: string,
): Promise<Anthropic.Message> {
  const client = override ?? getAnthropic();
  // C16: enforce per-agent daily input-token budget BEFORE acquiring the
  // concurrency slot so a budget-exceeded agent doesn't starve the queue.
  if (agentKey) checkBudget(agentKey);
  await acquire();
  try {
    let attempt = 0;
    // Свой счётчик: обрыв связи не должен съедать попытки у 429 и наоборот.
    let transientAttempt = 0;
    let backoffTransient = 500;
    let backoff5xx = 2000;
    // Без заголовка retry-after пауза на 429 была фиксированной секундой: пять
    // попыток укладывались в ~5 секунд и упирались в тот же перегруженный
    // лимит, после чего throw уходил наверх. Для 5xx удвоение с самого начала
    // было — 429 просто забыли.
    let backoff429 = 1000;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        // Аудит 2026-08-29: у `create` появился свой дедлайн. Клиентский
        // `timeout` из `createAnthropic` покрывает ТОЛЬКО заголовки:
        // `fetchWithTimeout` (client.js:562-593) снимает таймер в `finally`
        // сразу, как только `fetch` вернул Response, а тело читается позже.
        // Сокет, отдавший 200 и замолчавший на теле (half-open TCP, реап на
        // NAT/LB, буферизующий прокси), поэтому держал слот конкурентности
        // ВЕЧНО: ни таймаута, ни ретрая, ни строчки в логе. Три таких сокета
        // при дефолтных трёх слотах — и очередь не двигается больше никогда,
        // все 12 ролей молчат до `systemctl restart agent-team`, а
        // `journalctl` пуст.
        //
        // Пер-запросный signal SDK прокидывает в тот же `fetchWithTimeout`
        // (client.js:702) и вешает на него слушатель на всё время жизни
        // сигнала — то есть abort рвёт именно чтение тела, а не только
        // ожидание заголовков.
        const resp = (await client.messages.create(params, {
          signal: AbortSignal.timeout(_requestTimeoutMs()),
        })) as Anthropic.Message;
        if (agentKey) {
          try {
            // Аудит 2026-08-12: здесь стоял голый `usage.input_tokens`, то есть
            // кэш-чтение и кэш-запись в бюджет не попадали вовсе — а системные
            // блоки на этом пути помечены cache_control, и tool-loop гоняет их
            // на каждой итерации. Считает теперь общая функция с SDK-путём.
            recordUsage(
              agentKey,
              usageInputTokens(resp.usage),
              usageOutputTokens(resp.usage),
            );
          } catch (e) {
            log.error("[budget] recordUsage failed", {
              agentKey,
              error: getErrorMessage(e),
            });
          }
        }
        return resp;
      } catch (e) {
        const err = e as MaybeHttpError & { message?: string };
        const status = err?.status;
        if (status === 429) {
          attempt++;
          if (attempt > MAX_RETRIES) throw e;
          const ra = parseRetryAfterMs(err);
          const waitMs = (ra ?? backoff429) + jitter();
          log.warn("[anthropic] 429 rate-limited, retrying", {
            retryAfterSec: Math.round(waitMs / 1000),
            fromHeader: ra !== undefined,
            attempt,
            maxRetries: MAX_RETRIES,
          });
          await backoffWithoutSlot(waitMs);
          // Сервер сказал точное время — своей оценке она не противоречит,
          // удваиваем только собственную догадку.
          if (ra === undefined) backoff429 = Math.min(backoff429 * 2, 30_000);
          continue;
        }
        if (typeof status === "number" && status >= 500 && status < 600) {
          attempt++;
          if (attempt > MAX_RETRIES) throw e;
          const waitMs = backoff5xx + jitter();
          log.warn("[anthropic] 5xx, backing off", {
            status,
            backoffSec: Math.round(waitMs / 1000),
            attempt,
            maxRetries: MAX_RETRIES,
          });
          await backoffWithoutSlot(waitMs);
          backoff5xx = Math.min(backoff5xx * 2, 30_000);
          continue;
        }
        // Сеть оборвалась / 408 / 409. До этого коммита сюда не доходило: такие
        // отказы гасил SDK своими двумя ретраями, а этот цикл видел только то,
        // что пережило их. Теперь ретраев у SDK нет, и не покрыть их здесь
        // значило бы уронить ход на первом же дрогнувшем сокете.
        if (isTransientFailure(e)) {
          transientAttempt++;
          if (transientAttempt > TRANSIENT_MAX_RETRIES) throw e;
          const waitMs = backoffTransient + jitter();
          log.warn("[anthropic] connection failure, retrying", {
            status,
            waitSec: Math.round(waitMs / 1000),
            attempt: transientAttempt,
            maxRetries: TRANSIENT_MAX_RETRIES,
            error: getErrorMessage(e),
          });
          // Аудит 2026-08-21: здесь стоял голый `sleep`, то есть эта ветка —
          // единственная из трёх — спала, ДЕРЖА слот. Соседи (429 на :312,
          // 5xx на :328) отпускают его с 2026-08-13, а инвариант записан в
          // докблоке `backoffWithoutSlot` прямым текстом: спящий запрос API не
          // занимает. Замер: при трёх слотах и трёх запросах, поймавших
          // ECONNRESET, посторонний запрос ждал 572мс против 1мс на 429 —
          // молчала вся команда, включая тех, у кого связь не рвалась.
          await backoffWithoutSlot(waitMs);
          backoffTransient *= 2;
          continue;
        }
        throw e;
      }
    }
  } finally {
    release();
  }
}
