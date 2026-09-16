import { watchMacHistory } from "../lib/mac-refresh";
import { nativePanel } from "../lib/native";
import { useEffect, useRef, useState } from "react";
import { api, formatApiError } from "../lib/api";
import type { AgentAction } from "../lib/types";
import { subscribe as sseSubscribe } from "../lib/sse";
import { SkeletonList } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { ErrorBox } from "../components/ErrorBox";
import {
  macOutputView,
  macStatusBadge,
  stopAllConfirmText,
  toMacSession,
  type MacSession,
} from "../lib/mac-session";
import { adminFromAutonomy } from "../lib/admin";
import { toast } from "../lib/tg";
import { ellipsize } from "../lib/text";

export default function Mac() {
  const [provider, setProvider] = useState<"claude" | "codex">("claude");
  const [allowFallback, setAllowFallback] = useState(true);
  const [project, setProject] = useState("");
  const [prompt, setPrompt] = useState("");
  const [launchStatus, setLaunchStatus] = useState("");
  const [launchBusy, setLaunchBusy] = useState(false);
  const launching = useRef(false);
  async function startSession(event: React.FormEvent) {
    event.preventDefault();
    if (launching.current) return;
    launching.current = true; setLaunchBusy(true); setLaunchStatus("");
    try {
      const result = await (window as any).webkit.messageHandlers.panel.postMessage({macStart:{provider,allowFallback:provider === "claude" && allowFallback,project:project.trim(),prompt:prompt.trim()}});
      if (result?.ok !== true) throw new Error("Не удалось передать запрос");
      setPrompt(""); setLaunchStatus("Запрос добавлен в чат. Там появятся ответ и необходимое подтверждение.");
    } catch (error) { setLaunchStatus(formatApiError(error)); }
    finally { launching.current = false; setLaunchBusy(false); }
  }
  const [sessions, setSessions] = useState<MacSession[]>([]);
  const [history, setHistory] = useState<AgentAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [canStop, setCanStop] = useState(false);

  useEffect(() => watchMacHistory(
    () => loadMacHistory(false), sseSubscribe, () => !document.hidden,
  ), []);

  // Отдельно от загрузки списка: права — не то, ради чего открывают вкладку,
  // и их запрос не должен ни ронять историю сессий, ни всплывать над ней.
  // Ровно как на Tasks.tsx.
  useEffect(() => {
    api
      .autonomy()
      .then((r) => setCanStop(adminFromAutonomy(r)))
      .catch(() => setCanStop(adminFromAutonomy(null)));
  }, []);

  async function loadMacHistory(showLoading = true) {
    setError(null);
    if (showLoading) setLoading(true);
    
    try {
      // Fetch all MAC_RUN_CLAUDE actions from history
      const { actions } = await api.actions({
        type: "MAC_RUN_CLAUDE",
        limit: 50,
      });

      setHistory(actions);

      // Transform actions into Mac sessions. A single logical run produces TWO
      // action rows — a `pending_approval` placeholder (gated, NOT yet running
      // on the Mac) and the real execution after approval — so we drop the
      // non-execution statuses to avoid showing one run as two sessions.
      // Аудит 2026-08-10: `denied`/`completed`/`failed` тут не бывает — вокабуляр
      // статусов — закрытый набор `ACTION_STATUSES` в lib/audit.ts. Ветки под них были
      // мёртвыми; работу тянули `ok` и `error`, поэтому вреда не было, но и
      // защиты, которую они изображали, тоже.
      // `approved` — та же гейтовая строка, закрытая решением (аудит 2026-09-14).
      const NON_RUN = new Set<string>(["pending_approval", "forbidden", "rate_limited", "approved"]);
      const macSessions: MacSession[] = actions
        .filter(action => !NON_RUN.has(action.status))
        .map(toMacSession);

      setSessions(macSessions);
    } catch (err: any) {
      setError(formatApiError(err));
      console.error("[Mac] Load error:", err);
    } finally {
      setLoading(false);
    }
  }

  /**
   * Остановка на Mac — одна на всех.
   *
   * Кнопка стояла в карточке сессии и называлась «Остановить», а `api.macStop()`
   * аргументов не принимает: демону уходит один сигнал `stop`, после которого
   * падают и все ожидающие операции. Эта ручка останавливает все процессы,
   * поэтому кнопка расположена над списком и явно называет область действия.
   */
  async function handleStopAll(running: number) {
    if (!window.confirm(stopAllConfirmText(running))) return;
    setStopping(true);
    try {
      await api.macStop();
      await loadMacHistory();
    } catch (err: any) {
      // Не setError: он на этой странице — ранний возврат с ErrorBox вместо
      // всего содержимого. Неудачная остановка (403, 503 mac_offline) стирала
      // список сессий вместе с их выводом. Остальные страницы Mini App пишут
      // такие отказы в тост.
      toast(formatApiError(err), "error");
    } finally {
      setStopping(false);
    }
  }

  /**
   * Карточка сессии выбирает, чей вывод показать. Раз она интерактивна —
   * она интерактивна и с клавиатуры: `div` с одним `onClick` в Telegram
   * WebView недостижим ни табом, ни VoiceOver.
   */
  function selectProps(id: string) {
    return {
      role: "button" as const,
      tabIndex: 0,
      "aria-pressed": selectedSession === id,
      onClick: () => setSelectedSession(id),
      onKeyDown: (e: { key: string; preventDefault: () => void }) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setSelectedSession(id);
        }
      },
    };
  }

  function formatTimestamp(ts: number): string {
    try {
      return new Date(ts).toLocaleString("ru-RU", {
        day: "2-digit",
        month: "2-digit", 
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return String(ts);
    }
  }

  function getStatusBadge(status: MacSession["status"]) {
    const badge = macStatusBadge(status);
    return (
      <span
        className="status-badge"
        style={{
          background: badge.background,
          color: badge.color,
          padding: "2px 8px",
          borderRadius: 4,
          fontSize: 12,
          fontWeight: 500,
        }}
      >
        {badge.text}
      </span>
    );
  }

  const runningCount = sessions.filter((s) => s.status === "running").length;

  // Аудит 2026-08-29: здесь стояли ранние возвраты `if (loading)` и
  // `if (error)`. Оба уносили с экрана единственную точку входа в
  // `POST /api/mac/stop` — ровно тогда, когда она нужна. `handleStopAll` этот
  // урок уже усвоил и пишет свои отказы в тост, а `loadMacHistory` продолжал
  // ставить `setError`: неудача ЧТЕНИЯ истории отбирала право на ЗАПИСЬ.
  // Хуже того, после успешного стопа `handleStopAll` сам зовёт
  // `loadMacHistory`, то есть страница схлопывалась в скелет, а при 429 от
  // собственного всплеска — в ErrorBox без кнопки.
  //
  // Ручка `/api/mac/stop` от `/api/actions` не зависит вовсе. Значит и кнопка
  // не должна: скелет и ошибка теперь занимают только список.
  return (
    <div className="page">
      <div className="page-header">
        {!nativePanel && <h2>Сессии на Mac</h2>}
        <p style={{ color: "var(--hint)", margin: 0 }}>
          История запусков Claude Code и Codex на Mac
        </p>
      </div>

      {nativePanel && <form onSubmit={startSession} className="mac-launch-form">
        <label>Исполнитель<select value={provider} onChange={e => setProvider(e.currentTarget.value as "claude" | "codex")} disabled={launchBusy}><option value="claude">Claude Code</option><option value="codex">Codex</option></select></label>
        <label style={{display:"flex", flexDirection:"row", alignItems:"center", gap:10}}><input type="checkbox" checked={provider === "claude" && allowFallback} onChange={e => setAllowFallback(e.currentTarget.checked)} disabled={launchBusy || provider === "codex"} style={{width:22, minHeight:44, flexShrink:0}} />Разрешить Codex, если Claude Code недоступен до запуска</label>
        {provider === "codex" && <p>Переход с Codex на Claude Code требует отдельного выбора и подтверждения.</p>}
        <label>Проект на Mac<input value={project} onChange={e => setProject(e.currentTarget.value)} maxLength={500} required placeholder="Папка проекта или его название" /></label>
        <label>Задача<textarea value={prompt} onChange={e => setPrompt(e.currentTarget.value)} maxLength={4000} required rows={4} placeholder="Что нужно сделать в этой сессии?" /></label>
        <button type="submit" disabled={launchBusy || !project.trim() || !prompt.trim()}>{launchBusy ? "Передаём задачу…" : "Запустить сессию"}</button>
        {launchStatus && <p role="status">{launchStatus}</p>}
      </form>}
      {/*
        Аварийный стоп стоит здесь, а не в списке сессий, и не спрашивает,
        сколько их сейчас активно.

        Аудит 2026-08-28: условие было `canStop && runningCount > 0`, а
        ненулевым `runningCount` стать не мог — строка в `agent_actions`
        появлялась уже терминальной, после `await dispatchAction`. Кнопка не
        рисовалась ни в одном состоянии, и вместе с ней была недостижима вся
        ручка `/api/mac/stop` (ca58aefc).

        Аудит 2026-09-11: посылка с тех пор умерла — `openInflightAudit` пишет
        строку `attempted` ДО обращения наружу, `finalizeActionRow` доводит её
        до `ok`/`error` через UPDATE, `toMacSession` переводит всё нетерминальное
        в «выполняется», а `NON_RUN` на этой странице `attempted` не отсеивает.
        То есть идущий запуск панель теперь как раз видит.

        Решение от этого не меняется, но по другой причине: видимость запуска —
        не гарантия. Строка «в полёте» пишется по принципу «не легло — работаем
        дальше» (её отказ намеренно НЕ отменяет действие), а список тут —
        снимок последних строк журнала, обновляемый по таймеру. Значит
        «`runningCount` равен нулю» не означает «останавливать нечего», и гейт
        у аварийного стопа остаётся ровно один — админский, тот же, что у самой
        ручки (`requireAdmin` в ветке `/api/mac/stop`, lib/miniapp-server.ts).
      */}
      {canStop && (
        <button
          onClick={() => handleStopAll(runningCount)}
          style={{
            padding: "6px 10px",
            marginBottom: 12,
            border: "1px solid #e74c3c",
            borderRadius: 4,
            background: "transparent",
            color: "#e74c3c",
            fontSize: 13,
            cursor: "pointer",
          }}
          disabled={stopping}
        >
          {stopping ? "Остановка…" : "Остановить всё"}
        </button>
      )}

      {loading ? (
        <SkeletonList />
      ) : error ? (
        <ErrorBox message={error} onRetry={loadMacHistory} />
      ) : sessions.length === 0 ? (
        <EmptyState
          icon="💻"
          title="Пока нет сессий на Mac"
          hint="Запущенные сессии и их результаты появятся здесь."
        />
      ) : (
        <div className="mac-container">
          {/* Session List */}
          <div className="mac-sessions">
            <h3>Активные сессии</h3>

            {sessions.filter(s => s.status === "running").map(session => (
              <div 
                key={session.id}
                className={`mac-session-card ${selectedSession === session.id ? 'selected' : ''}`}
                {...selectProps(session.id)}
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  padding: 12,
                  marginBottom: 8,
                  cursor: "pointer",
                  backgroundColor:
                    selectedSession === session.id
                      ? "var(--secondary-bg)"
                      : "var(--bg)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 500, marginBottom: 4 }}>
                      {session.project}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--hint)", marginBottom: 8 }}>
                      {session.provider === "codex" ? "Codex" : session.provider === "claude" ? "Claude Code" : "—"} • {session.mode} • {formatTimestamp(session.createdAt)}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--hint)" }}>
                      {ellipsize(session.prompt, 100)}
                    </div>
                  </div>
                  <div style={{ marginLeft: 12 }}>
                    {getStatusBadge(session.status)}
                  </div>
                </div>
                
              </div>
            ))}

            {runningCount === 0 && (
              <div style={{ color: "var(--hint)", fontSize: 14, padding: 16, textAlign: "center" }}>
                В загруженной истории нет выполняющихся сессий.
              </div>
            )}
          </div>

          {/* Session Output */}
          {selectedSession && (() => {
            const view = macOutputView(
              sessions.find((s) => s.id === selectedSession),
            );
            return (
            <div className="mac-output">
              <h3>Вывод сессии</h3>

              <div
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  backgroundColor: "var(--secondary-bg)",
                  height: 300,
                  overflow: "auto",
                  padding: 12,
                  fontFamily: "Monaco, Consolas, monospace",
                  fontSize: 12,
                  whiteSpace: "pre-wrap",
                }}
              >
                {view.note ? (
                  <div style={{ color: "var(--hint)" }}>{view.note}</div>
                ) : (
                  view.lines.map((chunk, i) => (
                    <div key={i} style={{ marginBottom: 2 }}>
                      {chunk}
                    </div>
                  ))
                )}
              </div>
            </div>
            );
          })()}

          {/* History */}
          <div className="mac-history">
            <h3>История запусков</h3>
            
            {sessions.filter(s => s.status !== "running").map(session => (
              <div
                key={session.id}
                className={`mac-session-card ${selectedSession === session.id ? 'selected' : ''}`}
                {...selectProps(session.id)}
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  padding: 12,
                  marginBottom: 8,
                  cursor: "pointer",
                  backgroundColor:
                    selectedSession === session.id
                      ? "var(--secondary-bg)"
                      : "var(--bg)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 500, marginBottom: 4 }}>
                      {session.project}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--hint)", marginBottom: 8 }}>
                      {session.provider === "codex" ? "Codex" : session.provider === "claude" ? "Claude Code" : "—"} • {session.mode} • {formatTimestamp(session.createdAt)}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--hint)" }}>
                      {ellipsize(session.prompt, 150)}
                    </div>
                  </div>
                  <div style={{ marginLeft: 12 }}>
                    {getStatusBadge(session.status)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
