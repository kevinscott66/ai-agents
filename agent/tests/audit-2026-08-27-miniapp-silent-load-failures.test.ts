/**
 * Аудит 2026-08-27: три места в Mini App, где отказ ручки рисовался как
 * содержательный ответ.
 *
 * 1. `Agents.tsx::loadAgentAutonomy` глотала всё в `catch {}`. `autoMode[key]`
 *    оставался `undefined`, выпадающий список падал на пустой пункт — тот же
 *    самый, что и до загрузки. «Не знаем, есть ли у роли исключение» выглядело
 *    неотличимо от «исключения нет», и админ заводил переопределение поверх
 *    уже существующего.
 * 2. `Dashboard.tsx` подменял отказ `/api/budgets` пустым списком, и блок
 *    рисовал EmptyState «Токены пока не тратились» — прямое утверждение о
 *    факте, выведенное из отсутствия ответа.
 * 3. `Settings.tsx` так же подменял отказ `/api/budget-settings`, и форма
 *    показывала «нет своего лимита» для каждой роли.
 *
 * Инвариант: отказ чтения не превращается ни в значение, ни в ноль.
 *
 * DOM-харнесса у Mini App нет, поэтому решение вынесено в чистую функцию
 * (`autonomySelectState`), а расстановка веток в разметке проверяется чтением
 * исходника — так же, как в `miniapp-permissions-ui.test.ts`.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  autonomySelectState,
  AUTONOMY_PLACEHOLDERS,
} from "../miniapp/src/pages/Agents.tsx";

function src(name: string): string {
  return readFileSync(
    join(import.meta.dir, "..", "miniapp", "src", "pages", name),
    "utf-8",
  );
}

/** Только код: комментарии тут цитируют исправленное и ломали бы проверки. */
function code(name: string): string {
  return src(name)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\s*\/\/.*$/, ""))
    .join("\n");
}

describe("Agents: режим автономности — отказ отличим от «нет переопределения»", () => {
  test("загруженный режим — ready", () => {
    expect(autonomySelectState(false, null, true)).toBe("ready");
  });

  test("ещё не пришло — loading, а не ready", () => {
    expect(autonomySelectState(false, null, false)).toBe("loading");
  });

  test("отказ — error, даже если прошлое значение осталось в кэше", () => {
    expect(autonomySelectState(false, "500", true)).toBe("error");
    expect(autonomySelectState(false, "500", false)).toBe("error");
  });

  test("запись в полёте важнее прошлой ошибки чтения", () => {
    expect(autonomySelectState(true, "500", true)).toBe("busy");
  });

  test("у каждого состояния свой текст пустого пункта", () => {
    const texts = Object.values(AUTONOMY_PLACEHOLDERS);
    expect(new Set(texts).size).toBe(texts.length);
    expect(AUTONOMY_PLACEHOLDERS.error).not.toBe(
      AUTONOMY_PLACEHOLDERS.loading,
    );
    expect(AUTONOMY_PLACEHOLDERS.error).not.toBe(AUTONOMY_PLACEHOLDERS.ready);
  });

  test("loadAgentAutonomy больше не имеет пустого catch", () => {
    const s = code("Agents.tsx");
    const body = s.slice(
      s.indexOf("async function loadAgentAutonomy"),
      s.indexOf("const agentKeys ="),
    );
    expect(body.length).toBeGreaterThan(0);
    expect(body).not.toMatch(/catch\s*\{\s*\}/);
    expect(body).toContain("setAutoErr");
  });

  test("значение списка не берётся из кэша, когда состояние не ready", () => {
    const s = code("Agents.tsx");
    expect(s).toContain('value={autoState === "ready" ? autoMode[a.key] : ""}');
    // Пустой пункт нельзя выбрать: это послало бы mode="" в API.
    expect(s).toContain('<option value="" disabled>');
  });
});

describe("Dashboard: отказ /api/budgets не выдаётся за нулевые траты", () => {
  test("EmptyState стоит после ветки ошибки, а не вместо неё", () => {
    const s = code("Dashboard.tsx");
    const err = s.indexOf("budgetsErr ? (");
    const empty = s.indexOf('title="Токены пока не тратились"');
    expect(err).toBeGreaterThan(-1);
    expect(empty).toBeGreaterThan(err);
  });

  test("catch записывает ошибку, а не только пустой список", () => {
    const s = code("Dashboard.tsx");
    expect(s).not.toContain("api.budgets().catch(() =>");
    expect(s).toContain("budgetsFailed.err = formatApiError(e)");
    expect(s).toContain("setBudgetsErr(budgetsFailed.err)");
    // Успешный агрегированный путь обязан гасить флаг, иначе ошибка залипнет.
    expect(s).toContain("setBudgetsErr(null)");
  });
});

describe("Settings: отказ /api/budget-settings не выдаётся за «лимитов нет»", () => {
  test("catch записывает ошибку и она рисуется", () => {
    const s = code("Settings.tsx");
    expect(s).not.toContain("api.budgetSettings().catch(() =>");
    // Аудит 2026-09-11 развёл здесь два разных отказа: 403 — штатный ответ
    // зрителю, всё прочее — сбой. Решение переехало в чистую `overridesFailure`
    // (см. audit-2026-09-11-miniapp-viewer-dead-ends.test.ts), поэтому имена
    // другие. Проверяем то же самое: ошибка ЗАПИСЫВАЕТСЯ и РИСУЕТСЯ.
    expect(s).toContain("overridesFailure(e, formatApiError(e))");
    expect(s).toContain("setOverridesErr(overridesOutcome.err)");
    expect(s).toContain("message={overridesErr}");
  });
});
