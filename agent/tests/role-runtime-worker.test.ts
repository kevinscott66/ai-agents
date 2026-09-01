import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { db } from "../lib/db.ts";
import { enqueueRoleTask } from "../lib/role-runtime.ts";
import {
  createLocalRoleExecutors,
  runRoleRuntimeWorkerOnce,
  TEMPORARY_ROLE_ALLOWED_TOOLS,
} from "../lib/role-runtime-worker.ts";
import { runWithTools } from "../lib/tool-loop.ts";
import type Anthropic from "@anthropic-ai/sdk";

const CHAT_ID = -7_731_205;

function cleanup(): void {
  db.prepare("DELETE FROM role_runtime_queue WHERE chat_id = ?").run(CHAT_ID);
  db.prepare("DELETE FROM tasks WHERE chat_id = ?").run(CHAT_ID);
}

beforeEach(cleanup);
afterEach(cleanup);

describe("local SPAWN_ROLE worker", () => {
  test("has no shell or GitHub workflow execution boundary", () => {
    const source = readFileSync(new URL("../lib/role-runtime-worker.ts", import.meta.url), "utf8");
    expect(source).not.toContain("Bun.spawn");
    expect(source).not.toContain("child_process");
    expect(source).not.toMatch(/gh\s+workflow\s+run/);
  });

  test("temporary executor exposes only its read-only capability set", async () => {
    const captured: any[] = [];
    const anthropic = {
      messages: {
        create: async (request: any) => {
          captured.push(request);
          return {
            id: "temporary-role-test",
            type: "message",
            role: "assistant",
            model: "test",
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
            content: [{ type: "text", text: "bounded" }],
          } as unknown as Anthropic.Message;
        },
      },
    } as unknown as Anthropic;
    const orchestrator = {
      id: 1,
      def: { key: "orchestrator" },
      bot: { telegram: {} },
    } as any;
    const item = {
      id: "queue-1",
      taskId: "task-1",
      roleSlug: "temporary-audit",
      systemPrompt: "bounded test role",
      taskHint: "inspect the wiki",
      provider: "internal",
      state: "running",
      chatId: CHAT_ID,
      createdBy: "orchestrator",
      createdAt: 1,
    } as const;

    const executors = createLocalRoleExecutors({
      anthropic,
      model: "test",
      orchestrator,
      bots: [],
      handoffDeps: {} as any,
    });
    await executors.internal!(item);

    expect(captured).toHaveLength(1);
    expect(captured[0].tools.map((tool: { name: string }) => tool.name)).toEqual(
      [...TEMPORARY_ROLE_ALLOWED_TOOLS],
    );
    for (const forbidden of [
      "MAC_RUN_CLAUDE",
      "REVIEW_AND_MERGE_PR",
      "GRANT_PERMISSION",
      "UPDATE_AGENT_PROMPT",
      "CHANGE_AGENT_STATUS",
      "SPAWN_ROLE",
      "QUERY_DB",
      "GET_LOGS",
      "SEND_MESSAGE",
      "WRITE_WIKI",
    ]) {
      expect(captured[0].tools.some((tool: { name: string }) => tool.name === forbidden)).toBe(false);
    }
  });

  test("a forged privileged tool_use is rejected before dispatch", async () => {
    const captured: any[] = [];
    let call = 0;
    const anthropic = {
      messages: {
        create: async (request: any) => {
          captured.push(request);
          call += 1;
          if (call === 1) {
            return {
              id: "temporary-role-forged-tool",
              type: "message",
              role: "assistant",
              model: "test",
              stop_reason: "tool_use",
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
              content: [{
                type: "tool_use",
                id: "forged-mac-call",
                name: "MAC_RUN_CLAUDE",
                input: {},
              }],
            } as unknown as Anthropic.Message;
          }
          return {
            id: "temporary-role-forged-tool-result",
            type: "message",
            role: "assistant",
            model: "test",
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
            content: [{ type: "text", text: "blocked" }],
          } as unknown as Anthropic.Message;
        },
      },
    } as unknown as Anthropic;

    await runWithTools({
      anthropic,
      model: "test",
      system: [{ type: "text", text: "temporary role" }],
      messages: [{ role: "user", content: "run the approved task" }],
      agentKey: "orchestrator",
      chatId: CHAT_ID,
      capabilityAllowlist: TEMPORARY_ROLE_ALLOWED_TOOLS,
    });

    const toolResult = captured[1].messages
      .flatMap((message: { content?: unknown }) =>
        Array.isArray(message.content) ? message.content : [])
      .find((block: { type?: string }) => block.type === "tool_result");
    expect(toolResult).toMatchObject({
      type: "tool_result",
      tool_use_id: "forged-mac-call",
      is_error: true,
    });
    expect(toolResult.content).toContain("tool unavailable: MAC_RUN_CLAUDE");
  });

  test("claims and completes a queued job through the injected local executor", async () => {
    const queued = enqueueRoleTask({
      name: "worker-test",
      systemPrompt: "bounded test role",
      taskHint: "return the fixture result",
      chatId: CHAT_ID,
      createdBy: "orchestrator",
      provider: "internal",
    });
    const seen: string[] = [];
    const processed = await runRoleRuntimeWorkerOnce({
      pollMs: 1,
      runtime: { workerId: "test-worker", heartbeatMs: 1_000 },
      executors: {
        internal: async (item) => {
          seen.push(`${item.roleSlug}:${item.taskHint}`);
          return { ok: true, source: "local-worker" };
        },
      },
    });

    expect(seen).toEqual(["worker-test:return the fixture result"]);
    expect(processed?.taskId).toBe(queued.taskId);
    expect(processed?.state).toBe("done");
    expect((db.prepare("SELECT status, output FROM tasks WHERE id=?").get(queued.taskId) as {
      status: string;
      output: string;
    }).status).toBe("done");
  });
});
