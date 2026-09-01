import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { isTabNavKey, nextTabIndex, TABS, type TabKey } from "./lib/tabnav";
import { tg } from "./lib/tg";
import ToastHost from "./components/Toast";
import { onState, type ConnState } from "./lib/sse";

const Dashboard = lazy(() => import("./pages/Dashboard"));
const Tasks = lazy(() => import("./pages/Tasks"));
const Approvals = lazy(() => import("./pages/Approvals"));
const Agents = lazy(() => import("./pages/Agents"));
const Logs = lazy(() => import("./pages/Logs"));
const Wiki = lazy(() => import("./pages/Wiki"));
const Permissions = lazy(() => import("./pages/Permissions"));
const Settings = lazy(() => import("./pages/Settings"));
const Mac = lazy(() => import("./pages/Mac"));

const APP_NAME = "AI Agents";

/**
 * Подпись у индикатора связи. Раньше в `title`/`aria-label` уезжало сырое
 * значение состояния («связь: reconnecting»), то есть строка на английском из
 * внутреннего типа. Скринридер зачитывает её вслух.
 */
const CONN_LABEL: Record<ConnState, string> = {
  open: "есть",
  connecting: "подключение",
  reconnecting: "переподключение",
  closed: "нет",
  unauthorized: "сессия истекла",
};

function Fallback() {
  return <div style={{ padding: 16, color: "#888" }}>Загрузка…</div>;
}

export default function App() {
  const [tab, setTab] = useState<TabKey>("dashboard");
  const [userName, setUserName] = useState<string>("");
  const [conn, setConn] = useState<ConnState>("closed");
  // M4 — offline indicator.
  const [online, setOnline] = useState<boolean>(
    typeof navigator === "undefined" ? true : navigator.onLine !== false,
  );

  // Прокручиваемый таб-бар: держим активную вкладку в зоне видимости, чтобы
  // крайние (Mac/Настройки) были доступны и подъезжали при навигации.
  const navRef = useRef<HTMLElement | null>(null);

  useEffect(() => onState(setConn), []);

  useEffect(() => {
    const nav = navRef.current;
    const el = nav?.querySelector<HTMLButtonElement>(`#tab-${tab}`);
    el?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
    // Roving tabindex: фокусируемая кнопка ровно одна, поэтому стрелка обязана
    // переносить и фокус — иначе он остаётся на прежней кнопке (уже с
    // tabIndex=-1), следующее нажатие считает индекс от неё же и навигация
    // застревает на соседней вкладке. Забираем фокус только если он уже внутри
    // таб-бара: при клике мышью и на старте приложения его трогать нельзя.
    if (nav && el && nav.contains(document.activeElement) && document.activeElement !== el) {
      el.focus();
    }
  }, [tab]);

  // Sync document.title to the active tab so it's visible in browser history,
  // task switchers, and tabs (mostly for non-Telegram contexts).
  useEffect(() => {
    const cur = TABS.find((t) => t.key === tab);
    document.title = cur ? `${APP_NAME} · ${cur.label}` : APP_NAME;
  }, [tab]);

  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  const showReconnecting =
    online && (conn === "reconnecting" || conn === "connecting");

  useEffect(() => {
    const w = tg();
    if (w) {
      try {
        w.ready?.();
        w.expand?.();
        const u = w.initDataUnsafe?.user;
        if (u) {
          setUserName(
            [u.first_name, u.last_name].filter(Boolean).join(" ") ||
              u.username ||
              "",
          );
        }
      } catch {}
    }
  }, []);

  return (
    <div className="app">
      {!online && (
        <div
          role="status"
          style={{
            background: "#c0392b",
            color: "#fff",
            padding: "6px 12px",
            textAlign: "center",
            fontSize: 13,
          }}
        >
          {"\u{1F50C} Нет связи"}
        </div>
      )}
      {conn === "unauthorized" && (
        <div
          role="alert"
          style={{
            background: "#c0392b",
            color: "#fff",
            padding: "6px 12px",
            textAlign: "center",
            fontSize: 13,
          }}
        >
          Сессия Telegram истекла — обновления не приходят. Закройте и откройте
          приложение заново.
        </div>
      )}
      {showReconnecting && (
        <div
          role="status"
          style={{
            background: "#d4ac0d",
            color: "#1c1c1c",
            padding: "4px 12px",
            textAlign: "center",
            fontSize: 12,
          }}
        >
          Переподключение…
        </div>
      )}
      <header className="header">
        <h1>AI Agents</h1>
        <div className="header-right">
          <span
            className="sse-dot"
            title={`связь: ${CONN_LABEL[conn]}`}
            aria-label={`связь: ${CONN_LABEL[conn]}`}
            role="status"
            aria-live="polite"
          >
            {conn === "open"
              ? "\u{1F7E2}"
              : conn === "reconnecting" || conn === "connecting"
                ? "\u{1F7E1}"
                : "\u{1F534}"}
          </span>
          {userName && <div className="user">{userName}</div>}
        </div>
      </header>
      <main className="content" role="tabpanel" id={`tab-panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        <Suspense fallback={<Fallback />}>
          {tab === "dashboard" && <Dashboard onNav={setTab} />}
          {tab === "tasks" && <Tasks />}
          {tab === "approvals" && <Approvals />}
          {tab === "agents" && <Agents />}
          {tab === "perms" && <Permissions />}
          {tab === "logs" && <Logs />}
          {tab === "wiki" && <Wiki />}
          {tab === "settings" && <Settings />}
          {tab === "mac" && <Mac />}
          {/* Ветки «страница не найдена» здесь нет и быть не может: `tab` —
              это TabKey, других значений в него не попадает, а ветка на
              каждый ключ union'а есть выше. Раньше ветка была — с крупным
              «404» и кнопкой «На главную», — но довести до неё могло только
              приведение пропа `onNav` к `any`, единственная в файле дыра в
              типах. Дыру закрыли, мёртвую разметку убрали; полноту веток
              стережёт тест (audit-2026-08-21-tab-404-unreachable). */}
        </Suspense>
      </main>
      <nav className="tabs" role="tablist" aria-label="Навигация по разделам" ref={navRef}>
        {TABS.map((t) => (
          <button
            key={t.key}
            id={`tab-${t.key}`}
            className={tab === t.key ? "active" : ""}
            onClick={() => setTab(t.key)}
            role="tab"
            aria-selected={tab === t.key}
            aria-controls={`tab-panel-${t.key}`}
            tabIndex={tab === t.key ? 0 : -1}
            onKeyDown={(e) => {
              if (!isTabNavKey(e.key)) return;
              e.preventDefault();
              const currentIndex = TABS.findIndex((x) => x.key === t.key);
              const nextIndex = nextTabIndex(e.key, currentIndex, TABS.length);
              if (nextIndex !== currentIndex) setTab(TABS[nextIndex].key);
            }}
          >
            <span className="icon" aria-hidden="true">{t.icon}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </nav>
      <ToastHost />
    </div>
  );
}
