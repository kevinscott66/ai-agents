/**
 * Аудит 2026-08-20: anti-dup глушил инструменты Lead'а даже тогда, когда
 * пользователь адресовал сообщение ЕМУ САМОМУ вместе с коллегами.
 *
 * `shouldAllowTools` возвращала false, как только в тексте встречался
 * @-хэндл любого другого нашего бота, — свой собственный хэндл не
 * проверялся вовсе. Реальный сценарий:
 *
 *   «@dlb_lead_bot собери релиз: баннер от @dlb_design_bot, текст от
 *    @dlb_copy_bot»
 *
 * Оркестратор — единственный бот с выключенным privacy mode, его handler
 * отрабатывает всегда; message-handler.ts передаёт `allowedTools: []`, и
 * Lead, которого прямым текстом попросили координировать, физически не
 * может вызвать CREATE_TASK / DELEGATE_TO_ROLE / SPLIT_TASK — только
 * ответить текстом «сейчас передам». Anti-dup существует ради случая
 * «обращаются НЕ к нему», а не «к нему в том числе».
 */
import { describe, test, expect } from "bun:test";
import type { ChatRow } from "../lib/db.ts";
import type { RunningBot } from "../lib/types.ts";
import { shouldAllowTools } from "../lib/anti-dup.ts";

function fakeBot(key: string, username: string, id: number): RunningBot {
  return { def: { key } as any, bot: {} as any, username, id };
}

const BOTS: RunningBot[] = [
  fakeBot("orchestrator", "dlb_lead_bot", 1),
  fakeBot("design", "dlb_design_bot", 2),
  fakeBot("copy", "dlb_copy_bot", 3),
];

const LEAD = { key: "orchestrator" } as const;
const NO_HISTORY: ChatRow[] = [];

describe("anti-dup: Lead адресован вместе с коллегами", () => {
  test("@lead + @design в одном сообщении → инструменты остаются", () => {
    expect(
      shouldAllowTools(
        LEAD,
        NO_HISTORY,
        "@dlb_lead_bot собери релиз: баннер от @dlb_design_bot, текст от @dlb_copy_bot",
        BOTS,
      ),
    ).toBe(true);

    // Порядок упоминаний не должен влиять.
    expect(
      shouldAllowTools(
        LEAD,
        NO_HISTORY,
        "баннер от @dlb_design_bot — @dlb_lead_bot проследи",
        BOTS,
      ),
    ).toBe(true);
  });

  test("хэндлы регистронезависимы", () => {
    expect(
      shouldAllowTools(
        LEAD,
        NO_HISTORY,
        "@DLB_Lead_Bot раздай задачи, @DLB_Design_Bot нарисует",
        BOTS,
      ),
    ).toBe(true);
  });

  test("адресован ТОЛЬКО коллега → инструменты по-прежнему выключены", () => {
    // Контроль: правило anti-dup не должно исчезнуть целиком.
    expect(
      shouldAllowTools(LEAD, NO_HISTORY, "@dlb_design_bot сделай опрос", BOTS),
    ).toBe(false);
    expect(
      shouldAllowTools(
        LEAD,
        NO_HISTORY,
        "@dlb_copy_bot перепиши анонс покороче",
        BOTS,
      ),
    ).toBe(false);
  });

  test("чужой хэндл с префиксом Lead'а не считается упоминанием Lead'а", () => {
    // @dlb_lead_bot2 — посторонний аккаунт, а не наш оркестратор.
    // Наивный includes("@dlb_lead_bot") принял бы его за своего.
    expect(
      shouldAllowTools(
        LEAD,
        NO_HISTORY,
        "@dlb_lead_bot2 глянь, @dlb_design_bot сделает баннер",
        BOTS,
      ),
    ).toBe(false);
  });

  test("без единого @-хэндла ничего не меняется → true", () => {
    expect(shouldAllowTools(LEAD, NO_HISTORY, "как дела, команда?", BOTS)).toBe(
      true,
    );
  });
});
