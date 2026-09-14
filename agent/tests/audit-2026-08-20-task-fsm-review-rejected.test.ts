/**
 * Аудит 2026-08-20: у ревью не было исхода «отклонено».
 *
 * REQUEST_REVIEW (`lib/dispatch/tasks.ts:175`) паркует задачу в
 * `awaiting_review` — «работа сделана, но я не последняя инстанция». Выйти
 * оттуда таблица переходов позволяла ровно в два места: `running` (вернуть на
 * доработку) и `done` (принять). Терминала «посмотрели и не приняли» не было
 * вовсе, хотя `failed` — единственный статус, который это и означает.
 *
 * Чем это платили:
 *
 *  1. Ревьюер в Mini App видит кнопки строго по этой таблице
 *     (`miniapp/src/pages/Tasks.tsx:28`). Признать работу негодной он мог
 *     только соврав: «done» (в отчёты и дайджест уходит успех) либо вечное
 *     «running» без исполнителя.
 *  2. Агент, зовущий UPDATE_TASK_STATUS{failed} по задаче на ревью, получал
 *     `invalid status transition` — то есть тул отказывал ровно там, где
 *     честный ответ и требовался.
 *  3. `closeDelegatedTask` (`lib/action-dispatch.ts`) специально
 *     возвращает задачу из awaiting_review в running, чтобы записать провал
 *     делегата. Обход выглядит как «работу возобновили», хотя её закрыли.
 *  4. `gcStaleTasks` смотрит только pending/running — задача, оставленная в
 *     awaiting_review, не закрывается никем и никогда.
 *
 * Сознательно НЕ меняется `running → cancelled`: отмена уже идущей работы
 * ничего не останавливает (делегат досчитает и упрётся в терминал), и её
 * отсутствие пинит соседний тест tasks-fsm-bridge-cancel.test.ts.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import { createTask, getTask, updateTaskStatus } from "../lib/tasks.ts";
import { TASK_TRANSITIONS } from "../lib/task-fsm.ts";

const CHAT = -99871;

function mkReviewTask(title: string) {
  const t = createTask({ chatId: CHAT, createdBy: "orchestrator", title });
  updateTaskStatus(t.id, "running");
  updateTaskStatus(t.id, "awaiting_review");
  return t;
}

beforeEach(() => {
  db.prepare(`DELETE FROM tasks WHERE chat_id = ?`).run(CHAT);
});
afterEach(() => {
  db.prepare(`DELETE FROM tasks WHERE chat_id = ?`).run(CHAT);
});

describe("ревью умеет отклонять", () => {
  test("awaiting_review → failed проходит и пишет причину", () => {
    const t = mkReviewTask("ревью отклоняет");
    const after = updateTaskStatus(t.id, "failed", { error: "ревью: не принято" });
    expect(after.status).toBe("failed");
    expect(after.error).toBe("ревью: не принято");
    expect(getTask(t.id)!.status).toBe("failed");
  });

  test("переход есть в самой таблице — кнопка в Mini App берётся отсюда", () => {
    expect(TASK_TRANSITIONS.awaiting_review).toContain("failed");
  });

  test("оба прежних исхода ревью на месте", () => {
    expect(TASK_TRANSITIONS.awaiting_review).toContain("running");
    expect(TASK_TRANSITIONS.awaiting_review).toContain("done");

    const back = mkReviewTask("вернуть на доработку");
    expect(updateTaskStatus(back.id, "running").status).toBe("running");

    const ok = mkReviewTask("принять");
    expect(updateTaskStatus(ok.id, "done").status).toBe("done");
  });

  test("failed остаётся терминальным — из него ревью не переоткрыть", () => {
    expect(TASK_TRANSITIONS.failed).toHaveLength(0);
    const t = mkReviewTask("терминал");
    updateTaskStatus(t.id, "failed", { error: "нет" });
    expect(() => updateTaskStatus(t.id, "running")).toThrow(
      /invalid status transition/,
    );
  });

  test("контроль: отмена с ревью по-прежнему запрещена", () => {
    // Отмена — это «работа не начиналась»; после ревью она уже сделана.
    // Если этот переход появится, тест обязан упасть, а не тихо пройти.
    expect(TASK_TRANSITIONS.awaiting_review).not.toContain("cancelled");
    const t = mkReviewTask("отмена");
    expect(() => updateTaskStatus(t.id, "cancelled")).toThrow(
      /invalid status transition/,
    );
  });

  test("контроль: running → cancelled тоже не появился", () => {
    expect(TASK_TRANSITIONS.running).not.toContain("cancelled");
  });
});
