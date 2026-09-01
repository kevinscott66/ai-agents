/**
 * Аудит 2026-08-28: докблоки, описывающие не ту функцию, над которой лежат.
 *
 * Комментарий, который врёт, дороже отсутствующего: читатель принимает по нему
 * решение. Найдено три штуки — в tasks.ts два докблока лежали друг на друге
 * над `fsmPath` (описывали `reconcileExpectedChildren` и
 * `forceTerminalStatus`, обе объявлены НИЖЕ), в role-skills.ts описание
 * `pickAvailableAgent` лежало над `allCandidatesStopped`, у которой есть свой.
 *
 * Плюс докстринг diagnostic.ts обещал идемпотентность по
 * (failed_action_id, error_category), хотя разбор в самом коде (аудит
 * 2026-08-09) показывает, что этот id — свежий uuid на каждый вызов и дедуп
 * не срабатывает никогда. Обещание опасное: следующий читатель снимет троттл
 * `isDiagTaskThrottled` как «дублирующую защиту», а он там единственный.
 *
 * Тест держит не текст, а проверяемые свойства: соседство докблока с его
 * функцией, полноту CATEGORY_PRIORITY и порядок ранних возвратов.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  pickResponsibleRole,
  type ErrorCategory,
} from "../lib/diagnostic.ts";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf-8");
const DIAG = read("../lib/diagnostic.ts");
const TASKS = read("../lib/tasks.ts");
const SKILLS = read("../lib/role-skills.ts");

/** Строка объявления, идущая сразу за докблоком с данной фразой. */
function declAfterDocblock(src: string, phrase: string): string {
  const at = src.indexOf(phrase);
  expect(at).toBeGreaterThan(0);
  const close = src.indexOf(" */\n", at);
  expect(close).toBeGreaterThan(at);
  return src.slice(close + " */\n".length).split("\n")[0];
}

describe("докблок стоит над своей функцией", () => {
  const cases: [string, string, string, string][] = [
    [
      "tasks.ts: reconcileExpectedChildren",
      TASKS,
      "Зафиксировать фактическое число детей у родителя-сплита",
      "export function reconcileExpectedChildren(",
    ],
    [
      "tasks.ts: forceTerminalStatus",
      TASKS,
      "Проставить терминальный статус в обход FSM",
      "function forceTerminalStatus(",
    ],
    [
      "tasks.ts: fsmPath",
      TASKS,
      "Кратчайший путь по таблице переходов FSM",
      "function fsmPath(from: TaskStatus, to: TaskStatus): TaskStatus[] | null {",
    ],
    [
      "role-skills.ts: pickAvailableAgent",
      SKILLS,
      "Pick first available agent: target itself",
      "export function pickAvailableAgent(",
    ],
  ];

  for (const [name, src, phrase, decl] of cases) {
    test(name, () => {
      expect(declAfterDocblock(src, phrase)).toBe(decl);
    });
  }

  test("двух докблоков подряд в этих файлах не осталось", () => {
    // Именно так сироты и выглядели: ` */` и сразу `/**`.
    for (const [name, src] of [
      ["tasks.ts", TASKS],
      ["role-skills.ts", SKILLS],
    ] as const) {
      const lines = src.split("\n");
      const hits: string[] = [];
      for (let i = 1; i < lines.length; i++) {
        if (lines[i].trimStart().startsWith("/**") && lines[i - 1].trim() === "*/") {
          hits.push(`${name}:${i + 1}`);
        }
      }
      expect(hits).toEqual([]);
    }
  });
});

describe("diagnostic: докстринг не обещает того, чего нет", () => {
  test("идемпотентность больше не объявлена как факт", () => {
    expect(DIAG).not.toContain("createDiagnosticTask for the same pair is a no-op");
  });

  test("названа настоящая граница потока", () => {
    const head = DIAG.slice(0, DIAG.indexOf("import "));
    expect(head).toContain("isDiagTaskThrottled");
  });
});

describe("diagnostic: свойства, на которые ссылаются комментарии", () => {
  const ALL: ErrorCategory[] = [
    "permission_denied",
    "missing_capability",
    "unknown",
    "rate_limited",
    "network",
  ];

  test("union ErrorCategory перечислен здесь целиком", () => {
    const body = DIAG.slice(DIAG.indexOf("export type ErrorCategory"));
    const decl = body.slice(0, body.indexOf(";"));
    const names = [...decl.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(new Set(names)).toEqual(new Set(ALL));
  });

  test("CATEGORY_PRIORITY покрывает все категории — потому `return \"unknown\"` и недостижим", () => {
    const arr = DIAG.slice(DIAG.indexOf("const CATEGORY_PRIORITY"));
    const decl = arr.slice(0, arr.indexOf("];"));
    const names = [...decl.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(new Set(names)).toEqual(new Set(ALL));
  });

  test("null отдают ровно rate_limited и network", () => {
    const nulls = ALL.filter((c) => pickResponsibleRole(c) === null);
    expect(nulls.sort()).toEqual(["network", "rate_limited"]);
  });

  test("обе эти категории возвращаются РАНЬШЕ ветки no_role", () => {
    // Из этого и следует недостижимость `no_role`.
    const fn = DIAG.slice(DIAG.indexOf("export function createDiagnosticTask"));
    const rate = fn.indexOf('skippedReason: "deferred_rate_limited"');
    const net = fn.indexOf('skippedReason: "deferred_network"');
    const noRole = fn.indexOf('skippedReason: "no_role"');
    expect(rate).toBeGreaterThan(0);
    expect(net).toBeGreaterThan(rate);
    expect(noRole).toBeGreaterThan(net);
  });
});
