/**
 * T-704 completion: the `agent_states.status` flag must actually gate actions.
 *
 * Two gaps this covers (both in the T-704 DoD, previously unimplemented):
 *   1. evaluateGate denies EVERY action from a `disabled` agent.
 *   2. CHANGE_AGENT_STATUS cannot disable/lock the orchestrator (lock-out risk).
 */
import { describe, test, expect, afterEach } from "bun:test";
import { evaluateGate, isAgentDisabled, setPermission } from "../lib/permissions.ts";
import {
  setAgentStatus,
  validateChangeAgentStatusPayload,
} from "../lib/dispatch/agent-status.ts";
import { db } from "../lib/db.ts";
import { savePermissions } from "./_helpers.ts";

const TARGET = "smm";

function cleanup(): void {
  db.prepare(`DELETE FROM agent_states WHERE agent_key = ?`).run(TARGET);
}

// smm — настоящая роль, и её строка SEND_MESSAGE входит в сид, который
// проверяет c3.test.ts. Возвращаем как было. T-751.
const restores: Array<() => void> = [];
function grantSend(): void {
  restores.push(savePermissions([[TARGET, "SEND_MESSAGE"]]));
  setPermission(TARGET, "SEND_MESSAGE", {
    allowed: true,
    requires_approval: false,
  });
}

afterEach(() => {
  while (restores.length) restores.pop()!();
  cleanup();
});

describe("T-704 disabled-agent gate", () => {
  test("isAgentDisabled reflects agent_states.status", () => {
    cleanup();
    expect(isAgentDisabled(TARGET)).toBe(false); // no row → active
    setAgentStatus(TARGET, "disabled");
    expect(isAgentDisabled(TARGET)).toBe(true);
    setAgentStatus(TARGET, "active");
    expect(isAgentDisabled(TARGET)).toBe(false);
  });

  test("disabled agent → evaluateGate deny for any action", () => {
    // Even with an explicit allow permission, a disabled agent is inert.
    grantSend();
    setAgentStatus(TARGET, "disabled");
    const d = evaluateGate({ agentKey: TARGET, actionType: "SEND_MESSAGE" });
    expect(d.decision).toBe("deny");
    if (d.decision === "deny") {
      expect(d.reason).toBe("agent disabled");
    }
  });

  test("active agent is not denied by the disabled rule", () => {
    grantSend();
    setAgentStatus(TARGET, "active");
    const d = evaluateGate({ agentKey: TARGET, actionType: "SEND_MESSAGE" });
    // Whatever the decision, it must NOT be the disabled-deny.
    if (d.decision === "deny") {
      expect(d.reason).not.toBe("agent disabled");
    }
  });
});

describe("T-704 orchestrator lock-out guard", () => {
  test("cannot disable orchestrator", () => {
    const err = validateChangeAgentStatusPayload({
      target_agent_key: "orchestrator",
      new_status: "disabled",
      reason: "attempting to disable the router (should be blocked)",
    });
    expect(err).toMatch(/cannot disable orchestrator/);
  });

  test("cannot lock orchestrator", () => {
    const err = validateChangeAgentStatusPayload({
      target_agent_key: "orchestrator",
      new_autonomy_mode: "locked",
      reason: "attempting to lock the router (should be blocked)",
    });
    expect(err).toMatch(/cannot lock orchestrator/);
  });

  test("orchestrator may still be set to a non-lock autonomy mode", () => {
    const err = validateChangeAgentStatusPayload({
      target_agent_key: "orchestrator",
      new_autonomy_mode: "manual",
      reason: "tightening orchestrator to manual is allowed",
    });
    expect(err).toBeNull();
  });

  test("non-orchestrator agent may be disabled", () => {
    const err = validateChangeAgentStatusPayload({
      target_agent_key: TARGET,
      new_status: "disabled",
      reason: "rotating SMM agent out for prompt audit cycle",
    });
    expect(err).toBeNull();
  });
});
