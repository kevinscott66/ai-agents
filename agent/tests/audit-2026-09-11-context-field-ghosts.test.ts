/**
 * Аудит 2026-09-11: поля контекста с `_`-префиксом сторож протухших имён не
 * видел вовсе — и три из них протухли.
 *
 * Сторож (audit-2026-09-11-stale-symbol-names) берёт имя в обратных кавычках и
 * требует, чтобы оно встречалось в коде. Но классификатор пропускал только
 * CAMEL и SNAKE, а SNAKE требует буквы в начале: `_depth` не проходил ни один
 * шаблон и не проверялся. Симметрично молчал и сбор имён из кода — UNDERSCORED
 * начинается с `[A-Za-z]`, а границы слова перед `_` внутри `_userId` нет,
 * поэтому такое имя не попадало в словарь живых ни из одного файла.
 *
 * Что за этой слепотой стояло:
 *
 *   - `_depth` — счётчик глубины делегирования, удалён 2026-08-10 вместе с
 *     гейтом, который по нему не срабатывал ни разу;
 *   - `_delegation_chain` — имени не было никогда: цепочку держит
 *     `_delegation_path`;
 *   - `_rerouted` — настоящее поле называется `_rerouted_from`.
 *
 * Все три перечислялись в self-diag.ts как ДЕЙСТВУЮЩЕЕ соглашение проекта, то
 * есть читатель получал список полномочий, треть которого вымышлена.
 *
 * Почему это пережило предыдущие раунды: `withoutContextFields` и
 * `contextFieldsOf` разделяют payload по ПРЕФИКСУ, а не по списку имён. Любое
 * выдуманное `_`-поле ведёт себя в точности как настоящее — и тест
 * self-diag-context-fields клал `_depth` с `_delegation_chain` в payload сам,
 * там же их и находил, и заодно убеждал сторожа, что имена живые. Проверка
 * была верной, предмет — вымышленным.
 *
 * Правило намеренно узкое: отдельный шаблон на ведущее подчёркивание, а не
 * послабление в SNAKE. Разрешить SNAKE одиночное слово ради `_depth` — значит
 * впустить в проверку gunzip, printenv, getcwd, exports и прочую прозу.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import {
  UNDERSCORE_FIELD,
  LEADING_UNDERSCORE,
} from "./audit-2026-09-11-stale-symbol-names.test.ts";

const src = (rel: string) =>
  readFileSync(new URL("../" + rel, import.meta.url).pathname, "utf8");

/** Имена, которых в коде нет, а в комментариях они стояли как действующие. */
const GHOSTS = ["_depth", "_delegation_chain", "_rerouted"];
/** Их живые соответствия — ими и заменены. */
const REAL = [
  "_userId",
  "_delegation_path",
  "_parent_task_id",
  "_rerouted_from",
  "_retry_count",
  "_fix_chain",
  "_diag",
];

/** Строки кода: комментарии вырезаны, остаётся то, что исполняется. */
const codeOnly = (s: string) =>
  s
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

describe("призраки убраны из описания соглашения", () => {
  test("self-diag больше не выдаёт несуществующие поля за действующие", () => {
    const s = src("lib/self-diag.ts");
    for (const g of GHOSTS) {
      expect(s).not.toContain("`" + g + "`");
      expect(s).not.toContain("`" + g + ":");
    }
  });

  test("на их месте названы поля, которые в коде есть", () => {
    const s = src("lib/self-diag.ts");
    const code = [
      codeOnly(src("lib/action-payload.ts")),
      codeOnly(src("lib/action-dispatch.ts")),
      codeOnly(src("lib/self-diag.ts")),
    ].join("\n");
    for (const name of REAL) {
      expect(s).toContain("`" + name + "`");
      expect(code).toContain(name);
    }
  });

  test("`_delegation_path` — единственное имя цепочки, второго нет", () => {
    const code = codeOnly(src("lib/action-dispatch.ts"));
    expect(code).toContain("_delegation_path");
    expect(code).not.toContain("_delegation_chain");
  });

  test("мёртвые имена в исторических абзацах стоят без кавычек", () => {
    // Кавычки обещают существование; про удалённое поле пишут без них, иначе
    // надгробие неотличимо от указателя. Абзацы при этом на месте — они
    // объясняют, почему счётчика больше нет.
    for (const rel of [
      "lib/action-dispatch.ts",
      "lib/action-payload.ts",
      "tests/c10.test.ts",
    ]) {
      // Только комментарии: `chain_depth` в шаблонной строке кода содержит
      // `_depth` подстрокой, а речь про кавычки в прозе.
      const s = src(rel)
        .split("\n")
        .filter((l) => /^\s*(\/\/|\*|\/\*)/.test(l))
        .join("\n");
      expect(s).toMatch(/\b_depth\b/);
      expect(s).not.toMatch(/`[^`\n]*\b_depth\b[^`\n]*`/);
    }
  });
});

describe("сторож теперь такие имена видит", () => {
  test("поле контекста проходит классификатор", () => {
    for (const n of [...GHOSTS, ...REAL]) {
      expect(UNDERSCORE_FIELD.test(n)).toBe(true);
    }
  });

  test("обычная проза и имена без префикса под правило не попадают", () => {
    for (const n of ["gunzip", "printenv", "getcwd", "exports", "delegation_path", "_"]) {
      expect(UNDERSCORE_FIELD.test(n)).toBe(false);
    }
  });

  test("сбор имён из кода достаёт префиксное имя целиком", () => {
    // Регулярка с флагом `g` носит lastIndex между вызовами, поэтому только
    // matchAll со свежим обходом — `test` подряд давал бы разные ответы.
    const grab = (s: string) => [...s.matchAll(LEADING_UNDERSCORE)].map((m) => m[0]);
    expect(grab("p._delegation_path.length")).toContain("_delegation_path");
    expect(grab("{ _userId: id }")).toContain("_userId");
    // Имя целиком, а не хвост после подчёркивания: иначе `_rerouted_from`
    // засчитал бы жизнь призраку `_rerouted`.
    expect(grab("_rerouted_from: reroutedFrom")).toEqual(["_rerouted_from"]);
  });

  test("живое поле призрака не оживляет", () => {
    const code = codeOnly(src("lib/action-dispatch.ts"));
    const found = new Set([...code.matchAll(LEADING_UNDERSCORE)].map((m) => m[0]));
    expect(found.has("_rerouted_from")).toBe(true);
    for (const g of GHOSTS) expect(found.has(g)).toBe(false);
  });
});
