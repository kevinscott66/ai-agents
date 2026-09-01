/**
 * Дневной лимит не обходится производным ключом (аудит 2026-08-04).
 *
 * Вспомогательные вызовы писали расход под ключом вида `${agentKey}:svg-fallback`
 * (lib/svg-fallback.ts). Такой ключ не совпадает ни с одной строкой
 * budget_settings, а env-имя TOKEN_BUDGET_DESIGN_SVG_FALLBACK никто не задаёт —
 * значит он молча получал TOKEN_BUDGET_DEFAULT, то есть отдельный
 * полноразмерный лимит.
 *
 * Итог: агент, упёршийся в свой дневной потолок, продолжал жечь токены через
 * фолбэк, а лимит, выставленный оператором в Mini App, на этот расход не влиял
 * вообще — расход по производному ключу в его строке даже не появлялся.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import {
  budgetOwner,
  recordUsage,
  getDailyUsage,
  checkBudget,
  setBudget,
  BudgetExceededError,
  todayUTC,
} from "../lib/token-budget.ts";

const AGENT = "_test_subkey_design";
const SUB = `${AGENT}:svg-fallback`;

function reset(): void {
  db.prepare(`DELETE FROM agent_token_usage WHERE agent_key IN (?, ?)`).run(
    AGENT,
    SUB,
  );
  db.prepare(`DELETE FROM budget_settings WHERE agent_key IN (?, ?)`).run(
    AGENT,
    SUB,
  );
}

beforeEach(reset);
afterEach(reset);

describe("budgetOwner", () => {
  test("режет по первому двоеточию", () => {
    expect(budgetOwner("design:svg-fallback")).toBe("design");
    expect(budgetOwner("design")).toBe("design");
  });

  test("системные ключи без двоеточия остаются собой", () => {
    // У компактора свой бюджет — это осознанно, он не «часть чьего-то хода».
    expect(budgetOwner("_compactor")).toBe("_compactor");
    expect(budgetOwner("_sdk")).toBe("_sdk");
  });
});

describe("расход по производному ключу", () => {
  test("ложится на владельца, а не в отдельную строку", () => {
    recordUsage(SUB, 1000, 200);

    expect(getDailyUsage(AGENT)).toEqual({ input: 1000, output: 200 });
    // Отдельной строки быть не должно — раньше весь расход уходил именно туда.
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM agent_token_usage WHERE agent_key = ? AND date = ?`,
        )
        .get(SUB, todayUTC()),
    ).toEqual({ n: 0 });
  });

  test("суммируется с основным расходом агента", () => {
    recordUsage(AGENT, 600, 0);
    recordUsage(SUB, 400, 0);
    expect(getDailyUsage(AGENT).input).toBe(1000);
  });
});

describe("лимит владельца действует на производный ключ", () => {
  test("исчерпанный бюджет агента закрывает и фолбэк", () => {
    setBudget(AGENT, 500);
    recordUsage(AGENT, 500, 0);

    // Основной путь закрыт — это и раньше работало.
    expect(() => checkBudget(AGENT)).toThrow(BudgetExceededError);
    // А этот вызов раньше проходил: свой ключ, свой TOKEN_BUDGET_DEFAULT.
    expect(() => checkBudget(SUB)).toThrow(BudgetExceededError);
  });

  test("ошибка называет владельца, а не производный ключ", () => {
    setBudget(AGENT, 100);
    recordUsage(SUB, 100, 0);
    try {
      checkBudget(SUB);
      throw new Error("должно было бросить");
    } catch (e) {
      expect(e).toBeInstanceOf(BudgetExceededError);
      expect((e as BudgetExceededError).agentKey).toBe(AGENT);
      expect((e as BudgetExceededError).used).toBe(100);
    }
  });

  test("в пределах лимита фолбэк по-прежнему разрешён", () => {
    setBudget(AGENT, 1000);
    recordUsage(SUB, 100, 0);
    expect(() => checkBudget(SUB)).not.toThrow();
  });
});
