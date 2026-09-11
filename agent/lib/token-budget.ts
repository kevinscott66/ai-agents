/**
 * C16: per-agent daily token budget.
 *
 * Tracks input/output token usage per (agent_key, UTC date) and enforces a
 * daily input-token budget read from env. Budget reset is automatic because
 * the UTC date is part of the primary key.
 *
 * Env:
 *  - TOKEN_BUDGET_<UPPER_KEY> — per-agent daily input-token cap.
 *  - TOKEN_BUDGET_DEFAULT     — fallback cap for any agent without a specific
 *                                override. If neither is set → no limit (Infinity).
 *                                Заданное, но нечисловое значение — НЕ то же
 *                                самое, что незаданное: см. parseBudgetEnv.
 */
import { db } from "./db.ts";
import { log } from "./log.ts";

/**
 * Дневной лимит исчерпан.
 *
 * Аудит 2026-08-21: ошибка не несла ничего, кроме цифр, и на SDK-пути это
 * теряло сделанную работу. `runViaAgentSdk` может упереться в потолок ПОСЛЕ
 * того, как ход выполнил инструменты: сообщение отправлено, задача создана,
 * пост выложен — всё это уже случилось в реальном мире. Соседняя ветка того же
 * места (`AgentSdkRunError`) ровно для этого носит `sideEffects` и
 * `partialText`, а бюджетная бросалась голой.
 *
 * Пользователь при этом слышал «вернусь после сброса», то есть «я ничего не
 * сделал» — и не узнавал ни про выполненные действия, ни про текст, который
 * агент уже успел написать.
 *
 * Оба поля необязательные: `checkBudget` бросает до начала хода, там сообщать
 * нечего, и трёхаргументный вызов остаётся валидным.
 */
export class BudgetExceededError extends Error {
  /** Успел ли ход выполнить хоть один наш инструмент до отказа. */
  readonly sideEffects: boolean;
  /** Текст, который агент успел написать до отказа. */
  readonly partialText: string;

  constructor(
    public agentKey: string,
    public used: number,
    public budget: number,
    opts?: { sideEffects?: boolean; partialText?: string },
  ) {
    super(
      `[budget] ${agentKey} exceeded: used=${used} budget=${budget} input tokens today`,
    );
    this.name = "BudgetExceededError";
    this.sideEffects = opts?.sideEffects === true;
    this.partialText = typeof opts?.partialText === "string" ? opts.partialText : "";
  }
}

/** UTC date as YYYY-MM-DD. */
export function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Чей это бюджет: всё до первого двоеточия.
 *
 * Аудит 2026-08-04: вспомогательные вызовы пишут расход под производным ключом
 * — `svg-fallback` бьёт в `${agentKey}:svg-fallback`. Такой ключ не совпадает
 * ни с одной строкой `budget_settings`, а env-имя TOKEN_BUDGET_DESIGN_SVG_
 * FALLBACK никто не задаёт, так что он молча получал TOKEN_BUDGET_DEFAULT —
 * то есть отдельный полноразмерный лимит. Итог: агент, упёршийся в свой дневной
 * потолок, продолжал жечь токены через фолбэк, а лимит, выставленный оператором
 * в Mini App, на этот расход не влиял вообще.
 *
 * Считаем расход на владельца. Детализация «на что именно» и так живёт в
 * agent_actions и логах, а потолок, который не держит, хуже отсутствия
 * детализации.
 *
 * Ключи без двоеточия (`_compactor`, `_sdk`) — не производные, а собственные
 * системные потребители: у них свой бюджет, и это осознанно.
 */
export function budgetOwner(agentKey: string): string {
  const i = agentKey.indexOf(":");
  return i === -1 ? agentKey : agentKey.slice(0, i);
}

/**
 * Сколько input-токенов реально оплачено по одному usage-блоку Anthropic.
 *
 * `input_tokens` НЕ включает кэш: `cache_read_input_tokens` и
 * `cache_creation_input_tokens` — отдельные поля и отдельные позиции в счёте.
 *
 * Аудит 2026-08-12: raw-путь (`callAnthropic`) складывал только `input_tokens`,
 * а SDK-путь — все три, причём его комментарий утверждал паритет с raw. Кэш на
 * raw-пути используется везде (системные блоки помечены `cache_control` в
 * handoff.ts и orchestrator/message-handler.ts, tool-loop гоняет их на каждой
 * итерации), так что из счёта выпадала основная часть расхода: на сессии
 * «1 холодный вызов + 5 тёплых» с префиксом ~10k записывалось 8 700 из 65 100
 * оплаченных токенов, и дневной лимит срабатывал в разы позже, чем должен.
 *
 * Одна функция на оба пути — иначе они снова разъедутся.
 */
export function usageInputTokens(u: unknown): number {
  if (!u || typeof u !== "object") return 0;
  const x = u as Record<string, unknown>;
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return (
    n(x.input_tokens) +
    n(x.cache_read_input_tokens) +
    n(x.cache_creation_input_tokens)
  );
}

/** Output-токены того же usage-блока. */
export function usageOutputTokens(u: unknown): number {
  if (!u || typeof u !== "object") return 0;
  const v = (u as Record<string, unknown>).output_tokens;
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Atomic upsert of today's row for (agent_key, date).
 * Increments counters on conflict.
 */
export function recordUsage(
  agentKey: string,
  inputTokens: number,
  outputTokens: number,
  date: string = todayUTC(),
): void {
  if (!agentKey) return;
  const owner = budgetOwner(agentKey);
  const inT = Math.max(0, Math.floor(inputTokens || 0));
  const outT = Math.max(0, Math.floor(outputTokens || 0));
  db.prepare(
    `INSERT INTO agent_token_usage(agent_key, date, input_tokens, output_tokens)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(agent_key, date) DO UPDATE SET
       input_tokens = input_tokens + excluded.input_tokens,
       output_tokens = output_tokens + excluded.output_tokens`,
  ).run(owner, date, inT, outT);
}

/** Read today's (or given date's) usage; missing row → zeros. */
export function getDailyUsage(
  agentKey: string,
  date: string = todayUTC(),
): { input: number; output: number } {
  // Аудит 2026-08-12: recordUsage нормализует ключ (пишет на владельца), а
  // читатель шёл в базу с сырым — по `design:svg-fallback` строки просто нет,
  // и расход читался нулём. Кто пишет на владельца, тот и читает с владельца.
  const row = db
    .prepare(
      `SELECT input_tokens AS input, output_tokens AS output
       FROM agent_token_usage WHERE agent_key = ? AND date = ?`,
    )
    .get(budgetOwner(agentKey), date) as
    | { input: number; output: number }
    | undefined;
  return row ? { input: row.input, output: row.output } : { input: 0, output: 0 };
}

/**
 * Resolve the daily input-token budget for `agentKey`.
 *
 * Ключ сперва приводится к владельцу (`budgetOwner`), и цепочка идёт по нему, а
 * не по переданному: производный `design:svg-fallback` тратит потолок роли
 * `design`, а не заводит себе второй.
 *
 * Priority:
 *  1. budget_settings DB row (T-527, Mini App override)
 *  2. `TOKEN_BUDGET_<OWNER>` env, где OWNER — владелец в верхнем регистре и с
 *     любым не-`[A-Z0-9]` заменённым на `_`
 *  3. TOKEN_BUDGET_DEFAULT env
 *  4. MALFORMED_ENV_BUDGET, если валидного значения нет НИ ОДНОГО, но хотя бы
 *     одно из двух env задано мусором: оператор явно хотел лимит
 *  5. Infinity (no limit)
 *
 * Мусор на шаге 2 не обрывает цепочку и не отменяет шаг 3 — иначе опечатка в
 * ключе роли поднимала бы ей лимит выше заданного дефолта.
 */
export function getBudget(agentKey: string): number {
  // Аудит 2026-08-12: производный ключ (`design:svg-fallback`) не совпадал ни
  // со строкой budget_settings, ни с TOKEN_BUDGET_DESIGN — и получал
  // TOKEN_BUDGET_DEFAULT либо Infinity, то есть второй полноразмерный лимит.
  // checkBudget/budgetRemaining уже нормализуют ключ; здесь этого не было.
  const owner = budgetOwner(agentKey);
  // 1. DB override
  const row = db
    .prepare(
      `SELECT daily_input_tokens AS n FROM budget_settings WHERE agent_key = ?`,
    )
    .get(owner) as { n: number } | undefined;
  if (row && Number.isFinite(row.n) && row.n > 0) return row.n;
  // 2/3. env
  const envKey = `TOKEN_BUDGET_${owner.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  const specific = parseBudgetEnv(envKey);
  if (specific !== null && !specific.malformed) return specific.value;
  const fallback = parseBudgetEnv("TOKEN_BUDGET_DEFAULT");
  if (fallback !== null && !fallback.malformed) {
    // Аудит 2026-08-20: раньше сюда не доходили. Мусорное значение в ключе роли
    // возвращалось как «значение найдено» — и TOKEN_BUDGET_DEFAULT затирался.
    // Оператор писал TOKEN_BUDGET_DEFAULT=1000 и опечатывался пробелом в одной
    // роли: эта роль получала 100_000, то есть в 100 раз БОЛЬШЕ заданного
    // дефолта. Опечатка не должна поднимать лимит.
    if (specific?.malformed) {
      warnBudgetEnv(
        envKey,
        specific.raw,
        `берём TOKEN_BUDGET_DEFAULT (${fallback.value}) input-токенов/сутки`,
      );
    }
    return fallback.value;
  }
  // Ни одного валидного значения. Если хоть где-то был мусор — оператор явно
  // хотел лимит, поэтому не Infinity, а консервативный потолок.
  if (specific?.malformed) {
    warnBudgetEnv(
      envKey,
      specific.raw,
      `вместо «без лимита» берём ${MALFORMED_ENV_BUDGET} input-токенов/сутки`,
    );
    return MALFORMED_ENV_BUDGET;
  }
  if (fallback?.malformed) {
    warnBudgetEnv(
      "TOKEN_BUDGET_DEFAULT",
      fallback.raw,
      `вместо «без лимита» берём ${MALFORMED_ENV_BUDGET} input-токенов/сутки`,
    );
    return MALFORMED_ENV_BUDGET;
  }
  return Infinity;
}

/**
 * Консервативный потолок на случай испорченного значения в env: не Infinity и
 * не ноль. Обоснование — над `parseBudgetEnv` ниже, там же он и выставляется.
 */
const MALFORMED_ENV_BUDGET = 100_000;
const warnedBudgetKeys = new Set<string>();

interface BudgetEnvValue {
  /** Значение, которое стоит применить, если дальше по цепочке ничего нет. */
  value: number;
  /** true — значение задано, но не парсится. Не «найдено», а «испорчено». */
  malformed: boolean;
  /** Сырое значение — для сообщения в лог. */
  raw: string;
}

function warnBudgetEnv(envKey: string, raw: string, action: string): void {
  if (warnedBudgetKeys.has(envKey)) return;
  warnedBudgetKeys.add(envKey);
  log.warn(
    `[budget] ${envKey}=${JSON.stringify(raw)} — не число; ${action}. ` +
      `Исправьте значение.`,
  );
}

/**
 * Аудит 2026-08-09: испорченное значение читалось как «лимита нет».
 *
 * Было `const n = Number(raw); if (!Number.isFinite(n) || n <= 0) return
 * Infinity`. То есть TOKEN_BUDGET_DEFAULT=2_000_000 (или `500k`, или число с
 * пробелом) — NaN — молча снимал дневной потолок со всех 12 агентов, а
 * TOKEN_BUDGET_DEFAULT=0, самый естественный способ написать «не тратить»,
 * означал ровно противоположное. Это единственное, что стоит между агентом и
 * неограниченным счётом в Anthropic, и оно ломалось от опечатки, без единой
 * строчки в логе. Соседний модуль (rate-limits.ts) в такой же ситуации падает
 * на безопасный дефолт и прямо это пишет: «Fail-closed: invalid env values
 * fall back to default».
 *
 * Теперь: незаданное — это по-прежнему «нет лимита» (контракт из шапки файла),
 * заданное-но-мусорное — не «незаданное». Ноль честно значит ноль. Мусор даёт
 * громкий warn и консервативный потолок: не Infinity (потому что оператор явно
 * хотел лимит) и не ноль (потому что опечатка не должна класть всю команду) —
 * агент проработает недолго и упрётся в BudgetExceededError с этим же числом,
 * так что причина найдётся за минуту.
 *
 * Аудит 2026-08-20: «мусор» перестал быть терминальным ответом. Раньше функция
 * возвращала само число MALFORMED_ENV_BUDGET, и вызывающий не мог отличить
 * «оператор задал 100000» от «оператор опечатался» — поэтому испорченный ключ
 * роли обрывал цепочку и отменял валидный TOKEN_BUDGET_DEFAULT, причём в
 * сторону повышения лимита. Теперь флаг `malformed` едет отдельно, и getBudget
 * сперва досматривает цепочку до конца.
 *
 * @returns null — «здесь не задано, смотри дальше»; иначе значение + флаг
 *          malformed («задано, но не число — применяй только если больше
 *          ничего нет»)
 */
function parseBudgetEnv(envKey: string): BudgetEnvValue | null {
  const raw = process.env[envKey];
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return { value: n, malformed: false, raw };
  return { value: MALFORMED_ENV_BUDGET, malformed: true, raw };
}

/** Тестовый хелпер — сбросить дедуп предупреждений. */
export function _resetBudgetEnvWarnings(): void {
  warnedBudgetKeys.clear();
}

/**
 * T-527: persist a per-agent daily budget override. `dailyInputTokens` must
 * be a positive integer; pass `null` to clear the override (fall back to env).
 *
 * Аудит 2026-08-21: единственный писатель в этом файле, который НЕ приводил
 * ключ к владельцу. Читатели приводят все — `getBudget` ищет строку по
 * `budgetOwner(agentKey)`, туда же смотрят `recordUsage`,
 * `getDailyUsage`, `checkBudget`, `budgetRemaining`. Значит запись по
 * производному ключу (`design:svg-fallback`) ложилась строкой, которую не
 * прочитает никто: лимит выставлен, в `GET /api/budget-settings` он виден, а
 * на расход не влияет — то есть ровно та тихая поломка потолка, ради которой
 * `budgetOwner` и заводили.
 *
 * Сейчас недостижимо: `badAgentKey` в miniapp-server.ts пропускает только
 * ключи из CHARACTERS, а в них двоеточия нет. Но охрана стоит у вызывающего, а
 * не у функции, и следующий вызывающий её не унаследует. В проде строк в
 * `budget_settings` ноль, так что осиротить нормализацией нечего.
 */
export function setBudget(
  agentKey: string,
  dailyInputTokens: number | null,
  updatedBy: string | null = null,
): void {
  if (!agentKey) throw new Error("setBudget: agentKey required");
  const owner = budgetOwner(agentKey);
  if (dailyInputTokens === null) {
    db.prepare(`DELETE FROM budget_settings WHERE agent_key = ?`).run(owner);
    return;
  }
  const n = Math.floor(dailyInputTokens);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error("setBudget: dailyInputTokens must be a positive integer");
  }
  db.prepare(
    `INSERT INTO budget_settings(agent_key, daily_input_tokens, updated_at, updated_by)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(agent_key) DO UPDATE SET
       daily_input_tokens = excluded.daily_input_tokens,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`,
  ).run(owner, n, Date.now(), updatedBy);
}

export interface BudgetSetting {
  agentKey: string;
  dailyInputTokens: number;
  updatedAt: number;
  updatedBy: string | null;
}

/** T-527: list all DB-stored budget overrides (Mini App Settings page). */
export function getAllBudgetSettings(): BudgetSetting[] {
  const rows = db
    .prepare(
      `SELECT agent_key AS agentKey,
              daily_input_tokens AS dailyInputTokens,
              updated_at AS updatedAt,
              updated_by AS updatedBy
       FROM budget_settings
       ORDER BY agent_key`,
    )
    .all() as BudgetSetting[];
  return rows;
}

/**
 * Сколько input-токенов агенту ещё можно потратить сегодня. Infinity — лимита
 * нет. Нужно там, где один вызов checkBudget покрывает не один запрос к
 * модели, а целый ход из многих (SDK-путь): проверка «на входе» такой ход не
 * ограничивает вообще, лимит срабатывает только на следующем триггере.
 */
export function budgetRemaining(agentKey: string | undefined | null): number {
  if (!agentKey) return Infinity;
  const owner = budgetOwner(agentKey);
  const budget = getBudget(owner);
  if (!Number.isFinite(budget)) return Infinity;
  return Math.max(0, budget - getDailyUsage(owner).input);
}

/**
 * Throws BudgetExceededError when today's input usage has already reached the
 * configured budget. No-op for falsy `agentKey` (callers without identity).
 *
 * Проверка «до», а расход становится известен «после»: лимит дневной и мягкий
 * по устройству — два хода, начатых одновременно, оба пройдут проверку и оба
 * потратят. Жёстким его сделала бы только резервация, а зарезервировать
 * нечего: цена хода известна лишь из ответа модели.
 */
export function checkBudget(agentKey: string | undefined | null): void {
  if (!agentKey) return;
  const owner = budgetOwner(agentKey);
  const budget = getBudget(owner);
  if (!Number.isFinite(budget)) return;
  const used = getDailyUsage(owner).input;
  if (used >= budget) {
    log.warn("[budget] agent exceeded daily token budget", {
      agentKey: owner,
      // Ключ вызова оставляем видимым: по нему понятно, что упёрлись именно на
      // вспомогательном вызове, а не в основном ходе.
      ...(owner === agentKey ? {} : { calledAs: agentKey }),
      used,
      budget,
    });
    throw new BudgetExceededError(owner, used, budget);
  }
}
