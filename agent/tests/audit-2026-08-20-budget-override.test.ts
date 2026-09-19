/**
 * «Без лимита» в настройках молча возвращалось к прежнему числу.
 *
 * Поле дневного лимита заполнялось значением из `GET /api/budgets`, а там
 * лежит ИТОГОВЫЙ лимит: `getBudget()` идёт по четырём ступеням — строка
 * `budget_settings`, `TOKEN_BUDGET_<AGENT>`, `TOKEN_BUDGET_DEFAULT`,
 * Infinity (`lib/token-budget.ts:143-163`). Пишет же форма только первую
 * ступень: `POST /api/budgets` кладёт или снимает строку override.
 *
 * Отсюда расхождение. Если лимит приходит из окружения, а строки в БД нет,
 * админ видит в поле, скажем, 500000 — как будто у роли есть свой лимит.
 * Стирает его, жмёт «Сохранить»: клиент шлёт `dailyInputTokens: null`, сервер
 * снимает строку, которой не было, `load()` перечитывает — и в поле снова
 * 500000. Ни ошибки, ни объяснения; выглядит как «настройка не сохраняется».
 *
 * Чинится тем, что форма правит ровно то, что пишет: свои override-строки из
 * `GET /api/budget-settings`. Пустое поле теперь честно значит «своего лимита
 * нет, действует общий», и итоговый лимит показан рядом отдельной строкой.
 *
 * В конфигурации, где TOKEN_BUDGET_* не заданы (так и уехало в .env.example),
 * итоговый лимит и override совпадают — там фикс ничего не меняет.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import {
  budgetChanges,
  overrideMap,
  keepUnsavedDrafts,
} from "../miniapp/src/pages/Settings.tsx";

function row(agentKey: string, dailyInputTokens: number) {
  return { agentKey, dailyInputTokens, updatedAt: 0, updatedBy: "miniapp:1" };
}

describe("overrideMap", () => {
  test("нет строк — нет и своих лимитов", () => {
    expect(overrideMap([])).toEqual({});
  });

  test("строка становится числом", () => {
    expect(overrideMap([row("backend", 300_000)])).toEqual({
      backend: 300_000,
    });
  });

  test("несколько ролей не смешиваются", () => {
    expect(overrideMap([row("backend", 300_000), row("qa", 50_000)])).toEqual({
      backend: 300_000,
      qa: 50_000,
    });
  });
});

describe("что уходит на сервер", () => {
  test("нетронутая форма при лимите из окружения не шлёт ничего", () => {
    // Главный случай. Своей строки нет, поле пустое; итоговые 500000 приходят
    // из TOKEN_BUDGET_DEFAULT и формы не касаются.
    expect(budgetChanges({ backend: null }, overrideMap([]))).toEqual([]);
  });

  test("свой лимит поверх общего — это запись", () => {
    expect(budgetChanges({ backend: 100_000 }, overrideMap([]))).toEqual([
      { agentKey: "backend", dailyInputTokens: 100_000 },
    ]);
  });

  test("снятие своего лимита — это null", () => {
    expect(
      budgetChanges({ backend: null }, overrideMap([row("backend", 300_000)])),
    ).toEqual([{ agentKey: "backend", dailyInputTokens: null }]);
  });

  test("свой лимит не тронули — не шлём", () => {
    expect(
      budgetChanges(
        { backend: 300_000 },
        overrideMap([row("backend", 300_000)]),
      ),
    ).toEqual([]);
  });
});

describe("проводка Settings.tsx", () => {
  const RAW = readFileSync(
    new URL("../miniapp/src/pages/Settings.tsx", import.meta.url),
    "utf8",
  );
  const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

  test("страница читает свои override-строки", () => {
    expect(SRC).toMatch(/api\s*\.\s*budgetSettings\(\)/);
  });

  test("форма заполняется ими, а не итоговым лимитом", () => {
    // С AUD-015 после частичного сбоя поверх них кладутся недоехавшие черновики.
    expect(SRC).toMatch(/setEditingBudgets\(keep \? keepUnsavedDrafts\(next\.overrides, keep\.budgets, keep\.saved\) : next\.overrides\)/);
    expect(SRC).not.toMatch(/setEditingBudgets\(budgetMap\(/);
  });

  test("и отправляется диф против них же", () => {
    // Диф против итогового лимита и порождал фантомные правки.
    expect(SRC).toContain("const drafts = editingBudgets;");
    expect(SRC.match(/budgetChanges\((editingBudgets|drafts), settings\.overrides\)/g) ?? [])
      .toHaveLength(2);
    expect(SRC).not.toMatch(/budgetChanges\(editingBudgets, budgetMap\(/);
  });

  test("пустое поле подписано как «общий лимит», а не «без лимита»", () => {
    // Раньше placeholder обещал отсутствие лимита там, где он есть.
    expect(SRC).toMatch(/placeholder="Общий лимит"/);
  });

  test("итоговый лимит и его источник показаны рядом", () => {
    expect(SRC).toMatch(/effectiveHint\(/);
  });
});

describe("effectiveHint", () => {
  test("свой лимит — подсказка не нужна", async () => {
    const { effectiveHint } = await import("../miniapp/src/pages/Settings.tsx");
    expect(effectiveHint(300_000, 300_000)).toBe(null);
  });

  test("своего нет, общий есть — называем число", async () => {
    const { effectiveHint } = await import("../miniapp/src/pages/Settings.tsx");
    expect(effectiveHint(null, 500_000)).toContain("500");
  });

  test("нет ни своего, ни общего — так и говорим", async () => {
    const { effectiveHint } = await import("../miniapp/src/pages/Settings.tsx");
    expect(effectiveHint(null, null)).toBe("без лимита");
  });
});

describe("AUD-015: частичное сохранение не стирает черновики", () => {
  test("подтверждённое — с сервера, не отправленное — из черновика", () => {
    const server = { a: 100, b: 200, c: null };
    const drafts = { a: 150, b: 250, c: 300 };
    // a записался, b упал, c не отправлялся.
    expect(keepUnsavedDrafts(server, drafts, new Set(["a"]))).toEqual({ a: 100, b: 250, c: 300 });
  });
  test("без сохранённого — форма как у владельца", () => {
    expect(keepUnsavedDrafts({ a: 1 }, { a: 2, b: null }, new Set())).toEqual({ a: 2, b: null });
  });
  test("повтор отправляет только недоехавшее", () => {
    const server = { a: 150, b: 200 };
    const form = keepUnsavedDrafts(server, { a: 150, b: 250 }, new Set(["a"]));
    expect(budgetChanges(form, server)).toEqual([{ agentKey: "b", dailyInputTokens: 250 }]);
  });
  test("поля заблокированы на время отправки, заголовки — из темы", () => {
    const src = readFileSync(new URL("../miniapp/src/pages/Settings.tsx", import.meta.url), "utf8");
    expect(src.match(/disabled=\{readonly \|\| saving\}/g)?.length).toBe(2);
    expect(src).not.toContain("#2c3e50");
    expect(src).not.toContain("onRetry={load}");
  });
});
