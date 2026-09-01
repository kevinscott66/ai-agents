/**
 * T-703 — Inter-agent runtime status/autonomy mutation handler.
 *
 * `handleChangeAgentStatus` is invoked from `dispatchAction`
 * (action-dispatch.ts) AFTER the gate has approved the action
 * (`ALWAYS_APPROVE_ACTIONS` forces approval, so this only runs
 * post-user-approval). It validates the payload, reads the prior
 * state for diff, writes the new status to `agent_states` and (if
 * provided) updates `autonomy_modes` via `setAutonomy(scope='agent')`,
 * then emits a separate audit_log entry capturing the old → new
 * transition. `dispatchAndAudit` writes the canonical `agent_actions`
 * row independently.
 *
 * Coordination note: this module is a sibling to T-701's
 * `dispatch/permissions.ts` (PR #48). Once T-701 merges, both files
 * coexist in `agent/lib/dispatch/`.
 */
import {
  setAutonomy,
  getAutonomy,
  type AutonomyMode,
} from "../permissions.ts";
import { insertActionRow, emitActionEvents } from "../audit.ts";
import { db } from "../db.ts";
import { CHARACTERS } from "../../characters/index.ts";
import type { ChangeAgentStatusPayload } from "../action-payload.ts";

const VALID_AGENT_KEYS: Set<string> = new Set(CHARACTERS.map((c) => c.key));
const VALID_STATUSES: Set<string> = new Set(["active", "disabled"]);
const VALID_AUTONOMY: Set<string> = new Set([
  "locked",
  "manual",
  "semi_auto",
  "auto",
]);

export type AgentStatus = "active" | "disabled";

export interface ChangeAgentStatusResult {
  ok: true;
  result: {
    target_agent_key: string;
    old: { status: AgentStatus; autonomy_mode: AutonomyMode };
    new: { status: AgentStatus; autonomy_mode: AutonomyMode };
    reason: string;
  };
}

export interface ChangeAgentStatusFailure {
  ok: false;
  error: string;
}

/**
 * Validate the payload. Returns a string error message or null if valid.
 */
export function validateChangeAgentStatusPayload(
  p: ChangeAgentStatusPayload,
): string | null {
  if (typeof p?.target_agent_key !== "string" || !p.target_agent_key) {
    return "target_agent_key is required";
  }
  if (!VALID_AGENT_KEYS.has(p.target_agent_key)) {
    return `unknown target_agent_key: ${p.target_agent_key}`;
  }
  // T-704 hard guard: the orchestrator is the router/entry point for all 12
  // bots — disabling or locking it would lock the whole team out (no agent
  // could re-enable it via the normal flow). Reject both unconditionally.
  if (p.target_agent_key === "orchestrator") {
    if (p.new_status === "disabled") {
      return "cannot disable orchestrator (lock-out risk)";
    }
    if (p.new_autonomy_mode === "locked") {
      return "cannot lock orchestrator (lock-out risk)";
    }
  }
  // Аудит 2026-08-11: тот же lock-out risk, только невозвратный. Выключить perm
  // означает выключить единственного, кто может кого-либо включить:
  // CHANGE_AGENT_STATUS привязан к нему в CALLER_RESTRICTED, выключенному агенту
  // гейт отвечает deny на всё, а колонку `agent_states.status` во всём проекте
  // пишет только setAgentStatus — то есть этот же хендлер. В Mini App есть
  // пауза и автономия, статуса нет. Обратного пути не остаётся ни у агентов, ни
  // у владельца — только SQLite на VPS руками.
  //
  // Про `locked` здесь молчим намеренно: автономию Mini App переписывает
  // (POST /api/autonomy), это возвратно. И обратимый способ остановить perm
  // никуда не делся — пауза из Mini App денаит на гейте так же, а снимается
  // кнопкой.
  if (p.target_agent_key === "perm" && p.new_status === "disabled") {
    return (
      "cannot disable perm (lock-out risk): включить его обратно будет некому — " +
      "CHANGE_AGENT_STATUS доступен только perm. Останови его паузой в Mini App"
    );
  }
  const hasStatus = p.new_status !== undefined && p.new_status !== null;
  const hasAutonomy =
    p.new_autonomy_mode !== undefined && p.new_autonomy_mode !== null;
  if (!hasStatus && !hasAutonomy) {
    return "at least one of new_status or new_autonomy_mode must be provided";
  }
  if (hasStatus && !VALID_STATUSES.has(p.new_status as string)) {
    return `invalid new_status: ${p.new_status}`;
  }
  if (hasAutonomy && !VALID_AUTONOMY.has(p.new_autonomy_mode as string)) {
    return `invalid new_autonomy_mode: ${p.new_autonomy_mode}`;
  }
  if (typeof p.reason !== "string" || p.reason.trim().length < 10) {
    return "reason must be at least 10 characters (operator accountability)";
  }
  return null;
}

interface StateRow {
  status: string | null;
}

/**
 * Read the current status for an agent. Defaults to "active" when no row
 * exists (mirrors the migration default).
 */
export function getAgentStatus(agentKey: string): AgentStatus {
  const row = db
    .prepare(`SELECT status FROM agent_states WHERE agent_key = ?`)
    .get(agentKey) as StateRow | undefined;
  const s = row?.status ?? "active";
  return s === "disabled" ? "disabled" : "active";
}

/**
 * Upsert the status for an agent. Preserves any existing `paused` column.
 */
export function setAgentStatus(agentKey: string, status: AgentStatus): void {
  db.prepare(
    `INSERT INTO agent_states(agent_key, paused, updated_at, status)
     VALUES (?, 0, ?, ?)
     ON CONFLICT(agent_key) DO UPDATE SET
       status = excluded.status,
       updated_at = excluded.updated_at`,
  ).run(agentKey, Date.now(), status);
}

/**
 * Apply a CHANGE_AGENT_STATUS action. Caller restriction (`perm` only) and
 * the always-approve gate are enforced upstream in `evaluateGate`, so this
 * handler runs only after user approval.
 *
 * Side effects:
 *   - UPSERT `agent_states` row when `new_status` provided.
 *   - UPSERT `autonomy_modes` (scope=agent) when `new_autonomy_mode` provided.
 *   - Emit a dedicated audit_log row with old → new diff and reason.
 *
 * The canonical `agent_actions` row is written by `dispatchAndAudit`.
 */
export function handleChangeAgentStatus(
  payload: ChangeAgentStatusPayload,
  ctx: { agentKey: string; chatId: number },
): ChangeAgentStatusResult | ChangeAgentStatusFailure {
  const err = validateChangeAgentStatusPayload(payload);
  if (err) return { ok: false, error: err };

  const target = payload.target_agent_key;
  const oldStatus = getAgentStatus(target);
  // Report the mode that governs this action in its originating chat: agent
  // scope still wins, then chat scope, then global. Omitting chatId would make
  // a status-only change describe the global fallback instead of the mode the
  // operator actually sees in this conversation.
  const oldAutonomy = getAutonomy(ctx.chatId, target);

  const newStatus: AgentStatus = payload.new_status ?? oldStatus;
  const newAutonomy: AutonomyMode =
    payload.new_autonomy_mode ?? oldAutonomy;

  // Аудит 2026-08-29: три записи — статус, режим автономии и строка аудита —
  // уходили тремя отдельными автокоммитами. Обрыв между ними оставлял ровно ту
  // половину решения, до которой успели дойти: агент отключён, но режим
  // автономии прежний, и следа о том, что вообще происходило, нет. Решение
  // здесь одно и принято человеком (гейт всегда требует одобрения), значит и
  // durability-единица должна быть одна.
  //
  // Событие в шину шлём ПОСЛЕ коммита — так же, как это делают остальные
  // вызывающие, открывающие транзакцию (см. докблок `insertActionRow`):
  // подписчик, разбуженный до фиксации, прочитал бы состояние, которого ещё
  // нет в базе, а при откате — которого не будет никогда.
  const inserted = db.transaction(() => {
    if (payload.new_status !== undefined && payload.new_status !== null) {
      setAgentStatus(target, payload.new_status);
    }
    if (
      payload.new_autonomy_mode !== undefined &&
      payload.new_autonomy_mode !== null
    ) {
      setAutonomy("agent", target, payload.new_autonomy_mode);
    }

    // Dedicated audit row capturing the old → new diff.
    return insertActionRow("CHANGE_AGENT_STATUS", {
      agentKey: ctx.agentKey,
      chatId: ctx.chatId,
      payload: {
        target_agent_key: target,
        old: { status: oldStatus, autonomy_mode: oldAutonomy },
        new: { status: newStatus, autonomy_mode: newAutonomy },
        reason: payload.reason,
        _diff: true,
      },
      status: "ok",
    });
  })();
  emitActionEvents(inserted);

  return {
    ok: true,
    result: {
      target_agent_key: target,
      old: { status: oldStatus, autonomy_mode: oldAutonomy },
      new: { status: newStatus, autonomy_mode: newAutonomy },
      reason: payload.reason,
    },
  };
}
