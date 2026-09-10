/**
 * C12: in-memory sliding-window rate limits per (agentKey, actionType, chatId).
 *
 * Каждый бакет — массив timestamps (ms). При проверке отбрасываем всё старше
 * windowMs и считаем количество. Если >= max → reject.
 *
 * Не персистится, не делится между процессами. Этого достаточно: у нас один
 * процесс на VPS, рестарт = сброс. Цель — защита от багов и циклов внутри
 * сессии, а не enforcement квот.
 */

import { MINUTE_MS, HOUR_MS } from "./time-constants.ts";
import {
  DEFAULT_SEND_MESSAGE_RATE_LIMIT,
  DEFAULT_SET_REACTION_RATE_LIMIT,
  DEFAULT_GENERATE_IMAGE_GLOBAL_LIMIT,
  DEFAULT_GENERATE_IMAGE_PER_AGENT_LIMIT,
} from "./constants.ts";

export type RateLimitKey = string;

interface BucketRule {
  windowMs: number;
  max: number;
}

/**
 * Per-actionType правила. Не указан — без лимита.
 *
 * Цифры подобраны под человеческий темп общения и стоимость OpenAI:
 *  - GENERATE_IMAGE: дорого ($0.04). 6/час на агента, 30/час суммарно.
 *  - GENERATE_SVG_IMAGE: дёшево, но шум. 20/мин на агента.
 *  - SEND_MESSAGE / SET_REACTION: 30/мин — защита от спама-цикла.
 *  - tool calls в целом: 60/мин — общий потолок.
 */
const RULES: Record<string, { perAgent?: BucketRule; global?: BucketRule }> = {
  GENERATE_IMAGE: {
    perAgent: { windowMs: HOUR_MS, max: DEFAULT_GENERATE_IMAGE_PER_AGENT_LIMIT },
    global: { windowMs: HOUR_MS, max: DEFAULT_GENERATE_IMAGE_GLOBAL_LIMIT },
  },
  GENERATE_SVG_IMAGE: { perAgent: { windowMs: MINUTE_MS, max: 20 } },
  SEND_MESSAGE: { perAgent: { windowMs: MINUTE_MS, max: DEFAULT_SEND_MESSAGE_RATE_LIMIT } },
  SET_REACTION: { perAgent: { windowMs: MINUTE_MS, max: DEFAULT_SET_REACTION_RATE_LIMIT } },
  DELEGATE_TO_ROLE: { perAgent: { windowMs: MINUTE_MS, max: 6 } },
  WRITE_WIKI: { perAgent: { windowMs: MINUTE_MS, max: 5 } },
};

const ALL_AGENT_TOOLS_RULE: BucketRule = { windowMs: MINUTE_MS, max: 60 };

/** Потолок Telegram на пару (бот, чат): ~20 сообщений в минуту в группу. */
const DEFAULT_PER_BOT_PER_CHAT_MAX = 20;

/**
 * T-315 / T-300 MED #8: per-chat bucket — protects against a single spammy
 * chat draining a whole agent. Applies across ALL agents in the same chat.
 * Default 30 msg/min per chat, overridable via env RATE_LIMIT_PER_CHAT_PER_MIN.
 * Fail-closed: invalid env values fall back to default.
 */
function readPerChatMax(): number {
  const raw = process.env.RATE_LIMIT_PER_CHAT_PER_MIN;
  if (raw === undefined || raw === "") return 30;
  const n = Number(raw.trim());
  if (!Number.isSafeInteger(n) || n <= 0) return 30;
  return Math.min(n, 10_000);
}

function perChatRule(): BucketRule {
  return { windowMs: MINUTE_MS, max: readPerChatMax() };
}

/**
 * Аудит 2026-08-28: у пары (бот, чат) обязан быть свой потолок.
 *
 * Пока он совпадал с общечатовым, бакет `bot:<bot>:chat:<chat>:<action>` был
 * подмножеством `chat:<chat>:<action>` с тем же max — счётчик чата всегда
 * >= счётчика бота, а проверяется чат первым. Ветка отказа «per bot per chat»
 * была недостижима, зато ключей мы держали в двенадцать раз больше.
 *
 * Дефолт 20/мин — это то, как флуд считает сам Telegram: по паре (бот, чат),
 * около 20 сообщений в минуту в группу. Выше общечатового потолка не
 * поднимаем: одному боту не может быть позволено больше, чем всему чату.
 * Fail-closed: мусор, ноль и отрицательное в env → дефолт.
 */
function readPerBotPerChatMax(): number {
  const raw = process.env.RATE_LIMIT_PER_BOT_PER_CHAT_PER_MIN;
  const n =
    raw === undefined || raw === ""
      ? DEFAULT_PER_BOT_PER_CHAT_MAX
      : Number(raw.trim());
  const max = !Number.isSafeInteger(n) || n <= 0
    ? DEFAULT_PER_BOT_PER_CHAT_MAX
    : Math.min(n, 10_000);
  return Math.min(max, readPerChatMax());
}

function perBotPerChatRule(): BucketRule {
  return { windowMs: MINUTE_MS, max: readPerBotPerChatMax() };
}

interface BucketEntry {
  ts: number;
  /** Present only while a userbot flood slot is held by a reservation. */
  reservationId?: number;
}

const buckets = new Map<string, BucketEntry[]>();
let nextReservationId = 1;

/**
 * Аудит 2026-08-08: карта росла бесконечно.
 *
 * Шапка модуля объясняет, почему лимиты не персистятся: «рестарт = сброс».
 * Но рестарта может не быть месяцами, а из пяти форматов ключа четыре
 * содержат chatId и/или userId: `chat:<chatId>:<action>`,
 * `bot:<botId>:chat:<chatId>:<action>`, `userbot:<account>:chat:<chatId>` и
 * `ingest:chat:<chatId>:user:<userId>`. Число ключей задаёт не наш код, а тот,
 * кто пишет боту: любой может написать в личку или добавить бота в группу, и
 * каждый новый собеседник оставляет запись навсегда. Хуже того, checkBucket
 * клал в карту ПУСТОЙ массив даже для ключа, по которому ничего не
 * подтверждалось — а ingest-лимит вызывается на КАЖДОМ входящем сообщении, то
 * есть до всякой проверки прав. Утечка в том же единственном процессе, где
 * живут 12 ботов, HTTP Mini App и SQLite.
 *
 * Тот же класс уже вылечен в lib/http-utils.ts, и рассуждение оттуда работает
 * здесь ещё сильнее: ведро, у которого САМЫЙ СВЕЖИЙ штамп старше окна, при
 * следующем обращении всё равно будет вычищено до пустого — удалить его сейчас
 * и создать заново позже неотличимо по поведению. То есть вытеснение тут не
 * компромисс между памятью и строгостью лимита, а тождественное преобразование.
 *
 * Порог — самое длинное окно из встречавшихся (час у GENERATE_IMAGE, но окна
 * ingest и userbot-flood настраиваются через env и могут оказаться больше,
 * поэтому максимум подтягивается на лету).
 */
let maxWindowMs = HOUR_MS;
/**
 * Проход по карте — O(n). Без отсечки каждое входящее сообщение платило бы за
 * полный проход ровно под той нагрузкой, ради которой лимит и стоит.
 */
const EVICT_MIN_INTERVAL_MS = 1_000;
let lastEvict = 0;

/**
 * Порог вытеснения обязан покрывать окно ЛЮБОГО правила, ведро которого лежит
 * в карте, иначе вытеснение перестаёт быть тождественным преобразованием и
 * становится сбросом лимита.
 *
 * Аудит 2026-09-10: поднимался порог ровно в одном месте — в `checkBucket`, —
 * а `reserveUserbotFloodSlots` читает и пишет ведро сам, мимо него, и при этом
 * зовёт вытеснение. Окно userbot-flood настраивается переменной и допускает до
 * семи суток (`readUserbotFloodWindowMs`), то есть при
 * `USERBOT_FLOOD_WINDOW_MS` больше часа порог оставался часовым: набранное
 * владельцем ведро вычищал ЛЮБОЙ посторонний вызов через час после последней
 * записи (входящее сообщение зовёт `checkAndConsumeIngestLimit`, тот —
 * вытеснение), и следующая резервация видела пустое ведро. Ограничение на
 * личный аккаунт владельца молча превращалось из «N за окно» в «N в час».
 *
 * Дыра закрывалась сама собой после первого `checkUserbotFloodLimit` в
 * процессе (реакции и удаления идут через `checkBucket`), то есть жила от
 * старта до первого такого вызова — но именно на старте лимит и важен.
 *
 * Поэтому окно передаётся сюда параметром: всякий, кто вытесняет, обязан
 * назвать правило, по которому работает. `commit` вызывается только следом за
 * `checkBucket`, который окно уже учёл, — ему называть нечего.
 */
function evictExpiredBuckets(now: number, windowMs = 0): void {
  if (windowMs > maxWindowMs) maxWindowMs = windowMs;
  if (now - lastEvict < EVICT_MIN_INTERVAL_MS) return;
  lastEvict = now;
  const cutoff = now - maxWindowMs;
  for (const [k, arr] of buckets) {
    // Последний штамп — самый свежий: массив пополняется только push'ем.
    if (arr.length === 0 || arr[arr.length - 1]!.ts < cutoff) buckets.delete(k);
  }
}

/** Для тестов и /api/health: сколько ключей реально держим. */
export function _bucketCount(): number {
  return buckets.size;
}

function checkBucket(
  key: string,
  rule: BucketRule,
  now: number,
): { ok: boolean; retryInMs?: number } {
  evictExpiredBuckets(now, rule.windowMs);
  const arr = buckets.get(key) ?? [];
  const cutoff = now - rule.windowMs;
  // Drop old timestamps (in place, mutating).
  let i = 0;
  while (i < arr.length && arr[i]!.ts < cutoff) i++;
  if (i > 0) arr.splice(0, i);
  if (arr.length >= rule.max) {
    const retryInMs = Math.max(1, arr[0]!.ts + rule.windowMs - now);
    buckets.set(key, arr);
    return { ok: false, retryInMs };
  }
  // Пустое ведро в карте не держим: сама проверка не должна создавать записей.
  // Дальше по коду идёт commit() — он и заведёт ключ, когда есть что считать.
  if (arr.length === 0) buckets.delete(key);
  else buckets.set(key, arr);
  return { ok: true };
}

function commit(key: string, ts: number): void {
  evictExpiredBuckets(ts);
  const arr = buckets.get(key) ?? [];
  arr.push({ ts });
  buckets.set(key, arr);
}

export interface RateLimitDecision {
  ok: boolean;
  reason?: string;
  retryInMs?: number;
  /**
   * Момент, которым помечена резервация — тот же `now`, что ушёл в `commit`.
   * Заполняют только резервирующие функции и только на успешном пути; рефанд
   * снимает по нему ровно свою отметку. Подробности — в `refundBucket`.
   */
  reservedAt?: number;
}

/**
 * Проверяет все применимые лимиты для (agentKey, actionType). Не коммитит.
 * Возвращает первое нарушение или {ok:true}.
 *
 * ВНИМАНИЕ: это read-only check. Между `checkRateLimit()` и `commitRateLimit()`
 * есть race window — concurrent calls могут одновременно пройти check и
 * закоммитить, превысив лимит. Для race-free reservation используйте
 * `checkAndConsumeRateLimit()` (T-314).
 */
export function checkRateLimit(
  agentKey: string,
  actionType: string,
  now: number = Date.now(),
): RateLimitDecision {
  return evaluateAllBuckets(agentKey, actionType, now);
}

/**
 * T-314: race-free reservation. Атомарно (синхронно, без await) проверяет ВСЕ
 * применимые бакеты и, если все ok, коммитит во все три (perAgent, global,
 * agent-all). Это единственный способ корректно зарезервировать слот при
 * concurrent dispatch — JS event loop гарантирует, что между check и commit
 * никакая другая корутина не может вклиниться, потому что весь блок sync.
 *
 * NOTE: в одном-процессе Bun backend этого достаточно. Если когда-нибудь
 * понадобится multi-process — нужен будет переход на SQLite с BEGIN IMMEDIATE
 * или внешний store (Redis INCR + EXPIRE).
 */
export function checkAndConsumeRateLimit(
  agentKey: string,
  actionType: string,
  now: number = Date.now(),
): RateLimitDecision {
  const decision = evaluateAllBuckets(agentKey, actionType, now);
  if (!decision.ok) return decision;
  // All buckets cleared — commit atomically (still sync, no await between).
  const rules = RULES[actionType];
  if (rules?.perAgent) commit(`agent:${agentKey}:${actionType}`, now);
  if (rules?.global) commit(`global:${actionType}`, now);
  commit(`agent-all:${agentKey}`, now);
  return { ok: true, reservedAt: now };
}

function evaluateAllBuckets(
  agentKey: string,
  actionType: string,
  now: number,
): RateLimitDecision {
  const rules = RULES[actionType];

  // 1. Per-action per-agent
  if (rules?.perAgent) {
    const k = `agent:${agentKey}:${actionType}`;
    const r = checkBucket(k, rules.perAgent, now);
    if (!r.ok)
      return {
        ok: false,
        reason: `rate limit: ${actionType} per agent (${rules.perAgent.max}/${Math.round(rules.perAgent.windowMs / 1000)}s)`,
        retryInMs: r.retryInMs,
      };
  }
  // 2. Per-action global
  if (rules?.global) {
    const k = `global:${actionType}`;
    const r = checkBucket(k, rules.global, now);
    if (!r.ok)
      return {
        ok: false,
        reason: `rate limit: ${actionType} global (${rules.global.max}/${Math.round(rules.global.windowMs / 1000)}s)`,
        retryInMs: r.retryInMs,
      };
  }
  // 3. All-tools per-agent
  {
    const k = `agent-all:${agentKey}`;
    const r = checkBucket(k, ALL_AGENT_TOOLS_RULE, now);
    if (!r.ok)
      return {
        ok: false,
        reason: `rate limit: all tools per agent (${ALL_AGENT_TOOLS_RULE.max}/${Math.round(ALL_AGENT_TOOLS_RULE.windowMs / 1000)}s)`,
        retryInMs: r.retryInMs,
      };
  }
  return { ok: true };
}

/**
 * Фиксирует событие во всех применимых бакетах. Вызывать только когда
 * мы реально dispatched (а не denied/approval'd).
 *
 * @deprecated since T-314 — используйте `checkAndConsumeRateLimit()` чтобы
 * избежать race window между check и commit. Оставлен для обратной
 * совместимости тестов.
 */
export function commitRateLimit(
  agentKey: string,
  actionType: string,
  now: number = Date.now(),
): void {
  const rules = RULES[actionType];
  if (rules?.perAgent) commit(`agent:${agentKey}:${actionType}`, now);
  if (rules?.global) commit(`global:${actionType}`, now);
  commit(`agent-all:${agentKey}`, now);
}

/**
 * T-315: per-chat check — separate from per-agent check on purpose so
 * T-314's locking rewrite of checkRateLimit does not conflict. Caller must
 * invoke BOTH; either failure denies.  Returns ok:true if chatId is missing
 * (action without chat context — fall back to per-agent gate only).
 */
export function checkPerChatRateLimit(
  chatId: number | string | undefined,
  actionType: string,
  now: number = Date.now(),
): RateLimitDecision {
  if (chatId === undefined || chatId === null || chatId === "") {
    return { ok: true };
  }
  const rule = perChatRule();
  const k = `chat:${chatId}:${actionType}`;
  const r = checkBucket(k, rule, now);
  if (!r.ok) {
    return {
      ok: false,
      reason: `rate limit: ${actionType} per chat (${rule.max}/${Math.round(rule.windowMs / 1000)}s)`,
      retryInMs: r.retryInMs,
    };
  }
  return { ok: true };
}

/**
 * T-315: commit per-chat bucket. Called alongside commitRateLimit on
 * successful dispatch.
 */
export function commitPerChatRateLimit(
  chatId: number | string | undefined,
  actionType: string,
  now: number = Date.now(),
): void {
  if (chatId === undefined || chatId === null || chatId === "") return;
  commit(`chat:${chatId}:${actionType}`, now);
}

/**
 * T-240: per-bot per-chat rate limiting. Anti-flood protection keyed by
 * (bot_id, chat_id) combination. This is more specific than per-chat alone
 * and allows different bots to have separate flood limits in the same chat.
 */
export function checkPerBotPerChatRateLimit(
  botId: number | string | undefined,
  chatId: number | string | undefined,
  actionType: string,
  now: number = Date.now(),
): RateLimitDecision {
  if (botId === undefined || botId === null || botId === "") {
    return { ok: true };
  }
  if (chatId === undefined || chatId === null || chatId === "") {
    return { ok: true };
  }
  const rule = perBotPerChatRule();
  const k = `bot:${botId}:chat:${chatId}:${actionType}`;
  const r = checkBucket(k, rule, now);
  if (!r.ok) {
    return {
      ok: false,
      reason: `rate limit: ${actionType} per bot per chat (${rule.max}/${Math.round(rule.windowMs / 1000)}s)`,
      retryInMs: r.retryInMs,
    };
  }
  return { ok: true };
}

/**
 * T-240: commit per-bot per-chat bucket. Called alongside other rate limit
 * commits on successful dispatch.
 */
export function commitPerBotPerChatRateLimit(
  botId: number | string | undefined,
  chatId: number | string | undefined,
  actionType: string,
  now: number = Date.now(),
): void {
  if (botId === undefined || botId === null || botId === "" ||
      chatId === undefined || chatId === null || chatId === "") return;
  commit(`bot:${botId}:chat:${chatId}:${actionType}`, now);
}

/**
 * Аудит 2026-08-09: T-314 закрыл гонку check-then-act только для агентских
 * бакетов, а per-chat и per-bot-per-chat остались ровно в том виде, который
 * комментарий T-314 описывает как дырявый: проверка в начале gateOrDispatch,
 * коммит — ПОСЛЕ `await dispatchAndAudit`. Telegraf обрабатывает пачку из
 * getUpdates через Promise.all, так что конкурентные вызовы тут не гипотеза:
 * N ходов видят «count < max» на одной и той же пустой корзине, все проходят и
 * коммитят уже после отправки. Именно чат-лимит и защищает чат от флуда —
 * агентский лимит его не заменяет, у двенадцати ролей двенадцать своих корзин.
 *
 * Резервируем так же, как агентские: синхронно, без await между проверкой и
 * коммитом. Оба чат-бакета — одной операцией, иначе между ними появляется
 * половинчатое состояние (слот чата занят, слот бота нет).
 */
export function checkAndConsumeChatRateLimits(
  botId: number | string | undefined,
  chatId: number | string | undefined,
  actionType: string,
  now: number = Date.now(),
): RateLimitDecision {
  const chat = checkPerChatRateLimit(chatId, actionType, now);
  if (!chat.ok) return chat;
  const botChat = checkPerBotPerChatRateLimit(botId, chatId, actionType, now);
  if (!botChat.ok) return botChat;
  commitPerChatRateLimit(chatId, actionType, now);
  commitPerBotPerChatRateLimit(botId, chatId, actionType, now);
  return { ok: true, reservedAt: now };
}

/** Откат резервации чат-бакетов — зеркало refundRateLimit. */
export function refundChatRateLimits(
  botId: number | string | undefined,
  chatId: number | string | undefined,
  actionType: string,
  now: number = Date.now(),
  reservedAt?: number,
): void {
  if (NO_REFUND_ACTIONS.has(actionType)) return;
  const windowMs = perChatRule().windowMs;
  const hasChat = !(chatId === undefined || chatId === null || chatId === "");
  const hasBot = !(botId === undefined || botId === null || botId === "");
  if (hasChat) refundBucket(`chat:${chatId}:${actionType}`, windowMs, now, reservedAt);
  if (hasChat && hasBot) {
    refundBucket(`bot:${botId}:chat:${chatId}:${actionType}`, windowMs, now, reservedAt);
  }
}

/**
 * Снять отметку резервации из корзины.
 *
 * `reservedAt` — время, которым помечена наша резервация (его возвращают
 * `checkAndConsumeRateLimit` и `checkAndConsumeChatRateLimits`). Снимаем
 * ровно её; если она уже вышла из окна — не снимаем ничего.
 *
 * Аудит 2026-08-29: раньше снималась «последняя отметка в окне», без всякой
 * связи с резервацией. Для действия, которое завершается быстро, разницы нет
 * (отметки внутри окна взаимозаменяемы), а для долгого — есть, и она
 * обратная задуманному. `MAC_RUN_CLAUDE` ждёт мост до пяти минут
 * (mac-bridge.ts) и на таймауте возвращает `{ok:false}` без `sideEffect`, то
 * есть штатно рефандится; резервация с t=0 к этому моменту из минутного окна
 * уже вышла и в счёте не участвует. Рефанд же находил ЧУЖУЮ, живую отметку —
 * от хода, сделанного за эти пять минут, — и снимал её: лимит «60 в минуту»
 * пропускал шестьдесят первый вызов. То же у любого `DELEGATE_TO_ROLE` (6 в
 * минуту), провалившегося дольше чем через минуту.
 *
 * Одновременные ходы этим не задеты: их отметки лежат в одном окне и
 * действительно взаимозаменяемы. Ломался ровно случай «резервация истекла».
 *
 * Без `reservedAt` поведение прежнее — чтобы вызов, у которого резервации на
 * руках нет, не остался вовсе без отката.
 */
function refundBucket(
  key: string,
  windowMs: number,
  now: number,
  reservedAt?: number,
): void {
  const arr = buckets.get(key);
  if (!arr || arr.length === 0) return;
  const cutoff = now - windowMs;
  if (reservedAt !== undefined) {
    // Резервация вышла из окна — снимать нечего: она и так уже не считается,
    // а любая отметка в корзине сейчас принадлежит другому ходу.
    if (reservedAt < cutoff) return;
    const i = arr.findLastIndex((entry) => entry.ts === reservedAt);
    if (i !== -1) arr.splice(i, 1);
    buckets.set(key, arr);
    return;
  }
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i]!.ts >= cutoff) {
      arr.splice(i, 1);
      break;
    }
  }
  buckets.set(key, arr);
}

/**
 * Действия, у которых слот НЕ возвращается при ошибке dispatch'а.
 *
 * Аудит 2026-08-08: refundRateLimit возвращал слот всегда — «агент не виноват,
 * что инфраструктура упала». Для SEND_MESSAGE это верно и ничего не стоит. Для
 * GENERATE_IMAGE — нет: деньги OpenAI списываются ВНУТРИ dispatch'а, до того
 * как результат пойдёт в Telegram. Если tgSendPhoto стабильно падает (бота
 * выкинули из чата, фото не проходит по размеру), каждая попытка — реальные
 * $0.04, а счётчик после рефанда стоит на месте. Лимит «6/час на агента, 30/час
 * суммарно» подписан ценой в комментарии к RULES — но именно в том сценарии,
 * где цикл и возможен, он не держал вообще.
 *
 * Обратная сторона: если dispatch упал ДО обращения к OpenAI (например
 * `no telegram context`), слот всё равно спишется. Это осознанный размен —
 * шесть слотов в час против неограниченного счёта, и ранние падения такого
 * рода это баг конфигурации, а не рабочий режим.
 */
const NO_REFUND_ACTIONS = new Set<string>(["GENERATE_IMAGE"]);

/**
 * T-314: откат резервации (используется если dispatch упал после
 * `checkAndConsumeRateLimit`). Передавайте `reservedAt` из решения —
 * тогда снимается ровно своя отметка, а истёкшая резервация не снимает
 * ничего (см. `refundBucket`). Без него — прежнее поведение: последний
 * timestamp >= now-windowMs из каждого применимого бакета.
 */
export function refundRateLimit(
  agentKey: string,
  actionType: string,
  now: number = Date.now(),
  reservedAt?: number,
): void {
  if (NO_REFUND_ACTIONS.has(actionType)) return;
  const rules = RULES[actionType];
  const keys: Array<{ key: string; windowMs: number }> = [];
  if (rules?.perAgent) keys.push({ key: `agent:${agentKey}:${actionType}`, windowMs: rules.perAgent.windowMs });
  if (rules?.global) keys.push({ key: `global:${actionType}`, windowMs: rules.global.windowMs });
  keys.push({ key: `agent-all:${agentKey}`, windowMs: ALL_AGENT_TOOLS_RULE.windowMs });
  for (const { key, windowMs } of keys) refundBucket(key, windowMs, now, reservedAt);
}

/**
 * T-402: Userbot anti-flood — per-(account, chatId) sliding-window bucket.
 *
 * Keyed `userbot:<account>:chat:<chatId>`, где account — роль при включённом
 * роутере и один общий ключ при выключенном (см. userbotAccountKey).
 * Configurable via env:
 *   USERBOT_FLOOD_MAX_PER_WINDOW  — max messages (default 20)
 *   USERBOT_FLOOD_WINDOW_MS       — window in ms (default 60000)
 *
 * Env-parsing follows the same fail-closed style as readPerChatMax(): invalid
 * or empty values fall back to the safe default.
 */
function readUserbotFloodMax(): number {
  const raw = process.env.USERBOT_FLOOD_MAX_PER_WINDOW;
  if (raw === undefined || raw === "") return 20;
  const n = Number(raw.trim());
  if (!Number.isSafeInteger(n) || n <= 0) return 20;
  return Math.min(n, 10_000);
}

function readUserbotFloodWindowMs(): number {
  const raw = process.env.USERBOT_FLOOD_WINDOW_MS;
  if (raw === undefined || raw === "") return 60_000;
  const n = Number(raw.trim());
  if (!Number.isSafeInteger(n) || n <= 0) return 60_000;
  return Math.min(n, 7 * 24 * HOUR_MS);
}

function userbotFloodRule(): BucketRule {
  return { windowMs: readUserbotFloodWindowMs(), max: readUserbotFloodMax() };
}

/**
 * Аудит 2026-08-28: ведро анти-флуда ключевалось ролью, а аккаунт один.
 *
 * Пока `USERBOT_ROUTER_ENABLED` не равен "true", `resolveUserbotHandle`
 * (`dispatch/telegram.ts`) отдаёт ОДИН синглтон — личную сессию владельца.
 * Ролевой ключ в этом режиме означал: у четырёх ролей с PUBLISH_TO_CHANNEL
 * (permissions.ts) по своему ведру на 20/мин, то есть реальный потолок
 * аккаунта вчетверо выше настроенного, — при том что защищаем мы именно
 * аккаунт, а не роль.
 *
 * С включённым роутером у роли своя сессия, и раздельные вёдра верны. Поэтому
 * ключ зависит от режима: одна сессия — один ключ на всех.
 */
export const SHARED_USERBOT_ACCOUNT_KEY = "@owner";

export function userbotAccountKey(characterId: string | number): string {
  return process.env.USERBOT_ROUTER_ENABLED === "true"
    ? String(characterId)
    : SHARED_USERBOT_ACCOUNT_KEY;
}

function userbotBucketKey(
  characterId: string | number,
  chatId: string | number,
): string {
  return `userbot:${userbotAccountKey(characterId)}:chat:${chatId}`;
}

/**
 * T-402: Check per-(characterId, chatId) userbot flood limit.
 * Returns ok:true if characterId or chatId is missing (no context → pass).
 */
export function checkUserbotFloodLimit(
  characterId: string | number | undefined,
  chatId: string | number | undefined,
  now: number = Date.now(),
): RateLimitDecision {
  if (characterId === undefined || characterId === null || characterId === "") {
    return { ok: true };
  }
  if (chatId === undefined || chatId === null || chatId === "") {
    return { ok: true };
  }
  const rule = userbotFloodRule();
  const k = userbotBucketKey(characterId, chatId);
  const r = checkBucket(k, rule, now);
  if (!r.ok) {
    return {
      ok: false,
      reason: `userbot flood limit: per character/chat (${rule.max}/${Math.round(rule.windowMs / 1000)}s)`,
      retryInMs: r.retryInMs,
    };
  }
  return { ok: true };
}

/**
 * Сколько отправок ведро пропустит прямо сейчас (и когда освободится слот).
 *
 * Аудит 2026-08-20: ведро тратится ПО ОДНОЙ отправке, а длинный ответ уходит
 * N сообщениями. Проверка перед первой частью говорила «можно», части 1..k
 * уходили, а на k+1 ведро кончалось — в чате оставалось оборванное на середине
 * сообщение ОТ ЛИЦА ВЛАДЕЛЬЦА, и повторить его нельзя (см. PartialSendError:
 * повтор дублирует уже доставленное). Чтобы такого не было, вызывающий должен
 * уметь спросить ёмкость на все части СРАЗУ и отказаться целиком.
 *
 * `Infinity` при отсутствии characterId/chatId — то же fail-open, что и у
 * checkUserbotFloodLimit: без контекста ведро не ведём.
 */
export function userbotFloodCapacity(
  characterId: string | number | undefined,
  chatId: string | number | undefined,
  now: number = Date.now(),
): { free: number; max: number; retryInMs: number } {
  const rule = userbotFloodRule();
  if (
    characterId === undefined || characterId === null || characterId === "" ||
    chatId === undefined || chatId === null || chatId === ""
  ) {
    return { free: Number.POSITIVE_INFINITY, max: rule.max, retryInMs: 0 };
  }
  const k = userbotBucketKey(characterId, chatId);
  // Читаем, не создавая ключ: сама проверка ёмкости не должна занимать слот.
  const arr = buckets.get(k) ?? [];
  const cutoff = now - rule.windowMs;
  let i = 0;
  while (i < arr.length && arr[i]!.ts < cutoff) i++;
  const used = arr.length - i;
  const free = Math.max(0, rule.max - used);
  const oldest = arr[i]?.ts;
  return {
    free,
    max: rule.max,
    retryInMs: used > 0 && oldest !== undefined ? Math.max(1, oldest + rule.windowMs - now) : 0,
  };
}

/**
 * Через сколько в ведре `k` освободится `need` слотов.
 *
 * Слот освобождается, когда запись выпадает из окна, поэтому ждать надо не
 * самую старую запись, а `need`-ю по старшинству: она уйдёт последней из
 * тех, чей уход нам нужен.
 */
function retryInMsForSlots(
  k: string,
  need: number,
  rule: BucketRule,
  now: number,
): number {
  if (need <= 0) return 0;
  const arr = buckets.get(k) ?? [];
  const cutoff = now - rule.windowMs;
  let i = 0;
  while (i < arr.length && arr[i]!.ts < cutoff) i++;
  const live = arr.slice(i);
  // Записи в ведре монотонны по времени (пишутся только «сейчас»), так что
  // `live` уже отсортирован: нужная — под индексом `need - 1`.
  const target = live[need - 1]?.ts;
  if (target === undefined) return 0;
  return Math.max(1, target + rule.windowMs - now);
}

/**
 * Занять `count` слотов ведра СРАЗУ — атомарно относительно любого await.
 *
 * Аудит 2026-08-20 (вторая итерация). Гейт «не хватает ёмкости — не шлём
 * ничего» выше по файлу считал ёмкость через `userbotFloodCapacity`, а тот
 * намеренно ничего не занимает. Между чтением и первым коммитом (коммит идёт
 * только ПОСЛЕ успешной отправки, `userbot-flood.ts`) лежит сетевой
 * round-trip, то есть окно check-then-act:
 *
 *   ход A: partCount=12, free=20 → пропускаем
 *   ход B (до первого коммита A): free всё ещё 20 → тоже пропускаем
 *   дальше 24 части идут вперемешку, на 21-й ведро кончается
 *
 * и получается ровно тот отказ, ради которого гейт и писали: оборванное на
 * середине сообщение ОТ ЛИЦА ВЛАДЕЛЬЦА, которое нельзя повторить (повтор
 * дублирует уже доставленное — см. `partialSendFailure`).
 *
 * Что ходы бывают одновременными — не гипотеза: telegraf обрабатывает пачку
 * из getUpdates через `Promise.all`, а веер по ролям в message-handler идёт
 * без `await` (то же обоснование, что у `agent-sdk-runtime.ts:99` и ниже в
 * этом файле). Ключ ведра — `userbot:<account>:chat:<chatId>`, и при одной
 * общей сессии он совпадает у конкурирующих ходов любых ролей. Плюс
 * SET_REACTION/DELETE_MESSAGE ходят в то же ведро через `guardedUserbotCall`
 * и ёмкость не считают вовсе.
 *
 * Отсюда: проверка и занятие — одна синхронная операция. Незанятое
 * возвращается через `release(n)`.
 *
 * Слоты помечаются временем ВЫДАЧИ, а не отправки, поэтому истекают на
 * длительность отправки раньше реальной. Расхождение — доли секунды при окне
 * в минуту, и в безопасную сторону (лишний слот освободится чуть позже, чем
 * появился бы, а не раньше).
 */
export type UserbotSlotReservation =
  | { ok: true; release: (n: number) => void }
  | {
      ok: false;
      free: number;
      max: number;
      retryInMs: number;
      /**
       * Запрос больше всего ведра: ждать бессмысленно, сколько ни жди.
       * Вызывающий обязан сказать это словами, иначе получится совет
       * «повтор через ~0s», приглашающий крутить отказ в цикле.
       */
      impossible: boolean;
    };

export function reserveUserbotFloodSlots(
  characterId: string | number | undefined,
  chatId: string | number | undefined,
  count: number,
  now: number = Date.now(),
): UserbotSlotReservation {
  const noop = { ok: true as const, release: () => {} };
  if (
    characterId === undefined || characterId === null || characterId === "" ||
    chatId === undefined || chatId === null || chatId === ""
  ) {
    // Тот же fail-open, что у checkUserbotFloodLimit: без контекста ведра нет.
    return noop;
  }
  if (!Number.isFinite(count) || count <= 0) return noop;

  // Правило нужно обеим веткам: отказу — чтобы посчитать срок ожидания,
  // успеху — чтобы поднять порог вытеснения (evictExpiredBuckets).
  const rule = userbotFloodRule();
  const cap = userbotFloodCapacity(characterId, chatId, now);
  if (count > cap.free) {
    // Аудит 2026-08-27: отказ раньше сообщал `cap.retryInMs` — время до
    // освобождения ОДНОГО (самого старого) слота. Две беды сразу:
    //
    //  1. При пустом ведре и `count > max` ждать нечего вовсе: `retryInMs`
    //     равен нулю, и текст отказа звал повторить «через ~0s». Повтор
    //     давал ровно тот же отказ — то есть приглашение крутить цикл.
    //  2. Даже когда ждать осмысленно, одного слота обычно мало: нужно
    //     `count - free` штук. Повтор в названный срок падал снова.
    //
    // Считаем срок до освобождения ИМЕННО нужного числа слотов и отдельно
    // сообщаем случай, когда ждать бесполезно.
    const impossible = count > cap.max;
    return {
      ok: false,
      free: cap.free,
      max: cap.max,
      retryInMs: impossible
        ? 0
        : retryInMsForSlots(userbotBucketKey(characterId, chatId), count - cap.free, rule, now),
      impossible,
    };
  }

  const k = userbotBucketKey(characterId, chatId);
  const reservationId = nextReservationId++;
  evictExpiredBuckets(now, rule.windowMs);
  const arr = buckets.get(k) ?? [];
  for (let i = 0; i < count; i++) arr.push({ ts: now, reservationId });
  buckets.set(k, arr);

  let held = count;
  return {
    ok: true,
    release: (n: number) => {
      // Возвращаем не больше, чем ещё держим: двойной release не должен
      // выедать чужие записи из ведра.
      const back = Math.min(Math.max(0, Math.floor(n)), held);
      if (back === 0) return;
      held -= back;
      const arr = buckets.get(k);
      if (!arr) return;
      let left = back;
      for (let i = arr.length - 1; i >= 0 && left > 0; i--) {
        // Идентификатор принадлежности важнее времени: обычный commit или
        // соседняя резервация могут иметь тот же `now`.
        if (arr[i]!.reservationId === reservationId) {
          arr.splice(i, 1);
          left--;
        }
      }
      if (arr.length === 0) buckets.delete(k);
    },
  };
}

/**
 * T-402: Commit a userbot flood bucket entry. Call after a successful send.
 */
export function commitUserbotFloodLimit(
  characterId: string | number | undefined,
  chatId: string | number | undefined,
  now: number = Date.now(),
): void {
  if (
    characterId === undefined || characterId === null || characterId === "" ||
    chatId === undefined || chatId === null || chatId === ""
  ) return;
  commit(userbotBucketKey(characterId, chatId), now);
}

/**
 * SEC-3 / T-601: ingestion-side throttle — per-(chatId, userId) sliding window
 * on agent-TRIGGERING messages. Without it, any member of an allowlisted chat
 * can drive unbounded LLM spend by flooding messages (each triggers a full
 * runWithTools turn; the anti-dup layer only stops the *same* message_id).
 *
 * Keyed `ingest:chat:<chatId>:user:<userId>`. Configurable via env:
 *   INGEST_RATE_MAX_PER_WINDOW  — max triggers (default 15)
 *   INGEST_RATE_WINDOW_MS       — window in ms (default 60000)
 * Fail-open only on missing context (system/unknown sender) — never blocks
 * a message we can't attribute; otherwise check-and-consume atomically.
 */
function readIngestMax(): number {
  const raw = process.env.INGEST_RATE_MAX_PER_WINDOW;
  if (raw === undefined || raw === "") return 15;
  const n = Number(raw.trim());
  if (!Number.isSafeInteger(n) || n <= 0) return 15;
  return Math.min(n, 10_000);
}

function readIngestWindowMs(): number {
  const raw = process.env.INGEST_RATE_WINDOW_MS;
  if (raw === undefined || raw === "") return 60_000;
  const n = Number(raw.trim());
  if (!Number.isSafeInteger(n) || n <= 0) return 60_000;
  return Math.min(n, 7 * 24 * HOUR_MS);
}

export function checkAndConsumeIngestLimit(
  chatId: string | number | undefined | null,
  userId: string | number | undefined | null,
  now: number = Date.now(),
): RateLimitDecision {
  if (chatId === undefined || chatId === null || chatId === "") return { ok: true };
  if (userId === undefined || userId === null || userId === "") return { ok: true };
  const rule: BucketRule = { windowMs: readIngestWindowMs(), max: readIngestMax() };
  const k = `ingest:chat:${chatId}:user:${userId}`;
  const r = checkBucket(k, rule, now);
  if (!r.ok) {
    return {
      ok: false,
      reason: `ingest rate limit: ${rule.max}/${Math.round(rule.windowMs / 1000)}s per user/chat`,
      retryInMs: r.retryInMs,
    };
  }
  commit(k, now);
  return { ok: true };
}

/** Для тестов. */
export function _resetRateLimits(): void {
  buckets.clear();
  lastEvict = 0;
  maxWindowMs = HOUR_MS;
}
