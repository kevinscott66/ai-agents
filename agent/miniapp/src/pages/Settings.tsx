import { useEffect, useState } from "react";
import { api, formatApiError } from "../lib/api";
import type { AgentInfo, AutonomyMode } from "../lib/types";
import { AUTONOMY_MODES } from "../lib/types";
import { haptic, toast } from "../lib/tg";
import { SkeletonList } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { ErrorBox } from "../components/ErrorBox";

interface Budget {
  agentKey: string;
  usedTokens: number;
  outputTokens: number;
  limit: number | null;
  resetAt: number;
}

/**
 * Аудит 2026-08-10: страница показывала выдуманное состояние и «сохраняла» его
 * в никуда.
 *
 * Список разрешённых чатов состоял из двух захардкоженных строк («Main Chat»
 * −1001234567890, «Dev Chat») — к реальному allowlist'у они отношения не имели.
 * Глобальный лимит и режим автономии тоже подставлялись константами
 * (100000 / "manual"), то есть админ видел не то, что настроено на сервере.
 * А «Сохранить» ничего не сохраняло: оно заводило задачу «Settings Update
 * Request» в том же выдуманном чате −1001234567890 с типом `settings_update`,
 * которого не читает ни один обработчик, — и при этом тост сообщал «запрос
 * создан для аппрува», хотя никакого аппрува не создавалось.
 *
 * Хуже всего, что бэкенд для двух из четырёх настроек существует и работает:
 * POST /api/budgets ставит лимит агенту, POST /api/autonomy без agent/chat_id
 * ставит глобальный режим. Страница настроек обходила рабочие ручки ради
 * задачи-пустышки.
 *
 * Теперь бюджеты и режим автономии читаются и пишутся настоящими ручками, а
 * то, для чего ручки нет (глобальный дневной потолок и allowlist чатов — и то
 * и другое живёт в env на сервере), больше не изображается редактируемым.
 */
interface SettingsData {
  budgets: Budget[];
  /** Свои строки budget_settings — ровно то, что правит и пишет эта форма. */
  overrides: Record<string, number | null>;
  defaultAutonomyMode: AutonomyMode;
}

/**
 * Свои лимиты ролей в том же виде, в каком их правит форма.
 *
 * Аудит 2026-08-20: форма заполнялась ИТОГОВЫМ лимитом из `GET /api/budgets`
 * (`getBudget()` — строка БД, потом `TOKEN_BUDGET_<AGENT>`, потом
 * `TOKEN_BUDGET_DEFAULT`), а писала только первую ступень. Лимит из окружения
 * выглядел как свой: стереть его и сохранить получалось, но после перечитки
 * число возвращалось — сервер снимал строку, которой не было. Правим ровно то,
 * что пишем: `GET /api/budget-settings`.
 */
export function overrideMap(
  rows: readonly { agentKey: string; dailyInputTokens: number }[],
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const r of rows) out[r.agentKey] = r.dailyInputTokens;
  return out;
}

/**
 * Что написать под полем, когда своего лимита нет: какой лимит тогда работает.
 *
 * `null` — своё значение стоит, объяснять нечего.
 */
export function effectiveHint(
  override: number | null,
  effective: number | null,
): string | null {
  if (override !== null) return null;
  if (effective === null) return "без лимита";
  return `общий лимит: ${effective.toLocaleString("ru-RU")}`;
}

/**
 * Как читать отказ `GET /api/budget-settings`.
 *
 * Аудит 2026-09-11: с аудита 2026-08-20 чтение закрыто админом
 * (lib/miniapp-server.ts), и для допущенного НЕ-админа 403 здесь — штатный
 * ответ «не твоё», а не сбой загрузки. Страница же гнала его в общий
 * `ErrorBox` с кнопкой «Повторить», которая не могла сработать никогда: под
 * оранжевой полосой «Просмотр настроек (только для админа)» у каждого
 * зрителя навсегда висела красная ошибка про то же самое.
 *
 * Отличаем «нельзя» от «не получилось»: первому объяснение уже стоит рядом,
 * второе — настоящий сбой, и о нём админу надо сказать. Общее у них одно:
 * свои лимиты НЕизвестны, поэтому подпись «общий лимит» под пустым полем в
 * обоих случаях — утверждение, выведенное из отсутствия данных
 * (аудит 2026-08-27), и её не показываем.
 *
 * Экспортируется ради теста: DOM-харнесса у Mini App нет.
 */
export function overridesFailure(
  e: { status?: number } | null,
  message: string,
): { known: boolean; err: string | null } {
  if (!e) return { known: true, err: null };
  if (e.status === 403) return { known: false, err: null };
  return { known: false, err: message };
}

/**
 * Что именно надо отправить на сервер: только изменившиеся лимиты.
 *
 * Экспортируется ради теста — DOM-харнесса у Mini App нет, а решение тут
 * чистое. Отправлять весь набор нельзя: POST /api/budgets на каждый ключ — это
 * запись в budget_settings с `updated_by`, и 12 записей на каждое нажатие
 * «Сохранить» затирали бы чужие правки своей же копией.
 */
export function budgetChanges(
  editing: Record<string, number | null>,
  current: Record<string, number | null>,
): { agentKey: string; dailyInputTokens: number | null }[] {
  const out: { agentKey: string; dailyInputTokens: number | null }[] = [];
  for (const [agentKey, value] of Object.entries(editing)) {
    const before = current[agentKey] ?? null;
    const after = value ?? null;
    if (before === after) continue;
    out.push({ agentKey, dailyInputTokens: after });
  }
  return out;
}

/**
 * Ключи с лимитом, который сервер отвергнет (положительное число или null).
 *
 * Ноль и минус — не «без лимита», а ошибка ввода: пустое поле уже значит «без
 * лимита». Ловим до отправки, иначе половина ключей запишется, а на нулевом
 * прилетит 400 — и форма останется в состоянии «сохранено наполовину».
 */
export function invalidBudgets(editing: Record<string, number | null>): string[] {
  return Object.entries(editing)
    .filter(([, v]) => v !== null && (!Number.isFinite(v) || (v as number) <= 0))
    .map(([k]) => k);
}

export default function Settings() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [readonly, setReadonly] = useState(false);
  const [saving, setSaving] = useState(false);
  /** Ошибка сохранения — отдельно от ошибки загрузки: набор на экране цел. */
  const [saveErr, setSaveErr] = useState<string | null>(null);

  // Local state for form editing
  const [editingBudgets, setEditingBudgets] = useState<Record<string, number | null>>({});
  /**
   * Аудит 2026-08-27: отказ `/api/budget-settings` подменялся пустым списком,
   * и форма показывала «нет своего лимита» для КАЖДОЙ роли — утверждение,
   * выведенное из отсутствия ответа. Сохранение при этом безопасно (пишется
   * дифф, а он пуст), но админ видит неправду и заводит лимит поверх
   * существующего.
   */
  const [overridesErr, setOverridesErr] = useState<string | null>(null);
  /** Пришли ли свои лимиты. `false` — и отказ, и «нельзя»: см. `overridesFailure`. */
  const [overridesKnown, setOverridesKnown] = useState(true);
  const [editingAutonomyMode, setEditingAutonomyMode] = useState<AutonomyMode>("manual");

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      let overridesOutcome = { known: true, err: null as string | null };
      const [agentsRes, budgetsRes, autonomyRes, overridesRes] = await Promise.all([
        api.agents(),
        // 403 здесь не приходит: гейт стоит на POST, а GET открыт всем
        // пущенным. Ветка оставлена на случай, если чтение когда-нибудь
        // закроют; реальный признак — поле `admin` в ответе (см. ниже).
        api.budgets().catch((e: any) => {
          if (e.status === 403) {
            setReadonly(true);
            return { budgets: [] as Budget[], admin: false };
          }
          throw e;
        }),
        // Без chat_id/agent — это и есть глобальный режим по умолчанию,
        // тот самый, который пишет POST /api/autonomy без scope.
        api.autonomy(),
        // Свои строки лимитов. Закрыты админом (аудит 2026-08-20), поэтому
        // 403 тут — штатный ответ зрителю, а не сбой; всё остальное — сбой.
        // Ни то ни другое не должно ронять страницу: форма тогда просто
        // пустая, а не заполненная чужим (общим) числом.
        api.budgetSettings().catch((e: any) => {
          overridesOutcome = overridesFailure(e, formatApiError(e));
          return { settings: [] };
        }),
      ]);

      setAgents(agentsRes.agents);
      setOverridesErr(overridesOutcome.err);
      setOverridesKnown(overridesOutcome.known);

      // Права сообщает сервер. До аудита 2026-08-12 не-админ получал
      // редактируемые поля и кнопку «Сохранить», которая падала 403 на каждом
      // ключе — уже после того, как он ввёл цифры.
      if (budgetsRes.admin !== undefined) setReadonly(!budgetsRes.admin);
      else if (autonomyRes.admin !== undefined) setReadonly(!autonomyRes.admin);

      const next: SettingsData = {
        budgets: budgetsRes.budgets,
        overrides: overrideMap(overridesRes.settings),
        defaultAutonomyMode: autonomyRes.mode,
      };
      setSettings(next);

      // Initialize editing state
      setEditingBudgets(next.overrides);
      setEditingAutonomyMode(next.defaultAutonomyMode);
    } catch (e: any) {
      setErr(formatApiError(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleSaveSettings() {
    if (readonly || !settings) {
      toast("Только для админа", "error");
      return;
    }

    const bad = invalidBudgets(editingBudgets);
    if (bad.length > 0) {
      toast(`Лимит должен быть больше нуля: ${bad.join(", ")}`, "error");
      return;
    }

    setSaving(true);
    setSaveErr(null);
    try {
      for (const change of budgetChanges(editingBudgets, settings.overrides)) {
        await api.updateBudget(change);
      }
      if (editingAutonomyMode !== settings.defaultAutonomyMode) {
        await api.setAutonomy({ mode: editingAutonomyMode });
      }

      haptic("success");
      toast("Настройки сохранены", "success");
      // Перечитываем: сервер округляет лимит и мог отвергнуть часть правок.
      await load();
    } catch (e: any) {
      // Часть ключей могла записаться до отказа — перечитываем, чтобы форма
      // показывала то, что на сервере, а не то, что не доехало.
      setSaveErr(formatApiError(e));
      toast("Ошибка сохранения", "error");
      await load();
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <SkeletonList rows={3} />;
  }

  if (err && !settings) {
    return (
      <ErrorBox
        message={err}
        hint="Не удалось загрузить настройки. Проверь интернет и попробуй ещё раз."
        onRetry={load}
      />
    );
  }

  if (!settings) {
    return <EmptyState icon="⚙️" title="Настройки недоступны" />;
  }

  const pendingBudgets = budgetChanges(editingBudgets, settings.overrides);
  const hasChanges =
    pendingBudgets.length > 0 || editingAutonomyMode !== settings.defaultAutonomyMode;

  return (
    <div style={{ padding: 16 }}>
      {readonly && (
        <div
          style={{
            background: "#f39c12",
            color: "#fff",
            padding: "8px 12px",
            borderRadius: 6,
            marginBottom: 16,
            fontSize: 14,
          }}
        >
          Просмотр настроек (только для админа)
        </div>
      )}

      <h1 style={{ margin: "0 0 24px", fontSize: 24 }}>Настройки</h1>

      {overridesErr && (
        <ErrorBox
          message={overridesErr}
          hint="Свои лимиты ролей не загрузились. Пустые поля ниже не значат, что переопределений нет."
          onRetry={load}
        />
      )}

      {/* Token Budgets Section */}
      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 18, marginBottom: 16, color: "#2c3e50" }}>
          Дневной лимит входных токенов
        </h2>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {agents.map((agent) => {
            const budget = settings.budgets.find(b => b.agentKey === agent.key);
            const currentLimit = editingBudgets[agent.key] ?? null;
            // Свои лимиты неизвестны — молчим: «общий лимит» под пустым
            // полем был бы утверждением из отсутствия ответа.
            const hint = overridesKnown
              ? effectiveHint(currentLimit, budget?.limit ?? null)
              : null;
            const usedPct = budget && budget.limit ? (budget.usedTokens / budget.limit) * 100 : 0;

            return (
              <div
                key={agent.key}
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  padding: 12,
                  background: "var(--bg)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <span style={{ fontWeight: 500, fontSize: 14 }}>{agent.title}</span>
                  {budget && (
                    <span style={{ fontSize: 12, color: "#7f8c8d" }}>
                      {budget.usedTokens.toLocaleString()} / {budget.limit?.toLocaleString() ?? '∞'} tokens
                    </span>
                  )}
                </div>

                {budget && budget.limit && (
                  <div style={{ marginBottom: 8 }}>
                    <div
                      // Полоска декоративная: то же число написано текстом
                      // выше («N / M tokens»). Пометка и корректна для
                      // скринридера, и говорит проверке контраста, что текста
                      // внутри нет.
                      aria-hidden="true"
                      style={{
                        width: "100%",
                        height: 6,
                        background: "#ecf0f1",
                        borderRadius: 3,
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          width: `${Math.min(usedPct, 100)}%`,
                          height: "100%",
                          background: usedPct >= 90 ? "#e74c3c" : usedPct >= 70 ? "#f39c12" : "#2ecc71",
                          transition: "width 0.3s ease",
                        }}
                      />
                    </div>
                  </div>
                )}

                <input
                  type="number"
                  min={1}
                  value={currentLimit ?? ""}
                  onChange={(e) => setEditingBudgets(prev => ({
                    ...prev,
                    [agent.key]: e.currentTarget.value ? parseInt(e.currentTarget.value) : null
                  }))}
                  placeholder="Общий лимит"
                  disabled={readonly}
                  aria-label={`Дневной лимит токенов: ${agent.title}`}
                  style={{
                    width: "100%",
                    padding: "6px 10px",
                    border: "1px solid #bdc3c7",
                    borderRadius: 4,
                    fontSize: 13,
                  }}
                />
                {/* Пустое поле значит «своего лимита нет» — а не «лимита нет
                    вовсе». Какой тогда работает, видно здесь. */}
                {hint && (
                  <div style={{ fontSize: 11, color: "#7f8c8d", marginTop: 4 }}>
                    {hint}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* Autonomy Mode Section */}
      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 18, marginBottom: 16, color: "#2c3e50" }}>
          Режим автономии по умолчанию
        </h2>
        <select
          value={editingAutonomyMode}
          onChange={(e) => setEditingAutonomyMode(e.currentTarget.value as AutonomyMode)}
          disabled={readonly}
          aria-label="Глобальный режим автономии"
          style={{
            width: "100%",
            padding: "8px 12px",
            border: "1px solid var(--border)",
            borderRadius: 6,
            fontSize: 14,
            background: "var(--bg)",
            color: "var(--text)",
          }}
        >
          {AUTONOMY_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {mode === "locked" && "Заблокированы"}
              {mode === "manual" && "Ручной режим"}
              {mode === "semi_auto" && "Полуавтоматический"}
              {mode === "auto" && "Автоматический"}
            </option>
          ))}
        </select>
        <div style={{ marginTop: 8, fontSize: 12, color: "#7f8c8d" }}>
          Глобальное правило. Режим отдельного чата или агента перекрывает его.
        </div>
      </section>

      {/* Server-side settings — read-only by design */}
      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 18, marginBottom: 16, color: "#2c3e50" }}>
          Настройки сервера
        </h2>
        <div
          style={{
            padding: 12,
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--bg)",
            fontSize: 13,
            color: "var(--hint)",
            lineHeight: 1.5,
          }}
        >
          Разрешённые чаты (<code>TELEGRAM_ALLOWED_GROUP_IDS</code>) и общий
          дневной потолок по умолчанию (<code>TOKEN_BUDGET_DEFAULT</code>)
          задаются в окружении на сервере и перечитываются при рестарте.
          Из Mini App они не меняются.
        </div>
      </section>

      {/* Save Button */}
      {!readonly && (
        <button
          onClick={handleSaveSettings}
          disabled={!hasChanges || saving}
          style={{
            width: "100%",
            padding: "12px",
            border: "none",
            borderRadius: 8,
            background: hasChanges ? "#3498db" : "#bdc3c7",
            color: "#fff",
            fontSize: 16,
            fontWeight: 500,
            cursor: hasChanges ? "pointer" : "not-allowed",
            opacity: saving ? 0.7 : 1,
          }}
        >
          {saving ? "Сохранение…" : hasChanges ? "Сохранить изменения" : "Нет изменений"}
        </button>
      )}

      {saveErr && (
        <div role="alert" style={{ marginTop: 12, fontSize: 13, color: "#e74c3c" }}>
          Не удалось сохранить: {saveErr}
        </div>
      )}
    </div>
  );
}
