/**
 * Аудит 2026-08-08: `forceFirstTool` терялся на подписочном пути.
 *
 * handoff.ts ставит флаг делегированным «производящим» ролям, потому что без
 * него модель регулярно отвечает «сейчас сгенерирую:» и заканчивает ход, не
 * вызвав GENERATE_IMAGE или WRITE_WIKI. Raw-путь форсит это через tool_choice; у query()
 * такого параметра нет, флаг молча игнорировался — а на проде USE_AGENT_SDK=true,
 * то есть ровно там, где он нужен, его и не было.
 */
import { describe, test, expect } from "bun:test";
import { FORCE_FIRST_TOOL_BLOCK } from "../lib/agent-sdk-runtime.ts";

describe("FORCE_FIRST_TOOL_BLOCK", () => {
  test("требует вызова инструмента, а не текста", () => {
    expect(FORCE_FIRST_TOOL_BLOCK).toContain("ВЫЗОВА ИНСТРУМЕНТА");
  });

  test("прямо отбивает ответы «сейчас сделаю» — это и был симптом", () => {
    expect(FORCE_FIRST_TOOL_BLOCK).toContain("сейчас сделаю");
  });

  test("уходит в system последним, уже за фенсом предыстории", () => {
    // Блок начинается с переводов строк: он приклеивается к хвосту
    // systemText + historyBlock(), и его нельзя перепутать с чужой репликой.
    expect(FORCE_FIRST_TOOL_BLOCK.startsWith("\n\n")).toBe(true);
    expect(FORCE_FIRST_TOOL_BLOCK).toContain("ОБЯЗАТЕЛЬНО");
  });
});
