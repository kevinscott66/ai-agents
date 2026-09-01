/** Regression contract: no collaboration action may launch a GitHub workflow. */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { handleSpawnRole } from "../lib/dispatch/spawn-role.ts";

const HANDLER = new URL(
  "../lib/dispatch/spawn-role.ts",
  import.meta.url,
).pathname;

describe("internal collaboration executor boundary", () => {
  test("SPAWN_ROLE source has no workflow dispatch path", () => {
    const source = readFileSync(HANDLER, "utf8");
    expect(source).not.toContain("gh workflow run");
    expect(source).not.toMatch(/workflow\s+run/);
    expect(source).toContain("local role runtime");
  });

  test("SPAWN_ROLE queues through an injected internal boundary", async () => {
    const result = await handleSpawnRole(
      { name: "temporary-audit", system_prompt: "audit" },
      { agentKey: "orchestrator", chatId: -100123 },
      {
        enqueue: (input) => ({
          id: "queue-1",
          taskId: "task-1",
          roleSlug: input.name,
          systemPrompt: input.systemPrompt,
          taskHint: input.taskHint ?? "",
          provider: "internal",
          state: "queued",
          chatId: input.chatId,
          createdBy: input.createdBy,
          createdAt: 1,
        }),
      },
    );
    expect(result).toMatchObject({
      ok: true,
      result: {
        action: "queued",
        provider: "internal",
        state: "queued",
        execution: "local_role_runtime",
      },
    });
  });

  test("non-orchestrator calls are rejected before enqueue", async () => {
    const result = await handleSpawnRole(
      { name: "temporary-audit", system_prompt: "audit" },
      { agentKey: "backend", chatId: -100123 },
      { enqueue: () => { throw new Error("enqueue must not run"); } },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("restricted to orchestrator");
  });
});
