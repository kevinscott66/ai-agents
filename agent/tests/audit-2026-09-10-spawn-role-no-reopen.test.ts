/**
 * Аудит 2026-09-10: подзадача переоткрывала завершённый прогон роли.
 *
 * `createTask` переоткрывает терминального родителя, потому что появление
 * нового ребёнка опровергает вывод КОДА о полноте набора детей (rollupParent).
 * У задачи-роли (`SPAWN_ROLE`) статус так не выводится: его пишет воркер
 * рантайма в паре со строкой `role_runtime_queue` — id у обеих общий, вставка
 * одной транзакцией (`enqueueRoleTask`).
 *
 * Дети у роли при этом законны: модель внутри прогона имеет право на
 * CREATE_TASK{parentId}. И каждый такой ребёнок переводил уже закрытый прогон
 * в `running` с `error=NULL`, тогда как очередь оставалась `done`/`failed`.
 * Второго прогона не будет никогда — `claimNextRoleTask` берёт только
 * `queued`, а все UPDATE'ы воркера обусловлены `state='running'`. Итог: две
 * таблицы про один прогон расходятся навсегда, причина падения затирается, а
 * следующий rollupParent досчитывает роль по посторонним подзадачам — упавшая
 * роль выезжает на доску `done`.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { db } from "../lib/db.ts";
import { createTask, getTask } from "../lib/tasks.ts";
import { enqueueRoleTask } from "../lib/role-runtime.ts";

const CHAT = -99231;

/**
 * Завершить прогон так, как это делает воркер (role-runtime.ts:552, :578) —
 * обе строки разом. Через сам воркер не идём намеренно: тест про createTask,
 * а не про провайдеров.
 */
function finishRun(taskId: string, status: "done" | "failed", error: string | null) {
  db.transaction(() => {
    db.prepare(`UPDATE role_runtime_queue SET state=? WHERE task_id=?`).run(status, taskId);
    db.prepare(`UPDATE tasks SET status=?, error=?, updated_at=? WHERE id=?`)
      .run(status, error, Date.now(), taskId);
  })();
}

function spawnRole(): string {
  return enqueueRoleTask({
    name: `audit role ${crypto.randomUUID().slice(0, 8)}`,
    systemPrompt: "ты роль",
    chatId: CHAT,
    createdBy: "orchestrator",
  }).taskId;
}

describe("createTask не переоткрывает завершённый прогон роли", () => {
  beforeEach(() => {
    db.prepare(`DELETE FROM role_runtime_queue WHERE chat_id=?`).run(CHAT);
    db.prepare(`DELETE FROM tasks WHERE chat_id=?`).run(CHAT);
  });

  test("done-роль остаётся done, очередь с ней согласна", () => {
    const roleId = spawnRole();
    finishRun(roleId, "done", null);

    createTask({ chatId: CHAT, createdBy: "backend", title: "хвост", parentId: roleId });

    expect(getTask(roleId)!.status).toBe("done");
    const q = db.prepare(`SELECT state FROM role_runtime_queue WHERE task_id=?`).get(roleId) as
      | { state: string }
      | undefined;
    expect(q?.state).toBe("done");
  });

  test("failed-роль сохраняет причину падения", () => {
    const roleId = spawnRole();
    finishRun(roleId, "failed", "provider timeout");

    createTask({ chatId: CHAT, createdBy: "backend", title: "хвост", parentId: roleId });

    const role = getTask(roleId)!;
    expect(role.status).toBe("failed");
    // Ровно то, что затирал `error=NULL` при переоткрытии: в очереди текста
    // падения нет, эта колонка — единственное его место.
    expect(role.error).toBe("provider timeout");
  });

  test("роль-ПРЕДОК тоже останавливает подъём", () => {
    const roleId = spawnRole();
    // Ребёнок роли, закрытый до появления второго: обычная задача, её
    // переоткрыть можно и нужно, а вот подниматься выше неё — нельзя.
    const mid = createTask({ chatId: CHAT, createdBy: "backend", title: "середина", parentId: roleId });
    db.prepare(`UPDATE tasks SET status='done' WHERE id=?`).run(mid.id);
    finishRun(roleId, "done", null);

    createTask({ chatId: CHAT, createdBy: "backend", title: "внук", parentId: mid.id });

    expect(getTask(mid.id)!.status).toBe("running");
    expect(getTask(roleId)!.status).toBe("done");
  });

  test("контроль: обычный терминальный родитель по-прежнему переоткрывается", () => {
    const parent = createTask({ chatId: CHAT, createdBy: "pm", title: "обычный" });
    db.prepare(`UPDATE tasks SET status='done' WHERE id=?`).run(parent.id);

    createTask({ chatId: CHAT, createdBy: "backend", title: "поздний ребёнок", parentId: parent.id });

    expect(getTask(parent.id)!.status).toBe("running");
  });
});
