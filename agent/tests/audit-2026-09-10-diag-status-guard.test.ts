/**
 * Аудит 2026-09-10: чужая роль уводила задачу самопочинки из статуса, в
 * котором её ищут.
 *
 * Оба поставщика работы для самопочинки смотрят на статус в упор:
 * `listPendingDiagTasks` — строго `pending` (self-diag.ts:492), подборщик
 * осиротевших — строго `running` (:397), а `processDiagTask` пишет терминал
 * каждым UPDATE'ом с `AND status='running'`. Пока задача в `running` — поллер
 * поставил его ДО вызова модели — любая роль с той же доски могла увести её:
 * REQUEST_REVIEW в `awaiting_review`, UPDATE_TASK_STATUS в `done`.
 *
 * После этого задачу не видит никто: поллер ждёт `pending`, подборщик —
 * `running`, а `gcStaleTasks` `awaiting_review` не трогает намеренно. Ретрай
 * упавшего действия — а он разрешён ровно один — сгорал, не состоявшись.
 *
 * Тест держит обе двери и границу между ними: aieng свою задачу двигать
 * вправе, все остальные — нет.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { db } from "../lib/db.ts";
import { createTask, getTask, updateTaskStatus } from "../lib/tasks.ts";
import { handleRequestReview, handleUpdateTaskStatus } from "../lib/dispatch/tasks.ts";

const CHAT = -99233;

function diagTask(): string {
  const t = createTask({
    chatId: CHAT,
    createdBy: "orchestrator",
    assignedTo: "aieng",
    title: "самопочинка",
    inputPayload: { _diag: true, action: "SEND_MESSAGE" },
  });
  // Ровно то окно, в котором дыра и открыта: поллер уже взял задачу в работу.
  updateTaskStatus(t.id, "running");
  return t.id;
}

describe("статус задачи самопочинки чужой роли не подчиняется", () => {
  beforeEach(() => {
    db.prepare(`DELETE FROM tasks WHERE chat_id=?`).run(CHAT);
  });

  test("REQUEST_REVIEW от чужой роли — отказ, статус на месте", () => {
    const id = diagTask();
    const res = handleRequestReview({ taskId: id }, { agentKey: "smm", chatId: CHAT });
    expect(res.ok).toBe(false);
    expect(getTask(id)!.status).toBe("running");
  });

  test("UPDATE_TASK_STATUS от чужой роли — отказ, статус на месте", () => {
    const id = diagTask();
    const res = handleUpdateTaskStatus(
      { taskId: id, status: "done" },
      { agentKey: "smm", chatId: CHAT },
    );
    expect(res.ok).toBe(false);
    expect(getTask(id)!.status).toBe("running");
  });

  test("отказ называет причину, а не «task not found»", () => {
    const id = diagTask();
    const res = handleRequestReview({ taskId: id }, { agentKey: "backend", chatId: CHAT });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("самодиагностики");
  });

  test("aieng свою задачу двигать вправе", () => {
    const id = diagTask();
    const res = handleUpdateTaskStatus(
      { taskId: id, status: "done" },
      { agentKey: "aieng", chatId: CHAT },
    );
    expect(res.ok).toBe(true);
    expect(getTask(id)!.status).toBe("done");
  });

  test("контроль: обычную задачу чужая роль по-прежнему двигает", () => {
    const t = createTask({ chatId: CHAT, createdBy: "pm", title: "обычная" });
    updateTaskStatus(t.id, "running");
    const res = handleRequestReview({ taskId: t.id }, { agentKey: "smm", chatId: CHAT });
    expect(res.ok).toBe(true);
    expect(getTask(t.id)!.status).toBe("awaiting_review");
  });
});
