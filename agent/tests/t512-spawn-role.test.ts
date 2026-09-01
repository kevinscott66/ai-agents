/** T-512: SPAWN_ROLE is an approval-gated local queue boundary. */

import { describe, it, expect } from "bun:test";
import {
  handleSpawnRole,
  SPAWN_ROLE_PROVIDER,
} from "../lib/dispatch/spawn-role.ts";
import type { SpawnRolePayload } from "../lib/action-payload.ts";
import {
  ALWAYS_APPROVE_ACTIONS,
  CALLER_RESTRICTED,
  DISPATCH_ONLY_ACTIONS,
} from "../lib/permissions.ts";

const orchestratorCtx = { agentKey: "orchestrator", chatId: -123456789 };
const nonOrchestratorCtx = { agentKey: "backend", chatId: -123456789 };

describe("SPAWN_ROLE internal boundary", () => {
  it("is dispatch-only, orchestrator-only, and always approval-gated", () => {
    expect(DISPATCH_ONLY_ACTIONS.SPAWN_ROLE).toContain("approved dispatch");
    expect(ALWAYS_APPROVE_ACTIONS.has("SPAWN_ROLE")).toBe(true);
    expect(CALLER_RESTRICTED.SPAWN_ROLE).toBe("orchestrator");
  });

  it("rejects non-orchestrator callers before the internal boundary", async () => {
    const result = await handleSpawnRole(
      { name: "security-audit", system_prompt: "You are an auditor." },
      nonOrchestratorCtx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.provider).toBe(SPAWN_ROLE_PROVIDER);
      expect(result.state).toBe("rejected");
      expect(result.error).toContain("restricted to orchestrator");
    }
  });

  it("validates malformed input without invoking an external runner", async () => {
    for (const payload of [
      { name: "", system_prompt: "prompt" },
      { name: "role", system_prompt: "" },
    ] satisfies SpawnRolePayload[]) {
      const result = await handleSpawnRole(payload, orchestratorCtx);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.state).toBe("rejected");
    }
  });

  it("queues work through the local runtime", async () => {
    let captured: Record<string, unknown> | undefined;
    const result = await handleSpawnRole(
      {
        name: "security-audit",
        system_prompt: "You are a security auditor.",
        task_hint: "review auth",
      },
      orchestratorCtx,
      {
        enqueue: (input) => {
          captured = input as unknown as Record<string, unknown>;
          return {
            id: "queue-1",
            taskId: "task-1",
            roleSlug: "security-audit",
            systemPrompt: "You are a security auditor.",
            taskHint: "review auth",
            provider: "internal",
            state: "queued",
            chatId: orchestratorCtx.chatId,
            createdBy: orchestratorCtx.agentKey,
            createdAt: 1,
          };
        },
      },
    );
    expect(result).toMatchObject({
      ok: true,
      result: {
        action: "queued",
        role_slug: "security-audit",
        provider: "internal",
        state: "queued",
        execution: "local_role_runtime",
        task_id: "task-1",
        queue_id: "queue-1",
      },
    });
    expect(captured).toMatchObject({
      name: "security-audit",
      provider: "internal",
      taskHint: "review auth",
      chatId: orchestratorCtx.chatId,
      createdBy: "orchestrator",
    });
  });

  it("rejects an unknown provider and unavailable Codex", async () => {
    const enqueue = () => { throw new Error("enqueue must not run"); };
    const unknown = await handleSpawnRole(
      { name: "role", system_prompt: "prompt", provider: "external" as never },
      orchestratorCtx,
      { enqueue },
    );
    expect(unknown.ok).toBe(false);
    const codex = await handleSpawnRole(
      { name: "role", system_prompt: "prompt", provider: "codex" },
      orchestratorCtx,
      { enqueue, codexAvailable: false },
    );
    expect(codex.ok).toBe(false);
    if (!codex.ok) expect(codex.error).toContain("unavailable");
  });
});
