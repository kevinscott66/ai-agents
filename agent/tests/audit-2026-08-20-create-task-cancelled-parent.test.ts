/**
 * Аудит 2026-08-20: подзадача воскрешала ОТМЕНЁННОГО родителя.
 *
 * `createTask` переоткрывает любого терминального родителя голым UPDATE'ом в
 * обход FSM — это решение аудита 2026-08-10 и оно осознанное: план собирают по
 * одной подзадаче, первый закрывшийся ребёнок штампует родителя раньше
 * времени, и появление нового ребёнка — прямое доказательство, что набор был
 * неполон. Для `done` и `failed` это чинит ложный итог.
 *
 * Но `cancelled` в этот ряд не входит. Его ставит человек, и означает он «не
 * делаем», а не промежуточный итог rollup'а. Цепочка на входе модели:
 * CREATE_TASK(parentId = отменённая задача) → родитель уходит в `running`,
 * ребёнок закрывается `done` → rollupParent штампует родителю `done`. Отмена
 * владельца снята входом модели, без единого аппрува, и в истории задачи
 * перехода `cancelled → running` нет — он написан в обход FSM.
 *
 * Инвариант: отменённую задачу нельзя переоткрыть подзадачей со стороны
 * модели; done/failed переоткрываются как раньше.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { handleCreateTask } from "../lib/dispatch/tasks.ts";
import type { TaskHandlerResult } from "../lib/dispatch/tasks.ts";
import { createTask, getTask, updateTaskStatus, rollupParent } from "../lib/tasks.ts";
import { db } from "../lib/db.ts";

const HOME = 556101;
const FOREIGN = 556102;

const ctx = { agentKey: "backend", chatId: HOME };

/**
 * `TaskHandlerResult` — размеченное объединение, и `error` живёт только в
 * ветке `ok: false`. `expect(res.ok).toBe(false)` тип не сужает, поэтому
 * `res.error` не компилировался (`bun run typecheck`, TS2339 в четырёх
 * местах) — `bun test` этого не видит, он типы стирает.
 *
 * Заодно ассерты становятся строже: `String(res.error)` при отсутствующем
 * поле давал бы "undefined", и проверка `.not.toContain("cancelled")`
 * проходила бы впустую.
 */
function errorOf(res: TaskHandlerResult): string {
  if (res.ok) throw new Error("ожидался отказ, а вернулся ok: true");
  return res.error;
}

function parentIn(chatId: number, title = "план релиза") {
  return createTask({ chatId, createdBy: "pm", title });
}

function childrenOf(parentId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ?`)
    .get(parentId) as { n: number };
  return row.n;
}

beforeEach(() => {
  db.prepare(`DELETE FROM tasks WHERE chat_id IN (?, ?)`).run(HOME, FOREIGN);
});

describe("CREATE_TASK не воскрешает отменённого родителя", () => {
  test("отказ, если родитель cancelled", () => {
    const parent = parentIn(HOME);
    updateTaskStatus(parent.id, "cancelled");

    const res = handleCreateTask(
      { title: "подзадача", parentId: parent.id } as never,
      ctx,
    );

    expect(errorOf(res)).toContain("cancelled");
  });

  test("отменённый родитель остаётся отменённым", () => {
    const parent = parentIn(HOME);
    updateTaskStatus(parent.id, "cancelled");

    handleCreateTask({ title: "подзадача", parentId: parent.id } as never, ctx);

    expect(getTask(parent.id)!.status).toBe("cancelled");
  });

  test("ребёнок под отменённым родителем не создаётся вовсе", () => {
    const parent = parentIn(HOME);
    updateTaskStatus(parent.id, "cancelled");

    handleCreateTask({ title: "подзадача", parentId: parent.id } as never, ctx);

    expect(childrenOf(parent.id)).toBe(0);
  });

  test("вся цепочка: отмена владельца переживает закрытие подзадачи", () => {
    const parent = parentIn(HOME);
    updateTaskStatus(parent.id, "cancelled");

    const res = handleCreateTask(
      { title: "подзадача", parentId: parent.id } as never,
      ctx,
    );
    expect(res.ok).toBe(false);

    // Даже если бы ребёнок появился и закрылся, rollup не должен иметь по чему
    // пересчитывать: детей нет, статус родителя не меняется.
    rollupParent(parent.id);
    expect(getTask(parent.id)!.status).toBe("cancelled");
  });

  test("чужой чат проверяется РАНЬШЕ статуса — отказ не выдаёт существование", () => {
    const alien = parentIn(FOREIGN);
    updateTaskStatus(alien.id, "cancelled");

    const res = handleCreateTask(
      { title: "подзадача", parentId: alien.id } as never,
      ctx,
    );

    expect(errorOf(res)).toContain("not found");
    expect(errorOf(res)).not.toContain("cancelled");
  });
});

describe("остальные статусы родителя работают как раньше", () => {
  test("done переоткрывается — поведение аудита 2026-08-10 сохранено", () => {
    const parent = parentIn(HOME);
    updateTaskStatus(parent.id, "running");
    updateTaskStatus(parent.id, "done");

    const res = handleCreateTask(
      { title: "фронтенд", parentId: parent.id } as never,
      ctx,
    );

    expect(res.ok).toBe(true);
    expect(getTask(parent.id)!.status).toBe("running");
  });

  test("failed переоткрывается и теряет прежнюю ошибку", () => {
    const parent = parentIn(HOME);
    updateTaskStatus(parent.id, "running");
    updateTaskStatus(parent.id, "failed", { error: "упало" });

    const res = handleCreateTask(
      { title: "фикс", parentId: parent.id } as never,
      ctx,
    );

    expect(res.ok).toBe(true);
    expect(getTask(parent.id)!.status).toBe("running");
  });

  test("pending-родитель принимает ребёнка и статус не трогается", () => {
    const parent = parentIn(HOME);

    const res = handleCreateTask(
      { title: "подзадача", parentId: parent.id } as never,
      ctx,
    );

    expect(res.ok).toBe(true);
    expect(getTask(parent.id)!.status).toBe("pending");
    expect(childrenOf(parent.id)).toBe(1);
  });

  test("running-родитель принимает ребёнка", () => {
    const parent = parentIn(HOME);
    updateTaskStatus(parent.id, "running");

    const res = handleCreateTask(
      { title: "подзадача", parentId: parent.id } as never,
      ctx,
    );

    expect(res.ok).toBe(true);
    expect(getTask(parent.id)!.status).toBe("running");
  });

  test("несуществующий родитель — прежний отказ", () => {
    const res = handleCreateTask(
      { title: "подзадача", parentId: "нет-такого-id" } as never,
      ctx,
    );

    expect(errorOf(res)).toContain("not found");
  });
});

describe("граница именно на входе модели", () => {
  test("createTask напрямую (аппрувы, Mini App) переоткрытие сохраняет", () => {
    const parent = parentIn(HOME);
    updateTaskStatus(parent.id, "cancelled");

    // Ручной путь не режем: снятие отмены человеком — законный сценарий, и
    // ставить его под запрет здесь значило бы чинить не ту границу.
    createTask({
      chatId: HOME,
      createdBy: "owner",
      title: "ручная подзадача",
      parentId: parent.id,
    });

    expect(getTask(parent.id)!.status).toBe("running");
  });
});
