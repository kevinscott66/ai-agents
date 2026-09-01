/**
 * Аудит 2026-08-28: любая роль могла необратимо отменить чужую задачу.
 *
 * `cancelled` — терминальный статус: `TASK_TRANSITIONS.cancelled === []`, и
 * читают эту таблицу оба потребителя (сервер валидирует ею запись, Mini App
 * ею же рисует кнопки). То есть отменённую задачу не вернёт ни модель, ни
 * человек в Mini App — путь наружу существует ровно один, через
 * CREATE_TASK{parentId}, и он для моделей закрыт с аудита 2026-08-20.
 *
 * При этом `handleUpdateTaskStatus` пускал в `cancelled` кого угодно с доски
 * чата: проверка была одна — задача из моего чата. Отмена — не «мой статус»,
 * а решение «не делаем» по чужой работе, и цена ошибки здесь не «поставили не
 * тот статус», а «работа удалена без возврата».
 *
 * Тот же аудит 2026-08-20 уже записал доктрину в соседнем хендлере:
 * «`cancelled` ставит человек — это решение „не делаем“, а не промежуточный
 * итог rollup'а». Охранялся только вход обратно; вход внутрь оставался
 * открытым.
 *
 * Правило: отменить можно только задачу, которую создал ты сам. Остальным
 * доступен честный путь `running → failed{error}` — он оставляет причину и не
 * терминален для доски (родитель пересчитается rollup'ом).
 */
import { describe, test, expect, beforeEach } from "bun:test";
import {
  handleUpdateTaskStatus,
  handleCreateTask,
} from "../lib/dispatch/tasks.ts";
import { createTask, getTask, updateTaskStatus } from "../lib/tasks.ts";
import { TASK_TRANSITIONS } from "../lib/task-fsm.ts";
import { db } from "../lib/db.ts";

const HOME = 556001;
const FOREIGN = 556002;

const backend = { agentKey: "backend", chatId: HOME };

function task(createdBy: string, opts: { chatId?: number; assignedTo?: string } = {}) {
  return createTask({
    chatId: opts.chatId ?? HOME,
    createdBy,
    title: `задача от ${createdBy}`,
    assignedTo: opts.assignedTo ?? "backend",
  });
}

beforeEach(() => {
  db.prepare(`DELETE FROM tasks WHERE chat_id IN (?, ?)`).run(HOME, FOREIGN);
});

describe("предпосылки", () => {
  test("отмена необратима — из cancelled нет ни одного перехода", () => {
    expect(TASK_TRANSITIONS.cancelled).toEqual([]);
  });

  test("из pending отмена — единственный способ закрыть задачу", () => {
    // Поэтому её не запрещаем совсем: у создателя должен остаться способ
    // убрать свою же лишнюю задачу.
    expect(TASK_TRANSITIONS.pending).toContain("cancelled");
    expect(TASK_TRANSITIONS.pending).not.toContain("failed");
    expect(TASK_TRANSITIONS.pending).not.toContain("done");
  });
});

describe("отменить может только тот, кто завёл", () => {
  test("чужую задачу отменить нельзя, и статус не сдвинулся", () => {
    const t = task("pm");

    const res = handleUpdateTaskStatus(
      { taskId: t.id, status: "cancelled" } as never,
      backend,
    );

    expect(res.ok).toBe(false);
    expect(getTask(t.id)!.status).toBe("pending");
  });

  test("исполнитель — тоже не владелец отмены", () => {
    // Роль назначена на задачу, но завёл её не она.
    const t = task("pm", { assignedTo: "backend" });
    expect(
      handleUpdateTaskStatus({ taskId: t.id, status: "cancelled" } as never, backend).ok,
    ).toBe(false);
  });

  test("задачу человека из Mini App роль не отменяет", () => {
    const t = task("miniapp:42");
    expect(
      handleUpdateTaskStatus({ taskId: t.id, status: "cancelled" } as never, backend).ok,
    ).toBe(false);
  });

  test("свою задачу отменить можно", () => {
    const t = task("backend");
    const res = handleUpdateTaskStatus(
      { taskId: t.id, status: "cancelled" } as never,
      backend,
    );
    expect(res.ok).toBe(true);
    expect(getTask(t.id)!.status).toBe("cancelled");
  });

  test("своя задача отменяется и из awaiting_approval", () => {
    const t = task("backend");
    updateTaskStatus(t.id, "awaiting_approval");
    expect(
      handleUpdateTaskStatus({ taskId: t.id, status: "cancelled" } as never, backend).ok,
    ).toBe(true);
  });

  test("чужая задача не отменяется и из awaiting_approval", () => {
    const t = task("pm");
    updateTaskStatus(t.id, "awaiting_approval");
    expect(
      handleUpdateTaskStatus({ taskId: t.id, status: "cancelled" } as never, backend).ok,
    ).toBe(false);
  });
});

describe("отказ называет, что делать вместо", () => {
  test("в тексте есть честная альтернатива, а не только запрет", () => {
    const t = task("pm");
    const res = handleUpdateTaskStatus(
      { taskId: t.id, status: "cancelled" } as never,
      backend,
    );
    const err = (res as { error: string }).error;
    expect(err).toContain("failed");
    expect(err).toContain(t.id);
  });

  test("отказ по чужому ЧАТУ остаётся неотличим от несуществующей задачи", () => {
    // Иначе новый текст становится оракулом: «нельзя отменить» подтверждало бы
    // существование задачи на чужой доске, а «not found» — нет.
    const alien = task("backend", { chatId: FOREIGN });
    const res = handleUpdateTaskStatus(
      { taskId: alien.id, status: "cancelled" } as never,
      backend,
    );
    expect((res as { error: string }).error).toMatch(/not found/i);
  });
});

describe("совместная доска не сломана", () => {
  test("нетерминальные и не-отменяющие переходы по чужой задаче работают", () => {
    const t = task("pm");
    expect(
      handleUpdateTaskStatus({ taskId: t.id, status: "running" } as never, backend).ok,
    ).toBe(true);
    expect(
      handleUpdateTaskStatus(
        { taskId: t.id, status: "failed", error: "не выходит" } as never,
        backend,
      ).ok,
    ).toBe(true);
    expect(getTask(t.id)!.status).toBe("failed");
  });

  test("чужую задачу можно закрыть как done — это про работу, а не про отмену", () => {
    const t = task("pm");
    updateTaskStatus(t.id, "running");
    expect(
      handleUpdateTaskStatus({ taskId: t.id, status: "done" } as never, backend).ok,
    ).toBe(true);
  });

  test("подзадача под своим родителем по-прежнему создаётся", () => {
    const parent = task("pm");
    const res = handleCreateTask(
      { title: "ребёнок", parentId: parent.id } as never,
      backend,
    );
    expect(res.ok).toBe(true);
  });
});
