/**
 * T-705b anti-loop guards for the inter-agent diagnostic-fix chain.
 *
 * The "fix chain" is a list of short labels accumulated each time a failed
 * action spawns a diag task / retry. It travels INSIDE the payload of the
 * action so it survives across action-dispatch -> diag task -> aieng retry.
 *
 * Default max depth: 3. Override via env INTER_AGENT_FIX_CHAIN_MAX_DEPTH.
 *
 * Lives in its own module (not self-diag.ts) to avoid a circular import with
 * action-dispatch.ts.
 */

import { db } from "./db.ts";
import { DIAG_ASSIGNEE } from "./tasks.ts";
import { log } from "./log.ts";
import { HOUR_MS } from "./time-constants.ts";

const DEFAULT_FIX_CHAIN_MAX_DEPTH = 3;

/**
 * Целое >= 1 из env, иначе дефолт — но НЕ молча.
 *
 * Молчаливый фолбэк здесь стоил бы дорого: оператор, написавший
 * `DIAG_TASK_MAX_PER_HOUR=ten`, получает работающую систему с другим лимитом и
 * ни одного признака, что его настройку не прочитали. Оба потолка — про то,
 * как часто команда сама себя чинит; ошибиться в них и не узнать нельзя.
 */
function positiveEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    log.warn(`[fix-chain] ${name}='${raw}' — не целое >= 1, беру ${fallback}`);
    return fallback;
  }
  return Math.floor(n);
}

/**
 * T-705 throttle: лимит авто-создания diagnostic-task по одному типу действия
 * в скользящем окне — защита от шторма fix-loop'ов (один и тот же action
 * фейлится десятки раз → десятки diag-задач). Default: 5 / час.
 * Override: env DIAG_TASK_MAX_PER_HOUR.
 */
export function diagTaskThrottleMax(): number {
  return positiveEnvInt("DIAG_TASK_MAX_PER_HOUR", 5);
}

/**
 * True, если за последний час уже создано >= лимита diag-задач с этим title
 * (title = `Tool error: <actionType>`). `now` инжектится в тестах.
 *
 * `assignedTo` — на кого смотреть. По умолчанию `DIAG_ASSIGNEE`: C15-петля адресует
 * ретраи только ему, и сужение до одного исполнителя тут исторически и есть
 * смысл счётчика. `null` означает «любой исполнитель» и нужен путям T-704,
 * где ответственная роль выбирается по категории ошибки (или задаётся моделью
 * в CREATE_DIAGNOSTIC_TASK): там фильтр по одному исполнителю обнулил бы счётчик, и
 * шторм считался бы нулевым.
 */
export function isDiagTaskThrottled(
  title: string,
  now: number = Date.now(),
  assignedTo: string | null = DIAG_ASSIGNEE,
): boolean {
  const windowStart = now - HOUR_MS;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM tasks
       WHERE (? IS NULL OR assigned_to = ?)
         AND title = ?
         AND created_at >= ?`,
    )
    .get(assignedTo, assignedTo, title, windowStart) as { n: number };
  return row.n >= diagTaskThrottleMax();
}

/**
 * Аудит 2026-08-20: здесь стояло `n < 0`, то есть НОЛЬ проходил как валидный
 * потолок. А проверка на месте вызова — `parentChain.length >= maxDepth` в
 * action-dispatch.ts (искать по `circuit_breaker`), и при maxDepth=0 она
 * истинна всегда, ещё до
 * первого звена цепочки. Последствия у одной опечатки в .env две, и обе тихие:
 *
 *  1. self-diag выключается целиком — ни одной diag-задачи ни по одному
 *     упавшему действию;
 *  2. настоящий текст ошибки подменяется на
 *     `circuit breaker tripped (fix_chain depth 0 >= 0): <ошибка>` — то есть
 *     в чат и в аудит уезжает диагноз «сработал анти-луп» там, где никакого
 *     цикла не было.
 *
 * Сюда же `"-0"` (Number("-0") === -0, и `-0 < 0` — ложь) и `"0.4"`
 * (Math.floor → 0). Соседний diagTaskThrottleMax() ноль отвергал с самого
 * начала — расхождение внутри одного модуля.
 *
 * Ноль как «выключить self-diag» не поддерживаем намеренно: у отключения уже
 * есть свой путь (shouldSkipSelfDiag / NO_SELF_DIAG_ACTIONS в diagnostic.ts),
 * и он не переписывает текст чужой ошибки.
 */
export function getFixChainMaxDepth(): number {
  return positiveEnvInt(
    "INTER_AGENT_FIX_CHAIN_MAX_DEPTH",
    DEFAULT_FIX_CHAIN_MAX_DEPTH,
  );
}

/** Read the `_fix_chain` from an arbitrary payload-like object. */
export function getFixChain(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const v = (input as { _fix_chain?: unknown })._fix_chain;
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

/** Pure helper: append a label to a chain, returning a new array. */
export function appendFixChain(chain: string[], label: string): string[] {
  return [...chain, label];
}
