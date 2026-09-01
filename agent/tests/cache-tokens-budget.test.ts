/**
 * Аудит 2026-08-12: raw-путь не считал кэш-токены, и дневной лимит не держал.
 *
 * `callAnthropic` писал в бюджет только `usage.input_tokens`:
 *
 *   recordUsage(agentKey, resp.usage?.input_tokens ?? 0, resp.usage?.output_tokens ?? 0)
 *
 * У Anthropic `input_tokens` НЕ включает `cache_read_input_tokens` и
 * `cache_creation_input_tokens` — это отдельные поля, и оплачиваются они тоже
 * отдельно (запись в кэш дороже обычного input'а, чтение — дешевле, но не
 * бесплатно). А кэш на raw-пути используется везде: handoff.ts и
 * orchestrator/message-handler.ts помечают системные блоки (роль-промпт,
 * NARRATIVE_DISCIPLINE_BLOCK, ORCHESTRATION_MANDATE, buildMemorySystemText)
 * как `cache_control: {type:"ephemeral"}`, а tool-loop гоняет этот же system
 * через callAnthropic на каждой итерации.
 *
 * Значит из счёта выпадала ровно та часть, которая на длинном роль-промпте и
 * есть основной расход. Типовая сессия «1 холодный вызов + 5 тёплых» с
 * системным префиксом ~10k токенов: фактически оплачено 65 100 input-токенов,
 * записано 8 700 — 87% расхода невидимо. При лимите 100k/сутки checkBudget
 * срабатывает примерно на 68-м вызове, когда реально оплачено ~737 800.
 *
 * SDK-путь считает правильно (`sdkUsageTokens` складывает все три поля), и его
 * комментарий утверждает паритет с raw-путём — паритета не было. Инвариант:
 * оба пути считают input одинаково, потому что считает их одна функция.
 */
import { describe, test, expect, afterAll } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { callAnthropic } from "../lib/anthropic-client.ts";
import { sdkUsageTokens } from "../lib/agent-sdk-runtime.ts";
import { usageInputTokens, getDailyUsage } from "../lib/token-budget.ts";
import { db } from "../lib/db.ts";

const AGENT = "cache_tokens_budget_probe";

const params = {
  model: "t",
  max_tokens: 16,
  messages: [{ role: "user" as const, content: "hi" }],
} as Anthropic.MessageCreateParamsNonStreaming;

function clientReturning(usage: Record<string, number>): Anthropic {
  return {
    messages: {
      create: async () =>
        ({
          id: "m",
          type: "message",
          role: "assistant",
          model: "t",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage,
          content: [{ type: "text", text: "ok" }],
        }) as unknown as Anthropic.Message,
    },
  } as unknown as Anthropic;
}

afterAll(() => {
  db.prepare(`DELETE FROM agent_token_usage WHERE agent_key = ?`).run(AGENT);
});

describe("учёт кэш-токенов", () => {
  test("callAnthropic пишет в бюджет чтение и запись кэша", async () => {
    await callAnthropic(
      params,
      clientReturning({
        input_tokens: 700,
        cache_read_input_tokens: 9_500,
        cache_creation_input_tokens: 1_800,
        output_tokens: 300,
      }),
      AGENT,
    );
    expect(getDailyUsage(AGENT)).toEqual({
      input: 700 + 9_500 + 1_800,
      output: 300,
    });
  });

  test("raw-путь и SDK-путь считают один и тот же usage одинаково", () => {
    for (const u of [
      { input_tokens: 700, cache_read_input_tokens: 9_500, output_tokens: 3 },
      { input_tokens: 10, cache_creation_input_tokens: 12_000, output_tokens: 1 },
      { input_tokens: 5, output_tokens: 1 },
      {},
    ]) {
      expect({ u, n: usageInputTokens(u) }).toEqual({
        u,
        n: sdkUsageTokens(u).input,
      });
    }
  });

  test("отсутствующий usage — ноль, а не NaN", () => {
    expect(usageInputTokens(undefined)).toBe(0);
    expect(usageInputTokens(null)).toBe(0);
  });
});
