/**
 * C29: Skill-based fallback map for DELEGATE_TO_ROLE.
 *
 * When the primary target agent is unavailable (paused or silent), the
 * dispatcher walks ROLE_FALLBACKS[target] in order and picks the first
 * available agent. If none are available, the dispatch fails with
 * `no_available_agent`.
 */
import { agentStopReason } from "./permissions.ts";
import { getHealthSnapshot, type HealthSnapshot } from "./health.ts";

export const ROLE_FALLBACKS: Record<string, string[]> = {
  backend: ["tgdev", "aieng"],
  frontend: ["tgdev", "design"],
  tgdev: ["backend", "aieng"],
  aieng: ["backend", "tgdev"],
  design: ["frontend", "copy"],
  copy: ["smm", "design"],
  smm: ["copy", "pm"],
  qa: ["aieng", "backend"],
  pm: ["product", "orchestrator"],
  product: ["pm", "orchestrator"],
  perm: ["orchestrator"],
  orchestrator: [],
};

export interface AvailabilityDeps {
  /** Override health-snapshot lookup (tests). */
  getHealth?: (agentKey: string) => HealthSnapshot | undefined;
  /**
   * Override the «агент остановлен» lookup (tests). Раньше поле звалось
   * isPaused — и имя было точным описанием бага: спрашивали про одну колонку
   * из двух. (Без обратных кавычек намеренно: такого поля больше нет.)
   */
  isStopped?: (agentKey: string) => boolean;
}

/**
 * Аудит 2026-08-11: здесь жила приватная копия проверки паузы — SELECT paused
 * прямо из agent_states. Аудит 2026-08-09 свёл `paused` и `disabled` в один
 * предикат `agentStopReason` именно затем, чтобы «проверяем только первый
 * флаг» не повторилось; эту копию тогда не заметили.
 *
 * Цена расхождения: `setAgentStatus` намеренно не трогает `paused`, так что у
 * выключенного агента он почти всегда 0, а процесс бота продолжает поллиться
 * (disabled — флаг политики, не состояние процесса), поэтому health-снапшот у
 * него живой. Выключенный агент проходил как доступный, фолбэк не звался —
 * при том что фолбэк заведён ровно на «исполнитель недоступен». Дальше в чат
 * уходил анонс «🔀 X → Y», respondAs видел остановленную цель, возвращал null,
 * и задача закрывалась `failed / delegate returned empty reply`.
 */
function defaultIsStopped(agentKey: string): boolean {
  return agentStopReason(agentKey) !== null;
}

/**
 * Available = НЕ остановлен (paused или disabled) AND (no health info OR alive
 * OR <=2 consecutive failures).
 */
export function isAgentAvailable(
  agentKey: string,
  deps: AvailabilityDeps = {},
): boolean {
  const stopped = (deps.isStopped ?? defaultIsStopped)(agentKey);
  if (stopped) return false;
  const snap = (deps.getHealth ?? getHealthSnapshot)(agentKey);
  if (!snap) return true; // No health info → treat as available (monitor may not be running).
  if (snap.alive) return true;
  if (snap.consecutiveFailures > 2) return false;
  return true;
}

/**
 * Аудит 2026-08-21: почему `no_available_agent` недостаточно как текст.
 *
 * isAgentAvailable складывает две разные причины в один ответ `false`:
 * остановку по политике (paused/disabled — так решил владелец) и мёртвое
 * здоровье (бот не отвечает). Первое чинить нечего, второе чинить обязательно,
 * а на выходе у обеих был один текст — и самодиагностика заводила на паузу роли
 * две задачи на доску с просьбой починить сработавшую защиту.
 *
 * Различать по типу нельзя, различать может только производитель. Здесь и
 * различаем: `true` — ВСЕ кандидаты (цель и её фолбэки) остановлены политикой.
 * Смесь «одна на паузе, вторая мертва» даёт `false` намеренно: мёртвый бот есть,
 * значит есть что чинить, значит диагностика нужна.
 */
export function allCandidatesStopped(
  target: string,
  deps: AvailabilityDeps = {},
): boolean {
  const isStopped = deps.isStopped ?? defaultIsStopped;
  return [target, ...(ROLE_FALLBACKS[target] ?? [])].every((k) => isStopped(k));
}

/**
 * Pick first available agent: target itself, then ROLE_FALLBACKS[target].
 * Returns { role, reroutedFrom } where reroutedFrom is set only when a
 * fallback was used. Returns null when all candidates are unavailable.
 *
 * `avoid` — роли, которые вызывающий всё равно отвергнет: сам отправитель и
 * цепочка делегирования.
 *
 * Аудит 2026-08-20: функция возвращала ПЕРВОГО доступного кандидата, а два
 * правила, решающие, годится ли он, живут у вызывающего (action-dispatch.ts:
 * «cannot delegate to self» и проверки цепочки) и срабатывают ПОСЛЕ выбора.
 * Второго шанса не было — делегирование просто падало.
 *
 * Это не экзотика: каждый список фолбэков собран из естественной пары, поэтому
 * первый фолбэк — ровно та роль, которая чаще всего и есть отправитель.
 *   smm выполняет задачу → DELEGATE_TO_ROLE{role:"copy"}
 *   copy на паузе → ROLE_FALLBACKS.copy = ["smm","design"] → выбран smm
 *   вызывающий: role === ctx.agentKey → «cannot delegate to self»
 *   design был доступен всё это время и не был опробован
 * Так воспроизводится на десяти парах: backend↔tgdev, design↔frontend,
 * copy↔smm, pm↔product и далее. Модели при этом сообщают, что она пыталась
 * делегировать самой себе, чего она не делала.
 *
 * Столкнувшегося кандидата НЕ выбрасываем совсем: если чистых нет, возвращаем
 * его, чтобы вызывающий выдал свою прежнюю ошибку (self / delegation cycle) —
 * осмысленный отказ по правилам. Иначе штатный отказ выродился бы в безликий
 * `no_available_agent`, который никем не классифицируется и засоряет доску
 * тремя диагностическими задачами (см. diagnostic.ts).
 *
 * `avoid` фильтрует ТОЛЬКО фолбэки. Сама цель под фильтр не идёт: делегирование
 * тому, кто уже в цепочке, — это пинг-понг, и отказать на нём правильно, а не
 * объезжать его фолбэком.
 *
 * Аудит 2026-08-28: этот докблок лежал над `allCandidatesStopped` — то есть
 * над функцией, которая возвращает boolean и никого не выбирает. У самой
 * allCandidatesStopped докблок свой, прямо над ним, так что два описания
 * стояли подряд и читатель брал верхнее.
 */
export function pickAvailableAgent(
  target: string,
  deps: AvailabilityDeps = {},
  avoid: Iterable<string> = [],
): { role: string; reroutedFrom?: string } | null {
  if (isAgentAvailable(target, deps)) {
    return { role: target };
  }
  const skip = new Set(avoid);
  const fallbacks = ROLE_FALLBACKS[target] ?? [];
  /** Доступен, но вызывающий его отвергнет. Запасной ответ, не первый выбор. */
  let collided: string | undefined;
  for (const cand of fallbacks) {
    if (!isAgentAvailable(cand, deps)) continue;
    if (skip.has(cand)) {
      collided ??= cand;
      continue;
    }
    return { role: cand, reroutedFrom: target };
  }
  if (collided !== undefined) {
    return { role: collided, reroutedFrom: target };
  }
  return null;
}
