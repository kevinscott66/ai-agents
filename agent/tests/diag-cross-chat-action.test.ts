/**
 * Аудит 2026-08-11: явный CREATE_DIAGNOSTIC_TASK адресовал провал по id и не
 * спрашивал, из какого он чата.
 *
 * `failed_action_id` приходит ОТ МОДЕЛИ — это уже отмечено в самом хендлере,
 * когда туда добавляли дедуп. Но проверялось только «существует ли строка»:
 * `getAction(id)` читает `agent_actions` без единого условия по чату, при том
 * что у таблицы есть `chat_id`, а соседний `listActions` его фильтрует с T-725.
 *
 * Две цены, обе реальные:
 *
 *  1. Утечка внутрь. Текст чужой ошибки (`original_error`), тип действия и
 *     категория ложились задачей на НАШУ доску — то есть попадали в /tasks,
 *     Mini App и в контекст следующего вызова модели.
 *
 *  2. Запись наружу. `parentId: failed.task_id` — id задачи с ЧУЖОЙ доски.
 *     `createTask` при терминальном родителе тут же переоткрывает его
 *     (status→running, error=NULL), а когда диагностика закроется,
 *     `rollupParent` перепишет чужой задаче статус. Ровно тот разрыв дерева
 *     между чатами, ради которого 2026-08-10 в handleCreateTask завели
 *     `ownTask` — только вторым путём, мимо него.
 *
 * Инвариант: чат — граница арендатора и для аудита тоже. Чужое действие
 * отдаётся как несуществующее, теми же словами: иначе перебор id даёт оракул
 * существования по чужим чатам.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import { handleCreateDiagnosticTask } from "../lib/dispatch/diagnostic-action.ts";
import { logAction } from "../lib/audit.ts";
import { createTask, getTask } from "../lib/tasks.ts";

const OURS = -1_000_811_001;
const THEIRS = -1_000_811_002;
const HYPOTHESIS = "похоже, у роли нет права на это действие";
const ACT = "AUDIT_XCHAT_A";

function failedAction(chatId: number | null, taskId: string | null = null): string {
  const { id } = logAction({
    agentKey: "backend",
    actionType: ACT,
    chatId,
    taskId,
    payload: {},
    status: "error",
    error: `permission denied for ${ACT}`,
  } as never);
  return id;
}

function tasksIn(chatId: number): number {
  const r = db
    .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE chat_id = ?`)
    .get(chatId) as { n: number };
  return r.n;
}

function cleanup() {
  for (const c of [OURS, THEIRS]) {
    db.prepare(`DELETE FROM tasks WHERE chat_id = ?`).run(c);
    db.prepare(`DELETE FROM agent_actions WHERE chat_id = ?`).run(c);
  }
  db.prepare(`DELETE FROM agent_actions WHERE action_type = ?`).run(ACT);
}

beforeEach(cleanup);
afterEach(cleanup);

describe("диагностика не пересекает границу чата", () => {
  test("провал из чужого чата — как несуществующий", () => {
    const foreign = failedAction(THEIRS);
    const res = handleCreateDiagnosticTask(
      { failed_action_id: foreign, hypothesis: HYPOTHESIS } as never,
      { agentKey: "backend", chatId: OURS },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    // Тот же текст, что у неизвестного id: разница видна только в логе.
    expect(res.error).toBe(`failed_action_id not found: ${foreign}`);
    expect(tasksIn(OURS)).toBe(0);
  });

  test("чужая закрытая задача не переоткрывается", () => {
    // Самое дорогое последствие: строка на чужой доске меняется без апрува,
    // по одному id в payload'е модели.
    const theirTask = createTask({
      chatId: THEIRS,
      createdBy: "pm",
      title: "релиз чужого чата",
    });
    db.prepare(`UPDATE tasks SET status='done' WHERE id=?`).run(theirTask.id);
    const foreign = failedAction(THEIRS, theirTask.id);

    handleCreateDiagnosticTask(
      { failed_action_id: foreign, hypothesis: HYPOTHESIS } as never,
      { agentKey: "backend", chatId: OURS },
    );

    expect(getTask(theirTask.id)!.status).toBe("done");
    expect(tasksIn(OURS)).toBe(0);
  });

  test("действие без чата тоже отказ — принадлежность не проверить", () => {
    const orphan = failedAction(null);
    const res = handleCreateDiagnosticTask(
      { failed_action_id: orphan, hypothesis: HYPOTHESIS } as never,
      { agentKey: "backend", chatId: OURS },
    );
    expect(res.ok).toBe(false);
  });

  test("свой провал по-прежнему заводит расследование", () => {
    const mine = failedAction(OURS);
    const res = handleCreateDiagnosticTask(
      { failed_action_id: mine, hypothesis: HYPOTHESIS } as never,
      { agentKey: "backend", chatId: OURS },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.task_id).toBeTruthy();
    expect(tasksIn(OURS)).toBe(1);
  });

  test("своя закрытая задача тоже не переоткрывается", () => {
    // Здесь стояло `parent_id === mineTask.id` — «родитель со своей доски
    // сохраняется». Аудит 2026-08-13 показал, что сохранять его нельзя ни на
    // чьей доске: переоткрытие терминального родителя стирает `error`, а
    // rollupParent потом закрывает его по итогу расследования. Тест выше
    // («чужая закрытая задача не переоткрывается») ловил ровно эту беду —
    // но только за границей чата, хотя цена у неё одинаковая по обе стороны.
    //
    // Границу чата это не ослабляет: чужое действие по-прежнему отдаётся как
    // несуществующее (первый тест), задача на нашей доске не заводится вовсе.
    // Связь с исходной задачей живёт в payload'е и в agent_actions.task_id.
    const mineTask = createTask({
      chatId: OURS,
      createdBy: "pm",
      title: "своя задача",
    });
    db.prepare(`UPDATE tasks SET status='failed', error='API 400' WHERE id=?`).run(
      mineTask.id,
    );
    const mine = failedAction(OURS, mineTask.id);
    const res = handleCreateDiagnosticTask(
      { failed_action_id: mine, hypothesis: HYPOTHESIS } as never,
      { agentKey: "backend", chatId: OURS },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(getTask(res.result.task_id!)!.parent_id).toBeNull();

    // Причина провала на месте — а не затёрта переоткрытием.
    const parent = getTask(mineTask.id)!;
    expect(parent.status).toBe("failed");
    expect(parent.error).toBe("API 400");
  });

  test("исчезнувший родитель не роняет хендлер", () => {
    // `agent_actions` переживает `tasks`: строку задачи могли убрать архивом,
    // а createTask на отсутствующего родителя бросает. Провал расследования
    // не должен быть исключением наружу — расследуем без родителя.
    //
    // С 2026-08-13 родителя не берут вообще, так что бросить тут уже нечему —
    // тест остаётся сторожем: если родительство когда-нибудь вернут, оно
    // обязано пережить архивацию исходной задачи.
    const gone = createTask({ chatId: OURS, createdBy: "pm", title: "исчезнет" });
    const mine = failedAction(OURS, gone.id);
    db.prepare(`DELETE FROM tasks WHERE id=?`).run(gone.id);

    const res = handleCreateDiagnosticTask(
      { failed_action_id: mine, hypothesis: HYPOTHESIS } as never,
      { agentKey: "backend", chatId: OURS },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(getTask(res.result.task_id!)!.parent_id).toBeNull();
  });
});
