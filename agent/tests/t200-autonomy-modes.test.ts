/**
 * T-200 — Autonomy-modes gate coverage.
 *
 * Systematically exercises evaluateGate() across all 4 AutonomyModes
 * (locked | manual | semi_auto | auto) with three representative action classes:
 *
 *   • safe       — CREATE_TASK  (not in SEMI_AUTO_RISKY, not ALWAYS_APPROVE)
 *   • risky      — DELETE_MESSAGE (in SEMI_AUTO_RISKY, not ALWAYS_APPROVE)
 *   • always_app — GRANT_PERMISSION (in ALWAYS_APPROVE_ACTIONS + CALLER_RESTRICTED)
 *
 * Expected decision table (see .claude/memory/procedures/autonomy-modes.md):
 *
 * evaluateGate order: disabled → caller_restricted → allowed → READONLY →
 *   ALWAYS_APPROVE → mode_switch(locked|manual|semi_auto|auto)
 *
 *   mode      | safe    | risky    | always_approve (GRANT_PERMISSION/perm caller)
 *   ----------|---------|----------|---------------------------------------------
 *   locked    | deny    | deny     | approval (ALWAYS_APPROVE checked before mode)
 *   manual    | approval| approval | approval (ALWAYS_APPROVE reason, not manual)
 *   semi_auto | allow   | approval | approval
 *   auto      | allow   | allow    | approval
 *
 * Note: CALLER_RESTRICTED means only 'perm' may call GRANT_PERMISSION.
 * Tests that use GRANT_PERMISSION use agentKey='perm' with an explicit
 * permissions row so the gate reaches the autonomy/always-approve logic.
 *
 * env vars: none set directly — safe from cross-test leakage.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  evaluateGate,
  setAutonomy,
  setPermission,
  getAutonomy,
  type AutonomyMode,
} from "../lib/permissions.ts";
import { saveAutonomy, restoreAutonomy } from "./_helpers.ts";
import { db } from "../lib/db.ts";

// Use a dedicated agent + chat that won't collide with other test suites.
const AGENT = "perm"; // caller allowed for GRANT_PERMISSION
const CHAT_ID = 999_200_200;
const SAFE_ACTION = "CREATE_TASK" as const;
const RISKY_ACTION = "DELETE_MESSAGE" as const;
const ALWAYS_APP_ACTION = "GRANT_PERMISSION" as const;

let savedGlobal: AutonomyMode;

function setMode(mode: AutonomyMode): void {
  setAutonomy("global", "*", mode);
}

function grantAll(): void {
  // Give AGENT a blanket allow + no approval-required for SAFE and RISKY actions.
  setPermission(AGENT, SAFE_ACTION, { allowed: true, requires_approval: false });
  setPermission(AGENT, RISKY_ACTION, { allowed: true, requires_approval: false });
  // ALWAYS_APPROVE action — grant allowed so the gate progresses past the
  // permission check and reaches the always-approve override.
  setPermission(AGENT, ALWAYS_APP_ACTION, {
    allowed: true,
    requires_approval: false,
  });
}

beforeEach(() => {
  savedGlobal = saveAutonomy();
  grantAll();
  // Clear any per-chat or per-agent overrides for our test scope.
  db.prepare(
    `DELETE FROM autonomy_modes WHERE (scope = 'chat' AND scope_id = ?) OR (scope = 'agent' AND scope_id = ?)`,
  ).run(String(CHAT_ID), AGENT);
});

afterEach(() => {
  restoreAutonomy(savedGlobal);
  db.prepare(
    `DELETE FROM autonomy_modes WHERE (scope = 'chat' AND scope_id = ?) OR (scope = 'agent' AND scope_id = ?)`,
  ).run(String(CHAT_ID), AGENT);
});

// ---------------------------------------------------------------------------
// LOCKED mode
// ---------------------------------------------------------------------------

describe("locked mode", () => {
  test("safe action (CREATE_TASK) → deny", () => {
    setMode("locked");
    const d = evaluateGate({
      agentKey: AGENT,
      actionType: SAFE_ACTION,
      chatId: CHAT_ID,
    });
    expect(d.decision).toBe("deny");
    if (d.decision === "deny") {
      expect(d.reason).toContain("locked");
    }
  });

  test("risky action (DELETE_MESSAGE) → deny", () => {
    setMode("locked");
    const d = evaluateGate({
      agentKey: AGENT,
      actionType: RISKY_ACTION,
      chatId: CHAT_ID,
    });
    expect(d.decision).toBe("deny");
    if (d.decision === "deny") {
      expect(d.reason).toContain("locked");
    }
  });

  test("always-approve action (GRANT_PERMISSION) in locked → deny", () => {
    // Тест был характеризационным и фиксировал `approval`: ALWAYS_APPROVE
    // проверялся ДО режима автономии. Его же пояснение перечисляло порядок
    // гейта с пунктом «4. READONLY» — набора с таким именем нет с 2026-08-10
    // (переименован в LOW_FRICTION_ACTIONS и перенесён ПОД `locked` ровно
    // потому, что проверка выше рубильника оставляла выключенному агенту
    // канал). То есть тест описывал гейт, которого уже не было.
    //
    // Аудит 2026-08-21 доделал начатое: `locked` теперь первый из режимных
    // слоёв. ALWAYS_APPROVE — это пол («не меньше апрува ни в каком режиме»),
    // а не потолок; отказ сильнее апрува и должен побеждать. Иначе рубильник
    // держал SEND_MESSAGE и пропускал выдачу прав, мерж в main и MAC_RUN_CLAUDE.
    setMode("locked");
    const d = evaluateGate({
      agentKey: AGENT,
      actionType: ALWAYS_APP_ACTION,
      chatId: CHAT_ID,
    });
    expect(d.decision).toBe("deny");
    if (d.decision === "deny") {
      expect(d.reason).toContain("locked");
    }
  });
});

// ---------------------------------------------------------------------------
// MANUAL mode
// ---------------------------------------------------------------------------

describe("manual mode", () => {
  test("safe action (CREATE_TASK) → approval", () => {
    setMode("manual");
    const d = evaluateGate({
      agentKey: AGENT,
      actionType: SAFE_ACTION,
      chatId: CHAT_ID,
    });
    expect(d.decision).toBe("approval");
    if (d.decision === "approval") {
      expect(d.reason).toContain("manual");
    }
  });

  test("risky action (DELETE_MESSAGE) → approval", () => {
    setMode("manual");
    const d = evaluateGate({
      agentKey: AGENT,
      actionType: RISKY_ACTION,
      chatId: CHAT_ID,
    });
    expect(d.decision).toBe("approval");
    if (d.decision === "approval") {
      expect(d.reason).toContain("manual");
    }
  });

  test("always-approve action (GRANT_PERMISSION) → approval (always-approve wins over manual)", () => {
    // ALWAYS_APPROVE check comes before the autonomy switch, so the reason
    // is 'always-approve action' not 'manual mode'.
    setMode("manual");
    const d = evaluateGate({
      agentKey: AGENT,
      actionType: ALWAYS_APP_ACTION,
      chatId: CHAT_ID,
    });
    expect(d.decision).toBe("approval");
    if (d.decision === "approval") {
      expect(d.reason).toContain("always-approve");
    }
  });
});

// ---------------------------------------------------------------------------
// SEMI_AUTO mode
// ---------------------------------------------------------------------------

describe("semi_auto mode", () => {
  test("safe action (CREATE_TASK, not risky) → allow", () => {
    setMode("semi_auto");
    const d = evaluateGate({
      agentKey: AGENT,
      actionType: SAFE_ACTION,
      chatId: CHAT_ID,
    });
    expect(d.decision).toBe("allow");
  });

  test("risky action (DELETE_MESSAGE, in SEMI_AUTO_RISKY) → approval", () => {
    setMode("semi_auto");
    const d = evaluateGate({
      agentKey: AGENT,
      actionType: RISKY_ACTION,
      chatId: CHAT_ID,
    });
    expect(d.decision).toBe("approval");
    if (d.decision === "approval") {
      expect(d.reason).toContain("semi_auto");
    }
  });

  test("safe action with requires_approval=true → approval in semi_auto", () => {
    setMode("semi_auto");
    setPermission(AGENT, SAFE_ACTION, { allowed: true, requires_approval: true });
    try {
      const d = evaluateGate({
        agentKey: AGENT,
        actionType: SAFE_ACTION,
        chatId: CHAT_ID,
      });
      expect(d.decision).toBe("approval");
    } finally {
      // Restore to the grantAll() baseline
      setPermission(AGENT, SAFE_ACTION, { allowed: true, requires_approval: false });
    }
  });

  test("always-approve action (GRANT_PERMISSION) → approval regardless of semi_auto", () => {
    setMode("semi_auto");
    const d = evaluateGate({
      agentKey: AGENT,
      actionType: ALWAYS_APP_ACTION,
      chatId: CHAT_ID,
    });
    expect(d.decision).toBe("approval");
    if (d.decision === "approval") {
      expect(d.reason).toContain("always-approve");
    }
  });
});

// ---------------------------------------------------------------------------
// AUTO mode
// ---------------------------------------------------------------------------

describe("auto mode", () => {
  test("safe action (CREATE_TASK, requires_approval=false) → allow", () => {
    setMode("auto");
    const d = evaluateGate({
      agentKey: AGENT,
      actionType: SAFE_ACTION,
      chatId: CHAT_ID,
    });
    expect(d.decision).toBe("allow");
  });

  test("risky action (DELETE_MESSAGE, requires_approval=false) → allow in auto", () => {
    // SEMI_AUTO_RISKY only applies in semi_auto mode; auto ignores that set.
    setMode("auto");
    const d = evaluateGate({
      agentKey: AGENT,
      actionType: RISKY_ACTION,
      chatId: CHAT_ID,
    });
    expect(d.decision).toBe("allow");
  });

  test("action with requires_approval=true → approval even in auto", () => {
    setMode("auto");
    setPermission(AGENT, SAFE_ACTION, { allowed: true, requires_approval: true });
    try {
      const d = evaluateGate({
        agentKey: AGENT,
        actionType: SAFE_ACTION,
        chatId: CHAT_ID,
      });
      expect(d.decision).toBe("approval");
      if (d.decision === "approval") {
        expect(d.reason).toContain("permission requires approval");
      }
    } finally {
      setPermission(AGENT, SAFE_ACTION, { allowed: true, requires_approval: false });
    }
  });

  test("always-approve action (GRANT_PERMISSION) → approval even in auto", () => {
    setMode("auto");
    const d = evaluateGate({
      agentKey: AGENT,
      actionType: ALWAYS_APP_ACTION,
      chatId: CHAT_ID,
    });
    expect(d.decision).toBe("approval");
    if (d.decision === "approval") {
      expect(d.reason).toContain("always-approve");
    }
  });
});

// ---------------------------------------------------------------------------
// CALLER_RESTRICTED enforcement (cross-mode)
// ---------------------------------------------------------------------------

describe("CALLER_RESTRICTED: non-perm agent denied regardless of mode", () => {
  for (const mode of ["locked", "manual", "semi_auto", "auto"] as AutonomyMode[]) {
    test(`mode=${mode} → deny for non-perm caller of GRANT_PERMISSION`, () => {
      setMode(mode);
      // Give smm an explicit allow row to ensure it's the caller check that blocks.
      setPermission("smm", ALWAYS_APP_ACTION, {
        allowed: true,
        requires_approval: false,
      });
      try {
        const d = evaluateGate({
          agentKey: "smm",
          actionType: ALWAYS_APP_ACTION,
          chatId: CHAT_ID,
        });
        expect(d.decision).toBe("deny");
        if (d.decision === "deny") {
          expect(d.reason).toContain("caller not allowed");
        }
      } finally {
        db.prepare(
          `DELETE FROM permissions WHERE agent_key = 'smm' AND action_type = 'GRANT_PERMISSION'`,
        ).run();
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Per-chat override
// ---------------------------------------------------------------------------

describe("per-chat autonomy override", () => {
  test("global=locked but chat override=auto → allow for safe action", () => {
    setMode("locked");
    setAutonomy("chat", String(CHAT_ID), "auto");
    const d = evaluateGate({
      agentKey: AGENT,
      actionType: SAFE_ACTION,
      chatId: CHAT_ID,
    });
    expect(d.decision).toBe("allow");
  });

  test("global=auto but chat override=manual → approval for safe action", () => {
    setMode("auto");
    setAutonomy("chat", String(CHAT_ID), "manual");
    const d = evaluateGate({
      agentKey: AGENT,
      actionType: SAFE_ACTION,
      chatId: CHAT_ID,
    });
    expect(d.decision).toBe("approval");
  });
});

// ---------------------------------------------------------------------------
// Permission denied (allowed=false) short-circuits all modes
// ---------------------------------------------------------------------------

describe("permission denied overrides autonomy mode", () => {
  test("allowed=false in auto mode → deny", () => {
    setMode("auto");
    setPermission(AGENT, SAFE_ACTION, { allowed: false, requires_approval: false });
    try {
      const d = evaluateGate({
        agentKey: AGENT,
        actionType: SAFE_ACTION,
        chatId: CHAT_ID,
      });
      expect(d.decision).toBe("deny");
      if (d.decision === "deny") {
        expect(d.reason).toBe("permission denied");
      }
    } finally {
      setPermission(AGENT, SAFE_ACTION, { allowed: true, requires_approval: false });
    }
  });
});
