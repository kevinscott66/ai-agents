/**
 * Аудит 2026-08-29 — окно дедупликации диагностик отстало от таблицы переходов.
 *
 * `findExistingDiagnostic` искала дубль только среди `('pending','running')`.
 * Но `awaiting_review` и `awaiting_approval` — законные состояния живой задачи
 * (`REQUEST_REVIEW`, кнопки Mini App), и диагностика, припаркованная в любом из
 * них, для дедупа становилась невидимой. Повтор того же сбоя заводил дубль, и
 * так до потолка `isDiagTaskThrottled` — пять карточек про одну поломку на
 * доске владельца.
 *
 * Дыра открывается ровно там, где задача ЖИВА и работа по ней идёт: пока
 * aieng ждёт ревью по первой диагностике, вторая уже висит рядом.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import { findExistingDiagnostic } from "../lib/diagnostic.ts";
import { TASK_TRANSITIONS, type TaskStatus } from "../lib/task-fsm.ts";

const CHAT = -1_000_830;
const ACTION = "act-2026-08-29-diag";

function cleanup() {
  db.prepare(`DELETE FROM tasks WHERE chat_id = ?`).run(CHAT);
}

/**
 * Строка пишется напрямую: цель — проверить SQL-окно на КАЖДОМ статусе, а
 * пройти к `awaiting_*` через `updateTaskStatus` можно только законным путём,
 * который к предмету теста отношения не имеет.
 */
function diagRow(status: TaskStatus, actionId = ACTION): string {
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks(
       id, parent_id, depth, chat_id, created_by, assigned_to,
       title, description, status, priority, deadline,
       input, output, error, created_at, updated_at
     ) VALUES (?, NULL, 0, ?, 'orchestrator', 'aieng', ?, NULL, ?, 0, NULL, ?, NULL, NULL, ?, ?)`,
  ).run(
    id,
    CHAT,
    `[diagnostic] permission_denied: SEND_MESSAGE`,
    status,
    JSON.stringify({
      type: "diagnostic",
      failed_action_id: actionId,
      error_category: "permission_denied",
      hypothesis: "h",
      original_error: "boom",
    }),
    now,
    now,
  );
  return id;
}

describe("аудит 2026-08-29: окно дедупликации диагностик", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  test("диагностика на ревью видна дедупу", () => {
    const id = diagRow("awaiting_review");
    expect(findExistingDiagnostic(ACTION, "permission_denied")).toEqual({ id });
  });

  test("диагностика в ожидании аппрува видна дедупу", () => {
    const id = diagRow("awaiting_approval");
    expect(findExistingDiagnostic(ACTION, "permission_denied")).toEqual({ id });
  });

  test("каждый нетерминальный статус попадает в окно", () => {
    // Дословно инвариант правки: окно считается из TASK_TRANSITIONS, значит
    // добавление статуса не должно требовать правки SQL.
    for (const s of Object.keys(TASK_TRANSITIONS) as TaskStatus[]) {
      if (TASK_TRANSITIONS[s].length === 0) continue;
      cleanup();
      const id = diagRow(s);
      expect({ status: s, found: findExistingDiagnostic(ACTION, "permission_denied") })
        .toEqual({ status: s, found: { id } });
    }
  });

  test("терминальная диагностика дедупу не мешает", () => {
    // Обратная сторона: закрытая задача не должна глушить новую диагностику по
    // тому же сбою — иначе повтор поломки после «починили» останется незамечен.
    for (const s of Object.keys(TASK_TRANSITIONS) as TaskStatus[]) {
      if (TASK_TRANSITIONS[s].length > 0) continue;
      cleanup();
      diagRow(s);
      expect({ status: s, found: findExistingDiagnostic(ACTION, "permission_denied") })
        .toEqual({ status: s, found: null });
    }
  });

  test("чужой сбой и чужая категория не считаются дублем", () => {
    diagRow("awaiting_review", "act-другой");
    expect(findExistingDiagnostic(ACTION, "permission_denied")).toBeNull();
    cleanup();
    diagRow("awaiting_review");
    expect(findExistingDiagnostic(ACTION, "missing_capability")).toBeNull();
  });
});
