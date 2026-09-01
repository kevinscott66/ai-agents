/**
 * Аудит 2026-08-12: расход писался на владельца, а читался по ключу вызова.
 *
 * Производные ключи существуют: `svg-fallback.ts:71` бьёт в
 * `${agentKey}:svg-fallback`. Поэтому `recordUsage` нормализует ключ —
 * `budgetOwner(agentKey)`, всё до первого двоеточия, — и строка в
 * `agent_token_usage` всегда одна, на владельца. Так же поступают
 * `checkBudget` и `budgetRemaining`.
 *
 * А `getDailyUsage` и `getBudget` — нет: они шли в базу с тем ключом, что дали.
 * Замер (design + design:svg-fallback, лимит 1000, расход 1500):
 *
 *   getDailyUsage("design").input              → 1500
 *   getDailyUsage("design:svg-fallback").input → 0        ← строки нет
 *   getBudget("design")                        → 1000
 *   getBudget("design:svg-fallback")           → Infinity ← лимит не найден
 *
 * Читатель и писатель разошлись, и хуже всего это видно в SDK-пути
 * (`lib/agent-sdk-runtime.ts`): решение «бюджет исчерпан» принимается по
 * `budgetRemaining` (владелец), а числа в исключении берутся по сырому ключу —
 *
 *   throw new BudgetExceededError(
 *     opts.agentKey, getDailyUsage(opts.agentKey).input, getBudget(opts.agentKey));
 *
 * то есть ход обрывается, а сообщение говорит «used=0 budget=Infinity». Это
 * ровно та диагностика, ради которой исключение и заводили. То же и в
 * warn-строке: `agentKey: opts.agentKey` называет ключ вызова, хотя потолок,
 * в который упёрлись, принадлежит владельцу — соседний checkBudget уже пишет
 * `agentKey: owner` + `calledAs`.
 *
 * Инвариант: кто пишет расход на владельца, тот и читает с владельца.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  recordUsage,
  getDailyUsage,
  getBudget,
  setBudget,
  budgetRemaining,
  budgetOwner,
  todayUTC,
} from "../lib/token-budget.ts";
import { db } from "../lib/db.ts";

const OWNER = "_budgettest";
const DERIVED = `${OWNER}:svg-fallback`;

function clean() {
  db.prepare(`DELETE FROM agent_token_usage WHERE agent_key LIKE ?`).run(
    `${OWNER}%`,
  );
  db.prepare(`DELETE FROM budget_settings WHERE agent_key LIKE ?`).run(
    `${OWNER}%`,
  );
}

beforeEach(clean);
afterEach(clean);

describe("бюджет: чтение по тому же ключу, что и запись", () => {
  test("расход по производному ключу виден читателю", () => {
    recordUsage(DERIVED, 1500, 200);
    expect(getDailyUsage(OWNER).input).toBe(1500);
    expect(getDailyUsage(DERIVED).input).toBe(1500);
  });

  test("лимит владельца действует и для производного ключа", () => {
    setBudget(OWNER, 1000);
    expect(getBudget(OWNER)).toBe(1000);
    expect(getBudget(DERIVED)).toBe(1000);
  });

  test("числа для BudgetExceededError сходятся с решением budgetRemaining", () => {
    setBudget(OWNER, 1000);
    recordUsage(DERIVED, 1500, 0);
    // Решение принимает budgetRemaining — по владельцу.
    expect(budgetRemaining(DERIVED)).toBe(0);
    // Числа для сообщения берутся этими двумя — должны говорить то же самое.
    const used = getDailyUsage(DERIVED).input;
    const budget = getBudget(DERIVED);
    expect(used).toBeGreaterThanOrEqual(budget);
    expect({ used, budget }).toEqual({ used: 1500, budget: 1000 });
  });

  test("обычный ключ без двоеточия не изменился", () => {
    setBudget(OWNER, 700);
    recordUsage(OWNER, 300, 10);
    expect(getDailyUsage(OWNER)).toEqual({ input: 300, output: 10 });
    expect(getBudget(OWNER)).toBe(700);
    expect(budgetOwner(OWNER)).toBe(OWNER);
  });

  test("явная дата по-прежнему учитывается", () => {
    recordUsage(DERIVED, 42, 0, "2020-01-01");
    expect(getDailyUsage(DERIVED, "2020-01-01").input).toBe(42);
    expect(getDailyUsage(DERIVED, todayUTC()).input).toBe(0);
    db.prepare(`DELETE FROM agent_token_usage WHERE date = ?`).run("2020-01-01");
  });
});

describe("SDK-путь называет владельца бюджета", () => {
  const SRC = readFileSync(
    join(import.meta.dir, "..", "lib", "agent-sdk-runtime.ts"),
    "utf8",
  );

  test("числа для исключения берутся не по сырому ключу вызова", () => {
    expect(SRC).not.toInclude("getDailyUsage(opts.agentKey)");
    expect(SRC).not.toInclude("getBudget(opts.agentKey)");
  });

  test("warn называет владельца и оставляет ключ вызова видимым", () => {
    const block = SRC.slice(SRC.indexOf("ход прерван: дневной бюджет исчерпан"));
    const upToThrow = block.slice(0, block.indexOf("BudgetExceededError") + 400);
    expect(upToThrow).toInclude("agentKey: owner");
    // Ключ вызова остаётся видимым — как в checkBudget.
    expect(upToThrow).toInclude("calledAs");
    expect(upToThrow).toMatch(/BudgetExceededError\(\s*owner,/);
  });
});
