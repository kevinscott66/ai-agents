/**
 * Инварианты реестра инструментов (аудит 2026-08-02).
 *
 * Регистрация инструмента размазана по трём независимым спискам, и рассинхрон
 * между ними не ловится ни типами, ни рантаймом — он выглядит как «модель
 * почему-то не пользуется инструментом». Прецедент: SCHEDULE_POST был объявлен
 * в TOOLS, имел payload-валидатор и case в диспатчере, но отсутствовал в
 * TOOL_NAMES — executeTool отбивал его на `unknown tool` ДО gateOrDispatch, так
 * что не появлялось ни строки в agent_actions, ни ошибки в дайджесте. Модель
 * видела инструмент, вызывала его и молча получала отказ.
 */
import { describe, test, expect } from "bun:test";
import { TOOLS, TOOL_NAMES, INLINE_TOOL_NAMES } from "../lib/tools-schema.ts";
import { ACTION_TYPES, DISPATCH_ONLY_ACTIONS } from "../lib/permissions.ts";

const declared = new Set(TOOLS.map((t) => t.name));
const executable = new Set([...TOOL_NAMES, ...INLINE_TOOL_NAMES]);

describe("реестр инструментов", () => {
  test("каждый объявленный модели инструмент имеет исполнителя", () => {
    // Провал = ровно баг SCHEDULE_POST: модель зовёт, executeTool не знает.
    expect([...declared].filter((n) => !executable.has(n))).toEqual([]);
  });

  test("каждый исполнимый инструмент объявлен модели", () => {
    // Провал = мёртвая ветка в executeTool: код есть, вызвать некому.
    expect([...executable].filter((n) => !declared.has(n))).toEqual([]);
  });

  test("TOOL_NAMES и INLINE_TOOL_NAMES не пересекаются", () => {
    // Пересечение означает, что inline-обработчик перехватывает инструмент до
    // gateOrDispatch — то есть в обход permissions-гейта и аудита.
    expect([...TOOL_NAMES].filter((n) => INLINE_TOOL_NAMES.has(n))).toEqual([]);
  });

  test("список действий, скрытых от модели, не разъехался с ACTION_TYPES", () => {
    const hidden: string[] = ACTION_TYPES.filter((a) => !declared.has(a)).sort();
    const documented = Object.keys(DISPATCH_ONLY_ACTIONS).sort();
    // Если тест упал — появилось новое действие, которое модель не видит.
    // Либо добавь его в TOOLS (и в TOOL_NAMES!), либо впиши сюда с причиной.
    expect(hidden).toEqual(documented);
  });
});
