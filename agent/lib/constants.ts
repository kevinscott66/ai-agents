/**
 * constants.ts — Centralized application constants (T-321).
 *
 * Magic numbers extracted from across the codebase into named, documented
 * constants. Pure refactor: every value here is identical to the literal it
 * replaces — no behavioral change.
 *
 * Only constants with an actual call-site live here. Do not add aspirational
 * "might-use-later" values — that turns this file into dead code.
 */

// ========================================
// Network & Ports
// ========================================

/** Default port for the Mini App HTTP server / API endpoints. */
/**
 * Потолок задержки таймера: setTimeout/setInterval держат её в 32-битном
 * знаковом int. Больше — Bun печатает одну строку TimeoutOverflowWarning в
 * stderr (она тонет в логах ровно так же, как TimeoutNaNWarning) и ставит
 * период в 1 мс, то есть таймер начинает молотить вместо того чтобы спать.
 *
 * Аудит 2026-08-14 (#688): верхней границы у `_envPositiveInt` не было, и
 * лишняя цифра в env пролезала насквозь. `WATCHDOG_INTERVAL_MS=99999999999`
 * (одиннадцать девяток вместо девяти — «раз в год» вместо «раз в 100 секунд»)
 * не целым числом не является и нулём не является, поэтому доезжал до
 * setInterval. Замерено на рантайме проекта: 257 тиков за 300 мс. Ниже по
 * стеку границы нет ни у одного потребителя (`lib/health.ts`,
 * `lib/watchdog.ts` кладут значение в setInterval как есть).
 *
 * Аудит 2026-08-28: тот же исход нашёлся у периода тика шторма
 * (`stormTickMs` в lib/alerting.ts) — путь alerting в `_envPositiveInt` не
 * заходит вовсе. Поэтому граница живёт здесь: одно определение на проект.
 */
export const MAX_TIMER_MS = 2_147_483_647;

export const DEFAULT_MINIAPP_PORT = 8787;

/** Default port for the Mac Bridge WebSocket server.
 *  T-116: distinct from the Mini App's 8787 so the bridge can't collide-bind
 *  the miniapp port when MAC_BRIDGE_PORT is unset. */
export const DEFAULT_MAC_BRIDGE_PORT = 8788;

/** Интерфейс моста по умолчанию — только loopback.
 *  T-116: наружу мост не выставляется, демон на Mac приходит по ssh-туннелю,
 *  он же даёт транспортное шифрование. Константа отдельно от строки вызова,
 *  чтобы у дефолта было одно место и его нельзя было потерять в `??`. */
export const DEFAULT_MAC_BRIDGE_HOST = "127.0.0.1";

// ========================================
// Message & Content Limits
// ========================================

/**
 * Max characters kept from the tail of a combined agent reply before it is
 * posted to Telegram (guards against Telegram's per-message size limit).
 */
export const TELEGRAM_MESSAGE_TAIL_LIMIT = 3500;

/** Default number of recent messages pulled from memory for context. */
export const DEFAULT_MESSAGE_HISTORY_LIMIT = 30;

// ========================================
// Database & Maintenance
// ========================================

/** Default age (days) after which `messages`/task rows are archived. */
export const DEFAULT_ARCHIVE_DAYS = 30;

// ========================================
// Rate Limiting (per-agent / global)
// ========================================

/** Per-agent SEND_MESSAGE limit (per minute) — anti spam-loop. */
export const DEFAULT_SEND_MESSAGE_RATE_LIMIT = 30;

/** Per-agent SET_REACTION limit (per minute) — anti spam-loop. */
export const DEFAULT_SET_REACTION_RATE_LIMIT = 30;

/** Global GENERATE_IMAGE limit (per hour) across all agents — cost guard. */
export const DEFAULT_GENERATE_IMAGE_GLOBAL_LIMIT = 30;

/** Per-agent GENERATE_IMAGE limit (per hour) — cost guard ($0.04/image). */
export const DEFAULT_GENERATE_IMAGE_PER_AGENT_LIMIT = 6;

// ========================================
// Handoff / delegation
// ========================================

/**
 * S1: жёсткий потолок ОБЩЕГО числа handoff-вызовов в одном ходе пользователя.
 * `visited` ограничивает только линейный путь, но при ветвлении (несколько
 * @-упоминаний или несколько DELEGATE_TO_ROLE) дерево растёт, и каждый узел —
 * это LLM-вызов ($0.5–1.5).
 *
 * 16: полный проектный план (product→design→frontend→backend→tgdev→qa→copy)
 * проходит целиком, не упираясь в потолок. Всё ещё bounded (анти-runaway).
 *
 * Живёт здесь, а не рядом с respondAs, потому что счётчик заводит tool-loop —
 * а он ниже handoff по графу импортов (handoff → tool-loop).
 */
export const HANDOFF_MAX_INVOCATIONS = (() => {
  const n = Number.parseInt(process.env.HANDOFF_MAX_INVOCATIONS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 16;
})();

// ========================================
// Tool loop
// ========================================

/**
 * Сколько раз один и тот же инструмент может отработать за ОДИН ход
 * пользователя — на обоих путях исполнения (raw tool-loop и Agent SDK).
 *
 * Раньше жил только на SDK-пути (`SDK_MAX_CALLS_PER_TOOL`). У raw-пути был
 * лишь C12 — «не больше двух за ответ модели», а счётчик заводился ВНУТРИ
 * итерации цикла и обнулялся на каждой. То есть потолок на ход был не 2, а
 * 2 × MAX_TOOL_ITERS = 28, причём классическая петля — один вызов на итерацию,
 * четырнадцать раз подряд — не задевала охрану вовсе: n никогда не доходило
 * до 3. Ровно тот случай, ради которого охрану и ставили.
 *
 * 8 — не выдумка, а число, уже год работающее на SDK-пути (а на проде
 * USE_AGENT_SDK=true, то есть это и есть боевой потолок). Держим одно значение
 * на два пути: разъехавшиеся близнецы в этом коде уже случались.
 */
export const MAX_CALLS_PER_TOOL_PER_RUN = 8;

/** C12: не больше двух вызовов одного инструмента в ОДНОМ ответе модели. */
export const MAX_CALLS_PER_TOOL_PER_RESPONSE = 2;

/**
 * Статусы `ok:false`, которые НЕ являются провалом инструмента.
 *
 * `pending_approval` — действие поставлено на согласование, строка в
 * `approvals` уже закоммичена (ветка `pending_approval` в `gateOrDispatch`).
 * `rate_limited` — действие отложено, есть `retryInMs`, ждать надо, а не чинить. Если отдать
 * их модели как ошибку, она читает это как провал и зовёт тот же инструмент
 * снова: MAX_CALLS_PER_TOOL_PER_RESPONSE не мешает (вызов в каждом ответе
 * один), так что до MAX_CALLS_PER_TOOL_PER_RUN набегает до восьми карточек
 * согласования на одну просьбу человека — или восемь `rate_limited`-строк,
 * которые `alerting.ts` считает «штормом рейт-лимита», сгенерированным
 * агентом против самого себя.
 *
 * Живёт в constants.ts, а не в tool-loop.ts, потому что нужен ОБОИМ путям
 * исполнения, а прямой импорт между ними — цикл (см. agent-sdk-runtime.ts).
 * Аудит 2026-08-28: набор завели 2026-08-28 на raw-пути и не перенесли на
 * SDK-путь, а на проде USE_AGENT_SDK=true — то есть боевой путь остался
 * несогласованным именно там, где чинили. Разъехавшиеся близнецы в этом коде
 * уже случались, поэтому теперь значение одно на два пути.
 */
export const CONTROL_TOOL_STATUSES: ReadonlySet<string> = new Set([
  "pending_approval",
  "rate_limited",
]);

/**
 * Инструменты, которые диспатчер исполняет сам, не уходя в action-dispatch:
 * чтение без побочных эффектов (плюс CANCEL_SCHEDULED_POST — единственная
 * мутация в этом блоке, SEC-audit 2026-06-10 F1).
 *
 * Список живёт здесь, а не в tools-schema.ts, ради круга импортов: этот файл —
 * лист, его ни от кого не тянет. Аудит 2026-08-29: пока набор объявлялся в
 * tools-schema.ts, а agent-sdk-runtime.ts выводил из него
 * SDK_SIDE_EFFECT_FREE_TOOLS прямо на верхнем уровне модуля, любой прогон, где
 * первым вычислялся tools-schema.ts, падал с «Cannot access
 * 'INLINE_TOOL_NAMES' before initialization» — модуль ещё в полёте, а спред по
 * нему уже выполняется. В полном прогоне соседи подгружали цепочку в удобном
 * порядке и это пряталось; в одиночку файл не запускался вообще. Переезд в
 * лист рвёт круг для этой связки: константа готова раньше любого потребителя.
 *
 * tools-schema.ts продолжает реэкспортировать имя — все существующие импорты
 * остаются рабочими.
 */
export const INLINE_TOOL_NAMES = new Set<string>([
  "SEARCH_WIKI",
  "READ_WIKI",
  "GET_BOT_INFO",
  "GET_METRICS",
  "QUERY_DB",
  "GET_GITHUB_STATUS",
  "GET_CHANNEL_STATS",
  "GET_FIGMA_FILE",
  "GET_PROMPT_HISTORY",
  "GET_LOGS",
  "LIST_SCHEDULED_POSTS",
  "CANCEL_SCHEDULED_POST",
]);
