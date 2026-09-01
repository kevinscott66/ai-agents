import { useEffect, useMemo, useState } from "react";
import { api, formatApiError } from "../lib/api";
import type { AgentInfo, Permission } from "../lib/types";
import { haptic, toast } from "../lib/tg";
import { SkeletonList } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { ErrorBox } from "../components/ErrorBox";
import { permissionColumns } from "../lib/action-types";

// Tri-state cell semantics:
//   forbidden  -> allowed=false, requires_approval=false
//   approval   -> allowed=true,  requires_approval=true
//   allowed    -> allowed=true,  requires_approval=false
export type Cell = "forbidden" | "approval" | "allowed";

/**
 * Как ячейка называется словами.
 *
 * Аудит 2026-08-14: значение ячейки передавалось одним символом (`✓`, `?`,
 * `·`) плюс цветом фона. Символ без подписи скринридер читает как есть, а
 * цвет он не читает вовсе — то есть смысл ячейки до него не доходил. Плюс
 * `·` от `?` в таблице 12×N на глаз отличается плохо.
 */
export const CELL_LABELS: Record<Cell, string> = {
  forbidden: "запрещено",
  approval: "нужен аппрув",
  allowed: "разрешено",
};

function cellOf(p: Permission | undefined): Cell {
  if (!p || !p.allowed) return "forbidden";
  return p.requires_approval ? "approval" : "allowed";
}

function nextCell(c: Cell): Cell {
  if (c === "forbidden") return "allowed";
  if (c === "allowed") return "approval";
  return "forbidden";
}

function cellSymbol(c: Cell): string {
  if (c === "allowed") return "✓";
  if (c === "approval") return "?";
  return "·";
}

export default function Permissions() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [perms, setPerms] = useState<Permission[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [readonly, setReadonly] = useState(false);
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const [ag, pm] = await Promise.all([
        api.agents(),
        api.permissions().catch((e: any) => {
          if (e.status === 403) {
            setReadonly(true);
            return { permissions: [] as Permission[] };
          }
          throw e;
        }),
      ]);
      setAgents(ag.agents);
      setPerms(pm.permissions);
    } catch (e: any) {
      setErr(formatApiError(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const actionTypes = useMemo(() => permissionColumns(perms), [perms]);

  const byKey = useMemo(() => {
    const m = new Map<string, Permission>();
    for (const p of perms) m.set(`${p.agentKey}:${p.actionType}`, p);
    return m;
  }, [perms]);

  async function cycleCell(agentKey: string, actionType: string) {
    if (readonly) {
      toast("Только для админа", "error");
      return;
    }
    const k = `${agentKey}:${actionType}`;
    const current = cellOf(byKey.get(k));
    const next = nextCell(current);
    const allowed = next !== "forbidden";
    const requires_approval = next === "approval";
    setBusy((m) => ({ ...m, [k]: true }));
    try {
      const r = await api.setPermission({
        agentKey,
        actionType,
        allowed,
        requires_approval,
      });
      haptic("success");
      // Аудит 2026-08-28: право выдано, но действует не везде — SEMI_AUTO_RISKY
      // поднимает пол до апрува в чатах с автономией semi_auto, а это дефолт.
      // Раньше ячейка просто перекрашивалась в «авто», и узнать правду можно
      // было только по неприходящим сообщениям. `/grant` про это пишет всегда.
      // Тост живёт дольше обычного: это текст, который надо прочитать.
      if (r.caveat) toast(r.caveat, "info", 6000);
      setPerms((cur) => {
        const idx = cur.findIndex(
          (p) => p.agentKey === agentKey && p.actionType === actionType,
        );
        const updated: Permission = {
          agentKey,
          actionType,
          allowed,
          requires_approval,
        };
        if (idx === -1) return [...cur, updated];
        const copy = cur.slice();
        copy[idx] = updated;
        return copy;
      });
    } catch (e: any) {
      haptic("error");
      if (e.status === 403) {
        setReadonly(true);
        toast("Только для админа", "error");
      } else {
        toast(formatApiError(e), "error");
      }
    } finally {
      setBusy((m) => {
        const n = { ...m };
        delete n[k];
        return n;
      });
    }
  }

  if (loading && perms.length === 0 && !err) {
    return (
      <div>
        <SkeletonList rows={6} />
      </div>
    );
  }
  if (err) return <ErrorBox message={err} onRetry={() => load()} />;
  if (readonly && perms.length === 0) {
    return (
      <div>
        <div className="pending-count" style={{ background: "#6a737d" }}>
только просмотр
        </div>
        <div className="empty">
          Только для админа — права не видны обычным пользователям.
        </div>
      </div>
    );
  }

  return (
    <div>
      {readonly && (
        <div className="pending-count" style={{ background: "#6a737d" }}>
только просмотр
        </div>
      )}
      <div style={{ fontSize: 12, color: "var(--hint)", marginBottom: 8 }}>
Нажми на ячейку, чтобы переключить: · запрещено → ✓ разрешено → ? аппрув → ·
      </div>
      {/* Колонки теперь есть всегда — их даёт список известных типов, а не
          выданные строки. Пусто может быть только по строкам: без агентов
          рисовать нечего. */}
      {agents.length === 0 ? (
        <EmptyState
          icon="⚙"
          title="Агентов пока нет"
          hint="Матрица прав появится, как только в команде будет хотя бы одна роль."
        />
      ) : null}
      <div className="perm-matrix-wrap">
        <table className="perm-matrix">
          <thead>
            <tr>
              <th>агент</th>
              {actionTypes.map((at) => (
                <th key={at} title={at}>
                  {at.replace(/_/g, " ")}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.key}>
                <td className="agent-cell">{a.key}</td>
                {actionTypes.map((at) => {
                  const k = `${a.key}:${at}`;
                  const cell = cellOf(byKey.get(k));
                  const b = !!busy[k];
                  return (
                    <td
                      key={at}
                      className={`perm-cell ${cell}`}
                      title={`${a.key} · ${at} = ${CELL_LABELS[cell]}`}
                    >
                      {/* Клик и клавиатура — на кнопке: интерактивный <td>
                          недостижим табом, и роль его тоже не объявляет. */}
                      <button
                        type="button"
                        className="perm-cell-btn"
                        disabled={b}
                        aria-label={`${a.key} · ${at}: ${CELL_LABELS[cell]}. Нажми, чтобы стало «${CELL_LABELS[nextCell(cell)]}»`}
                        onClick={() => cycleCell(a.key, at)}
                      >
                        {b ? "⏳" : cellSymbol(cell)}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
