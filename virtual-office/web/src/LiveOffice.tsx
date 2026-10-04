import { useEffect, useRef, useState } from "react";
import { LiveClient, type LiveSnapshot } from "./live-client";
import { ROSTER, type RoleId } from "./roster";
type Message = { role: string; text: string; agentKey?: string };
export function LiveOffice({
  selected,
  onClose,
  onSnapshot,
}: {
  selected: RoleId | null;
  onClose: () => void;
  onSnapshot: (value: LiveSnapshot | null) => void;
}) {
  const client = useRef(new LiveClient()),
    epoch = useRef(0);
  const [paired, setPaired] = useState(false),
    [code, setCode] = useState(""),
    [error, setError] = useState(""),
    [draft, setDraft] = useState(""),
    [messages, setMessages] = useState<Message[]>([]),
    [sending, setSending] = useState(false),
    [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [pending, setPending] = useState<{
    id: string;
    role: RoleId;
    text: string;
    conversationId: string;
  } | null>(null);
  const [approvals, setApprovals] = useState<
    {
      id: string;
      action_type: string;
      payload: unknown;
      status: string;
      redacted?: boolean;
    }[]
  >([]);
  const [decisions, setDecisions] = useState<Record<string, string>>({});
  const decisionsRef = useRef(new Set<string>());
  const dialogs = useRef<Partial<Record<RoleId, string>>>({});
  const member = ROSTER.find((m) => m.id === selected),
    current = snapshot?.agents.find((a) => a.agentId === selected);
  const disconnect = () => {
    epoch.current++;
    client.current.clear();
    setPaired(false);
    setSending(false);
    setDraft("");
    setCode("");
    setError("");
    setSnapshot(null);
    onSnapshot(null);
    setMessages([]);
    setApprovals([]);
    setDecisions({});
    decisionsRef.current.clear();
    setPending(null);
    dialogs.current = {};
  };
  useEffect(
    () => () => {
      epoch.current++;
      client.current.clear();
      onSnapshot(null);
    },
    [onSnapshot],
  );
  useEffect(() => {
    if (!paired) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await client.current.snapshot();
        if (!active) return;
        setSnapshot(value);
        onSnapshot(value);
        for (const a of value.agents)
          if (a.conversationId && !dialogs.current[a.agentId])
            dialogs.current[a.agentId] = a.conversationId;
        setError("");
      } catch (e) {
        if (active) {
          setSnapshot(null);
          onSnapshot(null);
          setError(String(e instanceof Error ? e.message : e));
        }
      } finally {
        if (active) timer = setTimeout(poll, 3000);
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [paired, onSnapshot]);
  useEffect(() => {
    setMessages([]);
    setApprovals([]);
    setDraft("");
    if (!paired || !selected) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const id = dialogs.current[selected];
        if (id) {
          const data = await client.current.request("conversations/" + id);
          if (active) setMessages(data.messages ?? []);
          try {
            const approvals = await client.current.request(
              "conversations/" + id + "/approvals",
            );
            if (active) setApprovals(approvals.approvals ?? []);
          } catch {
            if (active) setApprovals([]);
          }
        }
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (active) timer = setTimeout(poll, 2000);
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [selected, paired]);
  const send = async () => {
    if (
      !selected ||
      (!pending && !draft.trim()) ||
      sending ||
      (pending && pending.role !== selected)
    )
      return;
    const role = selected,
      text = draft.trim(),
      version = epoch.current;
    setSending(true);
    setError("");
    try {
      let conversationId = dialogs.current[role];
      if (!conversationId) {
        conversationId = crypto.randomUUID();
        await client.current.request("conversations", {
          id: conversationId,
          title: "Офис · " + ROSTER.find((m) => m.id === role)!.role,
        });
        if (version !== epoch.current) return;
        dialogs.current[role] = conversationId;
      }
      const request = pending ?? {
        id: crypto.randomUUID(),
        role,
        text,
        conversationId,
      };
      setPending(request);
      await client.current.request("turns", {
        id: request.id,
        text: request.text,
        agentKey: request.role,
        conversationId: request.conversationId,
      });
      if (version !== epoch.current) return;
      setDraft("");
      setPending(null);
    } catch (e) {
      if (version === epoch.current)
        setError(
          (e instanceof Error ? e.message : String(e)) +
            " При неопределённом результате повтор использует тот же ID.",
        );
    } finally {
      if (version === epoch.current) setSending(false);
    }
  };
  return (
    <>
      {!paired ? (
        <section className="live-login">
          <h2>Подключение реальных агентов</h2>
          <p>
            Одноразовый код владельца из команды /pair_native. Ключ остаётся
            только в памяти вкладки.
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setError("");
              try {
                await client.current.pair(code.trim());
                setCode("");
                setPaired(true);
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              }
            }}
          >
            <input
              aria-label="Код подключения"
              type="password"
              autoComplete="off"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              pattern="[a-f0-9]{32}"
              required
            />
            <button className="primary">Подключить</button>
          </form>
          {error && <p role="alert">{error}</p>}
        </section>
      ) : (
        <div className="live-session">
          <span>
            {snapshot ? "Реальная система подключена" : "Нет связи с системой"}
          </span>
          <button onClick={disconnect}>Отключить</button>
          <small>
            Ваши запросы, личные задачи и согласования. Фоновая работа без
            привязки к вам здесь не отображается.
          </small>
          {error && <p role="alert">{error}</p>}
        </div>
      )}
      {paired && member && (
        <div className="panel-layer">
          <button
            className="scrim"
            aria-label="Закрыть живой диалог"
            onClick={onClose}
          />
          <section
            className="inspector"
            role="dialog"
            aria-label={"Диалог: " + member.name}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
            }}
          >
            <div className="inspector-top">
              <span>РЕАЛЬНЫЙ АГЕНТ / {member.role}</span>
              <button
                className="close"
                autoFocus
                onClick={onClose}
                aria-label="Закрыть живой диалог"
              >
                ×
              </button>
            </div>
            <div className="profile">
              <h2>
                {member.name} · {member.role}
              </h2>
            </div>
            <p className="mock-note">
              {current?.available
                ? "Можно отправить сообщение или поручение."
                : "Роль недоступна."}{" "}
              Одновременно выполняется один запрос владельца. Статус отражает
              запросы офиса и приложения.
            </p>
            <div className="conversation">
              <div className="messages">
                {approvals
                  .filter((a) => a.status === "pending")
                  .map((a) => (
                    <article className="approval" key={a.id}>
                      <strong>Подтверждение: {a.action_type}</strong>
                      <pre>{JSON.stringify(a.payload, null, 2)}</pre>
                      <p>
                        {decisions[a.id] ??
                          "Проверьте действие перед подтверждением."}
                      </p>
                      {!a.redacted &&
                        !decisions[a.id] &&
                        (["rejected", "approved"] as const).map((decision) => (
                          <button
                            key={decision}
                            type="button"
                            onClick={async () => {
                              if (decisionsRef.current.has(a.id)) return;
                              decisionsRef.current.add(a.id);
                              setDecisions((d) => ({
                                ...d,
                                [a.id]: "Решение отправляется…",
                              }));
                              const version = epoch.current;
                              try {
                                await client.current.request(
                                  "approvals/" +
                                    encodeURIComponent(a.id) +
                                    "/decide",
                                  { decision },
                                );
                                if (version === epoch.current)
                                  setDecisions((d) => ({
                                    ...d,
                                    [a.id]:
                                      "Решение принято; результат действия появится в истории.",
                                  }));
                              } catch {
                                if (version === epoch.current)
                                  setDecisions((d) => ({
                                    ...d,
                                    [a.id]:
                                      "Результат отправки неизвестен. Автоматического повтора не будет; проверьте историю.",
                                  }));
                              }
                            }}
                          >
                            {decision === "approved"
                              ? "Подтвердить"
                              : "Отклонить"}
                          </button>
                        ))}
                    </article>
                  ))}
                {messages.map((m, i) => (
                  <div
                    className={
                      "message " + (m.role === "user" ? "user" : "agent")
                    }
                    key={i}
                  >
                    <span>
                      {m.role === "user" ? "Вы" : (m.agentKey ?? member.role)}
                    </span>
                    <p>{m.text}</p>
                  </div>
                ))}
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void send();
                }}
              >
                <textarea
                  aria-label="Сообщение реальному агенту"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  maxLength={8000}
                  disabled={sending || !!pending}
                />
                <button
                  className="primary"
                  disabled={
                    sending ||
                    !snapshot ||
                    !current?.available ||
                    (!!pending && pending.role !== selected) ||
                    (!draft.trim() && !pending)
                  }
                >
                  {sending
                    ? "Отправка…"
                    : pending
                      ? "Проверить / повторить тот же запрос"
                      : "Отправить поручение ↗"}
                </button>
                {pending && (
                  <p>
                    Не создавайте повторное поручение, пока не выяснен результат
                    этого запроса.
                  </p>
                )}
              </form>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
