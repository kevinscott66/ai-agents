// SEC-4 / T-602: owner-voice (via_userbot) sends must require human approval
// regardless of autonomy mode, so a prompt-injected / auto-mode orchestrator
// can't post as the owner's real account without a human in the loop.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { evaluateGate, setAutonomy } from "../lib/permissions.ts";
import { saveAutonomy, restoreAutonomy } from "./_helpers.ts";

let saved: ReturnType<typeof saveAutonomy>;

beforeEach(() => {
  saved = saveAutonomy();
  setAutonomy("global", "*", "auto"); // most permissive mode
});

afterEach(() => {
  restoreAutonomy(saved);
});

describe("via_userbot force-approval (T-602 / SEC-4)", () => {
  test("baseline: a normal SEND_MESSAGE is allowed in auto mode", () => {
    const g = evaluateGate({ agentKey: "orchestrator", actionType: "SEND_MESSAGE" });
    expect(g.decision).toBe("allow");
  });

  test("forceApproval overrides auto → approval", () => {
    const g = evaluateGate({
      agentKey: "orchestrator",
      actionType: "SEND_MESSAGE",
      forceApproval: true,
    });
    expect(g.decision).toBe("approval");
  });

  test("forceApproval does NOT rescue a denied action (caller-restricted)", () => {
    // GRANT_PERMISSION is restricted to 'perm'; orchestrator must still be denied
    // even with forceApproval set — deny checks run first.
    const g = evaluateGate({
      agentKey: "orchestrator",
      actionType: "GRANT_PERMISSION",
      forceApproval: true,
    });
    expect(g.decision).toBe("deny");
  });
});
