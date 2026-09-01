/**
 * Аудит 2026-08-10: мутаторы задач не привязаны к чату-источнику.
 *
 * ASSIGN_TASK / UPDATE_TASK_STATUS / REQUEST_REVIEW / COMMENT_TASK берут taskId
 * из инпута модели и идут в БД по одному лишь id — ни chat_id задачи, ни
 * assigned_to никто не сверяет. То есть агент, отвечающий в чате A, может
 * переставить статус, переназначить исполнителя или закрыть задачу на доске
 * чата B. То же и у CREATE_TASK через parentId: ребёнок создаётся в СВОЁМ
 * чате, а родитель остаётся в чужом — дерево оказывается разорванным между
 * досками, и дальше rollupParent пересчитывает статус задачи чата B по
 * ребёнку из чата A, а при уже закрытом родителе ещё и переоткрывает его.
 *
 * Чат здесь — граница арендатора, и остальная кодовая база это знает: /tasks
 * фильтрует выдачу по `t.chat_id === chatId`, SPLIT_TASK и CREATE_TASK
 * пиннят chatId через pinnedChatId, SEND_DOCUMENT пиннут. Не пиннуты ровно те
 * действия, которые адресуют задачу по id.
 *
 * UUID не угадать, но и не нужно: id живут в общей вики (личный scope роли
 * один на все чаты), в аудите, в Mini App и просто в переписке. Полный id
 * агент получает прямо в результате CREATE_TASK/DELEGATE_TO_ROLE.
 *
 * Инвариант: действие агента не выходит за пределы доски того чата, где оно
 * произошло, а чужая задача неотличима от несуществующей.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import {
  handleAssignTask,
  handleUpdateTaskStatus,
  handleRequestReview,
  handleCommentTask,
  handleCreateTask,
} from "../lib/dispatch/tasks.ts";
import { createTask, getTask, updateTaskStatus } from "../lib/tasks.ts";
import { db } from "../lib/db.ts";

const HOME = 555001;
const FOREIGN = 555002;

const ctx = { agentKey: "backend", chatId: HOME };

function makeTask(chatId: number, title: string) {
  return createTask({ chatId, createdBy: "pm", title, assignedTo: "backend" });
}

beforeEach(() => {
  db.prepare(`DELETE FROM tasks WHERE chat_id IN (?, ?)`).run(HOME, FOREIGN);
});

describe("мутаторы не дотягиваются до доски чужого чата", () => {
  test("статус чужой задачи не меняется", () => {
    const alien = makeTask(FOREIGN, "чужая задача");

    const res = handleUpdateTaskStatus(
      { taskId: alien.id, status: "done" } as never,
      ctx,
    );

    expect(res.ok).toBe(false);
    // Отказ не должен подтверждать, что такая задача вообще есть: иначе id
    // превращается в оракул существования по чужим доскам.
    expect((res as { error: string }).error).toMatch(/not found/i);
    expect(getTask(alien.id)!.status).toBe("pending");
  });

  test("исполнитель чужой задачи не переназначается", () => {
    const alien = makeTask(FOREIGN, "чужая задача");
    const res = handleAssignTask(
      { taskId: alien.id, assignedTo: "qa" } as never,
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(getTask(alien.id)!.assigned_to).toBe("backend");
  });

  test("ревью на чужую задачу не запрашивается", () => {
    const alien = makeTask(FOREIGN, "чужая задача");
    updateTaskStatus(alien.id, "running");
    const res = handleRequestReview({ taskId: alien.id } as never, ctx);
    expect(res.ok).toBe(false);
    expect(getTask(alien.id)!.status).toBe("running");
  });

  test("комментарий к чужой задаче отклоняется", () => {
    // COMMENT_TASK сам по себе пишет только в аудит — но пишет его с task_id
    // чужой задачи, то есть подмешивает след в историю другой доски.
    const alien = makeTask(FOREIGN, "чужая задача");
    const res = handleCommentTask(
      { taskId: alien.id, comment: "мимо" } as never,
      ctx,
    );
    expect(res.ok).toBe(false);
  });

  test("подзадача не вешается на родителя из чужого чата", () => {
    const alien = makeTask(FOREIGN, "чужой родитель");

    const res = handleCreateTask(
      { title: "мой ребёнок", parentId: alien.id } as never,
      ctx,
    );

    expect(res.ok).toBe(false);
    // Ребёнка быть не должно вовсе: иначе дерево разорвано между досками, а
    // rollupParent будет пересчитывать чужого родителя по нашему ребёнку.
    const kids = db
      .prepare(`SELECT count(*) as n FROM tasks WHERE parent_id = ?`)
      .get(alien.id) as { n: number };
    expect(kids.n).toBe(0);
  });

  test("закрытый родитель из чужого чата не переоткрывается", () => {
    // createTask переоткрывает терминального родителя (набор детей неполон).
    // Через чужой parentId это давало запись в статус задачи другой доски
    // даже без единого мутатора.
    const alien = makeTask(FOREIGN, "чужой закрытый родитель");
    updateTaskStatus(alien.id, "running");
    updateTaskStatus(alien.id, "done");

    handleCreateTask({ title: "мой ребёнок", parentId: alien.id } as never, ctx);

    expect(getTask(alien.id)!.status).toBe("done");
  });
});

describe("своя доска работает как прежде", () => {
  test("статус, исполнитель и ревью меняются в своём чате", () => {
    const mine = makeTask(HOME, "своя задача");

    expect(handleAssignTask({ taskId: mine.id, assignedTo: "qa" } as never, ctx).ok).toBe(true);
    expect(getTask(mine.id)!.assigned_to).toBe("qa");

    expect(handleUpdateTaskStatus({ taskId: mine.id, status: "running" } as never, ctx).ok).toBe(true);
    expect(handleRequestReview({ taskId: mine.id } as never, ctx).ok).toBe(true);
    expect(getTask(mine.id)!.status).toBe("awaiting_review");

    expect(handleCommentTask({ taskId: mine.id, comment: "ок" } as never, ctx).ok).toBe(true);
  });

  test("подзадача своего чата по-прежнему создаётся", () => {
    const parent = makeTask(HOME, "свой родитель");
    const res = handleCreateTask(
      { title: "свой ребёнок", parentId: parent.id } as never,
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(getTask((res as { taskId: string }).taskId)!.parent_id).toBe(parent.id);
  });

  test("несуществующая задача — та же ошибка, что и чужая", () => {
    const missing = handleUpdateTaskStatus(
      { taskId: "00000000-0000-4000-8000-000000000000", status: "done" } as never,
      ctx,
    );
    expect(missing.ok).toBe(false);
    expect((missing as { error: string }).error).toMatch(/not found/i);
  });
});
