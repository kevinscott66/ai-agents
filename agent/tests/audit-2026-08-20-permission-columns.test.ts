/**
 * Пять типов действий нельзя было выдать через матрицу прав.
 *
 * Колонки матрицы строились по строкам, которые вернул сервер, то есть по уже
 * выданным правам. `GRANT_PERMISSION`, `UPDATE_AGENT_PROMPT`,
 * `CHANGE_AGENT_STATUS`, `REVIEW_AND_MERGE_PR` и `SPAWN_ROLE` не засеяны ни
 * одной строкой — гейт по ним отказывает всем ролям (`evaluateGate` не находит
 * записи), и в матрице у них не было колонки. Замкнутый круг: выдать право
 * можно только там, где уже есть право.
 *
 * Про саму дыру `lib/permissions.ts` знает и говорит вслух —
 * `warnUnseededActionTypes()` пишет предупреждение на старте, а докблок
 * `unseededActionTypes()` называет и выход: «нужен сид-миграция или выдача
 * через Mini App». Сид — решение владельца (это пять самых опасных действий в
 * системе), а вот выдача через Mini App просто не работала.
 *
 * Что этот фикс НЕ чинит: ячейка по-прежнему показывает строку таблицы прав, а
 * не итог гейта — `CALLER_RESTRICTED`, `ROLE_EXPOSED_TOOLS` и
 * `ALWAYS_APPROVE_ACTIONS` она не учитывает. Для новых пяти колонок это врёт в
 * безопасную сторону: гейт строже показанного, а не мягче.
 */
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import {
  KNOWN_ACTION_TYPES,
  permissionColumns,
} from "../miniapp/src/lib/action-types.ts";
import { ACTION_TYPES } from "../lib/permissions.ts";

const UNSEEDED = [
  "GRANT_PERMISSION",
  "UPDATE_AGENT_PROMPT",
  "CHANGE_AGENT_STATUS",
  "REVIEW_AND_MERGE_PR",
  "SPAWN_ROLE",
];

describe("список типов не расходится с гейтом", () => {
  test("зеркало совпадает с ACTION_TYPES посписочно", () => {
    // Дублировать список пришлось: lib/permissions.ts тянет bun:sqlite, а
    // бандлу Mini App он не нужен и не доступен. Расхождение ловим здесь.
    expect([...KNOWN_ACTION_TYPES].sort()).toEqual([...ACTION_TYPES].sort());
  });

  test("незасеянные пять — в зеркале", () => {
    const mirror: readonly string[] = KNOWN_ACTION_TYPES;
    for (const at of UNSEEDED) expect(mirror).toContain(at);
  });
});

describe("permissionColumns", () => {
  test("колонки есть, даже когда прав не выдано ни одного", () => {
    expect(permissionColumns([])).toEqual([...ACTION_TYPES].sort());
  });

  test("незасеянный тип получает колонку", () => {
    const cols = permissionColumns([{ actionType: "SEND_MESSAGE" }]);
    for (const at of UNSEEDED) expect(cols).toContain(at);
  });

  test("незнакомый серверу тип не выбрасывается", () => {
    // Сервер может оказаться новее клиента; спрятать пришедшую строку хуже,
    // чем показать колонку, о которой клиент не знал.
    expect(permissionColumns([{ actionType: "ZZ_FUTURE_ACTION" }])).toContain(
      "ZZ_FUTURE_ACTION",
    );
  });

  test("дубли строк не дублируют колонку", () => {
    const cols = permissionColumns([
      { actionType: "SEND_MESSAGE" },
      { actionType: "SEND_MESSAGE" },
    ]);
    expect(cols.filter((c) => c === "SEND_MESSAGE")).toHaveLength(1);
  });

  test("порядок алфавитный", () => {
    const cols = permissionColumns([{ actionType: "AAA_FIRST" }]);
    expect(cols).toEqual([...cols].sort());
    expect(cols[0]).toBe("AAA_FIRST");
  });
});

describe("проводка Permissions.tsx", () => {
  const RAW = readFileSync(
    new URL("../miniapp/src/pages/Permissions.tsx", import.meta.url),
    "utf8",
  );
  const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  test("колонки берутся из общей функции", () => {
    expect(SRC).toMatch(/permissionColumns\(perms\)/);
  });

  test("своего Set по строкам прав больше нет", () => {
    // Именно он и делал колонки зависимыми от уже выданного.
    expect(SRC).not.toMatch(/for \(const p of perms\) s\.add\(p\.actionType\)/);
  });

  test("пустое состояние висит на агентах, а не на колонках", () => {
    // `actionTypes.length === 0` стало недостижимым: колонки есть всегда.
    expect(SRC).not.toMatch(/actionTypes\.length === 0/);
    expect(SRC).toMatch(/agents\.length === 0 \?/);
  });
});
