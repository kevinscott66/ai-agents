/**
 * Аудит 2026-08-14: `forceTerminalStatus` вёл задачу к терминалу по одному
 * UPDATE на шаг FSM, каждый в своём автокоммите. Промежуточный `running` —
 * это след пути, а не состояние: сбой между шагами оставлял задачу в нём
 * долговечно, и через сутки её подбирал `gcStaleTasks`, переписывая в
 * `failed, error='gc_stale'` с подъёмом провала к родителю. Отмена сплита,
 * у которого все дети отменены, задним числом становилась «упало по
 * таймауту».
 *
 * Замер: подменённый `db.prepare`, бросающий на записи терминала.
 *   было  → статус после вызова `running`
 *   стало → `awaiting_approval`, то есть исходный
 *
 * Аудит 2026-08-20: сценарий переставлен с `awaiting_review` на
 * `awaiting_approval`. Мост нужен только там, где прямого перехода нет, а
 * `awaiting_review → failed` в таблице появился (у ревью не было исхода
 * «отклонено»), и мост для этой пары стал пустым — тест бы молча перестал
 * проверять то, ради чего написан. `awaiting_approval → failed` по-прежнему
 * идёт через `running`, поэтому замер остался тем же.
 */
import { test, expect, describe, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import {
  createTask,
  getTask,
  updateTaskStatus,
  rollupParent,
  TASK_FSM,
} from "../lib/tasks.ts";

const realPrepare = db.prepare.bind(db);

afterEach(() => {
  (db as unknown as { prepare: typeof realPrepare }).prepare = realPrepare;
});

/** Роняет запись терминала (единственный UPDATE с `error=?`), мост — пропускает. */
function breakTerminalWrite(): void {
  (db as unknown as { prepare: typeof realPrepare }).prepare = ((sql: string) => {
    if (sql.includes("error=?")) throw new Error("boom: рестарт между шагами");
    return realPrepare(sql);
  }) as typeof realPrepare;
}

/** Родитель в awaiting_approval + один провалившийся ребёнок. */
function seedSplit(): { parentId: string; childId: string } {
  const parent = createTask({ title: "сплит", createdBy: "orchestrator", chatId: -100123 });
  updateTaskStatus(parent.id, "running");
  updateTaskStatus(parent.id, "awaiting_approval");
  const child = createTask({
    title: "ребёнок",
    createdBy: "orchestrator",
    chatId: -100123,
    parentId: parent.id,
  });
  updateTaskStatus(child.id, "running");
  updateTaskStatus(child.id, "failed", { error: "child task failed" });
  // Провал ребёнка сам зовёт rollupParent — откатываем родителя обратно на
  // ревью, чтобы мост в тесте начинался с того же места, что и в проде.
  db.prepare(`UPDATE tasks SET status='awaiting_approval', error=NULL WHERE id=?`).run(
    parent.id,
  );
  return { parentId: parent.id, childId: child.id };
}

describe("мост к терминалу атомарен", () => {
  test("путь из двух шагов действительно есть — иначе тест ничего не проверяет", () => {
    // awaiting_approval → running → failed: мост непустой, значит в старом
    // коде между шагами был коммит.
    expect(TASK_FSM.awaiting_approval).toContain("running");
    expect(TASK_FSM.awaiting_approval).not.toContain("failed");
    expect(TASK_FSM.running).toContain("failed");
  });

  test("сбой на записи терминала не оставляет задачу в промежуточном running", () => {
    const { parentId } = seedSplit();
    expect(getTask(parentId)?.status).toBe("awaiting_approval");

    breakTerminalWrite();
    expect(() => rollupParent(parentId)).toThrow(/boom/);

    // Ключевое: НЕ "running". Иначе через сутки gcStaleTasks перепишет её в
    // failed с чужой причиной.
    expect(getTask(parentId)?.status).toBe("awaiting_approval");
  });

  test("сбой не оставляет и следов частичной записи: error пуст, статус исходный", () => {
    const { parentId } = seedSplit();

    breakTerminalWrite();
    expect(() => rollupParent(parentId)).toThrow();

    const row = db
      .prepare(`SELECT status, error FROM tasks WHERE id=?`)
      .get(parentId) as { status: string; error: string | null };
    expect(row.status).toBe("awaiting_approval");
    expect(row.error).toBeNull();
  });

  test("без сбоя rollup по-прежнему доводит родителя до failed с причиной ребёнка", () => {
    const { parentId } = seedSplit();

    rollupParent(parentId);

    const parent = getTask(parentId);
    expect(parent?.status).toBe("failed");
    expect(parent?.error).toBe("child task failed");
  });

  test("отмена всех детей по-прежнему даёт cancelled, а не running", () => {
    const parent = createTask({ title: "сплит-2", createdBy: "orchestrator", chatId: -100123 });
    updateTaskStatus(parent.id, "running");
    updateTaskStatus(parent.id, "awaiting_review");
    const child = createTask({
      title: "ребёнок-2",
      createdBy: "orchestrator",
      chatId: -100123,
      parentId: parent.id,
    });
    updateTaskStatus(child.id, "cancelled");
    db.prepare(`UPDATE tasks SET status='awaiting_review', error=NULL WHERE id=?`).run(
      parent.id,
    );

    rollupParent(parent.id);

    expect(getTask(parent.id)?.status).toBe("cancelled");
  });

  test("задача уже терминальна — мост не запускается вовсе", () => {
    const { parentId } = seedSplit();
    rollupParent(parentId);
    expect(getTask(parentId)?.status).toBe("failed");

    // Повторный rollup на терминальном родителе ничего не переписывает,
    // в том числе при сломанной записи.
    breakTerminalWrite();
    expect(() => rollupParent(parentId)).not.toThrow();
    expect(getTask(parentId)?.status).toBe("failed");
  });
});
