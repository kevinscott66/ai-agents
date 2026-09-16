/**
 * Модель и глубина рассуждений для каждой роли команды.
 *
 * Раньше все 12 ролей ходили в одну модель: ANTHROPIC_LARGE_MODEL (API),
 * ANTHROPIC_LARGE_MODEL_SDK (подписка) или CODEX_MODEL. Лиду, который
 * раскладывает задачи и решает, кому их отдать, доставалось столько же ума,
 * сколько копирайтеру. Таблица ниже задаёт уровень под работу роли:
 *
 * - lead (orchestrator) — самая сильная модель и глубокие рассуждения;
 * - инженерные роли, QA и Permissions — сильная модель, глубокие рассуждения:
 *   ошибка там стоит кода, регрессии или лишнего разрешения;
 * - PM, Product, Design, Copy, SMM — та же модель, средние рассуждения:
 *   тексты и планы не выигрывают от долгого обдумывания, а ответ быстрее.
 *
 * Порядок выбора для роли из таблицы: переменная роли → таблица.
 * Общие ANTHROPIC_LARGE_MODEL / ANTHROPIC_LARGE_MODEL_SDK / CODEX_MODEL
 * действуют только на ключи вне таблицы (временные и служебные вызовы).
 *
 * Переменные роли (суффикс — ключ роли в верхнем регистре):
 *   ANTHROPIC_LARGE_MODEL_<ROLE>      — API-идентификатор, например claude-opus-5;
 *   ANTHROPIC_LARGE_MODEL_SDK_<ROLE>  — алиас CLI для подписки: opus, sonnet, haiku;
 *   CODEX_MODEL_<ROLE>                — slug из каталога Codex CLI;
 *   AGENT_EFFORT_<ROLE>               — low | medium | high | xhigh | max.
 */

export type ModelPath = "api" | "sdk" | "codex";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface RoleModel {
  model?: string;
  effort?: Effort;
}

interface Tier {
  api: string;
  sdk: string;
  codex: string;
  effort: Effort;
}

const LEAD: Tier = { api: "claude-opus-5", sdk: "opus", codex: "gpt-5.6-sol", effort: "high" };
const ENGINEERING: Tier = { api: "claude-sonnet-5", sdk: "sonnet", codex: "gpt-5.6-terra", effort: "high" };
const WRITING: Tier = { api: "claude-sonnet-5", sdk: "sonnet", codex: "gpt-5.6-terra", effort: "medium" };

export const ROLE_TIERS: Readonly<Record<string, Tier>> = {
  orchestrator: LEAD,
  backend: ENGINEERING,
  frontend: ENGINEERING,
  tgdev: ENGINEERING,
  aieng: ENGINEERING,
  qa: ENGINEERING,
  perm: ENGINEERING,
  pm: WRITING,
  product: WRITING,
  design: WRITING,
  copy: WRITING,
  smm: WRITING,
};

const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

function envSuffix(agentKey: string): string {
  return agentKey.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

const ROLE_MODEL_ENV: Record<ModelPath, string> = {
  api: "ANTHROPIC_LARGE_MODEL_",
  sdk: "ANTHROPIC_LARGE_MODEL_SDK_",
  codex: "CODEX_MODEL_",
};

/**
 * Модель и effort роли для указанного пути. Для ключа вне таблицы без
 * переменных роли возвращает пустой объект — вызывающий оставляет прежний выбор.
 */
export function roleModel(
  agentKey: string | undefined,
  path: ModelPath,
  env: Record<string, string | undefined> = process.env,
): RoleModel {
  if (!agentKey) return {};
  const suffix = envSuffix(agentKey);
  const tier = Object.hasOwn(ROLE_TIERS, agentKey) ? ROLE_TIERS[agentKey] : undefined;
  const model = envValue(env, ROLE_MODEL_ENV[path] + suffix) ?? tier?.[path];
  const rawEffort = envValue(env, "AGENT_EFFORT_" + suffix);
  if (rawEffort !== undefined && !EFFORTS.includes(rawEffort as Effort)) {
    throw new Error(`AGENT_EFFORT_${suffix} must be one of ${EFFORTS.join(", ")}`);
  }
  const effort = (rawEffort as Effort | undefined) ?? tier?.effort;
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}
