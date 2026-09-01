/**
 * Аудит 2026-08-12: CREATE_TEAM_CHANNEL молча выбрасывал роли, которые не смог
 * опознать, и создавал канал без них.
 *
 * `roles` — это список ролей, чьих ботов надо сразу добавить админами в новый
 * канал. build-payload принимал его как свободные строки: `.map(String)
 * .filter(Boolean)` и всё. Дальше в action-dispatch каждая роль резолвится
 * через `ctx.resolveAgent?.(role)`; неизвестная роль даёт `undefined`, и её
 * просто пропускают. Orchestrator добавляется всегда, поэтому `usernames`
 * никогда не пустой — то есть ветка «не удалось резолвить ботов» не
 * срабатывает, и хендлер возвращает ok.
 *
 * Итог опечатки `["smm", "desing", "copy"]`: канал СОЗДАН, в нём один
 * orchestrator, `res.added` не упоминает ни smm, ни copy, ни `desing` — они
 * исчезли между payload'ом и вызовом. Ошибки нет, лог у создания успешный.
 *
 * Два соседних действия с тем же входом ведут себя ровно наоборот: SPLIT_TASK
 * и DELEGATE_TO_ROLE сверяют роль с ROLE_KEYS и отказывают текстом
 * `unknown role: X`. И в tools-schema их массив ролей объявлен через
 * `enum: ROLE_KEYS` — модели прямо перечислено, что можно; у
 * CREATE_TEAM_CHANNEL стояло голое `items: { type: "string" }`.
 *
 * Цена ошибки здесь выше, чем у соседей: создание канала необратимо. Повтор
 * после «странно, ботов нет» создаёт ВТОРОЙ канал, а первый остаётся висеть в
 * аккаунте владельца — его руками удалять.
 *
 * Инвариант: роль, которую попросил вызывающий, либо попадает в канал, либо
 * названа в отказе. Молча не исчезает.
 */
import { describe, test, expect } from "bun:test";
import { buildPayload } from "../lib/action-dispatch.ts";
import { CHARACTERS } from "../characters/index.ts";
import { TOOLS } from "../lib/tools-schema.ts";

const CTX = { agentKey: "orchestrator", chatId: -1 } as any;

function build(input: Record<string, unknown>) {
  return buildPayload("CREATE_TEAM_CHANNEL" as any, input, CTX);
}

describe("CREATE_TEAM_CHANNEL: неизвестная роль — отказ, а не тихий пропуск", () => {
  test("опечатка в роли отклоняется с именем роли", () => {
    const r = build({ title: "Канал", roles: ["desing"] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("desing");
  });

  test("одна опечатка среди верных ролей не превращается в урезанный список", () => {
    const r = build({ title: "Канал", roles: ["smm", "desing", "copy"] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("desing");
    // Важно именно это: до правки payload проходил дальше, и канал создавался
    // вообще без smm и copy — они терялись уже в хендлере, вместе с опечаткой.
  });

  test("роль-самозванец не проезжает под видом строки", () => {
    for (const bad of ["orchestrator ", "SMM", "admin", "_team", "../smm"]) {
      const r = build({ title: "Канал", roles: [bad] });
      expect(r.ok).toBe(false);
    }
  });

  test("нестроковый элемент массива тоже отказ, а не String(x)", () => {
    const r = build({ title: "Канал", roles: [{ role: "smm" }] });
    expect(r.ok).toBe(false);
  });
});

describe("CREATE_TEAM_CHANNEL: верные роли проходят как есть", () => {
  test("список ролей доезжает без изменений", () => {
    const r = build({ title: "Канал", roles: ["smm", "design", "copy"], about: "о" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.payload as any).roles).toEqual(["smm", "design", "copy"]);
  });

  test("каждая роль из CHARACTERS принимается", () => {
    for (const c of CHARACTERS) {
      const r = build({ title: "Канал", roles: [c.key] });
      expect(r.ok).toBe(true);
    }
  });

  test("пустой список ролей по-прежнему допустим — канал только с лидом", () => {
    const r = build({ title: "Канал", roles: [] });
    expect(r.ok).toBe(true);
  });
});

describe("tools-schema: модели перечислены допустимые роли", () => {
  const tool = TOOLS.find((t: any) => t.name === "CREATE_TEAM_CHANNEL") as any;
  const split = TOOLS.find((t: any) => t.name === "SPLIT_TASK") as any;

  test("roles объявлен enum'ом ролей, как у SPLIT_TASK", () => {
    const items = tool.input_schema.properties.roles.items;
    expect(Array.isArray(items.enum)).toBe(true);
    expect([...items.enum].sort()).toEqual(
      [...split.input_schema.properties.roles.items.enum].sort(),
    );
  });

  test("enum совпадает с реальным списком ролей", () => {
    const items = tool.input_schema.properties.roles.items;
    expect([...items.enum].sort()).toEqual(CHARACTERS.map((c) => c.key).sort());
  });
});
