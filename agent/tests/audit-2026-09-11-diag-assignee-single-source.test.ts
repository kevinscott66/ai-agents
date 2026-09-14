/**
 * Аудит 2026-09-11, круг 51: имя исполнителя diag-задач было записано в
 * четырёх местах, а докблок над константой объяснял это несуществующим
 * циклом импортов.
 *
 * `DIAG_ASSIGNEE` в lib/tasks.ts объявляла себя единственным источником, но
 * рядом жили три копии литерала `'aieng'`: два SQL поллера в lib/self-diag.ts
 * (`recoverStranded*` и `listPendingDiagTasks`) и дефолт параметра
 * `assignedTo` у `isDiagTaskThrottled` в lib/fix-chain.ts. Оправдание —
 * «импортировать не могут, не заводя цикл» — проверку не проходило: tasks.ts
 * тянет только task-fsm/errors/db/log, а self-diag.ts импортирует tasks.ts
 * с самого начала. Заодно проза называла пять мест при трёх.
 *
 * Цена расхождения не в стиле. Поллер выбирает работу по `assigned_to`, а
 * C15-петля кладёт её туда же; разъехавшись на одну букву, две половины
 * перестают видеть друг друга молча — задачи копятся в pending, ретрая нет,
 * в логах ничего. Ровно тот отказ, который дороже всего заметить.
 *
 * Здесь проверяется, что копий больше нет и что цикла, которым их
 * оправдывали, действительно нет.
 */
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { DIAG_ASSIGNEE } from "../lib/tasks.ts";
import { isDiagTaskThrottled } from "../lib/fix-chain.ts";

function src(rel: string): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

const TASKS = src("lib/tasks.ts");
const SELF_DIAG = src("lib/self-diag.ts");
const FIX_CHAIN = src("lib/fix-chain.ts");

describe("имя исполнителя diag-задач записано ровно один раз", () => {
  test("константа объявлена в tasks.ts и только там", () => {
    expect(DIAG_ASSIGNEE).toBe("aieng");
    const decl = [TASKS, SELF_DIAG, FIX_CHAIN].filter((s) =>
      s.includes(`DIAG_ASSIGNEE = "${DIAG_ASSIGNEE}"`),
    );
    expect(decl).toHaveLength(1);
  });

  test("поллер самодиагностики не держит литерал в SQL", () => {
    // `assigned_to = 'aieng'` в тексте запроса — та самая копия правила.
    expect(SELF_DIAG).not.toContain(`assigned_to = '${DIAG_ASSIGNEE}'`);
    // Оба запроса связывают имя параметром и берут его из константы.
    expect(SELF_DIAG.match(/assigned_to = \?/g)).toHaveLength(2);
    expect(SELF_DIAG.match(/\.all\(DIAG_ASSIGNEE, /g)).toHaveLength(2);
  });

  test("дефолт троттла берётся из константы, а не из своего литерала", () => {
    expect(FIX_CHAIN).toContain("assignedTo: string | null = DIAG_ASSIGNEE,");
    expect(FIX_CHAIN).not.toContain(`= "${DIAG_ASSIGNEE}",`);
    // Дефолт действительно работает: вызов без третьего аргумента не падает
    // и смотрит на того же исполнителя.
    expect(typeof isDiagTaskThrottled("[diagnostic] проверка дефолта", Date.now())).toBe(
      "boolean",
    );
  });

  test("цикла, которым оправдывали копии, нет", () => {
    // tasks.ts не тянет ни self-diag.ts, ни fix-chain.ts — значит импорт
    // обратно безопасен, и это проверяется, а не объявляется.
    const imports = [...TASKS.matchAll(/from "\.\/([a-z0-9-]+)\.ts"/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["db", "errors", "log", "task-fsm"]);
  });

  test("докблок называет прежнюю прозу прежней, а не повторяет её", () => {
    const block = TASKS.slice(
      TASKS.lastIndexOf("/**", TASKS.indexOf("export const DIAG_ASSIGNEE")),
      TASKS.indexOf("export const DIAG_ASSIGNEE"),
    )
      .replace(/^\s*\*/gm, "")
      .replace(/\s+/g, " ");
    // Обе неправды остались в тексте — но только внутри разбора, в прошедшем
    // времени: «прежняя редакция говорила …». Так надгробие отличается от
    // действующего утверждения, и проверяется именно это.
    expect(block).toContain("прежняя редакция говорила");
    expect(block.indexOf("прежняя редакция говорила")).toBeLessThan(
      block.indexOf("не заводя цикл"),
    );
    expect(block).toContain("Ни то, ни другое не было правдой");
    expect(block).toContain("Копий было три");
  });
});
