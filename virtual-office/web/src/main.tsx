import {
  Component,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import {
  STATES,
  type Activity,
  type Command,
  type World,
} from "../../contracts/protocol";
import { OfficeConnection, type ConnectionStatus } from "./connection";
import "./style.css";
const Scene = lazy(() => import("./Scene"));
const LABELS: Record<Activity, string> = {
  OFFLINE: "Не в сети",
  IDLE: "Свободен",
  THINKING: "Готовит ответ",
  READING: "Читает",
  RESEARCHING: "Исследует",
  CODING: "Пишет код",
  TERMINAL: "В терминале",
  TESTING: "Тестирует",
  REVIEWING: "Проверяет",
  WAITING: "Ожидает решения",
  WAITING_TOOL: "Ждёт инструмент",
  COMMUNICATING: "Общается",
  MEETING: "На встрече",
  ERROR: "Ошибка",
  DONE: "Завершено",
};
const MOTIONS: Record<string, string> = {
  seated: "за рабочим столом",
  standing: "встаёт",
  walking: "идёт",
  window: "смотрит в окно",
  sitting: "садится",
};
class SceneBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div className="scene-error">
        Не удалось запустить 3D. Режим «2D» доступен сверху.
      </div>
    ) : (
      this.props.children
    );
  }
}
function time(at: string) {
  return new Date(at).toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
function App() {
  const [world, setWorld] = useState<World | null>(null),
    [status, setStatus] = useState<ConnectionStatus>("connecting"),
    [panel, setPanel] = useState<"inspect" | "chat" | "task" | null>(null),
    [near, setNear] = useState(false),
    [overview, setOverview] = useState(false),
    [quality, setQuality] = useState("balanced"),
    [motion, setMotion] = useState("seated"),
    [text, setText] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [now, setNow] = useState(Date.now());
  const connection = useRef<OfficeConnection | null>(null),
    closeButton = useRef<HTMLButtonElement>(null),
    chatEnd = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const c = new OfficeConnection(() => {
      setWorld(c.world);
      setStatus(c.status);
    });
    connection.current = c;
    c.start();
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      c.stop();
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (panel) closeButton.current?.focus();
  }, [panel]);
  useEffect(() => {
    chatEnd.current?.scrollIntoView({ block: "nearest" });
  }, [world?.messages.length, panel]);
  const open = useCallback(() => setPanel("inspect"), []);
  const live = status === "live",
    agent = world?.agent;
  const send = async (cmd: Command) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await connection.current!.command(cmd);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось отправить");
      return false;
    } finally {
      setBusy(false);
    }
  };
  const scenario = async (state: Activity) => {
    await send({
      commandId: crypto.randomUUID(),
      agentId: "backend",
      kind: "scenario.set",
      state,
    });
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    const kind = panel === "task" ? "task.create" : "chat.send";
    if (
      await send({
        commandId: crypto.randomUUID(),
        agentId: "backend",
        kind,
        text: text.trim(),
      })
    ) {
      setText("");
      if (kind === "task.create")
        setNotice("Демо-задача добавлена. Реальный агент не запускался.");
    }
  };
  return (
    <main>
      <header className="topbar">
        <a className="brand" href="/" aria-label="DOBROPALM Office">
          <span className="brand-mark">
            d<span>p</span>
          </span>
          <span>
            DOBROPALM <span className="brand-light">/ OFFICE</span>
          </span>
        </a>
        <div className="top-actions">
          <span className="build-tag">ПРОТОТИП 01</span>
          <label className="quality-label">
            <span className="sr-only">Качество отображения</span>
            <select
              aria-label="Качество отображения"
              value={quality}
              onChange={(e) => setQuality(e.target.value)}
            >
              <option value="balanced">3D · Баланс</option>
              <option value="low">3D · Экономный</option>
              <option value="2d">2D · Без 3D-нагрузки</option>
            </select>
          </label>
        </div>
      </header>
      <section className="office" aria-label="Офис">
        {agent && quality !== "2d" ? (
          <SceneBoundary>
            <Suspense
              fallback={<div className="scene-error">Готовим офис…</div>}
            >
              <Scene
                stale={!live}
                agent={agent}
                interacting={panel !== null}
                onNear={setNear}
                onInteract={open}
                overview={overview}
                low={quality === "low"}
                onMotion={setMotion}
              />
            </Suspense>
          </SceneBoundary>
        ) : quality === "2d" && agent ? (
          <div className="flat-view">
            <div className="flat-grid" />
            <div className="flat-card">
              <span className="eyebrow">РАБОЧЕЕ МЕСТО 01</span>
              <div className="flat-monogram">
                B<span>↗</span>
              </div>
              <h1>Backend</h1>
              <p>
                {LABELS[agent.state]} <span className="mock-pill">MOCK</span>
              </p>
              <button className="primary" onClick={open}>
                Открыть рабочее место ↗
              </button>
            </div>
          </div>
        ) : (
          <div className="scene-error">
            {status === "offline"
              ? "Gateway недоступен. Переподключаемся…"
              : "Соединяемся с офисом…"}
          </div>
        )}
        <div className="room-heading">
          <span className="eyebrow">DOBROPALM VIRTUAL OFFICE</span>
          <h1>
            Рабочее пространство<span>01</span>
          </h1>
          <p>Один агент. Полный путь взаимодействия.</p>
        </div>
        <div className="connection">
          <span className={`dot ${live ? "live" : ""}`} />
          <span>
            {live
              ? "Gateway подключён"
              : status === "connecting"
                ? "Подключение…"
                : "Связь потеряна"}
          </span>
          <span className="mock-pill">MOCK</span>
        </div>
        <aside className="agent-card">
          <div className="card-overline">
            <span>КОМАНДА</span>
            <span>01 / 12</span>
          </div>
          <button className="agent-summary" onClick={open} disabled={!agent}>
            <span className="avatar">
              B<span className={`dot ${live ? "live" : ""}`} />
            </span>
            <span>
              <strong>Backend</strong>
              <small>{agent ? LABELS[agent.state] : "Нет данных"}</small>
            </span>
            <span className="arrow">↗</span>
          </button>
          <div className="card-divider" />
          <p className="ambient">
            <span>В офисе</span>
            {quality === "2d"
              ? "3D отключено"
              : panel
                ? "взаимодействие с вами"
                : MOTIONS[motion]}
          </p>
          <span className="ambient-note">Движения — только визуализация</span>
        </aside>
        {quality !== "2d" && (
          <button
            className="camera-button"
            onClick={() => setOverview(!overview)}
            aria-pressed={overview}
          >
            <span>⌖</span> {overview ? "За персонажем" : "Обзор офиса"}
          </button>
        )}
        {quality !== "2d" && near && !panel && (
          <button className="interact-prompt" onClick={open}>
            <kbd>E</kbd>
            <span>Поговорить с Backend</span>
            <span>↗</span>
          </button>
        )}
        {quality !== "2d" && (
          <div className="controls">
            <span>
              <kbd>W</kbd>
              <span className="key-row">
                <kbd>A</kbd>
                <kbd>S</kbd>
                <kbd>D</kbd>
              </span>
            </span>
            <span>Перемещение</span>
            <i />
            <span className="mouse-icon">↔</span>
            <span>
              Зажмите мышь
              <br />
              для поворота камеры
            </span>
          </div>
        )}
        <div className="room-coordinate">
          01 — ENGINEERING
          <br />
          <span>Дневной свет · 30 FPS максимум</span>
        </div>
      </section>
      <footer className="scenario-bar">
        <div className="scenario-title">
          <span className="mock-indicator" />
          <div>
            <strong>Демонстрационный сигнал</strong>
            <small>Управляет Gateway. LLM не вызывается.</small>
          </div>
        </div>
        <div className="scenario-buttons">
          {(["CODING", "TESTING", "WAITING", "IDLE"] as Activity[]).map((s) => (
            <button
              key={s}
              disabled={!live || busy}
              className={agent?.state === s ? "selected" : ""}
              onClick={() => void scenario(s)}
            >
              {LABELS[s]}
            </button>
          ))}
          <label>
            <span className="sr-only">Другие состояния</span>
            <select
              aria-label="Другие состояния"
              disabled={!live || busy}
              value=""
              onChange={(e) => void scenario(e.target.value as Activity)}
            >
              <option value="" disabled>
                Ещё…
              </option>
              {STATES.map((s) => (
                <option key={s} value={s}>
                  {LABELS[s]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <span className="sequence">
          EVENT {String(world?.seq ?? 0).padStart(3, "0")}
        </span>
      </footer>
      {(error || notice) && (
        <div
          className={`toast ${error ? "error" : ""}`}
          role={error ? "alert" : "status"}
        >
          {error || notice}
          <button
            aria-label="Закрыть уведомление"
            onClick={() => {
              setError("");
              setNotice("");
            }}
          >
            ×
          </button>
        </div>
      )}
      {panel && agent && (
        <div
          className="panel-layer"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setPanel(null);
              return;
            }
            if (e.key === "Tab") {
              const targets = Array.from(
                e.currentTarget.querySelectorAll<HTMLElement>(
                  'button:not(:disabled),input,textarea,select,[tabindex="0"]',
                ),
              );
              const first = targets[0],
                last = targets.at(-1);
              if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last?.focus();
              } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first?.focus();
              }
            }
          }}
        >
          <button
            className="scrim"
            aria-label="Закрыть инспектор"
            onClick={() => setPanel(null)}
          />
          <section
            className="inspector"
            role="dialog"
            aria-modal="true"
            aria-labelledby="agent-title"
          >
            <div className="inspector-top">
              <span className="eyebrow">РАБОЧЕЕ МЕСТО / 01</span>
              <button
                ref={closeButton}
                className="close"
                onClick={() => setPanel(null)}
                aria-label="Закрыть инспектор"
              >
                ×
              </button>
            </div>
            <div className="profile">
              <span className="avatar large">B</span>
              <div>
                <h2 id="agent-title">Backend</h2>
                <p>{agent.role}</p>
              </div>
            </div>
            <div className="status-line">
              <span className={`dot ${live ? "live" : ""}`} />
              <strong>
                {live ? LABELS[agent.state] : "Последнее известное состояние"}
              </strong>
              <span className="mock-pill">MOCK</span>
            </div>
            {!live && (
              <p className="offline-note">
                Соединение потеряно. Данные могут быть устаревшими; отправка
                отключена.
              </p>
            )}
            <nav className="tabs" aria-label="Рабочее место">
              {(
                [
                  ["inspect", "Обзор"],
                  ["chat", "Диалог"],
                  ["task", "Задача"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  aria-current={panel === id ? "page" : undefined}
                  onClick={() => {
                    setPanel(id);
                    setText("");
                  }}
                >
                  {label}
                </button>
              ))}
            </nav>
            {panel === "inspect" ? (
              <div className="panel-scroll">
                <span className="eyebrow">ТЕКУЩАЯ ЗАДАЧА</span>
                <h3>{agent.task ?? "Активной задачи нет"}</h3>
                <p className="summary-text">{agent.summary}</p>
                <dl className="details">
                  <dt>Проект</dt>
                  <dd>{agent.project ?? "Нет данных"}</dd>
                  <dt>Статус</dt>
                  <dd>
                    <code>{agent.state}</code>
                  </dd>
                  <dt>Файл</dt>
                  <dd>
                    <code>{agent.currentFile ?? "Нет данных"}</code>
                  </dd>
                  <dt>Ветка</dt>
                  <dd>
                    <code>{agent.branch ?? "Нет данных"}</code>
                  </dd>
                  <dt>Репозиторий</dt>
                  <dd>{agent.repository ?? "Не подключён"}</dd>
                  <dt>Прогресс</dt>
                  <dd>
                    {agent.progress === null
                      ? "Не сообщён"
                      : `${Math.round(agent.progress * 100)}%`}
                  </dd>
                  <dt>Тесты</dt>
                  <dd>
                    {agent.tests
                      ? `${agent.tests.passed} успешно · ${agent.tests.failed} ошибок`
                      : "Нет результатов"}
                  </dd>
                </dl>
                {agent.blocker && (
                  <div className="blocker">{agent.blocker}</div>
                )}
                <div className="activity-heading">
                  <span className="eyebrow">ПОСЛЕДНИЕ СОБЫТИЯ</span>
                  <span>{world?.actions.length ?? 0}</span>
                </div>
                {world?.actions.length ? (
                  <ol className="activity-list">
                    {world.actions.map((a) => (
                      <li key={a.id}>
                        <span className="activity-dot" />
                        <div>
                          <strong>{LABELS[a.state]}</strong>
                          <p>{a.summary}</p>
                          <time>{time(a.at)}</time>
                        </div>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="empty">
                    Измените демонстрационный сигнал внизу, чтобы увидеть
                    события.
                  </p>
                )}
                <button
                  className="primary full"
                  onClick={() => setPanel("chat")}
                >
                  Начать диалог ↗
                </button>
              </div>
            ) : (
              <div className="conversation">
                <p className="mock-note">
                  {panel === "chat"
                    ? "Прямой диалог с демонстрационным Backend. Ответ фиксированный, без LLM."
                    : "Создание демонстрационной задачи. Реальным агентам ничего не отправляется."}
                </p>
                {panel === "chat" ? (
                  <div className="messages" aria-live="polite">
                    {world?.messages.length ? (
                      world.messages.map((m) => (
                        <div key={m.id} className={`message ${m.speaker}`}>
                          <span>
                            {m.speaker === "user" ? "Вы" : "Backend · MOCK"}{" "}
                            <time>{time(m.at)}</time>
                          </span>
                          <p>{m.text}</p>
                        </div>
                      ))
                    ) : (
                      <div className="chat-empty">
                        <span>↗</span>
                        <h3>Обратитесь к Backend</h3>
                        <p>
                          Сообщение пройдёт через Gateway напрямую к выбранному
                          агенту.
                        </p>
                      </div>
                    )}
                    <div ref={chatEnd} />
                  </div>
                ) : (
                  <div className="task-help">
                    <h3>Что нужно сделать?</h3>
                    <p>
                      Задача появится у Backend со статусом «Ожидает решения».
                    </p>
                  </div>
                )}
                <form onSubmit={submit}>
                  <label className="sr-only" htmlFor="message">
                    {panel === "chat" ? "Сообщение Backend" : "Описание задачи"}
                  </label>
                  <textarea
                    id="message"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    maxLength={panel === "chat" ? 800 : 200}
                    rows={3}
                    placeholder={
                      panel === "chat"
                        ? "Напишите сообщение…"
                        : "Кратко опишите задачу…"
                    }
                    disabled={!live || busy}
                  />
                  <div className="compose-bottom">
                    <span>
                      {text.length} / {panel === "chat" ? 800 : 200}
                    </span>
                    <button
                      className="primary"
                      disabled={!live || busy || !text.trim()}
                    >
                      {busy
                        ? "Отправка…"
                        : panel === "chat"
                          ? "Отправить ↗"
                          : "Создать задачу ↗"}
                    </button>
                  </div>
                </form>
              </div>
            )}
            <div className="panel-bottom">
              <span className={`dot ${live ? "live" : ""}`} />
              <span>
                {live ? "Синхронизировано" : "Устаревшие данные"} ·{" "}
                {Math.max(
                  0,
                  Math.floor((now - Date.parse(agent.updatedAt)) / 1000),
                )}{" "}
                с после события
              </span>
              <code>#{world?.seq}</code>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
