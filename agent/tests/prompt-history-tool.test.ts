/**
 * T-719 (2026-06-10): GET_PROMPT_HISTORY — read-only история версий промптов.
 * Метаданные + превью, без дампа полного промпта (agent_prompts чувствителен).
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { executeTool } from "../lib/tools-schema.ts";
import { db } from "../lib/db.ts";

const CTX = { agentKey: "aieng", chatId: -1_000_719 };
const run = (args: Record<string, unknown>) =>
  executeTool("GET_PROMPT_HISTORY", args, CTX).then((s) => JSON.parse(s));

describe("GET_PROMPT_HISTORY", () => {
  beforeEach(() => {
    db.prepare("DELETE FROM agent_prompts WHERE agent_key = 'backend'").run();
    db.prepare(
      `INSERT INTO agent_prompts(agent_key, version, prompt, edited_by, edited_at, applied_at, reason)
       VALUES ('backend', 1, 'v1 prompt body', 'aieng', 1000, 1001, 'init'),
              ('backend', 2, ${"'" + "x".repeat(300) + "'"}, 'aieng', 2000, NULL, 'tweak')`,
    ).run();
  });

  test("возвращает версии DESC с превью, без полного prompt", async () => {
    const out = await run({ agentKey: "backend" });
    expect(out.ok).toBe(true);
    expect(out.count).toBe(2);
    expect(out.history[0].version).toBe(2); // DESC
    expect(out.history[0].applied).toBe(false); // applied_at NULL
    expect(out.history[1].applied).toBe(true);
    // превью обрезано до 200 + …; полного 300-симв тела нет
    expect(out.history[0].preview.length).toBeLessThanOrEqual(201);
    expect("prompt" in out.history[0]).toBe(false);
    expect(out.history[0].length).toBe(300);
  });

  test("неизвестный agentKey → ошибка", async () => {
    const out = await run({ agentKey: "nope" });
    expect(out.ok).toBe(false);
  });
});
