/**
 * T-701 — Inter-agent permission mutation handlers.
 *
 * `handleGrantPermission` is invoked from `dispatchAction` (action-dispatch.ts)
 * AFTER the gate has approved the action (`ALWAYS_APPROVE_ACTIONS` forces
 * approval, so this only runs post-user-approval). It validates the payload,
 * reads the prior permission row for diff, writes the new row via
 * `setPermission`, and emits a separate audit_log entry capturing the
 * old → new transition. `dispatchAndAudit` writes the canonical
 * `agent_actions` row independently.
 *
 * Future siblings (T-703 UPDATE_AGENT_PROMPT, T-704 CHANGE_AGENT_STATUS)
 * live in this same module.
 */
import {
  ACTION_TYPES,
  getPermission,
  grantCaveat,
  grantIneffectiveReason,
  setPermission,
  type ActionType,
} from "../permissions.ts";
import { logAction } from "../audit.ts";
import { CHARACTERS } from "../../characters/index.ts";
import type { GrantPermissionPayload } from "../action-payload.ts";

const VALID_AGENT_KEYS: Set<string> = new Set(CHARACTERS.map((c) => c.key));
const VALID_ACTION_TYPES: Set<string> = new Set<string>(ACTION_TYPES);

export interface GrantPermissionResult {
  ok: true;
  result: {
    target_agent_key: string;
    action_type: ActionType;
    old: { allowed: boolean; requires_approval: boolean };
    new: { allowed: boolean; requires_approval: boolean };
    reason: string;
  };
  /** Оговорка про SEMI_AUTO_RISKY — та же, что видят `/grant` и Mini App. */
  caveat: string | null;
}

export interface GrantPermissionFailure {
  ok: false;
  error: string;
}

/**
 * Validate the payload. Returns a string error message or null if valid.
 *
 * Последняя проверка — общий рубеж `grantIneffectiveReason`: подействует ли
 * строка вообще. Это третий вход к `setPermission` (первые два — команда
 * `/grant` и `POST /api/permissions`), и до аудита 2026-08-28 он был
 * единственным, кто рубеж не спрашивал: писал строку, которую гейт никогда
 * не прочтёт, и рапортовал успех. Отзыв (`allowed: false`) не проверяем — он
 * действует на любой карте, ровно как в Mini App.
 *
 * Стоит здесь, а не в `handleGrantPermission`, потому что `dispatchAction`
 * зовёт валидатор ДО создания строки апрува: владельца не спрашивают про
 * выдачу, которая ничего не сделает.
 */
export function validateGrantPermissionPayload(
  p: GrantPermissionPayload,
): string | null {
  if (typeof p?.target_agent_key !== "string" || !p.target_agent_key) {
    return "target_agent_key is required";
  }
  if (!VALID_AGENT_KEYS.has(p.target_agent_key)) {
    return `unknown target_agent_key: ${p.target_agent_key}`;
  }
  if (typeof p.action_type !== "string" || !p.action_type) {
    return "action_type is required";
  }
  if (!VALID_ACTION_TYPES.has(p.action_type)) {
    return `unknown action_type: ${p.action_type}`;
  }
  if (typeof p.allowed !== "boolean") {
    return "allowed must be boolean";
  }
  if (typeof p.requires_approval !== "boolean") {
    return "requires_approval must be boolean";
  }
  if (typeof p.reason !== "string" || p.reason.trim().length < 10) {
    return "reason must be at least 10 characters (operator accountability)";
  }
  if (p.allowed) {
    const dead = grantIneffectiveReason(
      p.target_agent_key,
      p.action_type as ActionType,
      p.requires_approval ? "approval" : "auto",
    );
    if (dead) return `строка не подействует: ${dead}`;
  }
  return null;
}

/**
 * Apply a GRANT_PERMISSION action. Caller restriction (`perm` only) and the
 * always-approve gate are enforced upstream in `evaluateGate`, so this
 * handler runs only after user approval.
 *
 * Side effects:
 *   - UPSERT `permissions` row for (target_agent_key, action_type).
 *   - Emit a dedicated audit_log row with old → new diff and reason.
 *
 * The canonical `agent_actions` row is written by `dispatchAndAudit`.
 */
export function handleGrantPermission(
  payload: GrantPermissionPayload,
  ctx: { agentKey: string; chatId: number },
): GrantPermissionResult | GrantPermissionFailure {
  const err = validateGrantPermissionPayload(payload);
  if (err) return { ok: false, error: err };

  const actionType = payload.action_type as ActionType;
  const old = getPermission(payload.target_agent_key, actionType);
  const next = {
    allowed: payload.allowed,
    requires_approval: payload.requires_approval,
  };

  setPermission(payload.target_agent_key, actionType, next);

  // Dedicated audit row capturing the old → new diff. Uses the same
  // `agent_actions` table (free-form JSON payload) — no schema change.
  logAction({
    agentKey: ctx.agentKey,
    chatId: ctx.chatId,
    actionType: "GRANT_PERMISSION",
    payload: {
      target_agent_key: payload.target_agent_key,
      action_type: actionType,
      old,
      new: next,
      reason: payload.reason,
      _diff: true,
    },
    status: "ok",
  });

  return {
    ok: true,
    result: {
      target_agent_key: payload.target_agent_key,
      action_type: actionType,
      old,
      new: next,
      reason: payload.reason,
    },
    caveat: payload.allowed
      ? grantCaveat(actionType, payload.requires_approval ? "approval" : "auto")
      : null,
  };
}
