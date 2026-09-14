/**
 * Аудит 2026-08-21: setBudget — единственный писатель в token-budget.ts,
 * который не приводил ключ к владельцу.
 *
 * Читатели приводят все: `getBudget` ищет строку `budget_settings` по
 * `budgetOwner(agentKey)`, туда же смотрят recordUsage, getDailyUsage,
 * checkBudget и budgetRemaining. Значит запись по производному ключу
 * (`design:svg-fallback`) ложилась строкой, которую не прочитает никто —
 * лимит выставлен и виден в `GET /api/budget-settings`, а на расход не
 * влияет. Ровно та тихая поломка потолка, ради которой budgetOwner и заводили
 * (см. её описание в шапке token-budget.ts).
 *
 * Через HTTP сейчас недостижимо: `badAgentKey` (miniapp-server.ts)
 * пропускает только ключи из CHARACTERS, двоеточий в них нет. Но охрана стоит
 * у вызывающего, а не у функции. В проде строк в budget_settings ноль.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import { setBudget, getBudget, getAllBudgetSettings, budgetOwner } from "../lib/token-budget.ts";

const OWNER = "zzbudgetowner";
const DERIVED = `${OWNER}:svg-fallback`;

afterEach(() => {
  db.prepare(`DELETE FROM budget_settings WHERE agent_key = ?`).run(OWNER);
  db.prepare(`DELETE FROM budget_settings WHERE agent_key = ?`).run(DERIVED);
});

describe("setBudget пишет по тому же ключу, по которому читают", () => {
  test("лимит, выставленный производному ключу, действительно действует", () => {
    setBudget(DERIVED, 1234, "test");

    // До правки строка лежала под 'zzbudgetowner:svg-fallback', а getBudget
    // искал 'zzbudgetowner' — и не находил ничего.
    expect(getBudget(DERIVED)).toBe(1234);
    // Тот же потолок — у владельца: расход-то считается на него.
    expect(getBudget(OWNER)).toBe(1234);
  });

  test("строка хранится под ключом владельца, а не производным", () => {
    setBudget(DERIVED, 999, "test");

    const keys = getAllBudgetSettings().map((b) => b.agentKey);
    expect(keys).toContain(OWNER);
    expect(keys).not.toContain(DERIVED);
    expect(budgetOwner(DERIVED)).toBe(OWNER);
  });

  test("снятие лимита производным ключом снимает лимит владельца", () => {
    setBudget(OWNER, 555, "test");
    expect(getBudget(OWNER)).toBe(555);

    setBudget(DERIVED, null);

    // До правки DELETE бил по несуществующей строке, а лимит оставался.
    expect(getBudget(OWNER)).not.toBe(555);
    expect(getAllBudgetSettings().map((b) => b.agentKey)).not.toContain(OWNER);
  });

  test("обычный ключ роли ведёт себя как прежде", () => {
    setBudget(OWNER, 777, "test");
    expect(getBudget(OWNER)).toBe(777);

    setBudget(OWNER, null);
    expect(getAllBudgetSettings().map((b) => b.agentKey)).not.toContain(OWNER);
  });

  test("пустой ключ по-прежнему отбивается", () => {
    expect(() => setBudget("", 100)).toThrow(/agentKey required/);
  });
});
