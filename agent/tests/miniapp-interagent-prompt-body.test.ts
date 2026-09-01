/**
 * Аудит 2026-08-11: карточка аппрува UPDATE_AGENT_PROMPT не показывала сам промпт.
 *
 * `InterAgentCard` — это то, что человек читает, решая, одобрять ли перезапись
 * system-prompt одного из 12 продовых ботов. Для UPDATE_AGENT_PROMPT она искала
 * текст в ключах `full_text` / `body` / `diff`. Ни одного из них в payload нет:
 * бэкенд валидирует и кладёт в аппрув `new_prompt` (см. UpdateAgentPromptPayload
 * и validateUpdateAgentPromptPayload). Ветка `{fullText && <PromptPreview/>}`
 * не срабатывала никогда, строка «длина: ±N» — тоже.
 *
 * То есть карточка сообщала «Обновить промпт для qa» + причину, а сам новый
 * промпт (50..8000 символов, ровно то, что меняет поведение бота) был виден
 * только если развернуть сырой JSON под карточкой. Ровно то действие, ради
 * которого аппрув и стоит, человек одобрял вслепую.
 *
 * Тест держит инвариант через два слоя: payload, прошедший валидатор бэкенда,
 * ОБЯЗАН отдавать непустое тело в карточке.
 */
import { describe, test, expect } from "bun:test";
import { promptBodyOf } from "../miniapp/src/components/InterAgentCard.tsx";
import {
  validateUpdateAgentPromptPayload,
  MIN_PROMPT_LEN,
  MIN_REASON_LEN,
} from "../lib/dispatch/agent-prompt.ts";
import type { PayloadByType } from "../lib/action-payload.ts";

function validPayload(): PayloadByType["UPDATE_AGENT_PROMPT"] {
  return {
    target_agent_key: "qa",
    new_prompt: "Ты QA-инженер команды. ".repeat(10).slice(0, MIN_PROMPT_LEN + 40),
    reason: "x".repeat(MIN_REASON_LEN + 5),
  };
}

describe("InterAgentCard: тело промпта в карточке аппрува", () => {
  test("payload, прошедший валидатор бэкенда, даёт непустое тело", () => {
    const p = validPayload();
    // Сначала убеждаемся, что это действительно тот payload, который дойдёт
    // до аппрува, а не выдуманная форма.
    expect(validateUpdateAgentPromptPayload(p)).toBeNull();
    expect(promptBodyOf(p)).toBe(p.new_prompt);
  });

  test("длина тела совпадает с длиной нового промпта", () => {
    const p = validPayload();
    expect(promptBodyOf(p).length).toBe(p.new_prompt.length);
    expect(promptBodyOf(p).length).toBeGreaterThanOrEqual(MIN_PROMPT_LEN);
  });

  test("исторические ключи остаются запасными вариантами", () => {
    expect(promptBodyOf({ full_text: "full" })).toBe("full");
    expect(promptBodyOf({ body: "body" })).toBe("body");
    expect(promptBodyOf({ diff: "diff" })).toBe("diff");
  });

  test("new_prompt приоритетнее исторических ключей", () => {
    expect(promptBodyOf({ new_prompt: "new", full_text: "old", body: "b", diff: "d" })).toBe(
      "new",
    );
  });

  test("мусорный payload не роняет карточку", () => {
    expect(promptBodyOf(null)).toBe("");
    expect(promptBodyOf(undefined)).toBe("");
    expect(promptBodyOf("строка")).toBe("");
    expect(promptBodyOf(42)).toBe("");
    expect(promptBodyOf({})).toBe("");
    expect(promptBodyOf({ new_prompt: 123 })).toBe("123");
  });

  test("карточка читает тело только через promptBodyOf", async () => {
    const src = await Bun.file(
      new URL("../miniapp/src/components/InterAgentCard.tsx", import.meta.url),
    ).text();
    const block = src.slice(src.indexOf('actionType === "UPDATE_AGENT_PROMPT"'));
    expect(block).toContain("promptBodyOf(p)");
    // Прямой перебор ключей внутри ветки — это ровно тот способ, которым
    // ключ и разъехался с бэкендом.
    expect(block.slice(0, block.indexOf("return ("))).not.toContain('str(p, "full_text")');
  });
});
