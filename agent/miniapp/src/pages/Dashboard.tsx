import { useEffect, useState } from "react";
import { api, formatApiError } from "../lib/api";
import { telegramLaunchState } from "../lib/tg";
import type { AgentAction, AgentInfo, AutonomyMode } from "../lib/types";
import { subscribe as sseSubscribe } from "../lib/sse";
import { useCoalescer } from "../lib/coalesce";
import { useLatestRun } from "../lib/stale";
import { SkeletonList } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { ErrorBox } from "../components/ErrorBox";
import { ACTION_STATUS_LABELS, label } from "../lib/labels";
import { AUTONOMY_MODES } from "../lib/types";
import type { TabKey } from "../lib/tabnav";

interface Props {
  /**
   * Переключить вкладку. Было `(tab: any)`, и App подставлял сюда
   * `setTab as any` — опечатка в ключе карточки уводила приложение на пустой
   * экран, а типы молчали.
   */
  onNav: (tab: TabKey) => void;
}

interface Budget {
  agentKey: string;
  usedTokens: number;
  outputTokens: number;
  limit: number | null;
  resetAt: number;
}

/** Pick green/yellow/red severity class given percentage [0..100]. */
export function budgetSeverity(pct: number): "ok" | "warn" | "crit" {
  if (pct >= 90) return "crit";
  if (pct >= 70) return "warn";
  return "ok";
}

/**
 * Get agent status indicator (lamp) based on agent info.
 *
 * Экспортируется с аудита 2026-08-20: это единственное определение того, что
 * значит «агент онлайн», и считать по нему должна не только лампа (см.
 * countOnline ниже). DOM-харнесса у Mini App нет, решение тут чистое.
 */
export function getAgentStatusIndicator(agent: AgentInfo): {
  status: "online" | "idle" | "blocked" | "error";
  color: string;
  tooltip: string;
} {
  if (agent.paused) {
    return { status: "idle", color: "#888", tooltip: "Агент приостановлен" };
  }
  
  if (agent.status === "running") {
    const health = agent.health;
    if (!health || !health.alive) {
      return { status: "error", color: "#e74c3c", tooltip: "Агент не отвечает" };
    }
    if (health.consecutiveFailures > 3) {
      return { status: "blocked", color: "#f39c12", tooltip: `${health.consecutiveFailures} ошибок подряд` };
    }
    return { status: "online", color: "#2ecc71", tooltip: "Агент работает нормально" };
  }
  
  return { status: "error", color: "#e74c3c", tooltip: `Статус: ${agent.status}` };
}

/**
 * Сколько ролей действительно на связи.
 *
 * Аудит 2026-08-20: считалось `agents.filter(a => a.status === "running")`, но
 * сервер выставляет это поле как `paused ? "paused" : "running"`
 * (lib/miniapp-server.ts:210) — то есть счётчик мерил «не на паузе», а не
 * живость. Живость лежит в `health`, и её читает лампа. Карточка показывала
 * «12/12» над двенадцатью красными лампами.
 *
 * Источник теперь один — тот же предикат, что красит лампу.
 */
export function countOnline(agents: AgentInfo[]): number {
  return agents.filter((a) => getAgentStatusIndicator(a).status === "online")
    .length;
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

export default function Dashboard({ onNav }: Props) {
  const [tasksPending, setTasksPending] = useState<number | null>(null);
  const [approvalsPending, setApprovalsPending] = useState<number | null>(null);
  const [actionsToday, setActionsToday] = useState<number | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [recent, setRecent] = useState<AgentAction[]>([]);
  const [budgets, setBudgets] = useState<Budget[] | null>(null);
  /**
   * Аудит 2026-08-27: отказ `/api/budgets` подменялся пустым списком, и блок
   * рисовал EmptyState «Токены пока не тратились» — утверждение о факте,
   * выведенное из отсутствия ответа. Не знаем ≠ ноль.
   */
  const [budgetsErr, setBudgetsErr] = useState<string | null>(null);
  const [macOnline, setMacOnline] = useState<boolean | null>(null);
  const [autonomyMode, setAutonomyMode] = useState<AutonomyMode | null>(null);
  const [canChangeAutonomy, setCanChangeAutonomy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const coalescer = useCoalescer();
  // Аудит 2026-08-21: «Сводка» — единственная из перезагружаемых по SSE
  // страниц, писавшая в состояние без проверки, чей это ответ. Загрузка тут
  // самая долгая во всём Mini App (/api/dashboard — ~45 синхронных запросов к
  // SQLite в общем однопоточном сервере), а стартует она и на монтировании, и
  // на каждом схлопнутом пакете событий. Пересечение двух забегов — обычное
  // дело, и побеждал тот, кто вернулся последним, а не тот, кто ушёл позже:
  // цифры на карточках откатывались к состоянию до события, которое эту
  // перезагрузку и вызвало. Приём общий для страниц — `lib/stale.ts`.
  const beginLoad = useLatestRun();

  async function loadAggregated(isCurrent: () => boolean): Promise<boolean> {
    try {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const cutoff = startOfDay.getTime();
      // «Сегодня» — по часам того, кто смотрит, а не по UTC сервера.
      const d = await api.dashboard(cutoff);
      // Пока ждали, мог стартовать более свежий забег. Возвращаем true —
      // маршрут на сервере есть, fallback ниже не нужен, — но ничего не пишем.
      if (!isCurrent()) return true;
      // Цифры на карточках берём с сервера (COUNT по таблице). Списки ниже —
      // превью на 10/10/20 элементов, и считать по ним нельзя: до аудита
      // 2026-08-12 карточка показывала 1 при 200 pending-задачах.
      // Ветка по спискам оставлена как fallback для старого бэкенда.
      setTasksPending(
        d.counts
          ? d.counts.tasksPending
          : d.recentTasks.filter((t) => t.status === "pending").length,
      );
      setApprovalsPending(
        d.counts ? d.counts.approvalsPending : d.pendingApprovals.length,
      );
      setActionsToday(
        d.counts
          ? d.counts.actionsSince
          : d.recentActions.filter((a) => a.created_at >= cutoff).length,
      );
      setAgents(d.agents);
      setRecent(d.recentActions.slice(0, 10));
      setBudgets(d.budgets as Budget[]);
      setBudgetsErr(null);
      return true;
    } catch (e: any) {
      // Аудит 2026-08-13: `catch { return false }` ловил ВСЁ, а fallback ниже
      // шлёт ещё пять запросов, два из них — самые дорогие GET на сервере
      // (tasks limit=200 и actions limit=200, оба однопоточные по SQLite).
      // То есть на 401 (Mini App открыли вне Telegram — initData пустой) и на
      // 429 один рендер вместо одного запроса делал шесть, причём на 429
      // ответом на исчерпанное ведро было потратить из него ещё пять токенов.
      // И так на каждую SSE-перезагрузку.
      //
      // Fallback задуман ровно для одного случая — «на старом бэкенде
      // маршрута нет», а это 404. Остальное отдаём наверх, там `load()` уже
      // умеет показать ошибку.
      if (e?.status === 404) return false;
      throw e;
    }
  }

  async function loadMacHealth(isCurrent: () => boolean) {
    try {
      const health = await api.health();
      if (!isCurrent()) return;
      // Поле приходит только аутентифицированному вызывающему (см.
      // /api/health в lib/miniapp-server.ts). Мы всегда шлём initData, но
      // отсутствие поля — «неизвестно», а не «офлайн».
      setMacOnline(health.mac_online ?? null);
    } catch {
      if (!isCurrent()) return;
      setMacOnline(null);
    }
  }

  async function loadAutonomyMode(isCurrent: () => boolean) {
    try {
      const autonomy = await api.autonomy();
      if (!isCurrent()) return;
      setAutonomyMode(autonomy.mode);
      // Признак приходит с сервера — тот же гейт, что у POST /api/autonomy.
      // Раньше здесь стояло «assume yes», и переключатель показывали всем.
      // undefined — старый бэкенд: ведём себя как раньше.
      setCanChangeAutonomy(autonomy.admin ?? true);
    } catch {
      if (!isCurrent()) return;
      setAutonomyMode(null);
      setCanChangeAutonomy(false);
    }
  }

  async function load() {
    const isCurrent = beginLoad();
    setErr(null);
    const launch = telegramLaunchState();
    if (!launch.inTelegram || !launch.hasInitData) {
      setErr("Telegram-сессия не найдена. Откройте панель кнопкой Mini App в Telegram.");
      setInitialLoading(false);
      return;
    }
    // C27: try the aggregated /api/dashboard endpoint first — one round-trip
    // instead of 4–5 parallel ones. Fall back to the legacy per-resource
    // fetches if the aggregated endpoint isn't available (older backend).
    //
    // Вызов агрегата стоял ВНЕ try, и это было безопасно ровно пока он глотал
    // любую ошибку. Раз он теперь пробрасывает всё, кроме 404, — заводим его
    // внутрь, иначе отказ уходил бы неперехваченным реджектом: ни setErr, ни
    // setInitialLoading(false), то есть вечный спиннер вместо сообщения.
    // `finally` заодно снимает дублирование setInitialLoading по двум веткам.
    try {
      if (await loadAggregated(isCurrent)) {
        if (!isCurrent()) return;
        // Load Mac health separately since it's not in dashboard endpoint
        loadMacHealth(isCurrent);
        // Load autonomy mode
        loadAutonomyMode(isCurrent);
        return;
      }
      const budgetsFailed: { err: string | null } = { err: null };
      const [tasks, appr, acts, ag, bud] = await Promise.all([
        api.tasks({ status: "pending", limit: 200 }),
        api.approvals({ status: "pending", limit: 200 }),
        api.actions({ limit: 200 }),
        api.agents(),
        api.budgets().catch((e: any) => {
          // Бюджеты — не то, ради чего открывают дашборд: их отказ не должен
          // ронять страницу. Но и «ноль трат» из него выводить нельзя.
          budgetsFailed.err = formatApiError(e);
          return { budgets: [] as Budget[] };
        }),
      ]);
      if (!isCurrent()) return;
      setTasksPending(tasks.tasks.length);
      setApprovalsPending(appr.approvals.length);
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const cutoff = startOfDay.getTime();
      setActionsToday(
        acts.actions.filter((a) => a.created_at >= cutoff).length,
      );
      setAgents(ag.agents);
      setRecent(acts.actions.slice(0, 10));
      setBudgets(bud.budgets as Budget[]);
      setBudgetsErr(budgetsFailed.err);
      loadMacHealth(isCurrent);
      loadAutonomyMode(isCurrent);
    } catch (e: any) {
      // Сторож гонки — от main: поздний ответ отменённого запроса не должен
      // перетирать экран. Текст — из ветки: `formatApiError` разбирает и те
      // отказы, у которых `message` пустой.
      if (!isCurrent()) return;
      setErr(formatApiError(e));
    } finally {
      // Устаревший забег не гасит скелетон: актуальный ещё в пути.
      if (isCurrent()) setInitialLoading(false);
    }
  }

  async function handleAutonomyChange(newMode: AutonomyMode) {
    try {
      await api.setAutonomy({ mode: newMode });
      setAutonomyMode(newMode);
    } catch (e: any) {
      setErr(`Не удалось изменить режим автономности: ${formatApiError(e)}`);
    }
  }

  // Семь имён событий на одну тяжёлую перезагрузку: /api/dashboard — это ~45
  // синхронных запросов к SQLite, а один ход команды даёт десятки
  // action.executed подряд. Без схлопывания открытая сводка тормозит ту самую
  // команду, которую показывает (Bun.serve однопоточный, поток общий с SQLite и
  // 12 ботами), и выбивает себе 429 в общем ведре рейт-лимита.
  useEffect(() => {
    load();
    const reload = () => coalescer.schedule(() => load());
    const unsubs = [
      sseSubscribe("task.created", reload),
      sseSubscribe("task.updated", reload),
      sseSubscribe("approval.created", reload),
      sseSubscribe("approval.decided", reload),
      sseSubscribe("agent.health", reload),
      sseSubscribe("agent.paused", reload),
      sseSubscribe("action.executed", reload),
    ];
    return () => unsubs.forEach((u) => u());
  }, []);

  const online = countOnline(agents);

  // Only show agents with a defined limit OR any usage > 0, sorted by pct desc.
  const visibleBudgets = (budgets ?? [])
    .map((b) => {
      const pct =
        b.limit && b.limit > 0
          ? Math.min(100, (b.usedTokens / b.limit) * 100)
          : null;
      return { ...b, pct };
    })
    .filter((b) => b.pct !== null || b.usedTokens > 0)
    .sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));

  return (
    <div>
      <ErrorBox message={err} onRetry={() => load()} />
      <div className="stat-grid">
        <div 
          className="stat-card" 
          onClick={() => onNav("tasks")}
          role="button"
          aria-label={`Задачи в очереди: ${tasksPending ?? "неизвестно"}, перейти к списку задач`}
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && onNav("tasks")}
        >
          {/* Аудит 2026-08-13: подпись была «Задачи в работе», а сервер
              считает `WHERE status = 'pending'` — то есть именно очередь, с
              явным исключением running. При пяти выполняющихся задачах и
              пустой очереди карточка читалась как «Задачи в работе: 0». */}
          <div className="label">Задачи в очереди</div>
          <div className="value">{tasksPending ?? "—"}</div>
        </div>
        <div 
          className="stat-card" 
          onClick={() => onNav("approvals")}
          role="button"
          aria-label={`Ждут аппрува: ${approvalsPending ?? "неизвестно"}, перейти к списку аппрувов`}
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && onNav("approvals")}
        >
          <div className="label">Ждут аппрува</div>
          <div className="value">{approvalsPending ?? "—"}</div>
        </div>
        <div 
          className="stat-card" 
          onClick={() => onNav("logs")}
          role="button"
          aria-label={`Действий за сегодня: ${actionsToday ?? "неизвестно"}, перейти к логам`}
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && onNav("logs")}
        >
          <div className="label">Действий за сегодня</div>
          <div className="value">{actionsToday ?? "—"}</div>
        </div>
        <div 
          className="stat-card" 
          onClick={() => onNav("agents")}
          role="button"
          aria-label={`Агенты онлайн: ${online} из ${agents.length}, перейти к списку агентов`}
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && onNav("agents")}
        >
          <div className="label">Агенты онлайн</div>
          <div className="value">
            {online}/{agents.length}
          </div>
        </div>
        <div className="stat-card">
          <div className="label">Mac Control</div>
          <div className="value">
            {macOnline === null ? "—" : macOnline ? "Онлайн" : "Офлайн"}
          </div>
        </div>
      </div>

      <div className="section-title">Статус агентов</div>
      {initialLoading && agents.length === 0 ? (
        <SkeletonList rows={12} />
      ) : agents.length === 0 ? (
        <EmptyState
          icon="🤖"
          title="Агенты не найдены"
          hint="Агенты будут отображаться здесь когда система запустится."
        />
      ) : (
        <div className="agents-grid">
          {agents.map((agent) => {
            const indicator = getAgentStatusIndicator(agent);
            return (
              <div 
                key={agent.key} 
                className="agent-status-card"
                title={indicator.tooltip}
              >
                <div className="agent-indicator">
                  <div 
                    className="status-lamp"
                    style={{ backgroundColor: indicator.color }}
                    aria-label={indicator.tooltip}
                  />
                  <span className="agent-name">{agent.title}</span>
                </div>
                <span className="agent-provider">
                  {agent.provider ?? "internal"} · {agent.execution_state ?? indicator.status}
                </span>
                <span className={`agent-status ${indicator.status}`}>
                  {indicator.status}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <div className="section-title">
        Режим автономности
        {canChangeAutonomy && (
          <select 
            value={autonomyMode || 'locked'} 
            onChange={(e) => handleAutonomyChange(e.currentTarget.value as AutonomyMode)}
            className="autonomy-selector"
            aria-label="Изменить режим автономности"
          >
            {AUTONOMY_MODES.map(mode => (
              <option key={mode} value={mode}>
                {mode === 'locked' ? 'Заблокирован' : 
                 mode === 'manual' ? 'Ручной' :
                 mode === 'semi_auto' ? 'Полуавтомат' : 
                 mode === 'auto' ? 'Автомат' : mode}
              </option>
            ))}
          </select>
        )}
      </div>
      {!canChangeAutonomy && (
        <div className="autonomy-display">
          Текущий режим: <strong>
            {autonomyMode === 'locked' ? 'Заблокирован' : 
             autonomyMode === 'manual' ? 'Ручной' :
             autonomyMode === 'semi_auto' ? 'Полуавтомат' : 
             autonomyMode === 'auto' ? 'Автомат' : autonomyMode || 'Неизвестно'}
          </strong>
        </div>
      )}

      <div className="section-title">Бюджеты токенов (сегодня)</div>
      {initialLoading && !budgets ? (
        <SkeletonList rows={3} />
      ) : budgetsErr ? (
        <ErrorBox
          message={budgetsErr}
          hint="Бюджеты не загрузились. Пустой блок ниже не значит, что трат не было."
          onRetry={() => load()}
        />
      ) : visibleBudgets.length === 0 ? (
        <EmptyState
          icon="∑"
          title="Токены пока не тратились"
          hint="Когда агенты начнут обращаться к LLM, здесь появятся дневные бюджеты."
        />
      ) : (
        visibleBudgets.map((b) => {
          const hasLimit = b.pct !== null;
          const sev = hasLimit ? budgetSeverity(b.pct as number) : "unlimited";
          const widthPct = hasLimit ? (b.pct as number) : 8;
          return (
            <div className="budget-row" key={b.agentKey}>
              <div className="budget-head">
                <span className="agent">{b.agentKey}</span>
                <span className="nums">
                  {fmtNum(b.usedTokens)}
                  {hasLimit ? ` / ${fmtNum(b.limit as number)}` : " / ∞"}
                  {hasLimit ? `  (${(b.pct as number).toFixed(0)}%)` : ""}
                </span>
              </div>
              <div 
                className="budget-bar"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={hasLimit ? (b.limit as number) : undefined}
                aria-valuenow={b.usedTokens}
                aria-label={`Использование токенов для агента ${b.agentKey}: ${b.usedTokens} из ${hasLimit ? b.limit : 'неограниченно'}`}
              >
                <div
                  className={`budget-fill ${sev}`}
                  style={{ width: `${widthPct}%` }}
                />
              </div>
            </div>
          );
        })
      )}

      <div className="section-title">Последние события</div>
      {initialLoading ? (
        <SkeletonList rows={5} />
      ) : recent.length === 0 ? (
        <EmptyState
          icon="·"
          title="Активности пока нет"
          hint="Действия агентов будут появляться здесь в реальном времени."
        />
      ) : (
        recent.map((a) => (
          <div className="list-item" key={a.id}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="title">
                {a.agent_key} · {a.action_type}
              </div>
              <div className="meta">
                {new Date(a.created_at).toLocaleString()}
              </div>
            </div>
            <span className={`badge ${a.status}`}>{label(ACTION_STATUS_LABELS, a.status)}</span>
          </div>
        ))
      )}
    </div>
  );
}
