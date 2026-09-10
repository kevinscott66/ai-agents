/**
 * Аудит 2026-09-11: прогон временной роли можно было закрыть со стороны доски.
 *
 * Задача-роль и строка `role_runtime_queue` — половины одного прогона: id
 * общий, вставляются одной транзакцией (`enqueueRoleTask`), и каждый UPDATE
 * воркера обусловлен `status='running'` / `state='running'`. Круг 2026-09-10
 * закрыл одну дверь к их расхождению — переоткрытие завершённой роли поздним
 * ребёнком (`createTask`). Оставались ещё две, обе ведут в тот же тупик:
 *
 * 1. `rollupParent`. Роль взята воркером (обе строки `running`); любая роль с
 *    доски заводит под ней подзадачу — это законно, модель внутри роли на
 *    CREATE_TASK{parentId} имеет право — и закрывает её. `expectedChildren`
 *    роль не обещала, значит набор «полон», и родителю штампуется терминал.
 *    Очередь остаётся `running`, `heartbeatRoleTask` ищет `status='running'`
 *    и не находит: воркер получает `leaseLost`, бросает «lease lost before
 *    completion» мимо `failRoleTask`. Оплаченный прогон выброшен, а доска
 *    показывает роль выполненной.
 * 2. `UPDATE_TASK_STATUS` / `REQUEST_REVIEW` прямо по задаче роли. На ещё не
 *    взятой роли `pending → running` оставляет очередь в `queued`, и сводящая
 *    проверка воркера молча уводит строку в `failed` — одобренный человеком
 *    прогон не случается. `awaiting_review` вдобавок не трогает `gcStaleTasks`
 *    (намеренно: это ожидание человека), так что строка зависает навсегда.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import { enqueueRoleTask } from "../lib/role-runtime.ts";
import { createTask, getTask, updateTaskStatus } from "../lib/tasks.ts";
import { handleUpdateTaskStatus, handleRequestReview } from "../lib/dispatch/tasks.ts";

const CHAT = -7_731_921;

function cleanup(): void {
  db.prepare("DELETE FROM role_runtime_queue WHERE chat_id = ?").run(CHAT);
  db.prepare("DELETE FROM tasks WHERE chat_id = ?").run(CHAT);
}

beforeEach(cleanup);
afterEach(cleanup);

/** Роль, взятая воркером: обе половины в `running`. */
function runningRole(): string {
  const item = enqueueRoleTask({
    name: "security audit",
    systemPrompt: "Ты аудитор. Проверь доступы и напиши отчёт.",
    chatId: CHAT,
    createdBy: "orchestrator",
  });
  db.prepare("UPDATE tasks SET status='running' WHERE id=?").run(item.taskId);
  db.prepare("UPDATE role_runtime_queue SET state='running' WHERE task_id=?").run(item.taskId);
  return item.taskId;
}

function queueState(taskId: string): string {
  return (
    db
      .prepare("SELECT state FROM role_runtime_queue WHERE task_id=?")
      .get(taskId) as { state: string }
  ).state;
}

describe("статус прогона роли принадлежит воркеру", () => {
  test("закрытая подзадача не закрывает прогон", () => {
    const roleTaskId = runningRole();
    const child = createTask({
      chatId: CHAT,
      createdBy: "qa",
      title: "проверить логи",
      parentId: roleTaskId,
    });

    updateTaskStatus(child.id, "running");
    updateTaskStatus(child.id, "done");

    // Половины не разъехались: обе всё ещё про идущий прогон.
    expect(getTask(roleTaskId)!.status).toBe("running");
    expect(queueState(roleTaskId)).toBe("running");
  });

  test("UPDATE_TASK_STATUS по задаче роли отклоняется", () => {
    const roleTaskId = runningRole();

    const res = handleUpdateTaskStatus(
      { taskId: roleTaskId, status: "done" } as never,
      { agentKey: "qa", chatId: CHAT },
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("прогон временной роли");
    expect(getTask(roleTaskId)!.status).toBe("running");
    expect(queueState(roleTaskId)).toBe("running");
  });

  test("REQUEST_REVIEW по задаче роли отклоняется", () => {
    const roleTaskId = runningRole();

    const res = handleRequestReview({ taskId: roleTaskId } as never, {
      agentKey: "qa",
      chatId: CHAT,
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(getTask(roleTaskId)!.status).toBe("running");
  });

  test("обычный родитель по-прежнему закрывается по детям (контроль)", () => {
    const parent = createTask({
      chatId: CHAT,
      createdBy: "orchestrator",
      title: "обычная задача",
    });
    const child = createTask({
      chatId: CHAT,
      createdBy: "orchestrator",
      title: "ребёнок",
      parentId: parent.id,
    });

    updateTaskStatus(child.id, "running");
    updateTaskStatus(child.id, "done");

    expect(getTask(parent.id)!.status).toBe("done");
  });
});
