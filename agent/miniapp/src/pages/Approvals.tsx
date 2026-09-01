import { useEffect, useState } from "react";
import { api, formatApiError } from "../lib/api";
import type { Approval } from "../lib/types";
import { haptic, toast } from "../lib/tg";
import { subscribe as sseSubscribe } from "../lib/sse";
import { useLatestRun } from "../lib/stale";
import { SkeletonList } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { ErrorBox } from "../components/ErrorBox";
import { APPROVAL_STATUS_LABELS, label } from "../lib/labels";
import { InterAgentCard, isInterAgentAction } from "../components/InterAgentCard";

interface Group {
  key: string;
  list: Approval[];
}

// T-546: group approvals that came from one logical agent turn (same
// request_id) into a single card; approvals without a request_id stay solo.
function groupApprovals(items: Approval[]): Group[] {
  const order: string[] = [];
  const map = new Map<string, Approval[]>();
  for (const a of items) {
    const key = a.request_id ? `req:${a.request_id}` : `solo:${a.id}`;
    if (!map.has(key)) {
      map.set(key, []);
      order.push(key);
    }
    map.get(key)!.push(a);
  }
  return order.map((key) => ({ key, list: map.get(key)! }));
}

// "DELETE_MESSAGE ×2 · SEND_MESSAGE"
function summarizeTypes(list: Approval[]): string {
  const counts = new Map<string, number>();
  for (const a of list) counts.set(a.action_type, (counts.get(a.action_type) ?? 0) + 1);
  return [...counts.entries()]
    .map(([t, n]) => (n > 1 ? `${t} ×${n}` : t))
    .join(" · ");
}

/**
 * Текст подтверждения одобрения.
 *
 * Аудит 2026-08-10: подтверждения стояли не на той стороне. Отклонение —
 * обратимое и ничего не исполняющее — требовало window.confirm, а для
 * одиночного ещё и второго экрана с полем причины. Одобрение исполнялось
 * с первого тапа, включая «Одобрить все (N)».
 *
 * Между тем одобрение — это и есть исполнение: аппрув стоит ровно на тех
 * действиях, которые уходят наружу (публикация в канал, сообщение в чат,
 * отправка документа). Отменить их нельзя, а промах пальцем по кнопке в
 * Telegram Mini App на телефоне — обычное дело.
 *
 * Экспортируется ради теста: DOM-харнесса у Mini App нет.
 */
export function confirmApproveText(list: Approval[]): string {
  const what = summarizeTypes(list);
  return list.length > 1
    ? `Выполнить ${list.length} действий — ${what}?`
    : `Выполнить ${what}?`;
}

/**
 * Текст ошибки запроса в человеческом виде.
 *
 * `req()` в lib/api.ts кладёт в `message` поле `error` из тела ответа, а если
 * его нет — `HTTP <код>`; сам код дублируется в `status`. Сюда же прилетают и
 * сетевые сбои (`Failed to fetch`), у которых `status` нет вовсе.
 */
export function errorText(e: any): string {
  const msg = typeof e?.message === "string" ? e.message.trim() : "";
  if (msg) return msg;
  return typeof e?.status === "number" ? `HTTP ${e.status}` : "неизвестная ошибка";
}

/**
 * Хвост тоста с причинами отказа. Пусто, если причин не набралось.
 *
 * Аудит 2026-08-21: пакетное решение ловило ошибки как `catch { failed++ }` и
 * причину выбрасывало. Тост «Не удалось: 2 из 5» одинаково выглядел для трёх
 * совершенно разных исходов, а действия у них противоположные:
 *
 *   • 403 — роль лишилась права, повторять бессмысленно;
 *   • 429 — исчерпано ведро рейт-лимита, помогает просто подождать;
 *   • «апрув уже решён» / истёк — повторять нечего, список устарел.
 *
 * Апрув стоит на необратимом действии, и «попробуйте ещё раз» вслепую тут —
 * худший из советов. Показываем до двух разных причин: в пакете обычно либо
 * одна на всех (упёрлись в лимит), либо две (часть истекла, часть прошла).
 */
export function failureSummary(reasons: string[], maxLen = 80): string {
  const uniq: string[] = [];
  for (const r of reasons) {
    const t = (r ?? "").trim();
    if (t && !uniq.includes(t)) uniq.push(t);
  }
  if (uniq.length === 0) return "";
  let out = uniq.slice(0, 2).join("; ");
  if (uniq.length > 2) out += ` и ещё ${uniq.length - 2}`;
  if (out.length > maxLen) out = out.slice(0, maxLen - 1).trimEnd() + "…";
  return out;
}

/**
 * Вернуть в список только те строки, по которым решение не прошло.
 *
 * Аудит 2026-08-28: `decideMany` снимал строки оптимистично, а на любой сбой
 * делал `setItems(snapshot)` — снимком, снятым ДО удаления. Одна ошибка в
 * пакете из пяти возвращала на экран все пять, включая те четыре, чьи
 * действия уже УШЛИ наружу: апрув стоит на публикации в канал, отправке
 * сообщения и документа, и «вернувшаяся» карточка предлагает одобрить их
 * второй раз. Заодно снимок затирал строки, приехавшие по SSE за время
 * пакета: цикл идёт последовательно, по запросу на апрув.
 *
 * Хвостовой `load()` это чинил, но лишь после ответа сервера — на телефоне
 * окно вполне достаточное, чтобы успеть нажать.
 *
 * Порядок берём из снимка (в нём группировка по request_id), объекты — из
 * текущего состояния, если строка в нём есть: оно свежее. Что приехало после
 * снимка — дописываем в хвост, а не теряем.
 *
 * Экспортируется ради теста: DOM-харнесса у Mini App нет.
 */
export function restoreFailed<T extends { id: string }>(
  current: T[],
  snapshot: T[],
  failed: Set<string>,
): T[] {
  const byId = new Map(current.map((x) => [x.id, x]));
  const out: T[] = [];
  for (const row of snapshot) {
    const live = byId.get(row.id);
    if (live) {
      out.push(live);
      byId.delete(row.id);
    } else if (failed.has(row.id)) {
      out.push(row);
    }
  }
  for (const row of current) if (byId.has(row.id)) out.push(row);
  return out;
}

export default function Approvals() {
  const [items, setItems] = useState<Approval[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [rejectingKey, setRejectingKey] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  // decideMany делает свой load() после решений, а то же решение прилетает ещё
  // и событием approval.decided — два запроса в полёте. Ответ, ушедший ДО
  // записи решения в БД, вернёт апрув всё ещё pending; придёт он вторым —
  // только что одобренное действие снова окажется в списке и его предложат
  // одобрить второй раз. Аппрув стоит на необратимом, второго раза быть не
  // должно.
  const beginLoad = useLatestRun();

  async function load() {
    const isCurrent = beginLoad();
    setLoading(true);
    setErr(null);
    try {
      const r = await api.approvals({ status: "pending", limit: 100 });
      if (!isCurrent()) return;
      setItems(r.approvals);
    } catch (e: any) {
      if (isCurrent()) setErr(formatApiError(e));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const unsubs = [
      sseSubscribe("approval.created", () => load()),
      sseSubscribe("approval.decided", () => load()),
    ];
    return () => unsubs.forEach((u) => u());
  }, []);

  // Decide one or many approvals at once (a whole request_id batch). Optimistic
  // removal of all ids, one API call each, single reload at the end.
  async function decideMany(
    ids: string[],
    decision: "approved" | "rejected",
    why?: string,
  ) {
    const snapshot = items;
    const idSet = new Set(ids);
    setItems((cur) => cur.filter((x) => !idSet.has(x.id)));
    setBusy((m) => {
      const n = { ...m };
      for (const id of ids) n[id] = true;
      return n;
    });
    let failed = 0;
    // Причины копим, а не считаем: без них тост не отличал «нет прав» от
    // «подождите» — см. failureSummary.
    const reasons: string[] = [];
    // Кто именно упал — см. restoreFailed: возвращать на экран нужно только их.
    const failedIds = new Set<string>();
    for (const id of ids) {
      try {
        await api.decideApproval(id, { decision, reason: why });
      } catch (e: any) {
        failed++;
        failedIds.add(id);
        reasons.push(errorText(e));
      }
    }
    setBusy((m) => {
      const n = { ...m };
      for (const id of ids) delete n[id];
      return n;
    });
    setRejectingKey(null);
    setReason("");
    if (failed === 0) {
      haptic("success");
      toast(
        decision === "approved"
          ? ids.length > 1 ? `Одобрено: ${ids.length}` : "Одобрено"
          : ids.length > 1 ? `Отклонено: ${ids.length}` : "Отклонено",
        "success",
      );
    } else {
      haptic("error");
      const why2 = failureSummary(reasons);
      toast(
        `Не удалось: ${failed} из ${ids.length}${why2 ? ` — ${why2}` : ""}`,
        "error",
      );
      setItems((cur) => restoreFailed(cur, snapshot, failedIds));
    }
    load();
  }

  function confirmReject(count: number): boolean {
    return window.confirm(count > 1 ? `Отклонить все (${count})?` : "Отклонить аппрув?");
  }

  function renderActions(g: Group) {
    const ids = g.list.map((a) => a.id);
    const anyBusy = ids.some((id) => busy[id]);
    const n = g.list.length;
    if (rejectingKey === g.key) {
      return (
        <>
          <textarea
            placeholder="Причина (необязательно)"
            value={reason}
            onChange={(e) => setReason(e.currentTarget.value)}
            style={{ marginTop: 8 }}
          />
          <div className="btn-row">
            <button
              className="btn danger"
              disabled={anyBusy}
              onClick={() => decideMany(ids, "rejected", reason || undefined)}
            >
              {anyBusy ? "⏳" : n > 1 ? `Подтвердить отклонение (${n})` : "Подтвердить отклонение"}
            </button>
            <button
              className="btn secondary"
              onClick={() => {
                setRejectingKey(null);
                setReason("");
              }}
            >
              Отмена
            </button>
          </div>
        </>
      );
    }
    return (
      <div className="btn-row">
        <button
          className="btn success"
          disabled={anyBusy}
          onClick={() => {
            if (window.confirm(confirmApproveText(g.list))) {
              decideMany(ids, "approved");
            }
          }}
        >
          {anyBusy ? "⏳" : n > 1 ? `Одобрить все (${n})` : "Одобрить"}
        </button>
        <button
          className="btn danger"
          disabled={anyBusy}
          onClick={() => {
            if (confirmReject(n)) {
              if (n > 1) decideMany(ids, "rejected");
              else setRejectingKey(g.key);
            }
          }}
        >
          {n > 1 ? "Отклонить все" : "Отклонить"}
        </button>
      </div>
    );
  }

  const groups = groupApprovals(items);

  return (
    <div>
      <ErrorBox message={err} onRetry={() => load()} />
      {items.length > 0 && (
        <div className="pending-count">
          {items.length} в ожидании
          {groups.length !== items.length ? ` · ${groups.length} групп` : ""}
        </div>
      )}
      {loading && items.length === 0 ? (
        <SkeletonList rows={3} />
      ) : items.length === 0 ? (
        <EmptyState
          icon="✓"
          title="Аппрувов нет"
          hint="Действия, требующие подтверждения, появятся здесь."
        />
      ) : (
        groups.map((g) => {
          const first = g.list[0];
          const isBatch = g.list.length > 1;
          return (
            <div className="card" key={g.key}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <div>
                  <div style={{ fontWeight: 600 }}>
                    {isBatch ? (
                      <>
                        <span className="badge pending">{g.list.length}</span>{" "}
                        {summarizeTypes(g.list)}
                      </>
                    ) : (
                      first.action_type
                    )}
                  </div>
                  <div className="meta">
                    {isBatch ? "пакет · " : ""}от {first.requested_by} ·{" "}
                    {new Date(first.created_at).toLocaleString()}
                  </div>
                </div>
                <span className={`badge ${first.status}`}>
                  {label(APPROVAL_STATUS_LABELS, first.status)}
                </span>
              </div>

              {!isBatch && isInterAgentAction(first.action_type) && (
                <InterAgentCard
                  actionType={first.action_type}
                  payload={first.payload}
                  redacted={first.redacted}
                />
              )}

              <details style={{ marginTop: 8 }}>
                <summary style={{ fontSize: 12, color: "var(--hint)" }}>
                  {isBatch ? `данные (${g.list.length})` : "данные"}
                </summary>
                {g.list.map((a) => (
                  <div key={a.id} style={{ marginTop: 6 }}>
                    {isBatch && (
                      <div className="meta" style={{ fontWeight: 600 }}>{a.action_type}</div>
                    )}
                    <pre className="json-block">{JSON.stringify(a.payload, null, 2)}</pre>
                  </div>
                ))}
              </details>

              {renderActions(g)}
            </div>
          );
        })
      )}
    </div>
  );
}
