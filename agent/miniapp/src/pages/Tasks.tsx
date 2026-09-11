import { useEffect, useState } from "react";
import { api, formatApiError } from "../lib/api";
import type { Task, TaskStatus } from "../lib/types";
import { AGENTS_EMPTY, agentsHint, loadAgents } from "../lib/agents-load";
import { currentChatId, haptic, toast } from "../lib/tg";
import { subscribe as sseSubscribe } from "../lib/sse";
import { useLatestRun } from "../lib/stale";
import { useCoalescer } from "../lib/coalesce";
import { SkeletonList } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { ErrorBox } from "../components/ErrorBox";
import { TASK_STATUS_LABELS, label } from "../lib/labels";
import { ellipsize } from "../lib/text";
import { adminFromAutonomy } from "../lib/admin";
import { TASK_TRANSITIONS, nextStatuses } from "../../../lib/task-fsm.ts";

const STATUSES: (TaskStatus | "")[] = [
  "",
  "pending",
  "running",
  "awaiting_approval",
  "awaiting_review",
  "done",
  "failed",
  "cancelled",
];

// Куда можно из текущего статуса. Раньше здесь лежала своя копия серверной
// таблицы, и она разошлась: сервер разрешал pending/running → awaiting_approval,
// а кнопки для этого не было ни в списке, ни в карточке. Теперь источник один.
//
// Кнопки строятся не отсюда, а из `nextStatuses`: таблица знает только статус,
// а сервер отказывает ещё и по самой задаче (прогон временной роли). Аудит
// 2026-09-11: пока кнопки строились по таблице, такой задаче рисовалось
// «→ done», и жать её значило получить 400 — расхождение вернулось, просто
// этажом выше. Здесь таблица остаётся ровно для `isTerminalStatus`, которому
// задачи не дают: он отвечает про ЦЕЛЕВОЙ статус, а не про текущую задачу.
const NEXT_STATUS = TASK_TRANSITIONS;

/**
 * Какую версию задачи показывать в открытой карточке.
 *
 * Карточка открывалась снимком: в состояние клали сам объект задачи. Пока она
 * открыта, задачу меняют 12 агентов, список перезагружается по SSE — а снимок
 * остаётся тем же. Карточка показывала устаревший статус и, что хуже, строила
 * по нему кнопки переходов: из «done» сервер уже никуда не пустит, но кнопка
 * «→ running» продолжала висеть, пока пользователь её не нажмёт и не получит
 * ошибку.
 *
 * Берём свежую версию из списка по id. Снимок остаётся запасным: после смены
 * статуса задача может выпасть из активного фильтра, и в списке её не будет —
 * тогда показываем последнее, что о ней точно известно.
 *
 * Экспортируется ради теста: DOM-харнесса у Mini App нет, решение тут чистое.
 */
export function pickSelected(
  tasks: Task[],
  id: string | null,
  snapshot: Task | null,
): Task | null {
  if (!id) return null;
  return tasks.find((t) => t.id === id) ?? snapshot;
}

// Quick actions only make sense for statuses that have at least one terminal transition.
const QUICK_ACTIONS: { label: string; status: TaskStatus; cls: string; aria: string }[] = [
  { label: "✓", status: "done", cls: "success", aria: "Отметить как выполненную" },
  { label: "✗", status: "failed", cls: "danger", aria: "Отметить как проваленную" },
  { label: "⊘", status: "cancelled", cls: "warn", aria: "Отменить задачу" },
];

/** Потолок на название в вопросе: это alert телефона, а не отдельный экран. */
const CONFIRM_TITLE_MAX = 60;

/**
 * Статус, из которого FSM не выпускает.
 *
 * Экспортируется ради теста: DOM-харнесса у Mini App нет, решение тут чистое.
 */
export function isTerminalStatus(status: TaskStatus): boolean {
  return NEXT_STATUS[status].length === 0;
}

/**
 * Вопрос перед сменой статуса; `null` — спрашивать не о чем.
 *
 * Аудит 2026-08-28: подтверждение стояло флажком рядом с кнопкой и оказалось
 * ровно на одном из трёх необратимых исходов. `⊘` (cancelled) спрашивал, а
 * соседние `✓` (done) и `✗` (failed) — нет, при том что в FSM все три
 * терминальны одинаково (`done: []`, `failed: []`, `cancelled: []`) и стоят
 * тремя кнопками подряд в одной строке списка на телефоне. Промах пальцем
 * закрывал задачу навсегда: обратного перехода нет, сервер на попытку отвечает
 * `invalid status transition`.
 *
 * Поэтому признак выводится из самой таблицы переходов, а не из флажка: новый
 * терминальный статус подхватит защиту сам, а появившийся выход из `failed`
 * снимет её сам.
 */
export function confirmStatusText(title: string, next: TaskStatus): string | null {
  if (!isTerminalStatus(next)) return null;
  const name = ellipsize(title, CONFIRM_TITLE_MAX);
  return `«${name}» → «${label(TASK_STATUS_LABELS, next)}».\n\nСтатус конечный: вернуть задачу в работу потом будет нельзя. Продолжить?`;
}


export default function Tasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  // Ответ ручки режется лимитом, и до аудита 2026-08-28 узнать об этом было
  // неоткуда: сотня задач из трёхсот выглядела как вся доска.
  const [truncated, setTruncated] = useState(false);
  const [status, setStatus] = useState<TaskStatus | "">("");
  const [assignee, setAssignee] = useState<string>("");
  const [agentsState, setAgentsState] = useState(AGENTS_EMPTY);
  const agents = agentsState.agents;
  // Открытая карточка хранит id, а не объект: содержимое берётся из свежего
  // списка (см. pickSelected). snapshot — запасной, на случай выпадения из фильтра.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedSnapshot, setSelectedSnapshot] = useState<Task | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyIds, setBusyIds] = useState<Record<string, boolean>>({});
  // До ответа — как раньше: баннер «нельзя» мигать на каждом открытии у
  // админа (обычный случай) неприятнее, чем кнопка, живущая долю секунды.
  const [canEdit, setCanEdit] = useState(true);
  const [showNew, setShowNew] = useState(false);

  const selected = pickSelected(tasks, selectedId, selectedSnapshot);

  function openTask(t: Task) {
    setSelectedId(t.id);
    setSelectedSnapshot(t);
  }

  function closeTask() {
    setSelectedId(null);
    setSelectedSnapshot(null);
  }

  // New-task form state
  const initialChat = currentChatId();
  const [nTitle, setNTitle] = useState("");
  const [nAssignee, setNAssignee] = useState("");
  const [nInput, setNInput] = useState("");
  const [nChat, setNChat] = useState<string>(
    initialChat != null ? String(initialChat) : "",
  );
  const [nSubmitting, setNSubmitting] = useState(false);

  // Список перезагружается на смену фильтра И на каждое task.created/updated от
  // любого из 12 агентов, так что запросов в полёте бывает несколько. Применяем
  // только ответ последнего: иначе медленный ответ на прошлый фильтр
  // перезапишет свежий список, и сам он уже не починится.
  const beginLoad = useLatestRun();
  const coalescer = useCoalescer();

  async function load() {
    const isCurrent = beginLoad();
    setLoading(true);
    setErr(null);
    try {
      const r = await api.tasks({
        status: status || undefined,
        assignee: assignee || undefined,
        limit: 100,
      });
      if (!isCurrent()) return;
      setTasks(r.tasks);
      setTruncated(Boolean(r.truncated));
    } catch (e: any) {
      if (isCurrent()) setErr(formatApiError(e));
    } finally {
      // Устаревший запрос не гасит индикатор: актуальный ещё в пути.
      if (isCurrent()) setLoading(false);
    }
  }

  useEffect(() => {
    void loadAgents(() => api.agents()).then(setAgentsState);
  }, []);

  // Отдельно от load(): автономия — не то, ради чего открывают страницу, и её
  // ошибка не должна ни ронять список задач, ни всплывать в ErrorBox над ним.
  useEffect(() => {
    api
      .autonomy()
      .then((r) => setCanEdit(adminFromAutonomy(r)))
      .catch(() => setCanEdit(adminFromAutonomy(null)));
  }, []);

  useEffect(() => {
    load();
  }, [status, assignee]);

  // Задачи меняют все 12 агентов, и за один ход команды событий прилетает
  // пачка. Схлопываем: смена фильтра грузит сразу, поток событий — не чаще
  // одного запроса за окно.
  useEffect(() => {
    const reload = () => coalescer.schedule(() => load());
    const unsubs = [
      sseSubscribe("task.created", reload),
      sseSubscribe("task.updated", reload),
    ];
    // Аудит 2026-08-13: снималась только подписка, а отложенный запуск
    // коалесера оставался — и держал замыкание на load() со СТАРЫМ фильтром
    // (useCoalescer отменяет только при размонтировании). Сценарий: прилетело
    // task.updated, открылось окно 700 мс, внутри окна читатель выбрал в
    // фильтре «готово». Эффект грузит done, следом срабатывает таймер и
    // грузит прежний фильтр — а `useLatestRun` благословляет тот запуск,
    // который начался ПОЗЖЕ, то есть устаревший. В списке оказываются все
    // статусы при выбранном «готово», и само это не чинится: следующий рендер
    // данные не перезапрашивает.
    return () => {
      unsubs.forEach((u) => u());
      coalescer.cancel();
    };
  }, [status, assignee]);

  function setBusy(id: string, b: boolean) {
    setBusyIds((m) => ({ ...m, [id]: b }));
  }

  async function changeStatus(id: string, next: TaskStatus) {
    setBusy(id, true);
    try {
      const r = await api.taskStatus(id, { status: next, by: "miniapp" });
      haptic("success");
      toast(`Задача → ${label(TASK_STATUS_LABELS, next)}`, "success");
      // Свежий ответ — и в запасной снимок: после смены статуса задача может
      // выпасть из активного фильтра, и в списке её уже не найти.
      if (selectedId === id) setSelectedSnapshot(r.task);
      load();
    } catch (e: any) {
      toast(formatApiError(e), "error");
      haptic("error");
    } finally {
      setBusy(id, false);
    }
  }

  /**
   * Единственная точка входа в смену статуса из интерфейса.
   *
   * Обе кнопки — быстрая в списке и переход в карточке — идут сюда: раньше
   * карточка звала `changeStatus` напрямую, и один и тот же переход спрашивал
   * в списке и молчал в карточке.
   */
  async function requestStatus(t: Task, next: TaskStatus) {
    const ask = confirmStatusText(t.title, next);
    if (ask && !window.confirm(ask)) return;
    if (!nextStatuses(t).includes(next)) {
      toast(`Нельзя «${label(TASK_STATUS_LABELS, next)}» из «${label(TASK_STATUS_LABELS, t.status)}»`, "error");
      return;
    }
    await changeStatus(t.id, next);
  }

  async function submitNew() {
    if (!nTitle.trim()) {
      toast("Укажи название", "error");
      return;
    }
    const chatNum = Number(nChat);
    if (!Number.isFinite(chatNum) || nChat.trim() === "") {
      toast("Укажи chat_id", "error");
      return;
    }
    let parsedInput: unknown = undefined;
    if (nInput.trim()) {
      try {
        parsedInput = JSON.parse(nInput);
      } catch {
        parsedInput = nInput;
      }
    }
    setNSubmitting(true);
    try {
      await api.createTask({
        title: nTitle.trim(),
        chat_id: chatNum,
        assignee: nAssignee || undefined,
        input: parsedInput,
      });
      haptic("success");
      toast("Задача создана", "success");
      setShowNew(false);
      setNTitle("");
      setNInput("");
      load();
    } catch (e: any) {
      haptic("error");
      toast(formatApiError(e), "error");
    } finally {
      setNSubmitting(false);
    }
  }

  return (
    <div>
      <ErrorBox message={err} onRetry={() => load()} />
      {!canEdit && (
        <div className="error-box">
          Изменение задач доступно только админам (тебя нет в
          MINIAPP_ADMIN_USER_IDS). Список открыт на чтение.
        </div>
      )}
      <div className="btn-row" style={{ marginBottom: 10 }}>
        <button
          className="btn"
          disabled={!canEdit}
          onClick={() => setShowNew(true)}
        >
          + Новая задача
        </button>
      </div>
      <div className="filter-row">
        <select
          value={status}
          onChange={(e) => setStatus(e.currentTarget.value as TaskStatus | "")}
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s ? label(TASK_STATUS_LABELS, s) : "все статусы"}
            </option>
          ))}
        </select>
        <select
          value={assignee}
          onChange={(e) => setAssignee(e.currentTarget.value)}
        >
          <option value="">все исполнители</option>
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

      {truncated && !loading && (
        <div className="meta" style={{ marginBottom: 8 }}>
          Показаны не все задачи — выдача обрезана по лимиту. Сузь фильтрами.
        </div>
      )}

      {loading && tasks.length === 0 ? (
        <SkeletonList rows={5} />
      ) : tasks.length === 0 ? (
        <EmptyState
          icon="✓"
          title="Задач нет"
          hint={status || assignee ? "Попробуй сбросить фильтры." : "Нажми «+ Новая задача», чтобы создать."}
        />
      ) : (
        tasks.map((t) => {
          const busy = !!busyIds[t.id];
          const possible = nextStatuses(t);
          return (
            <div className="list-item" key={t.id}>
              <div
                style={{ minWidth: 0, flex: 1 }}
                onClick={() => openTask(t)}
              >
                <div className="title">{t.title}</div>
                <div className="meta">
                  {t.assigned_to ?? "—"} ·{" "}
                  {new Date(t.created_at).toLocaleString()}
                </div>
              </div>
              <span className={`badge ${t.status}`}>{label(TASK_STATUS_LABELS, t.status)}</span>
              <div className="task-actions">
                {QUICK_ACTIONS.filter((qa) =>
                  possible.includes(qa.status),
                ).map((qa) => (
                  <button
                    key={qa.status}
                    className={`action-btn ${qa.cls}`}
                    title={qa.aria}
                    aria-label={qa.aria}
                    disabled={busy || !canEdit}
                    onClick={(e) => {
                      e.stopPropagation();
                      requestStatus(t, qa.status);
                    }}
                  >
                    {busy ? "⏳" : qa.label}
                  </button>
                ))}
              </div>
            </div>
          );
        })
      )}

      {selected && (
        <div className="modal-overlay" onClick={closeTask}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{selected.title}</h2>
            <div className="meta" style={{ marginBottom: 10 }}>
              <span className={`badge ${selected.status}`}>
                {label(TASK_STATUS_LABELS, selected.status)}
              </span>{" "}
              · {selected.assigned_to ?? "—"}
            </div>
            {selected.description && (
              <p style={{ marginTop: 0 }}>{selected.description}</p>
            )}
            <div className="section-title">Ввод</div>
            <pre className="json-block">
              {JSON.stringify(selected.input, null, 2)}
            </pre>
            {selected.output != null && (
              <>
                <div className="section-title">Результат</div>
                <pre className="json-block">
                  {JSON.stringify(selected.output, null, 2)}
                </pre>
              </>
            )}
            {selected.error && (
              <>
                <div className="section-title">Ошибка</div>
                <pre className="json-block">{selected.error}</pre>
              </>
            )}
            <div className="btn-row">
              {nextStatuses(selected).map((next) => (
                <button
                  key={next}
                  className={`btn ${
                    next === "done"
                      ? "success"
                      : next === "failed" || next === "cancelled"
                        ? "danger"
                        : ""
                  }`}
                  disabled={!!busyIds[selected.id] || !canEdit}
                  onClick={() => requestStatus(selected, next)}
                >
                  {busyIds[selected.id] ? "⏳" : `→ ${label(TASK_STATUS_LABELS, next)}`}
                </button>
              ))}
              <button
                className="btn secondary"
                onClick={closeTask}
              >
                Закрыть
              </button>
            </div>
          </div>
        </div>
      )}

      {showNew && (
        <div className="modal-overlay" onClick={() => setShowNew(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Новая задача</h2>
            <div className="section-title">Название</div>
            <input
              type="text"
              value={nTitle}
              onChange={(e) => setNTitle(e.currentTarget.value)}
              placeholder="Короткое название"
              style={{
                width: "100%",
                padding: 8,
                borderRadius: 8,
                border: "1px solid var(--border)",
                background: "var(--bg)",
                color: "var(--text)",
                marginBottom: 8,
              }}
            />
            <div className="section-title">Исполнитель</div>
            <select
              value={nAssignee}
              onChange={(e) => setNAssignee(e.currentTarget.value)}
              style={{ width: "100%", padding: 8, marginBottom: 8 }}
            >
              <option value="">— без исполнителя —</option>
              {agentsHint(agentsState) && (
                <option value="" disabled>
                  {agentsHint(agentsState)}
                </option>
              )}
              {agents.map((a) => (
                <option key={a.key} value={a.key}>
                  {a.key} — {a.title}
                </option>
              ))}
            </select>
            <div className="section-title">Chat ID</div>
            <input
              type="text"
              value={nChat}
              onChange={(e) => setNChat(e.currentTarget.value)}
              placeholder="например, -1001234567"
              style={{
                width: "100%",
                padding: 8,
                borderRadius: 8,
                border: "1px solid var(--border)",
                background: "var(--bg)",
                color: "var(--text)",
                marginBottom: 8,
              }}
            />
            <div className="section-title">Ввод (JSON или текст)</div>
            <textarea
              value={nInput}
              onChange={(e) => setNInput(e.currentTarget.value)}
              placeholder='{"goal": "..."}'
            />
            <div className="btn-row">
              <button
                className="btn success"
                onClick={submitNew}
                disabled={nSubmitting}
              >
                {nSubmitting ? "⏳ Создаём…" : "Создать"}
              </button>
              <button
                className="btn secondary"
                onClick={() => setShowNew(false)}
                disabled={nSubmitting}
              >
                Отмена
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
