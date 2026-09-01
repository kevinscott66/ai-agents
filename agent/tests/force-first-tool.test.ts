/**
 * Автономность Step 3: forceFirstTool ставит tool_choice:any на ПЕРВОЙ итерации
 * (делегированные «производящие» роли обязаны вызвать инструмент, а не «сделаю»).
 */
import { describe, test, expect } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { runWithTools } from "../lib/tool-loop.ts";

function fakeAnthropic(captured: any[]) {
  return {
    messages: {
      create: async (req: any) => {
        captured.push(req);
        return {
          id: "m", type: "message", role: "assistant", model: "t",
          stop_reason: "end_turn", stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
          content: [{ type: "text", text: "ok" }],
        } as unknown as Anthropic.Message;
      },
    },
  } as unknown as Anthropic;
}

const base = {
  model: "t",
  system: [{ type: "text" as const, text: "s" }],
  messages: [{ role: "user" as const, content: "сделай макет" }],
  agentKey: "design",
  chatId: -1,
};

describe("forceFirstTool", () => {
  test("ON → tool_choice:any на первом вызове", async () => {
    const cap: any[] = [];
    await runWithTools({ ...base, anthropic: fakeAnthropic(cap), forceFirstTool: true });
    expect(cap[0].tool_choice).toEqual({ type: "any" });
  });

  test("OFF → без tool_choice (по умолчанию)", async () => {
    const cap: any[] = [];
    await runWithTools({ ...base, anthropic: fakeAnthropic(cap) });
    expect(cap[0].tool_choice).toBeUndefined();
  });
});
