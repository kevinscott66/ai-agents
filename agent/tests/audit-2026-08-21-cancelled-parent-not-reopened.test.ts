/**
 * Аудит 2026-08-21: отменённая человеком задача воскресала появлением ребёнка
 * и закрывалась как выполненная.
 *
 * `createTask` переоткрывает терминального родителя, когда под ним появляется
 * новый ребёнок. Обоснование (tasks.ts, комментарий выше по файлу) держится на
 * том, что `done`/`failed` — это ВЫВОД кода о полноте набора детей, и новый
 * ребёнок этот вывод опровергает. `cancelled` — тоже терминал с пустым списком
 * переходов, поэтому попадал сюда наравне. Но отмена не вывод, а решение
 * человека: в `cancelled` из `pending` и `awaiting_approval` ведут только
 * кнопки Mini App (эти строки `TASK_TRANSITIONS` в task-fsm.ts), а из
 * `running` перехода нет вовсе.
 *
 * Замер до правки:
 *   после отмены человеком: cancelled
 *   после появления ребёнка: running | error: null
 *   после закрытия ребёнка:  done
 *
 * То есть отмена откатывалась молча (UPDATE ... error=NULL стирал и статус, и
 * текст), а `rollupParent` закрывал родителя по детям. На доске отменённая
 * человеком задача показана выполненной, следа отмены не оставалось нигде.
 * Внутреннее противоречие: `rollupParent` отказывается пересчитывать
 * отменённого родителя специально — переоткрытие снимало ровно эту защиту,
 * переводя его в `running` ДО проверки.
 *
 * ГДЕ ЧИНИТЬ. Не в `createTask`: ту же функцию зовут аппрувы и Mini App, где
 * снятие отмены человеком законно, и это зафиксировано отдельным тестом
 * (`audit-2026-08-20-create-task-cancelled-parent.test.ts`, describe «граница
 * именно на входе модели»). Режем на входах модели. Их два, и `CREATE_TASK`
 * закрыт там же (`handleCreateTask` в dispatch/tasks.ts); второй —
 * `DELEGATE_TO_ROLE`, куда `parentId` приезжает явным `_parent_task_id` и,
 * чаще, циклом `SPLIT_TASK`: тот создаёт детей по одному через
 * gateOrDispatch, каждая итерация — полный ход делегата (десятки секунд ×
 * N ролей), и владелец, нажавший «отменить» на
 * `[split] …`, отменял только уже созданное — следующий ребёнок переоткрывал
 * родителя.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { dispatchAction } from "../lib/action-dispatch.ts";
import { createTask, getTask, updateTaskStatus, rollupParent } from "../lib/tasks.ts";
import { TASK_TRANSITIONS } from "../lib/task-fsm.ts";
import { db } from "../lib/db.ts";

const CHAT = -100_777_021;
let seq = 0;
const uniq = (s: string) => `${s} #${Date.now()}-${seq++}`;

function cleanup(): void {
  db.prepare(`DELETE FROM tasks WHERE chat_id = ?`).run(CHAT);
}

beforeEach(cleanup);
afterEach(cleanup);

function parentWithStatus(
  status: "cancelled" | "done" | "failed",
  error?: string,
): string {
  const p = createTask({ chatId: CHAT, createdBy: "owner", title: uniq("Релиз") });
  if (status === "cancelled") {
    updateTaskStatus(p.id, "cancelled", error ? { error } : undefined);
  } else {
    updateTaskStatus(p.id, "running");
    updateTaskStatus(p.id, status, { error: error ?? "преждевременный вывод" });
  }
  expect(getTask(p.id)!.status).toBe(status);
  return p.id;
}

/**
 * Хендлер зовём напрямую, а не через `dispatchAndAudit`: гейт и аудит к этой
 * границе отношения не имеют, а тестовый ctx без `resolveAgent` до отказа по
 * отменённому родителю доходить обязан — проверка стоит выше резолва ботов
 * ровно потому, что «не делаем» не зависит от того, поднялся ли целевой бот.
 */
const delegateUnder = (parentId: string) =>
  dispatchAction(
    "DELEGATE_TO_ROLE",
    { role: "backend", task: "подзадача", _parent_task_id: parentId } as never,
    { agentKey: "pm", chatId: CHAT },
  );

describe("отменённого родителя вход модели не воскрешает", () => {
  test("DELEGATE_TO_ROLE под отменённым родителем — отказ", async () => {
    const parent = parentWithStatus("cancelled");
    const res = await delegateUnder(parent);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(String(res.error)).toContain("cancelled");
    // Отказ должен случиться ДО резолва ботов: иначе на боевом ctx (где
    // resolveAgent есть) порядок был бы другим, чем в тесте.
    expect(String(res.error)).not.toMatch(/resolveAgent/);
  });

  test("статус и текст отмены не тронуты", async () => {
    const parent = parentWithStatus("cancelled", "владелец отменил релиз");
    await delegateUnder(parent);

    expect(getTask(parent)!.status).toBe("cancelled");
    expect(getTask(parent)!.error).toBe("владелец отменил релиз");
  });

  test("строки ребёнка не появляется вовсе", async () => {
    const parent = parentWithStatus("cancelled");
    await delegateUnder(parent);

    const kids = db
      .prepare(`SELECT id FROM tasks WHERE parent_id = ?`)
      .all(parent) as unknown[];
    expect(kids.length).toBe(0);
  });

  test("несколько попыток подряд — родитель всё ещё отменён", async () => {
    const parent = parentWithStatus("cancelled");
    for (let i = 0; i < 3; i++) await delegateUnder(parent);
    rollupParent(parent);
    expect(getTask(parent)!.status).toBe("cancelled");
  });
});

describe("done/failed по-прежнему переоткрываются", () => {
  for (const terminal of ["done", "failed"] as const) {
    test(`родитель ${terminal}: отказ не по отмене`, async () => {
      const parent = parentWithStatus(terminal);
      const res = await delegateUnder(parent);

      // В тестовом ctx нет resolveAgent, поэтому хендлер всё равно откажет —
      // но уже ПОСЛЕ нашей проверки и по другой причине. Важно, что отмена
      // тут ни при чём и родитель не заперт.
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(String(res.error)).not.toContain("cancelled");
    });
  }

  test("прямой createTask (аппрувы, Mini App) переоткрытие сохраняет", () => {
    const parent = parentWithStatus("cancelled");
    createTask({
      chatId: CHAT,
      createdBy: "owner",
      title: uniq("ручная подзадача"),
      parentId: parent,
    });
    // Ручной путь не режем сознательно: снятие отмены человеком — законный
    // сценарий, и запрет здесь чинил бы не ту границу.
    expect(getTask(parent)!.status).toBe("running");
  });
});

describe("предпосылки, на которых держится правка", () => {
  test("cancelled — терминал в FSM наравне с done/failed", () => {
    expect(TASK_TRANSITIONS.cancelled).toEqual([]);
    expect(TASK_TRANSITIONS.done).toEqual([]);
    expect(TASK_TRANSITIONS.failed).toEqual([]);
  });

  test("в cancelled человек попадает из pending и awaiting_approval", () => {
    expect(TASK_TRANSITIONS.pending).toContain("cancelled");
    expect(TASK_TRANSITIONS.awaiting_approval).toContain("cancelled");
    // Из running — нет: там отмена уже не кнопка владельца.
    expect(TASK_TRANSITIONS.running).not.toContain("cancelled");
  });

  test("rollupParent сам отказывается пересчитывать отменённого родителя", () => {
    // Ребёнок появляется ДО отмены — иначе `createTask` переоткроет родителя
    // (законный ручной путь), и мерить мы будем не защиту rollup'а, а её
    // отсутствие после переоткрытия.
    const p = createTask({ chatId: CHAT, createdBy: "owner", title: uniq("Релиз") });
    const child = createTask({
      chatId: CHAT,
      createdBy: "backend",
      title: uniq("бэкенд"),
      parentId: p.id,
    });
    updateTaskStatus(p.id, "cancelled");
    updateTaskStatus(child.id, "running");
    updateTaskStatus(child.id, "failed", { error: "упало" });
    rollupParent(p.id);
    expect(getTask(p.id)!.status).toBe("cancelled");
  });
});
