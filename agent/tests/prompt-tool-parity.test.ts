/**
 * Аудит 2026-08-12: промпты двух ролей требуют вызвать инструменты, которых
 * модели никогда не отдавали.
 *
 * Замер (scratchpad-проба по TOOLS / ACTION_TYPES / CHARACTERS):
 *
 *   тулов отдаётся модели: 37 | типов действий: 31
 *   есть в ACTION_TYPES, но модель вызвать не может:
 *     GRANT_PERMISSION, UPDATE_AGENT_PROMPT, CHANGE_AGENT_STATUS,
 *     REVIEW_AND_MERGE_PR, CREATE_DIAGNOSTIC_TASK, SPAWN_ROLE
 *
 *   [orchestrator] промпт требует то, чего нет в TOOLS: REVIEW_AND_MERGE_PR
 *   [perm]         промпт требует то, чего нет в TOOLS:
 *                  GRANT_PERMISSION, CHANGE_AGENT_STATUS, UPDATE_AGENT_PROMPT
 *
 * Это не регрессия: `git log -S` показывает, что ни одно из шести имён никогда
 * не было в tools-schema.ts. Хендлеры написаны, покрыты тестами (t511, t701,
 * t702, t703, t512, c15) и загорожены CALLER_RESTRICTED — но провода от модели
 * к ним нет. Оба рантайма (`tool-loop.ts`, `agent-sdk-runtime.ts`)
 * строят список строго из `TOOLS` и только фильтруют его; ничто не добавляет
 * туда действия по роли. Апрувы минтятся единственным местом —
 * `gateOrDispatch` в action-dispatch.ts, то есть тоже с вызова модели.
 * Значит и путь «через апрув владельца» этих шести не достигает.
 *
 * Чем это стоило:
 *  • orchestrator'у предписано «в начале каждой итерации, ПЕРЕД тем как брать
 *    новый таск» разобрать открытые PR — то есть каждая итерация начинается с
 *    попытки вызвать несуществующий тул. Разбор PR на самом деле живёт в
 *    отдельном проходе (`agent.ts --mode review` → orchestrator/review-mode.ts),
 *    и его тоже никто не запускает: ни один workflow не передаёт `--mode`.
 *  • у `perm` из трёх мандатов состоит вся роль целиком.
 *
 * Инвариант: ни один системный промпт не вправе требовать действия, которого
 * модель не может вызвать. Либо действие в TOOLS, либо промпт о нём молчит.
 */
import { describe, test, expect } from "bun:test";
import { TOOLS } from "../lib/tools-schema.ts";
import { ACTION_TYPES, DISPATCH_ONLY_ACTIONS } from "../lib/permissions.ts";
import { CHARACTERS } from "../characters/index.ts";

const toolNames = new Set(TOOLS.map((t) => t.name));
const actionTypes = new Set<string>(ACTION_TYPES as readonly string[]);

/**
 * SCREAMING_SNAKE-имена в тексте промпта. Порог в 5 символов отсекает «PR», «CI»
 * и прочие аббревиатуры, которые именами действий не являются.
 */
function mentionedActions(text: string): string[] {
  const words = new Set(text.match(/\b[A-Z][A-Z0-9_]{4,}\b/g) ?? []);
  return [...words].filter((w) => actionTypes.has(w));
}

describe("промпт не зовёт того, чего модели не дали", () => {
  for (const c of CHARACTERS) {
    test(`${c.key}: каждое упомянутое действие есть в TOOLS`, () => {
      const ghost = mentionedActions(c.system ?? "").filter((a) => !toolNames.has(a));
      // Сообщение печатает и строку промпта — чтобы падение сразу показывало,
      // что именно править, а не только имя.
      const where = ghost
        .map((g) => `${g}: ${((c.system ?? "").split("\n").find((l) => l.includes(g)) ?? "").trim().slice(0, 160)}`)
        .join("\n");
      expect(ghost.length === 0 ? "" : `${c.key} требует недоступное:\n${where}`).toBe("");
    });
  }

  test("шесть действий по-прежнему не отдаются модели — это фиксируется осознанно", () => {
    // Обратная сторона инварианта: тест выше можно «починить» и добавив шесть
    // действий в TOOLS. Это расширение поверхности прав модели — решение
    // владельца, а не автономного цикла. Пока решение не принято, состав
    // недоступных действий закреплён: изменится он — тест заставит перечитать
    // шапку этого файла и PR, в котором он появился.
    const unreachable = [...actionTypes].filter((a) => !toolNames.has(a)).sort();
    expect(unreachable).toEqual(Object.keys(DISPATCH_ONLY_ACTIONS).sort());
  });
});
