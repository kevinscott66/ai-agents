/**
 * Аудит 2026-08-09: обрезка агрегированного текста ломала правило «отказ по
 * правилам — не поломка».
 *
 * Писатель (SPLIT_TASK в action-dispatch.ts) резал `errors.join("; ")` по 500-му
 * символу; читатель (isByDesignRefusal) требует, чтобы КАЖДЫЙ сегмент выглядел
 * отказом. С шести ролей лимит кончался, последний сегмент приезжал огрызком —
 * и на штатный отказ снова заводились три диагностические задачи на доску.
 */
import { describe, test, expect } from "bun:test";
import { isByDesignRefusal, joinDelegationErrors } from "../lib/diagnostic.ts";

/** Ровно те тексты, которые выдаёт DELEGATE_TO_ROLE (action-dispatch.ts:812-871). */
const cycle = (r: string, chain: string[]) =>
  `${r}: delegation cycle: '${r}' is already in chain [${chain.join("→")}]`;
const cyclePath = (r: string, chain: string[]) =>
  `${r}: delegation cycle detected: path=[${chain.join(",")}] target='${r}' appears in last 2 entries`;
// Аудит 2026-08-20: здесь стояло `${r}: delegation depth exceeded` — текст,
// которого действующий код не производит вовсе (и который был мёртвой записью
// в DELEGATION_REFUSALS). Настоящий отказ по глубине втрое длиннее, а длина
// сегментов — ровно то, что этот файл и проверяет.
const depth = (r: string, chain: string[]) =>
  `${r}: delegation cycle detected: path=[${chain.join(",")}] exceeds max length 5`;

const ALL = [
  "orchestrator", "pm", "product", "backend", "frontend", "tgdev",
  "aieng", "qa", "smm", "copy", "design", "perm",
];
const CHAIN = ["orchestrator", "pm", "product", "backend"];
const ROLES = ["frontend", "tgdev", "aieng", "qa", "smm", "copy", "design"];

function split(errors: string[]): string {
  return `split failed: no roles accepted the task (${joinDelegationErrors(errors)})`;
}
function splitRaw(errors: string[]): string {
  return `split failed: no roles accepted the task (${errors.join("; ")})`;
}

describe("сплит: обрезка не превращает отказ в поломку", () => {
  // Смешанные по длине причины — обычное дело: у части ролей цикл, у части
  // исчерпана глубина. Именно смесь сдвигает 500-й символ внутрь сегмента.
  const MIXED = ALL.slice(0, 7).map((r, i) =>
    i % 3 === 0 ? depth(r, ALL.slice(0, 5)) : cycle(r, ALL.slice(0, 5)),
  );

  test("семь ролей со смешанными причинами читаются как отказ", () => {
    expect(MIXED.join("; ").length).toBeGreaterThan(500);
    // До фикса здесь было false: 500-й символ приходился на «tgdev: delegat…».
    expect(isByDesignRefusal(split(MIXED))).toBe(true);
  });

  test("обрезанный текст укладывается в лимит", () => {
    expect(joinDelegationErrors(MIXED).length).toBeLessThanOrEqual(500);
  });

  test("вердикт по обрезке совпадает с вердиктом по полному списку", () => {
    // Инвариант, ради которого всё и затевалось: длина текста не должна
    // влиять на классификацию. Перебираем реальные формы сообщений, длины
    // цепочки и число ролей — раньше расходилось примерно в четверти случаев.
    for (const form of [cycle, cyclePath]) {
      for (let chainLen = 1; chainLen <= 8; chainLen++) {
        for (let n = 2; n <= 12; n++) {
          for (const mixed of [false, true]) {
            const chain = ALL.slice(0, chainLen);
            const errors = ALL.slice(0, n).map((r, i) =>
              mixed && i % 3 === 0 ? depth(r, chain) : form(r, chain),
            );
            expect(isByDesignRefusal(split(errors))).toBe(
              isByDesignRefusal(splitRaw(errors)),
            );
          }
        }
      }
    }
  });

  test("сколько отказов отброшено — видно в тексте", () => {
    const errors = ROLES.map((r) => cycle(r, CHAIN));
    expect(joinDelegationErrors(errors)).toMatch(
      /\+\d+ further by-design refusals omitted/,
    );
  });
});

describe("поломка среди длинного хвоста отказов не теряется", () => {
  // Единственная настоящая ошибка проводки среди десятка штатных отказов —
  // тот самый случай, ради которого правило не гасит SPLIT_TASK по типу.
  const BREAKAGE = "design: no handoffDeps in dispatch ctx";

  test("поломка в конце списка переживает обрезку", () => {
    const errors = [...ROLES.map((r) => cycle(r, CHAIN)), BREAKAGE];
    const out = joinDelegationErrors(errors);
    expect(out).toContain("no handoffDeps in dispatch ctx");
    expect(isByDesignRefusal(split(errors))).toBe(false);
  });

  test("поломка в середине — тоже", () => {
    const half = ROLES.length >> 1;
    const errors = [
      ...ROLES.slice(0, half).map((r) => cycle(r, CHAIN)),
      BREAKAGE,
      ...ROLES.slice(half).map((r) => cycle(r, CHAIN)),
    ];
    expect(joinDelegationErrors(errors)).toContain("handoffDeps");
    expect(isByDesignRefusal(split(errors))).toBe(false);
  });

  test("несколько поломок: диагностика заводится, счёт отброшенного честный", () => {
    const errors = [
      ...ROLES.map((r) => cycle(r, CHAIN)),
      BREAKAGE,
      "qa: target agent not found: qa",
      "pm: no resolveAgent in dispatch ctx",
    ];
    const out = joinDelegationErrors(errors);
    expect(isByDesignRefusal(split(errors))).toBe(false);
    // Все три поломки пережили обрезку — местом жертвуют отказы, а не они.
    expect(out).toContain("handoffDeps");
    expect(out).toContain("target agent not found");
    expect(out).toContain("no resolveAgent");
    // И маркер честно говорит, что отброшены именно отказы.
    expect(out).toMatch(/\+\d+ further by-design refusals omitted/);
  });

  test("когда поломок больше, чем влезает, маркер не врёт «одни отказы»", () => {
    const errors = Array.from(
      { length: 30 },
      (_, i) => `role${i}: target agent not found: role${i}`,
    );
    const out = joinDelegationErrors(errors);
    expect(out).toMatch(/\+\d+ further errors omitted/);
    expect(out).not.toMatch(/by-design/);
    expect(isByDesignRefusal(split(errors))).toBe(false);
  });

  test("одна поломка длиннее лимита остаётся поломкой", () => {
    const errors = [`design: ${"x".repeat(900)} no handoffDeps in dispatch ctx`];
    const out = joinDelegationErrors(errors);
    expect(out.length).toBeLessThanOrEqual(500);
    expect(isByDesignRefusal(split(errors))).toBe(false);
  });
});

describe("короткие случаи не меняются", () => {
  test("два отказа — текст ровно такой же, как был", () => {
    const errors = ["frontend: cannot delegate to self", depth("qa", CHAIN)];
    expect(joinDelegationErrors(errors)).toBe(errors.join("; "));
    expect(isByDesignRefusal(split(errors))).toBe(true);
  });

  test("пустой список — по-прежнему пустая строка (вызов подставит свой текст)", () => {
    expect(joinDelegationErrors([])).toBe("");
    expect(isByDesignRefusal(split([]))).toBe(false);
  });

  test("одна поломка среди двух — не отказ", () => {
    const errors = ["frontend: cannot delegate to self", "qa: target agent not found: qa"];
    expect(isByDesignRefusal(split(errors))).toBe(false);
  });
});
