/**
 * Аудит 2026-08-13, жизненный цикл задач и апрувов. Три места, где состояние
 * на доске переставало соответствовать тому, что произошло на самом деле.
 *
 * Общее у всех трёх — то, что видит владелец. Проваленная задача показана
 * выполненной; выполненный сплит показан проваленным; закрытая заявка на
 * апрув показана ожидающей. Ни одно из трёх не заметно из логов: везде
 * консистентная БД и ноль ошибок.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import {
  createTask,
  getTask,
  updateTaskStatus,
  reconcileExpectedChildren,
} from "../lib/tasks.ts";
import { handleCreateDiagnosticTask } from "../lib/dispatch/diagnostic-action.ts";
import { logAction } from "../lib/audit.ts";
import { createApproval } from "../lib/approvals.ts";
import { expireStaleApprovals } from "../lib/db-maint.ts";
import { subscribe as busSubscribe, type BusEvent } from "../lib/events-bus.ts";

const CHAT = -1_000_813;

function cleanup() {
  db.prepare(`DELETE FROM tasks WHERE chat_id = ?`).run(CHAT);
  db.prepare(`DELETE FROM agent_actions WHERE chat_id = ?`).run(CHAT);
  db.prepare(`DELETE FROM approvals WHERE chat_id = ?`).run(CHAT);
}

/** `approvals.action_id` — NOT NULL, так что заявке нужно реальное действие. */
function pendingActionId(text: string): string {
  const { id } = logAction({
    agentKey: "smm",
    actionType: "PUBLISH_TO_CHANNEL",
    chatId: CHAT,
    payload: { text },
    status: "pending_approval",
  } as never);
  return id;
}

beforeEach(cleanup);
afterEach(cleanup);

describe("диагностика не переоткрывает и не отбеливает упавшую задачу", () => {
  test("упавший таск остаётся failed со своим текстом ошибки", () => {
    const failedTask = createTask({
      chatId: CHAT,
      createdBy: "backend",
      title: "выкатить конфиг",
    });
    updateTaskStatus(failedTask.id, "running");
    updateTaskStatus(failedTask.id, "failed", {
      error: "API 400: invalid parse_mode",
    });

    // Действие, привязанное к этому таску, — ровно то, по чему просят разбор.
    const { id: actionId } = logAction({
      agentKey: "backend",
      actionType: "AUDIT_LIFECYCLE_A",
      chatId: CHAT,
      taskId: failedTask.id,
      payload: {},
      status: "error",
      error: "API 400: invalid parse_mode",
    } as never);

    const out = handleCreateDiagnosticTask(
      { failed_action_id: actionId, hypothesis: "не та разметка" } as never,
      { agentKey: "backend", chatId: CHAT },
    );
    expect(out.ok).toBe(true);
    const diagId = (out as { result: { task_id: string } }).result.task_id;
    expect(diagId).toBeTruthy();

    const after = getTask(failedTask.id)!;
    // Было: `running` и error === null — свидетельство стёрто.
    expect(after.status).toBe("failed");
    expect(after.error).toBe("API 400: invalid parse_mode");

    // И диагностика не висит под ним: иначе её итог решал бы его итог.
    const diag = getTask(diagId)!;
    expect(diag.parent_id).toBeNull();
    // Связь при этом не потеряна — она в payload'е.
    expect((diag.input as { failed_action_id?: string }).failed_action_id).toBe(
      actionId,
    );
  });

  test("успешный разбор не делает упавшую задачу выполненной", () => {
    const failedTask = createTask({
      chatId: CHAT,
      createdBy: "backend",
      title: "выкатить конфиг (2)",
    });
    updateTaskStatus(failedTask.id, "running");
    updateTaskStatus(failedTask.id, "failed", { error: "API 400: boom" });

    const { id: actionId } = logAction({
      agentKey: "backend",
      actionType: "AUDIT_LIFECYCLE_B",
      chatId: CHAT,
      taskId: failedTask.id,
      payload: {},
      status: "error",
      error: "API 400: boom",
    } as never);

    const out = handleCreateDiagnosticTask(
      // ≥10 символов — иначе хендлер отклонит payload и тест проверит не то.
      { failed_action_id: actionId, hypothesis: "разметка не та" } as never,
      { agentKey: "backend", chatId: CHAT },
    );
    const diagId = (out as { result: { task_id: string } }).result.task_id;

    // Расследование доведено до конца — и это ничего не меняет для упавшего.
    updateTaskStatus(diagId, "running");
    updateTaskStatus(diagId, "done");

    const after = getTask(failedTask.id)!;
    expect(after.status).toBe("failed");
    expect(after.error).toBe("API 400: boom");
  });
});

describe("переоткрытие родителя снимает маркер несостоявшегося делегирования", () => {
  const kid = (parentId: string, role: string) =>
    createTask({
      chatId: CHAT,
      createdBy: "orchestrator",
      assignedTo: role,
      parentId,
      title: `часть для ${role}`,
    });

  const finish = (id: string, status: "done" | "failed", error?: string) => {
    updateTaskStatus(id, "running");
    updateTaskStatus(id, status, error ? { error } : undefined);
  };

  test("догнавшее делегирование доводит сплит до done, а не оставляет failed", () => {
    // Частичный сплит — единственный путь, на котором `delegationError` вообще
    // записывается: при `actual === 0` reconcileExpectedChildren идёт другой
    // веткой и кладёт текст в колонку `error`, а не в input.
    const parent = createTask({
      chatId: CHAT,
      createdBy: "orchestrator",
      title: "сплит на три роли",
    });
    const first = [kid(parent.id, "backend"), kid(parent.id, "frontend")];
    reconcileExpectedChildren(parent.id, 2, {
      error: "делегирование в qa не создало задачу: ушло в апрув",
    });
    for (const k of first) finish(k.id, "done");

    // Пока третьего нет, провал честен: треть работы никому не выдана.
    const beforeApproval = getTask(parent.id)!;
    expect(beforeApproval.status).toBe("failed");
    expect(
      (beforeApproval.input as { delegationError?: unknown }).delegationError,
    ).toBeTruthy();

    // Владелец аппрувит — делегирование доезжает, ребёнок появляется.
    const late = kid(parent.id, "qa");
    const reopened = getTask(parent.id)!;
    expect(reopened.status).toBe("running");
    expect(reopened.error).toBeNull();
    // Вот это и не снималось: маркер живёт в input, а гасили только колонку.
    expect(
      (reopened.input as { delegationError?: unknown }).delegationError,
    ).toBeUndefined();

    finish(late.id, "done");

    // Было: `failed` навсегда — при трёх детях `done` и пустой колонке error.
    expect(getTask(parent.id)!.status).toBe("done");
  });

  test("настоящий провал ребёнка родителя по-прежнему валит", () => {
    // Страховка от «сняли маркер, заодно разучились видеть провалы».
    const parent = createTask({
      chatId: CHAT,
      createdBy: "orchestrator",
      title: "сплит на три роли (2)",
    });
    const first = [kid(parent.id, "backend"), kid(parent.id, "frontend")];
    reconcileExpectedChildren(parent.id, 2, { error: "qa ушла в апрув" });
    for (const k of first) finish(k.id, "done");

    const late = kid(parent.id, "qa");
    finish(late.id, "failed", "не смог");

    const final = getTask(parent.id)!;
    expect(final.status).toBe("failed");
    expect(final.error).toBe("не смог");
  });

  test("делегирование, которое так и не доехало, остаётся провалом", () => {
    // Вторая страховка: маркер снимается ТОЛЬКО появлением ребёнка. Без него
    // сплит обязан числиться проваленным сколько угодно долго.
    const parent = createTask({
      chatId: CHAT,
      createdBy: "orchestrator",
      title: "сплит на три роли (3)",
    });
    const first = [kid(parent.id, "backend"), kid(parent.id, "frontend")];
    reconcileExpectedChildren(parent.id, 2, { error: "qa ушла в апрув" });
    for (const k of first) finish(k.id, "done");

    const final = getTask(parent.id)!;
    expect(final.status).toBe("failed");
    expect(final.error).toBe("qa ушла в апрув");
  });
});

describe("протухание апрува по TTL поднимает событие", () => {
  test("expireStaleApprovals эмитит approval.decided на каждую строку", () => {
    const seen: BusEvent[] = [];
    const unsub = busSubscribe((e) => {
      if (e.name === "approval.decided") seen.push(e);
    });
    try {
      const a = createApproval({
        actionId: pendingActionId("пост"),
        chatId: CHAT,
        requestedBy: "smm",
        actionType: "PUBLISH_TO_CHANNEL",
        payload: { text: "пост" },
      } as never);
      const b = createApproval({
        actionId: pendingActionId("второй пост"),
        chatId: CHAT,
        requestedBy: "smm",
        actionType: "PUBLISH_TO_CHANNEL",
        payload: { text: "второй пост" },
      } as never);
      // Состариваем обе заявки за пределы TTL.
      db.prepare(`UPDATE approvals SET created_at = ? WHERE id IN (?, ?)`).run(
        Date.now() - 90 * 24 * 3600_000,
        a.id,
        b.id,
      );

      const res = expireStaleApprovals();
      expect(res.expired).toBeGreaterThanOrEqual(2);

      // Открытая вкладка Mini App узнаёт о протухании — раньше молчали.
      const ids = seen.map((e) => (e.payload as { id: string }).id);
      expect(ids).toContain(a.id);
      expect(ids).toContain(b.id);
      for (const e of seen) {
        expect((e.payload as { status: string }).status).toBe("expired");
      }
    } finally {
      unsub();
    }
  });

  test("когда протухать нечему — событий нет", () => {
    const seen: BusEvent[] = [];
    const unsub = busSubscribe((e) => {
      if (e.name === "approval.decided") seen.push(e);
    });
    try {
      createApproval({
        actionId: pendingActionId("свежая заявка"),
        chatId: CHAT,
        requestedBy: "smm",
        actionType: "PUBLISH_TO_CHANNEL",
        payload: {},
      } as never);
      expireStaleApprovals();
      expect(seen).toHaveLength(0);
    } finally {
      unsub();
    }
  });
});
