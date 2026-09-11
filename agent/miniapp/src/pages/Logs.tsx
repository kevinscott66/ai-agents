import { useEffect, useMemo, useRef, useState } from "react";
import { api, formatApiError } from "../lib/api";
import type { AgentAction } from "../lib/types";
import { AGENTS_EMPTY, agentsHint, loadAgents } from "../lib/agents-load";
import { SkeletonList } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { ErrorBox } from "../components/ErrorBox";
import { ACTION_STATUS_LABELS, label } from "../lib/labels";
import { INTER_AGENT_ACTION_TYPES, isInterAgentAction } from "../components/InterAgentCard";
import { subscribe as sseSubscribe } from "../lib/sse";
import { ellipsize } from "../lib/text";
import { useDebouncedValue } from "../lib/debounce";
import { useCoalescer } from "../lib/coalesce";

// attempted / pending_approval переехали в общую карту (аудит 2026-08-13) —
// там они нужны и сводке, и карточке агента, а не одной этой странице.
const STATUS_LABELS_LOCAL: Record<string, string> = { ...ACTION_STATUS_LABELS };

const STATUSES = [
  "",
  "attempted",
  "ok",
  "error",
  "forbidden",
  "pending_approval",
  "rate_limited",
];

// Heuristic mapping: log "level" is a synthetic dimension over status.
const LEVEL_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "все уровни" },
  { value: "info", label: "инфо" },
  { value: "warn", label: "предупреждения" },
  { value: "error", label: "ошибки" },
];

function levelOfStatus(s: string): "info" | "warn" | "error" {
  if (s === "error" || s === "forbidden") return "error";
  if (s === "pending_approval" || s === "rate_limited") return "warn";
  return "info";
}

const PAGE = 50;

/** Exported for tests: parse `#agent=foo&q=bar&level=warn&status=ok&type=…`. */
export function parseLogsHash(hash: string): {
  agent: string;
  q: string;
  level: string;
  status: string;
  type: string;
} {
  const out = { agent: "", q: "", level: "", status: "", type: "" };
  const raw = (hash || "").replace(/^#/, "");
  if (!raw) return out;
  const sp = new URLSearchParams(raw);
  for (const k of Object.keys(out) as (keyof typeof out)[]) {
    const v = sp.get(k);
    if (v != null) out[k] = v;
  }
  return out;
}

/** Exported for tests: serialise filters into URL hash (omit empty). */
export function serializeLogsHash(f: {
  agent: string;
  q: string;
  level: string;
  status: string;
  type: string;
}): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) {
    if (v) sp.set(k, v);
  }
  const s = sp.toString();
  return s ? `#${s}` : "";
}

/**
 * Как реагировать на живое событие `action.executed`.
 *
 * Аудит 2026-08-10: подписка звала `load(true)`, то есть полный сброс набора к
 * первой странице. Пока страница одна, это и есть желаемое поведение. Но стоит
 * нажать «Показать ещё» — и любое действие любого из 12 агентов в любом чате
 * отматывает чтение обратно наверх, теряя все догруженные страницы. Агенты
 * работают постоянно, так что чем дальше пользователь ушёл в историю, тем
 * вероятнее, что он до неё не дочитает.
 *
 * Экспортируется ради теста: DOM-харнесса у Mini App нет, а решение тут
 * чистое.
 */
export function liveActionMode(paged: boolean): "reload" | "notify" {
  return paged ? "notify" : "reload";
}

/**
 * Кто из параллельных запросов имеет право писать в состояние.
 *
 * Аудит 2026-08-14: `load()` писала результат в состояние безусловно, а звали
 * её из четырёх мест сразу — смена фильтра, живое событие `action.executed`,
 * кнопка «Обновить» и повтор после ошибки. Ни одно из них не ждало предыдущего.
 * Сеть порядок ответов не гарантирует, поэтому:
 *
 *   1. Пользователь переключает агента. Эффект чистит список и шлёт запрос.
 *      Старый, ещё не вернувшийся запрос приходит вторым — и заполняет список
 *      действиями ПРЕЖНЕГО агента. В фильтре стоит один, на экране другой.
 *   2. Агенты работают постоянно, `action.executed` прилетает пачками. Каждое
 *      событие на первой странице — свой `load(true)`; выигрывает тот, кто
 *      вернулся последним, а это не обязательно самый свежий.
 *   3. Проигравший забег дёргает и `setLoading(false)` в `finally` — спиннер
 *      актуального запроса гаснет раньше времени, кнопка «Показать ещё»
 *      разблокируется посреди загрузки.
 *
 * Лечится не отменой запроса (ответ всё равно может успеть), а правом записи:
 * номер забега берётся до `await`, и после `await` состояние трогает только
 * тот, после кого никто не стартовал. Экспортируется ради теста — DOM-харнесса
 * у Mini App нет, но само решение чистое.
 */
export function createRunGate() {
  let latest = 0;
  return {
    /** Начать забег и получить его номер. Вызывать ДО первого `await`. */
    start(): number {
      latest += 1;
      return latest;
    },
    /** Забег всё ещё последний — значит его результат актуален. */
    isCurrent(run: number): boolean {
      return run === latest;
    },
  };
}

export default function Logs() {
  const initial = parseLogsHash(
    typeof window !== "undefined" ? window.location.hash : "",
  );
  const [items, setItems] = useState<AgentAction[]>([]);
  const [agent, setAgent] = useState(initial.agent);
  const [status, setStatus] = useState(initial.status);
  const [type, setType] = useState(initial.type);
  // Поле свободного ввода: в перезагрузку идёт значение после паузы в
  // наборе, иначе каждая буква — свой запрос и своя пересборка подписки.
  const typeQuery = useDebouncedValue(type);
  const [q, setQ] = useState(initial.q);
  const [level, setLevel] = useState(initial.level);
  const [interAgentOnly, setInterAgentOnly] = useState(false);
  const [agentsState, setAgentsState] = useState(AGENTS_EMPTY);
  const agents = agentsState.agents;
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const firstLoad = useRef(true);
  /** Пользователь догрузил хотя бы одну страницу — сбрасывать набор нельзя. */
  const paged = useRef(false);
  const [liveWaiting, setLiveWaiting] = useState(false);
  /** Право записи в состояние: см. `createRunGate`. Создаём один раз. */
  const gateRef = useRef<ReturnType<typeof createRunGate> | null>(null);
  if (gateRef.current === null) gateRef.current = createRunGate();
  const gate = gateRef.current;
  /** Схлопывание всплеска `action.executed`: см. эффект подписки ниже. */
  const coalescer = useCoalescer();

  useEffect(() => {
    void loadAgents(() => api.agents()).then(setAgentsState);
  }, []);

  async function load(reset = false) {
    if (reset) {
      paged.current = false;
      setLiveWaiting(false);
    } else {
      paged.current = true;
    }
    const run = gate.start();
    setLoading(true);
    setErr(null);
    try {
      const before =
        !reset && items.length > 0 ? items[items.length - 1].id : undefined;
      const r = await api.actions({
        agent: agent || undefined,
        status: status || undefined,
        type: typeQuery || undefined,
        before_id: before,
        limit: PAGE,
      });
      // Пока ждали, стартовал забег посвежее — его набор и должен остаться.
      if (!gate.isCurrent(run)) return;
      setHasMore(r.actions.length === PAGE);
      setItems((prev) => (reset ? r.actions : [...prev, ...r.actions]));
    } catch (e: any) {
      // Ошибка отменённого фильтра — не ошибка текущего экрана.
      if (!gate.isCurrent(run)) return;
      setErr(formatApiError(e));
    } finally {
      // Спиннер гасит только актуальный забег: иначе кнопка «Показать ещё»
      // разблокируется, пока настоящий запрос ещё в пути.
      if (gate.isCurrent(run)) {
        setLoading(false);
        if (firstLoad.current) {
          firstLoad.current = false;
          setInitialLoading(false);
        }
      }
    }
  }

  // Reload server-side filtered set when server-affecting filters change.
  // P1 (2026-06-09): + live-подписка — новые действия агентов появляются в
  // логах сразу (объективная видимость прогресса, без ручного обновления).
  useEffect(() => {
    setItems([]);
    setHasMore(true);
    load(true);
    // Аудит 2026-08-28: перезагрузка звалась напрямую, по одному GET на
    // событие. `liveActionMode` прикрывает только догруженный набор
    // (`paged.current === true`, режим `notify`); в состоянии по умолчанию —
    // первая страница — режим `reload`, а `action.executed` шина шлёт на
    // каждую записанную строку действия любой из 12 ролей (lib/audit.ts:190).
    // Ход команды на ~15 действий = ~15 GET за пару секунд из общего ведра
    // (capacity 120, refill 4/сек — `GET_LIMIT` в lib/miniapp-server.ts), и
    // вкладка, ради
    // которой всё и открыто, выбивала себе 429. Тот же коалесер, что на
    // Dashboard, Tasks и Agents (аудит 2026-08-11): ведущий запрос уходит
    // сразу, дальше не чаще одного за окно, хвост всплеска не теряется.
    const unsub = sseSubscribe("action.executed", () => {
      if (liveActionMode(paged.current) === "notify") setLiveWaiting(true);
      else coalescer.schedule(() => load(true));
    });
    // Отложенный запуск снимаем вместе с подпиской: иначе он держит замыкание
    // на load() со СТАРЫМ фильтром и переписывает свежий набор — ровно то, что
    // разбирал аудит 2026-08-13 на Tasks.
    return () => {
      unsub();
      coalescer.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent, status, typeQuery]);

  // Persist all filters (incl. client-only q/level) in URL hash.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const next = serializeLogsHash({ agent, q, level, status, type });
    if (window.location.hash !== next) {
      try {
        history.replaceState(null, "", window.location.pathname + window.location.search + next);
      } catch {}
    }
  }, [agent, q, level, status, type]);

  // Client-side filtering: text + level.
  const visible = useMemo(() => {
    const qn = q.trim().toLowerCase();
    return items.filter((a) => {
      if (level && levelOfStatus(a.status) !== level) return false;
      if (interAgentOnly && !isInterAgentAction(a.action_type)) return false;
      if (!qn) return true;
      const hay = [
        a.agent_key,
        a.action_type,
        a.status,
        a.error ?? "",
        a.id,
        new Date(a.created_at).toLocaleString(),
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(qn);
    });
  }, [items, q, level, interAgentOnly]);

  return (
    <div>
      <ErrorBox message={err} onRetry={() => load(true)} />
      {liveWaiting && (
        // Догруженные страницы не выбрасываем молча: обновление — по клику.
        <div className="btn-row" style={{ justifyContent: "center" }}>
          <button className="btn secondary" onClick={() => load(true)}>
            ↑ Есть новые действия — обновить
          </button>
        </div>
      )}
      <div className="filter-row">
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
          <label htmlFor="logs-search" style={{ fontSize: 12, color: 'var(--hint)', marginBottom: 4 }}>
            Поиск по логам
          </label>
          <input
            id="logs-search"
            placeholder="Поиск…"
            value={q}
            onChange={(e) => setQ(e.currentTarget.value)}
            role="search"
            aria-label="Поиск по логам действий агентов"
          />
        </div>
      </div>
      <div className="filter-row">
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
          <label htmlFor="filter-agent" style={{ fontSize: 12, color: 'var(--hint)', marginBottom: 4 }}>
            Агент
          </label>
          <select id="filter-agent" value={agent} onChange={(e) => setAgent(e.currentTarget.value)}>
            <option value="">все агенты</option>
            {agentsHint(agentsState) && (
              <option value="" disabled>
                {agentsHint(agentsState)}
              </option>
            )}
            {agents.map((a) => (
              <option key={a.key} value={a.key}>
                {a.key}
              </option>
            ))}
          </select>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
          <label htmlFor="filter-status" style={{ fontSize: 12, color: 'var(--hint)', marginBottom: 4 }}>
            Статус
          </label>
          <select id="filter-status" value={status} onChange={(e) => setStatus(e.currentTarget.value)}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s ? label(STATUS_LABELS_LOCAL, s) : "все статусы"}
              </option>
            ))}
          </select>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
          <label htmlFor="filter-level" style={{ fontSize: 12, color: 'var(--hint)', marginBottom: 4 }}>
            Уровень
          </label>
          <select id="filter-level" value={level} onChange={(e) => setLevel(e.currentTarget.value)}>
            {LEVEL_OPTIONS.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
          <label htmlFor="filter-type" style={{ fontSize: 12, color: 'var(--hint)', marginBottom: 4 }}>
            Тип действия
          </label>
          <input
            id="filter-type"
            placeholder="фильтр по типу"
            value={type}
            onChange={(e) => setType(e.currentTarget.value)}
            aria-label="Фильтр по типу действия"
          />
        </div>
      </div>

      <div className="btn-row" style={{ marginBottom: 10 }}>
        <button
          type="button"
          className={interAgentOnly ? "btn" : "btn secondary"}
          style={{ padding: "4px 10px", fontSize: 12 }}
          onClick={() => setInterAgentOnly((v) => !v)}
          title={`Только: ${INTER_AGENT_ACTION_TYPES.join(", ")}`}
          aria-pressed={interAgentOnly}
        >
          Inter-agent {interAgentOnly ? "✓" : ""}
        </button>
      </div>

      {initialLoading ? (
        <SkeletonList rows={6} />
      ) : visible.length === 0 && !loading ? (
        <EmptyState
          icon="∅"
          title="Ничего не найдено"
          hint={
            q || level || agent || status || type
              ? "Попробуй сбросить часть фильтров."
              : "Действия агентов появятся здесь."
          }
        />
      ) : (
        visible.map((a) => (
          <div className="list-item" key={a.id}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="title">
                {a.agent_key} · {a.action_type}
              </div>
              <div className="meta">
                {new Date(a.created_at).toLocaleString()}
                {a.error ? ` · ${ellipsize(a.error, 80)}` : ""}
              </div>
            </div>
            <span className={`badge ${a.status}`}>{label(STATUS_LABELS_LOCAL, a.status)}</span>
          </div>
        ))
      )}

      {hasMore && !initialLoading && (
        <div className="btn-row" style={{ justifyContent: "center" }}>
          <button
            className="btn secondary"
            disabled={loading}
            onClick={() => load(false)}
          >
            {loading ? "Загрузка…" : "Показать ещё"}
          </button>
        </div>
      )}
    </div>
  );
}
