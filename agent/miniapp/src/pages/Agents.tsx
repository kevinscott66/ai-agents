import { useEffect, useState } from "react";
import { api, formatApiError, type DashboardPayload } from "../lib/api";
import type { AgentInfo, AutonomyMode, Permission, AgentAction } from "../lib/types";
import { haptic, toast } from "../lib/tg";
import { subscribe as sseSubscribe } from "../lib/sse";
import { useCoalescer } from "../lib/coalesce";
import { useLatestRun } from "../lib/stale";
import { SkeletonRow } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { ErrorBox } from "../components/ErrorBox";
import { AGENT_STATUS_LABELS, PERMISSION_LABELS, ACTION_STATUS_LABELS, label } from "../lib/labels";
import { ellipsize } from "../lib/text";

/**
 * `inherit` — не режим, а его отсутствие: у роли нет своей строки, она слушается
 * чата и глобального. Аудит 2026-08-21: снять переопределение было нечем, и
 * выпадающий список этого не показывал — он выводил ЭФФЕКТИВНЫЙ режим, тот же
 * самый и у роли без переопределения. Выбрать в нём то, что уже написано, —
 * значило молча создать бессрочное исключение из будущего рубильника.
 */
const AUTONOMY_CHOICES: Array<AutonomyMode | "inherit"> = [
  "inherit",
  "locked",
  "manual",
  "semi_auto",
  "auto",
];

const AUTONOMY_LABELS: Record<AutonomyMode | "inherit", string> = {
  inherit: "Наследует чат",
  locked: "Заблокирован",
  manual: "Ручной",
  semi_auto: "Полуавто",
  auto: "Авто",
};

/**
 * Что показать в блоке прав роли.
 *
 * Аудит 2026-08-14: «загружается» выводилось из `perms.length === 0`. Пустой
 * список — это не только «ещё не пришло»: ручка может честно вернуть ноль
 * строк, и тогда скелетон пульсировал бесконечно, обещая данные, которых уже
 * не будет. Отличать «нет ответа» от «ответ пустой» может только явный флаг.
 *
 * Экспортируется ради теста: DOM-харнесса у Mini App нет, решение тут чистое.
 */
export function permsPanel(
  loading: boolean,
  count: number,
  err: string | null,
): "loading" | "error" | "empty" | "list" {
  if (loading) return "loading";
  if (err) return "error";
  return count === 0 ? "empty" : "list";
}

/**
 * Что показывать в пустом пункте списка автономности.
 *
 * Аудит 2026-08-27: `loadAgentAutonomy` глотала отказ в `catch {}`, и
 * `autoMode[key]` оставался `undefined` — то есть выбранным оставался ровно
 * тот же пункт, что и до загрузки. Отвалившаяся ручка выглядела как «ещё
 * грузится», а неизвестное — как «переопределения нет». Админ, глядя на
 * список, считал, что роль слушается чата, хотя на самом деле неизвестно,
 * есть у неё исключение или нет.
 *
 * Порядок веток: запись в полёте важнее прошлой ошибки чтения (её вот-вот
 * перечитают), ошибка важнее «грузится», а «грузится» — не то же самое, что
 * загруженный режим.
 *
 * Экспортируется ради теста: DOM-харнесса у Mini App нет, решение тут чистое.
 */
export function autonomySelectState(
  busy: boolean,
  err: string | null,
  hasMode: boolean,
): "busy" | "error" | "loading" | "ready" {
  if (busy) return "busy";
  if (err) return "error";
  return hasMode ? "ready" : "loading";
}

export const AUTONOMY_PLACEHOLDERS: Record<
  ReturnType<typeof autonomySelectState>,
  string
> = {
  busy: "⏳…",
  error: "⚠ режим не загрузился",
  loading: "загрузка…",
  ready: "(автономность)",
};

/**
 * Адресат записи права — только та роль, чья карточка сейчас открыта.
 *
 * Аудит 2026-08-20: `toggle()` брал ключ из строки прав (`next.agentKey`).
 * Строки приезжают асинхронно, и ответ на запрос для уже закрытой карточки
 * мог осесть в открытой (см. `openAgent` ниже). В этот момент заголовок
 * показывал одну роль, а переключатель писал право другой — без единого
 * признака в интерфейсе. Проверка ключа делает такую запись невозможной даже
 * если строки в состоянии почему-то окажутся чужими.
 *
 * Экспортируется ради теста: DOM-харнесса у Mini App нет, решение тут чистое.
 */
export function canWritePermission(
  rowAgentKey: string,
  openAgentKey: string | null,
): openAgentKey is string {
  if (!openAgentKey) return false;
  return rowAgentKey === openAgentKey;
}

/**
 * Собственные режимы ролей из одного ответа `/api/autonomy`.
 *
 * Аудит 2026-08-28: страница спрашивала режим по одной роли за раз — двенадцать
 * GET'ов на монтирование и ещё двенадцать на каждое событие `agent.autonomy`.
 * Смысла в этом не было: ручка отдаёт `agent_overrides` целиком независимо от
 * параметра `agent` (ветка `GET /api/autonomy` в miniapp-server.ts, «отдаём
 * список всегда»), а из
 * ответа читались ровно два поля — этот список и `admin`. Эффективный `r.mode`,
 * единственное, что зависит от параметра, не читался вовсе.
 *
 * Цена: ведро GET'ов рейт-лимита — 120 с доливом 4/с (`GET_LIMIT` в miniapp-server.ts),
 * и оно общее на все запросы вкладки. Двенадцать ролей, переключаемые подряд
 * на этой же странице, дают событие на каждое нажатие — 12 запросов на
 * событие плюс перезагрузка списка. Десяток нажатий выбирал ведро целиком, и
 * админ получал 429 на всю Mini App от собственной работы.
 *
 * Нет строки — `inherit`: у роли без переопределения нет своего режима, она
 * слушается чата. Это то же правило, что было в поштучной загрузке.
 *
 * Экспортируется ради теста: DOM-харнесса у Mini App нет, решение тут чистое.
 */
export function ownAutonomyModes(
  overrides: Array<{ agent: string; mode: AutonomyMode }> | undefined,
  keys: string[],
): Record<string, AutonomyMode | "inherit"> {
  const own = new Map((overrides ?? []).map((o) => [o.agent, o.mode]));
  const out: Record<string, AutonomyMode | "inherit"> = {};
  for (const k of keys) out[k] = own.get(k) ?? "inherit";
  return out;
}

export default function Agents() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [selected, setSelected] = useState<AgentInfo | null>(null);
  const [perms, setPerms] = useState<Permission[]>([]);
  const [readonly, setReadonly] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [permErr, setPermErr] = useState<string | null>(null);
  /** Явный флаг: пустой список прав — не то же самое, что «ещё не пришло». */
  const [permsLoading, setPermsLoading] = useState(false);
  const [autoMode, setAutoMode] = useState<
    Record<string, AutonomyMode | "inherit">
  >({});
  /** Ошибка чтения режима — по роли. Пустой список ≠ «нет переопределения». */
  const [autoErr, setAutoErr] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [adminBlocked, setAdminBlocked] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [budgets, setBudgets] = useState<DashboardPayload["budgets"]>([]);
  const [recentActions, setRecentActions] = useState<Record<string, AgentAction[]>>({});

  const coalescer = useCoalescer();
  /** Права грузим по клику; выигрывает последний клик, а не последний ответ. */
  const beginPerms = useLatestRun();

  async function refresh() {
    try {
      setErr(null);
      const [agentsRes, budgetsRes] = await Promise.all([
        api.agents(),
        api.budgets()
      ]);
      setAgents(agentsRes.agents);
      setBudgets(budgetsRes.budgets);
      // Не-админа сервер называет сразу, в первом же ответе. Прежде страница
      // это поле игнорировала и узнавала о запрете только из 403 на попытку
      // записи — то есть после клика, которому не суждено сработать.
      if (budgetsRes.admin !== undefined) setAdminBlocked(!budgetsRes.admin);
      setLoaded(true);
    } catch (e: any) {
      setErr(formatApiError(e));
    }
  }

  useEffect(() => {
    refresh();
    // agent.health прилетает по каждому пингу воркеров — на 12 ролей это
    // регулярная пачка, а refresh() тянет и список агентов, и все бюджеты.
    const reload = () => coalescer.schedule(() => refresh());
    const unsubs = [
      sseSubscribe("agent.health", reload),
      sseSubscribe("agent.paused", reload),
      sseSubscribe("agent.autonomy", reload),
    ];
    return () => unsubs.forEach((u) => u());
  }, []);

  // Lazy-load per-agent autonomy when admin controls become visible.
  // Показываем СВОЮ строку роли, а не эффективный режим: `r.mode` у роли без
  // переопределения равен чатовому, и список выглядел бы так, будто исключение
  // уже есть. Нет строки — «Наследует чат».
  async function loadAgentAutonomy(keys: string[]) {
    if (keys.length === 0) return;
    try {
      // Аудит 2026-08-28: запрос был на роль, то есть двенадцать GET на
      // монтирование и ещё двенадцать на каждое событие agent.autonomy. При
      // этом `agent_overrides` ручка отдаёт списком целиком и всегда
      // (`agent_overrides` в ветке `GET /api/autonomy`) — параметр `agent`
      // на состав ответа не
      // влияет, а эффективный режим страница не читает вовсе. Общий бакет GET
      // — 120 с доливом 4/сек (`GET_LIMIT` в miniapp-server.ts), и админ,
      // щёлкающий
      // режимы на этой же странице, выбивал 429 сам себе.
      const r = await api.autonomy();
      // Своё исключение от унаследованного отличает только `agent_overrides`:
      // у роли без своей строки эффективный режим равен чатовому, и список
      // выглядел бы так, будто исключение уже заведено.
      const own = ownAutonomyModes(r?.agent_overrides, keys);
      setAutoMode((cur) => ({ ...cur, ...own }));
      // Тот же гейт, что у POST: ручка сообщает его и на чтении.
      if (r?.admin !== undefined) setAdminBlocked(!r.admin);
      setAutoErr((cur) => {
        if (!keys.some((k) => k in cur)) return cur;
        const n = { ...cur };
        for (const k of keys) delete n[k];
        return n;
      });
    } catch (e: any) {
      // Аудит 2026-08-27: было `catch {}`. Отказ не должен выглядеть как
      // ответ «переопределения нет» — это разные вещи, и вторая толкает
      // админа заводить исключение поверх уже существующего.
      //
      // 403 отдельной веткой не ловим: GET открыт всем пущенным и сообщает
      // гейт полем `admin` выше. Инвариант из
      // audit-2026-08-21-agents-admin-flag — ровно две точки, где взводится
      // флаг админа: чтение по полю ответа и запись по отказу. Догадка на
      // месте была бы третьей.
      //
      // Запрос теперь один на все роли, значит и отказ общий: помечаем все
      // запрошенные, иначе одиннадцать строк молчали бы об ошибке.
      const msg = formatApiError(e);
      setAutoErr((cur) => {
        const n = { ...cur };
        for (const k of keys) n[k] = msg;
        return n;
      });
    }
  }

  // Аудит 2026-08-13: зависимость была `[agents.length]`, а подписка на
  // agent.autonomy зовёт refresh(), который перечитывает список агентов и
  // бюджеты — но НЕ режим автономности. Длина массива при этом не меняется,
  // значит эффект не перезапускается: админ переключил роль в другом клиенте
  // или в Telegram, событие пришло, а выпадающий список продолжал показывать
  // прежний режим до полной перезагрузки страницы. Ключи вместо длины ловят
  // ещё и подмену состава при той же длине.
  const agentKeys = agents.map((a) => a.key).join(",");
  useEffect(() => {
    loadAgentAutonomy(agents.map((a) => a.key));
  }, [agentKeys]);

  // Само событие тоже должно перечитывать режим, а не только список.
  useEffect(() => {
    return sseSubscribe("agent.autonomy", () => {
      loadAgentAutonomy(agents.map((a) => a.key));
    });
  }, [agentKeys]);

  async function setAgentAutonomy(key: string, mode: AutonomyMode | "inherit") {
    setBusy((m) => ({ ...m, [`auto:${key}`]: true }));
    try {
      await api.setAutonomy({ mode, agent: key });
      setAutoMode((cur) => ({ ...cur, [key]: mode }));
      toast(`${key}: ${AUTONOMY_LABELS[mode]}`, "success");
      haptic("success");
    } catch (e: any) {
      haptic("error");
      if (e.status === 403) {
        setAdminBlocked(true);
        toast("Только для админа", "error");
      } else {
        toast(formatApiError(e), "error");
      }
    } finally {
      setBusy((m) => {
        const n = { ...m };
        delete n[`auto:${key}`];
        return n;
      });
    }
  }

  async function togglePause(a: AgentInfo) {
    const goingToPause = !a.paused;
    if (goingToPause && !window.confirm(`Поставить ${a.key} на паузу?`)) return;
    setBusy((m) => ({ ...m, [`pause:${a.key}`]: true }));
    try {
      if (goingToPause) await api.pauseAgent(a.key);
      else await api.resumeAgent(a.key);
      toast(`${a.key} ${goingToPause ? "на паузе" : "запущен"}`, "success");
      haptic("success");
      // Optimistic update + refresh.
      setAgents((cur) =>
        cur.map((x) =>
          x.key === a.key
            ? {
                ...x,
                paused: goingToPause,
                status: goingToPause ? "paused" : "running",
              }
            : x,
        ),
      );
      refresh();
    } catch (e: any) {
      haptic("error");
      if (e.status === 403) {
        setAdminBlocked(true);
        toast("Только для админа", "error");
      } else {
        toast(formatApiError(e), "error");
      }
    } finally {
      setBusy((m) => {
        const n = { ...m };
        delete n[`pause:${a.key}`];
        return n;
      });
    }
  }

  async function openAgent(a: AgentInfo) {
    setSelected(a);
    setPerms([]);
    setPermErr(null);
    setReadonly(false);
    setPermsLoading(true);
    // Аудит 2026-08-20. Карточка закрывается кликом по оверлею, после чего
    // сразу кликабельна следующая — то есть «открыл backend, закрыл, открыл
    // frontend» укладывается в один round-trip /api/permissions. Без номера
    // прогона ответ для backend приезжал вторым и перерисовывал открытую
    // карточку frontend, а `toggle()` потом писал право backend'у.
    const isCurrent = beginPerms();
    // Две независимые ручки, и права из них — админские, а действия открыты
    // всем из аллоу-листа. Пока обе стояли в `Promise.all`, 403 от прав
    // реджектил всё разом и уносил с собой уже полученный список действий:
    // не-админ видел «Действий пока нет» там, где действия есть и читать их
    // ему можно. allSettled — чтобы отказ одной не гасил другую.
    const [permsRes, actionsRes] = await Promise.allSettled([
      api.permissions(a.key),
      api.actions({ agent: a.key, limit: 10 }),
    ]);

    if (actionsRes.status === "fulfilled") {
      setRecentActions((prev) => ({ ...prev, [a.key]: actionsRes.value.actions }));
    }

    // Дальше — только состояние прав, а оно принадлежит открытой карточке.
    // Список действий выше остаётся без предиката намеренно: он пишется в
    // словарь по `a.key`, то есть в свою же ячейку, и устаревший ответ там
    // ничего не портит — гасить его значило бы выбросить полученные данные.
    if (!isCurrent()) return;

    // Ответ пришёл — любой. Дальше скелетону места нет ни в одной ветке.
    setPermsLoading(false);

    if (permsRes.status === "fulfilled") {
      setPerms(permsRes.value.permissions);
      return;
    }
    const e = permsRes.reason as any;
    if (e?.status === 403) {
      // Прежний текст обещал read-only просмотр прав — обещание без предмета:
      // список прав в этой ветке остаётся пустым, смотреть нечего.
      setReadonly(true);
      setPermErr("Права доступны только админам (MINIAPP_ADMIN_USER_IDS).");
    } else {
      setPermErr(formatApiError(e));
    }
  }

  async function toggle(
    p: Permission,
    field: "allowed" | "requires_approval",
  ) {
    if (readonly) return;
    // Ключ берём у открытой карточки, а не у строки: строка могла приехать
    // ответом на запрос для другой роли (см. canWritePermission выше).
    const openKey = selected?.key ?? null;
    if (!canWritePermission(p.agentKey, openKey)) return;
    const next = { ...p, [field]: !p[field] };
    try {
      await api.setPermission({
        agentKey: openKey,
        actionType: next.actionType,
        allowed: next.allowed,
        requires_approval: next.requires_approval,
      });
      haptic("success");
      setPerms((prev) =>
        prev.map((x) =>
          x.actionType === p.actionType && x.agentKey === p.agentKey
            ? next
            : x,
        ),
      );
    } catch (e: any) {
      haptic("error");
      if (e.status === 403) {
        setReadonly(true);
        setPermErr("Только для админа.");
      } else {
        toast(formatApiError(e), "error");
      }
    }
  }

  return (
    <div>
      <ErrorBox message={err} onRetry={() => refresh()} />
      {adminBlocked && (
        <div className="error-box">
          Управление доступно только админам (тебя нет в MINIAPP_ADMIN_USER_IDS).
        </div>
      )}
      {agents.length === 0 && !err && !loaded ? (
        <div className="stat-grid" aria-hidden="true">
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </div>
      ) : null}
      {agents.length === 0 && !err && loaded ? (
        <EmptyState
          icon="◆"
          title="Агентов пока нет"
          hint="Команда соберётся, как только бэкенд зарегистрирует роли."
        />
      ) : null}
      <div className="stat-grid">
        {agents.map((a) => {
          const autoBusy = !!busy[`auto:${a.key}`];
          const autoState = autonomySelectState(
            autoBusy,
            autoErr[a.key] ?? null,
            a.key in autoMode,
          );
          const pauseBusy = !!busy[`pause:${a.key}`];
          return (
            <div className="stat-card" key={a.key}>
              <div
                onClick={() => openAgent(a)}
                style={{ cursor: "pointer" }}
              >
                <div className="label">{a.key}</div>
                <div
                  style={{ fontSize: 14, fontWeight: 600, marginTop: 4 }}
                >
                  {a.title}
                </div>
                <span
                  className={`badge ${
                    a.paused
                      ? "cancelled"
                      : a.status === "running"
                        ? "running"
                        : "pending"
                  }`}
                  style={{ marginTop: 6 }}
                >
                  {label(AGENT_STATUS_LABELS, a.status)}
                </span>
                {(() => {
                  const budget = budgets.find(b => b.agentKey === a.key);
                  if (!budget) return null;
                  const pct = budget.limit ? Math.round((budget.usedTokens / budget.limit) * 100) : 0;
                  return (
                    <div style={{ marginTop: 6, fontSize: 12, color: "#666" }}>
                      <div>Токены: {budget.usedTokens.toLocaleString()}</div>
                      {budget.limit && (
                        <div style={{ 
                          marginTop: 2,
                          color: pct >= 90 ? "#e74c3c" : pct >= 70 ? "#f39c12" : "#27ae60"
                        }}>
                          {pct}% от лимита
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
              <div style={{ marginTop: 8 }}>
                <select
                  value={autoState === "ready" ? autoMode[a.key] : ""}
                  disabled={adminBlocked || autoBusy}
                  onChange={(e) =>
                    setAgentAutonomy(
                      a.key,
                      e.currentTarget.value as AutonomyMode | "inherit",
                    )
                  }
                  style={{
                    width: "100%",
                    padding: 4,
                    fontSize: 12,
                    borderRadius: 6,
                    border: "1px solid var(--border)",
                    background: "var(--bg)",
                    color: "var(--text)",
                  }}
                >
                  {/* disabled: выбрать «пусто» значило послать mode="" в API. */}
                  <option value="" disabled>
                    {AUTONOMY_PLACEHOLDERS[autoState]}
                  </option>
                  {AUTONOMY_CHOICES.map((m) => (
                    <option key={m} value={m}>
                      {AUTONOMY_LABELS[m]}
                    </option>
                  ))}
                </select>
                <button
                  className={`action-btn ${a.paused ? "success" : "warn"}`}
                  style={{ marginTop: 6, width: "100%" }}
                  disabled={adminBlocked || pauseBusy}
                  onClick={() => togglePause(a)}
                >
                  {pauseBusy ? "⏳" : a.paused ? "▶ Запустить" : "⏸ Пауза"}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {selected && (
        <div className="modal-overlay" onClick={() => setSelected(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>
              {selected.title}{" "}
              <span className="meta" style={{ fontSize: 12 }}>
                ({selected.key})
              </span>
            </h2>
            
            <h3 style={{ fontSize: 14, marginTop: 16, marginBottom: 8 }}>Последние действия</h3>
            {(() => {
              const actions = recentActions[selected.key] || [];
              if (actions.length === 0) {
                return <div style={{ color: "#888", fontSize: 12 }}>Действий пока нет</div>;
              }
              return (
                <div style={{ maxHeight: "150px", overflowY: "auto", marginBottom: 16 }}>
                  {actions.map((action) => (
                    <div key={action.id} style={{
                      fontSize: 11,
                      padding: 6,
                      borderBottom: "1px solid var(--border)",
                      fontFamily: "monospace"
                    }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span style={{ fontWeight: "bold" }}>{action.action_type}</span>
                        {/* Статус идёт в класс как есть — так же, как в
                            Dashboard.tsx и Logs.tsx. Здесь стояла своя
                            перекодировка, и "ok" она отдавала классом
                            "success", которого у бейджа нет вовсе (есть
                            .btn.success и .toast.success — другие компоненты).
                            У .badge задан color:#fff и не задан фон, так что
                            самый частый статус рисовался белым по белому.
                            Заодно "forbidden" ехал в серый, хотя у него есть
                            своё красное правило, а всё остальное — включая
                            rate_limited — сваливалось в "pending". */}
                        <span className={`badge ${action.status}`}>
                          {label(ACTION_STATUS_LABELS, action.status)}
                        </span>
                      </div>
                      <div style={{ color: "#666", marginTop: 2 }}>
                        {/* created_at в БД — миллисекунды (audit.ts пишет
                            Date.now()), как и во всех остальных вью. */}
                        {new Date(action.created_at).toLocaleString("ru-RU")}
                      </div>
                      {action.error && (
                        <div style={{ color: "#e74c3c", marginTop: 2 }}>
                          {ellipsize(action.error, 100)}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              );
            })()}

            <h3 style={{ fontSize: 14, marginBottom: 8 }}>Права доступа</h3>
            {permErr && <div className="error-box">{permErr}</div>}
            {(() => {
              const panel = permsPanel(permsLoading, perms.length, permErr);
              if (panel === "loading") {
                return (
                  <>
                    <SkeletonRow />
                    <SkeletonRow />
                    <SkeletonRow />
                  </>
                );
              }
              if (panel === "error") return null;
              if (panel === "empty") {
                return (
                  <div style={{ fontSize: 12, color: "var(--hint)", padding: "6px 0" }}>
                    Прав для этой роли не задано.
                  </div>
                );
              }
              return perms.map((p) => (
                <div className="perm-row" key={p.actionType}>
                  <div style={{ fontSize: 12, fontFamily: "monospace" }}>
                    {p.actionType}
                  </div>
                  <div className="perm-flags">
                    {/* Кнопки, а не span'ы: тумблер права должен доставаться
                        табом и нажиматься с клавиатуры. readonly выключает
                        их по-настоящему, а не только гасит курсор. */}
                    <button
                      type="button"
                      className={`flag ${p.allowed ? "on" : ""}`}
                      aria-pressed={p.allowed}
                      aria-label={`${p.actionType}: ${p.allowed ? "разрешено" : "запрещено"}`}
                      disabled={readonly}
                      onClick={() => toggle(p, "allowed")}
                    >
                      {p.allowed ? "разрешено" : "запрещено"}
                    </button>
                    <button
                      type="button"
                      className={`flag ${p.requires_approval ? "on" : ""}`}
                      aria-pressed={p.requires_approval}
                      aria-label={`${p.actionType}: ${p.requires_approval ? "нужен аппрув" : "без аппрува"}`}
                      disabled={readonly}
                      onClick={() => toggle(p, "requires_approval")}
                    >
                      аппрув
                    </button>
                  </div>
                </div>
              ));
            })()}
            <div className="btn-row">
              <button
                className="btn secondary"
                onClick={() => setSelected(null)}
              >
                Закрыть
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
