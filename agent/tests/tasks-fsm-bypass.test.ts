/**
 * Переходы в терминал мимо FSM (повторный аудит 2026-08-04).
 *
 * updateTaskStatus проверяет таблицу FSM и бросает на нелегальном переходе, но
 * два места пишут статус голым UPDATE'ом: rollupParent (по набору детей) и
 * нулевая ветка reconcileExpectedChildren. Обход там осознанный — согласован-
 * ность детей уже проверена, — однако rollupParent мостил pending → running →
 * terminal, а нулевая ветка нет: родитель сплита, у которого не создалось ни
 * одного ребёнка, прыгал pending → failed. Такого перехода в FSM нет вообще,
 * то есть история задачи содержала запись, невозможную по её же машине.
 *
 * Тесты фиксируют не «как реализовано», а инвариант: конечный статус тот же,
 * что и был, а промежуточный шаг — легальный по FSM.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { db } from "../lib/db.ts";
import {
  createTask,
  getTask,
  updateTaskStatus,
  reconcileExpectedChildren,
  rollupParent,
} from "../lib/tasks.ts";

const CHAT = -99881;

function mkParent(expectedChildren: number) {
  return createTask({
    chatId: CHAT,
    createdBy: "orchestrator",
    title: "[split] fsm-bypass",
    inputPayload: { type: "split", expectedChildren },
  });
}

beforeEach(() => {
  db.prepare(`DELETE FROM tasks WHERE chat_id = ?`).run(CHAT);
});

describe("нулевой набор детей закрывает родителя легальным путём", () => {
  test("pending-родитель без детей становится failed", () => {
    const p = mkParent(3);
    expect(p.status).toBe("pending");
    reconcileExpectedChildren(p.id, 0, { error: "all delegations failed" });
    const after = getTask(p.id)!;
    expect(after.status).toBe("failed");
    expect(after.error).toBe("all delegations failed");
  });

  test("переход pending → failed нелегален — значит был мост через running", () => {
    // Прямой вызов на том же переходе обязан бросить. Если он вдруг проходит,
    // FSM ослабили, и тест про мост потерял смысл — пусть это будет видно.
    const t = createTask({
      chatId: CHAT,
      createdBy: "orchestrator",
      title: "direct",
    });
    expect(() => updateTaskStatus(t.id, "failed")).toThrow(
      /invalid status transition/,
    );
  });

  test("уже терминального родителя нулевая ветка не трогает", () => {
    const p = mkParent(2);
    updateTaskStatus(p.id, "running");
    updateTaskStatus(p.id, "done", { output: { ok: 1 } });
    reconcileExpectedChildren(p.id, 0, { error: "поздно" });
    const after = getTask(p.id)!;
    expect(after.status).toBe("done");
    expect(after.error).toBeNull();
  });

  test("expectedChildren приводится к факту и при нулевом наборе", () => {
    // Иначе счётчик обещания навсегда расходится с реальностью, и любой
    // последующий rollup по этому родителю считает набор неполным.
    const p = mkParent(3);
    reconcileExpectedChildren(p.id, 0);
    const after = getTask(p.id)!;
    expect((after.input as { expectedChildren: number }).expectedChildren).toBe(
      0,
    );
  });
});

describe("голая запись статуса живёт в одном месте", () => {
  // Конечный статус одинаков и с мостом, и без него, а истории переходов у
  // задач нет — то есть поведенчески мост не наблюдаем. Пинить его можно
  // только структурно: оба обходчика обязаны звать общий helper, а не писать
  // статус сами. Без этого теста откат правки прошёл бы незамеченным.
  const src = require("node:fs").readFileSync(
    new URL("../lib/tasks.ts", import.meta.url),
    "utf8",
  ) as string;

  function bodyOf(name: string): string {
    const start = src.indexOf(`function ${name}(`);
    expect(start).toBeGreaterThan(-1);
    const rest = src.slice(start + 1);
    const next = rest.search(/\n(?:export )?function /);
    return next === -1 ? rest : rest.slice(0, next);
  }

  for (const fn of ["rollupParent", "reconcileExpectedChildren"]) {
    test(`${fn} не пишет статус напрямую`, () => {
      expect(bodyOf(fn)).not.toMatch(/UPDATE tasks SET[^`]*status/i);
    });
  }

  test("голая запись статуса есть только в объявленных местах", () => {
    // Смысл проверки — не «ровно столько штук», а «ни одной незаявленной».
    // Заявленных три, и они делают разное:
    //   forceTerminalStatus — шаг моста и сама запись терминала, чтобы в
    //     истории не осталось перехода, которого нет в FSM;
    //   createTask — переоткрытие родителя, закрытого по неполному набору
    //     детей (аудит 2026-08-10); из терминала FSM не выпускает никого.
    // Штатный путь (updateTaskStatus) собирает SET динамически и под регексп
    // не попадает — он и так проверяет FSM.
    const all = src.match(/UPDATE tasks SET status/g) ?? [];
    expect(all.length).toBe(3);
    // Мост больше не зашит в конкретный статус: аудит 2026-08-10 показал, что
    // из running не достижим cancelled, и шаг выбирается по самой таблице.
    expect(bodyOf("forceTerminalStatus")).toMatch(
      /UPDATE tasks SET status=\?[\s\S]*UPDATE tasks SET status=\?/,
    );
    expect(bodyOf("forceTerminalStatus")).not.toContain("status='running'");
    expect(bodyOf("createTask")).toContain(
      "UPDATE tasks SET status='running', error=NULL",
    );
  });
});

describe("rollupParent сохраняет прежний результат", () => {
  function child(parentId: string, status: "done" | "failed" | "cancelled") {
    const c = createTask({
      chatId: CHAT,
      createdBy: "orchestrator",
      parentId,
      title: `child-${status}`,
    });
    if (status === "cancelled") {
      updateTaskStatus(c.id, "cancelled");
    } else {
      updateTaskStatus(c.id, "running");
      updateTaskStatus(c.id, status, { error: status === "failed" ? "boom" : undefined });
    }
    return c;
  }

  test("провалившийся ребёнок роняет pending-родителя с его ошибкой", () => {
    const p = mkParent(1);
    child(p.id, "failed");
    const after = getTask(p.id)!;
    expect(after.status).toBe("failed");
    expect(after.error).toBe("boom");
  });

  test("все дети отменены → родитель cancelled, а не done", () => {
    const p = mkParent(2);
    child(p.id, "cancelled");
    child(p.id, "cancelled");
    expect(getTask(p.id)!.status).toBe("cancelled");
  });

  test("родитель в awaiting_approval тоже доводится до терминала", () => {
    // Раньше мост стоял под условием `status === "pending"`, поэтому из
    // awaiting_approval шёл прямой прыжок в done — перехода нет в FSM.
    const p = mkParent(1);
    updateTaskStatus(p.id, "awaiting_approval");
    const c = createTask({
      chatId: CHAT,
      createdBy: "orchestrator",
      parentId: p.id,
      title: "c",
    });
    updateTaskStatus(c.id, "running");
    updateTaskStatus(c.id, "done");
    rollupParent(p.id);
    expect(getTask(p.id)!.status).toBe("done");
  });
});
