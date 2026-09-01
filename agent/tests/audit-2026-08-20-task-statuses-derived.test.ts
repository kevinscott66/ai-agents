// Аудит 2026-08-20: TASK_STATUSES был написан руками рядом с FSM.
//
// `TASK_TRANSITIONS` типизирован как `Record<TaskStatus, …>` — там пропустить
// статус нельзя, компилятор потребует все ключи. А `TASK_STATUSES: TaskStatus[]`
// — обычный массив: компилятор проверяет, что каждый элемент валиден, но НЕ
// что перечислены все. Добавить статус в FSM и забыть его здесь — молчаливая
// ошибка сразу в трёх местах:
//
//   • digest.ts:68  — считает задачи по каждому статусу из списка; пропущенный
//     статус выпадает из total. Ровно это уже случалось (см. комментарий там:
//     без awaiting_review и cancelled дайджест печатал «(no data)» при живой
//     доске).
//   • tools-schema.ts:105 — enum в JSON-схеме UPDATE_TASK_STATUS; агент не
//     сможет назвать статус, который FSM разрешает.
//   • miniapp-server.ts:1074 — POST /api/tasks/:id/status отвечает «bad
//     status» на переход, который updateTaskStatus() принял бы.
//
// Поэтому список выводится из таблицы переходов, а не дублирует её.
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { TASK_STATUSES } from "../lib/types.ts";
import { TASK_TRANSITIONS, type TaskStatus } from "../lib/task-fsm.ts";
import { OPEN_TASK_STATUSES } from "../lib/tasks.ts";
import { TOOLS } from "../lib/tools-schema.ts";

const RAW = readFileSync(new URL("../lib/types.ts", import.meta.url), "utf8");
const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("TASK_STATUSES — состав", () => {
  test("совпадает с ключами FSM, включая порядок", () => {
    expect(TASK_STATUSES).toEqual(Object.keys(TASK_TRANSITIONS) as TaskStatus[]);
  });

  test("покрывает каждый ключ FSM — ни одного пропущенного статуса", () => {
    for (const s of Object.keys(TASK_TRANSITIONS)) {
      expect(TASK_STATUSES).toContain(s as TaskStatus);
    }
  });

  test("не содержит статусов, которых нет в FSM", () => {
    for (const s of TASK_STATUSES) {
      expect(TASK_TRANSITIONS[s]).toBeDefined();
    }
  });

  test("без дублей", () => {
    expect(new Set(TASK_STATUSES).size).toBe(TASK_STATUSES.length);
  });

  test("непустой", () => {
    expect(TASK_STATUSES.length).toBeGreaterThan(0);
  });
});

describe("TASK_STATUSES — согласованность с потребителями", () => {
  test("открытые статусы — подмножество полного списка", () => {
    for (const s of OPEN_TASK_STATUSES) {
      expect(TASK_STATUSES).toContain(s);
    }
  });

  test("полный список = открытые + терминальные, без остатка", () => {
    const open = new Set<string>(OPEN_TASK_STATUSES);
    const terminal = TASK_STATUSES.filter((s) => !open.has(s));
    expect(open.size + terminal.length).toBe(TASK_STATUSES.length);
    for (const s of terminal) {
      expect(TASK_TRANSITIONS[s]).toHaveLength(0);
    }
    expect(terminal.length).toBeGreaterThan(0);
  });

  test("enum в схеме UPDATE_TASK_STATUS — тот же список", () => {
    const tool = TOOLS.find((t: any) => t.name === "UPDATE_TASK_STATUS");
    expect(tool).toBeDefined();
    const en = (tool as any).input_schema.properties.status.enum;
    expect(en).toEqual(TASK_STATUSES);
  });
});

describe("TASK_STATUSES — источник", () => {
  test("выводится из TASK_TRANSITIONS, а не написан руками", () => {
    expect(SRC).toMatch(
      /TASK_STATUSES[^=]*=\s*Object\s*\.\s*keys\(\s*TASK_TRANSITIONS\s*,?\s*\)/,
    );
  });

  test("литерального списка статусов в types.ts не осталось", () => {
    const decl = SRC.match(/TASK_STATUSES[\s\S]*?;/);
    expect(decl).not.toBeNull();
    expect(decl![0]).not.toContain('"awaiting_review"');
    expect(decl![0]).not.toContain('"pending"');
  });
});
