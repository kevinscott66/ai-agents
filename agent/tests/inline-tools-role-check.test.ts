/**
 * Инлайновые инструменты проверяют роль вызывающего (аудит 2026-08-04).
 *
 * executeTool обслуживает часть инструментов сам, коротким замыканием до
 * gateOrDispatch. Это осознанно — read-only справочники не нужно ни гейтить, ни
 * писать в agent_actions. Побочный эффект был неосознанным: мимо гейта проходят
 * и CALLER_RESTRICTED, и строка permissions, так что для инлайновых тулз
 * ROLE_EXPOSED_TOOLS оставался лишь фильтром выдачи в промпте.
 *
 * Список инструментов — не граница безопасности: он держится на том, что модель
 * не назовёт инструмент, которого ей не давали. Против prompt-injection (а SQL
 * сюда приходит именно из tool-call модели, см. шапку query-db.ts) это ровно то
 * допущение, которое ломается первым. У QUERY_DB — произвольный SELECT по
 * операционной БД без chat-скоупа — других преград не было вовсе.
 */
import { describe, test, expect } from "bun:test";
import { executeTool, INLINE_TOOL_NAMES } from "../lib/tools-schema.ts";
import { ROLE_EXPOSED_TOOLS, CALLER_RESTRICTED, isToolExposedToRole } from "../lib/permissions.ts";

const ctx = (agentKey: string) => ({ agentKey, chatId: -1, telegram: {} }) as any;

async function call(name: string, role: string, input: Record<string, unknown> = {}) {
  return JSON.parse(await executeTool(name, input, ctx(role))) as {
    ok: boolean;
    error?: string;
  };
}

describe("QUERY_DB", () => {
  test("чужая роль получает отказ", async () => {
    const out = await call("QUERY_DB", "smm", { sql: "SELECT 1" });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/forbidden/);
  });

  test("отказ наступает ДО исполнения запроса", async () => {
    // Синтаксически валидный, но запрещённый по префиксу SQL: если бы роль
    // проверялась после валидатора, текст ошибки был бы про префикс.
    const out = await call("QUERY_DB", "design", { sql: "DELETE FROM tasks" });
    expect(out.error).toMatch(/forbidden/);
    expect(out.error).not.toMatch(/SELECT\/WITH/);
  });

  test("своей роли отказа по роли нет", async () => {
    // Намеренно невалидный SQL: до песочницы (spawn воркера) доходить незачем,
    // важно лишь что отказ теперь не про роль.
    const out = await call("QUERY_DB", "backend", { sql: "DELETE FROM tasks" });
    expect(out.ok).toBe(false);
    expect(out.error).not.toMatch(/forbidden/);
  });
});

describe("класс целиком, а не один инструмент", () => {
  const restricted = [...INLINE_TOOL_NAMES].filter(
    (t) => CALLER_RESTRICTED[t] || ROLE_EXPOSED_TOOLS[t],
  );

  test("список ограниченных инлайновых тулз не пуст", () => {
    // Иначе следующий тест зелен вхолостую.
    expect(restricted.length).toBeGreaterThan(0);
  });

  for (const tool of restricted) {
    test(`${tool}: роль вне списка не проходит`, async () => {
      const allowed = CALLER_RESTRICTED[tool]
        ? [CALLER_RESTRICTED[tool]]
        : [...(ROLE_EXPOSED_TOOLS[tool] ?? [])];
      const outsider = ["smm", "backend", "design", "qa", "perm"].find(
        (r) => !allowed.includes(r),
      )!;
      expect(isToolExposedToRole(tool, outsider)).toBe(false);
      const out = await call(tool, outsider, { sql: "SELECT 1", id: "x", agentKey: "qa" });
      expect(out.ok).toBe(false);
      expect(out.error).toMatch(/forbidden/);
    });
  }
});
