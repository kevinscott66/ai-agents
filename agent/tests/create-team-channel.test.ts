/**
 * CREATE_TEAM_CHANNEL: build-payload + caller-restriction (orchestrator-only).
 */
import { describe, test, expect } from "bun:test";
import { buildPayload } from "../lib/action-dispatch.ts";
import { evaluateGate, CALLER_RESTRICTED } from "../lib/permissions.ts";

describe("CREATE_TEAM_CHANNEL", () => {
  test("dispatch delegates implementation to the channel module", async () => {
    const dispatchSource = await Bun.file(
      new URL("../lib/action-dispatch.ts", import.meta.url),
    ).text();
    const channelSource = await Bun.file(
      new URL("../lib/dispatch/channel.ts", import.meta.url),
    ).text();
    const start = dispatchSource.indexOf('case "CREATE_TEAM_CHANNEL"');
    const end = dispatchSource.indexOf('case "PUBLISH_TO_CHANNEL"');
    const actionSlice = dispatchSource.slice(start, end);

    expect(dispatchSource).toContain('from "./dispatch/channel.ts"');
    expect(actionSlice).toContain("handleCreateTeamChannel");
    expect(actionSlice).not.toContain("guardedUserbotCall");
    expect(channelSource).toContain("registerTeamChannel");
  });

  test("build-payload: title+roles", () => {
    const r = buildPayload("CREATE_TEAM_CHANNEL" as any, { title: "Канал", roles: ["smm", "design"], about: "о" }, { agentKey: "orchestrator", chatId: -1 } as any);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.payload as any).title).toBe("Канал");
      expect((r.payload as any).roles).toEqual(["smm", "design"]);
    }
  });
  test("build-payload: без title → ошибка", () => {
    const r = buildPayload("CREATE_TEAM_CHANNEL" as any, { roles: ["smm"] }, { agentKey: "orchestrator", chatId: -1 } as any);
    expect(r.ok).toBe(false);
  });
  test("orchestrator-only (CALLER_RESTRICTED)", () => {
    expect(CALLER_RESTRICTED["CREATE_TEAM_CHANNEL"]).toBe("orchestrator");
    const g = evaluateGate({ agentKey: "smm", actionType: "CREATE_TEAM_CHANNEL", chatId: -1 } as any);
    expect(g.decision).toBe("deny");
  });
});
