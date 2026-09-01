/**
 * Аудит 2026-08-29: `shapeRuns` — единственный из трёх шейперов `lib/github.ts`
 * без проверки `Array.isArray`.
 *
 * Докблок файла (правка 2026-08-20) обещает: при неожиданном типе ответа «все
 * три шейпера получают не тот тип и молча возвращают []». Для `shapePRs` и
 * `shapeCommits` это правда — у них стоит `Array.isArray(x) ? x : []`. У
 * `shapeRuns` вместо этого `?? []`, который ловит только null/undefined: любое
 * другое значение под ключом `workflow_runs` уходит в `.slice(0, 5).map(...)`
 * и бросает TypeError.
 *
 * Цена ошибки — не сам TypeError, а то, как он выглядит: `fetchGithubStatus`
 * зовёт три шейпера подряд, исключение из шейпера всплывает туда же, куда и
 * обрыв сети, и в логе GET_METRICS остаётся «runs.slice is not a function» без
 * единого намёка, что запрос-то прошёл и ответ пришёл.
 */
import { describe, test, expect } from "bun:test";
import { shapeRuns, shapePRs, shapeCommits } from "../lib/github.ts";

describe("shapeRuns: не-массив под workflow_runs", () => {
  test("объект вместо массива — [] вместо TypeError", () => {
    expect(shapeRuns({ workflow_runs: {} })).toEqual([]);
  });

  test("строка вместо массива — [] вместо TypeError", () => {
    // Строка коварнее объекта: у неё .slice ЕСТЬ, падает уже .map.
    expect(shapeRuns({ workflow_runs: "workflow_runs" })).toEqual([]);
  });

  test("число вместо массива — [] вместо TypeError", () => {
    expect(shapeRuns({ workflow_runs: 42 })).toEqual([]);
  });
});

describe("shapeRuns: то, что работало и должно продолжать", () => {
  test("null и undefined по-прежнему дают []", () => {
    expect(shapeRuns({ workflow_runs: null })).toEqual([]);
    expect(shapeRuns({ workflow_runs: undefined })).toEqual([]);
    expect(shapeRuns({})).toEqual([]);
    expect(shapeRuns(null)).toEqual([]);
    expect(shapeRuns("не json")).toEqual([]);
  });

  test("нормальный ответ шейпится и режется до пяти", () => {
    const runs = {
      workflow_runs: Array.from({ length: 7 }, (_, i) => ({
        name: `wf-${i}`,
        head_branch: "main",
        status: "completed",
        conclusion: i % 2 === 0 ? "success" : null,
      })),
    };
    const out = shapeRuns(runs);
    expect(out).toHaveLength(5);
    expect(out[0]).toEqual({
      name: "wf-0",
      branch: "main",
      status: "completed",
      conclusion: "success",
    });
    expect(out[1].conclusion).toBeNull();
  });

  // Элементы-примитивы — да; про `null` ВНУТРИ массива речи здесь нет: на нём
  // падают все три шейпера одинаково (`(null as Record).number`), это отдельное
  // и общее поведение, которого правка сознательно не касается.
  test("элементы-примитивы внутри массива не роняют шейпер", () => {
    expect(shapeRuns({ workflow_runs: [1, "x", true] })).toEqual([
      { name: "?", branch: "?", status: "?", conclusion: null },
      { name: "?", branch: "?", status: "?", conclusion: null },
      { name: "?", branch: "?", status: "?", conclusion: null },
    ]);
  });
});

describe("паритет трёх шейперов", () => {
  // Ровно тот инвариант, который обещает докблок lib/github.ts.
  const junk: unknown[] = [{}, "строка", 42, null, undefined, { a: 1 }, true];

  test("shapePRs и shapeCommits на мусоре дают []", () => {
    for (const v of junk) {
      expect(shapePRs(v)).toEqual([]);
      expect(shapeCommits(v)).toEqual([]);
    }
  });

  test("shapeRuns на том же мусоре тоже даёт []", () => {
    for (const v of junk) {
      expect(shapeRuns(v)).toEqual([]);
      expect(shapeRuns({ workflow_runs: v })).toEqual([]);
    }
  });
});
