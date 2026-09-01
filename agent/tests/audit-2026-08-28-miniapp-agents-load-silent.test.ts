/**
 * Аудит 2026-08-28: отказ справочника агентов проглатывался молча.
 *
 * Logs и Tasks обе делали `api.agents().then(...).catch(() => {})`. Не ронять
 * страницу из-за справочного запроса — верно, список действий и список задач
 * приезжают своими вызовами. Но следа не оставалось никакого: `<select>` молча
 * оставался пустым, а пустой список выглядит как «агентов нет», а не как
 * «спросить не удалось».
 *
 * Больнее всего в модалке новой задачи (Tasks): из этого же списка выбирают
 * исполнителя, и молчаливый отказ означает «задачу не на кого назначить» без
 * единого слова о причине.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  AGENTS_EMPTY,
  agentsHint,
  loadAgents,
} from "../miniapp/src/lib/agents-load.ts";

const agent = (key: string) => ({ key, title: key, online: true }) as any;

function src(name: string): string {
  return readFileSync(new URL(`../miniapp/src/pages/${name}`, import.meta.url), "utf8");
}

describe("loadAgents", () => {
  test("успех отдаёт список и не помечает отказ", async () => {
    const st = await loadAgents(async () => ({ agents: [agent("pm"), agent("qa")] }));
    expect(st.agents.map((a) => a.key)).toEqual(["pm", "qa"]);
    expect(st.failed).toBe(false);
  });

  test("отказ не бросает наружу, но запоминается", async () => {
    const st = await loadAgents(async () => {
      throw new Error("503");
    });
    expect(st.agents).toEqual([]);
    expect(st.failed).toBe(true);
  });

  test("пустой список без отказа — это просто пусто", async () => {
    const st = await loadAgents(async () => ({ agents: [] }));
    expect(st.failed).toBe(false);
  });

  test("ответ без массива считается отказом", async () => {
    const st = await loadAgents(async () => ({}) as any);
    expect(st).toEqual({ agents: [], failed: true });
  });
});

describe("agentsHint", () => {
  test("молчит, пока ничего не сломалось", () => {
    expect(agentsHint(AGENTS_EMPTY)).toBeNull();
    expect(agentsHint({ agents: [agent("pm")], failed: false })).toBeNull();
  });

  test("подписывает пустой список после отказа", () => {
    const hint = agentsHint({ agents: [], failed: true });
    expect(typeof hint).toBe("string");
    expect(hint).toContain("не загрузился");
  });

  test("не пугает поверх работающего фильтра: что-то приехало — молчим", () => {
    expect(agentsHint({ agents: [agent("pm")], failed: true })).toBeNull();
  });

  test("AGENTS_EMPTY — не «отказ»", () => {
    expect(AGENTS_EMPTY.failed).toBe(false);
    expect(AGENTS_EMPTY.agents).toEqual([]);
  });
});

describe("страницы больше не глушат отказ", () => {
  for (const page of ["Logs.tsx", "Tasks.tsx"]) {
    test(`${page}: справочник грузится через loadAgents`, () => {
      const text = src(page);
      expect(text).toContain("loadAgents(() => api.agents())");
      // Ровно тот проглатыватель, из-за которого всё и затевалось.
      expect(text).not.toContain("api.agents().then");
      expect(text).toContain("agentsHint(agentsState)");
    });
  }

  test("Tasks: подписан и фильтр, и выбор исполнителя в модалке", () => {
    // Два списка агентов на странице; молчал раньше каждый.
    const text = src("Tasks.tsx");
    expect(text.split("agentsHint(agentsState)").length - 1).toBe(4);
  });
});
