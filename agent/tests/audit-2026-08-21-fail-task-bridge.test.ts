/**
 * Аудит 2026-08-21: «пометить задачу проваленной» из нетерминального статуса
 * было нечем, и self-diag четырежды пытался это сделать переходом, который
 * FSM запрещает.
 *
 * Замер на временной базе:
 *
 *   status после создания: pending
 *   pending -> failed   -> THROW: invalid status transition: pending → failed
 *   status после попытки: pending
 *   pending -> running  -> ok
 *   running -> failed   -> ok
 *
 * Запрет правильный: история задачи читается по переходам, и записи, которой
 * в FSM нет, ломают читателя. Неправильным было то, что делал вызывающий.
 *
 * `lib/self-diag.ts` в четырёх местах писал так:
 *
 *   try { updateTaskStatus(id, "running"); } catch (e) { log.debug(...); }
 *   updateTaskStatus(id, "failed", { error: ... });
 *
 * То есть страховка «если в running не пустили — всё равно пометим failed»
 * гарантированно бросала: из статуса, откуда не пустили в running, в failed
 * тем более нельзя. А обработчик падения самого поллера (:678) моста не делал
 * вовсе и звал `failed` напрямую из pending.
 *
 * Цена: задача остаётся `pending`, а `listPendingDiagTasks` выбирает ровно
 * `status = 'pending'` — поллер поднимает её снова каждые 30 секунд, и так
 * бесконечно, засоряя лог строкой уровня ERROR. Второй, менее редкий случай —
 * гонка с отменой: владелец отменяет диаг-задачу между выборкой и переходом,
 * `cancelled` терминален, обе записи бросают, и штатная отмена выглядит в
 * логе как крах обработчика.
 *
 * В самом `lib/tasks.ts` мост уже был — `forceTerminalStatus` с поиском пути
 * по таблице переходов и одной транзакцией на все шаги (аудит 2026-08-10 и
 * 2026-08-14). Он был приватным и обслуживал только rollup. `failTask` —
 * публичная обёртка над ним: тот же мост, плюс терминальный статус как
 * no-op и rollup родителя.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { db } from "../lib/db.ts";
import { createTask, getTask, updateTaskStatus, failTask } from "../lib/tasks.ts";

const CHAT = -1_000_822;

function mk(title = "diag"): string {
  return createTask({
    chatId: CHAT,
    createdBy: "backend",
    assignedTo: "aieng",
    title,
    inputPayload: { _diag: true, actionType: "SEND_MESSAGE", payload: {}, error: "boom" },
  }).id;
}

beforeEach(() => {
  db.prepare(`DELETE FROM tasks WHERE chat_id = ?`).run(CHAT);
});

describe("failTask — мост из любого нетерминального статуса", () => {
  test("сам запрет никуда не делся: pending → failed напрямую бросает", () => {
    // Не тавтология, а фиксация причины: если FSM когда-нибудь разрешит этот
    // переход, тесты ниже станут проходить сами по себе и перестанут что-либо
    // охранять. Тогда этот упадёт и объяснит, почему.
    const id = mk();
    expect(() => updateTaskStatus(id, "failed", { error: "x" })).toThrow(
      /invalid status transition/,
    );
    expect(getTask(id)!.status).toBe("pending");
  });

  test("pending → failed через failTask: статус и причина записаны", () => {
    const id = mk();
    expect(failTask(id, "poller crashed: boom")).toBe("failed");
    const t = getTask(id)!;
    expect(t.status).toBe("failed");
    expect(t.error).toBe("poller crashed: boom");
  });

  test("awaiting_approval → failed: путь ищется, а не угадывается", () => {
    const id = mk();
    updateTaskStatus(id, "awaiting_approval");
    expect(failTask(id, "gate closed")).toBe("failed");
    expect(getTask(id)!.status).toBe("failed");
  });

  test("awaiting_review → failed", () => {
    const id = mk();
    updateTaskStatus(id, "running");
    updateTaskStatus(id, "awaiting_review");
    expect(failTask(id, "review never came")).toBe("failed");
    expect(getTask(id)!.status).toBe("failed");
  });

  test("running → failed: обычный случай тоже проходит", () => {
    const id = mk();
    updateTaskStatus(id, "running");
    expect(failTask(id, "aieng call failed")).toBe("failed");
    const t = getTask(id)!;
    expect(t.status).toBe("failed");
    expect(t.error).toBe("aieng call failed");
  });
});

describe("failTask — терминальный статус не переписывается", () => {
  test("cancelled остаётся cancelled и не бросает", () => {
    // Ровно гонка из шапки: владелец отменил задачу, пока поллер её вёл.
    // Отмена — это решение человека, и «провалилась» поверх неё было бы ложью.
    const id = mk();
    updateTaskStatus(id, "cancelled", { error: "отменил владелец" });
    expect(failTask(id, "poller crashed")).toBe("cancelled");
    const t = getTask(id)!;
    expect(t.status).toBe("cancelled");
    expect(t.error).toBe("отменил владелец");
  });

  test("done остаётся done, причина не дописывается", () => {
    const id = mk();
    updateTaskStatus(id, "running");
    updateTaskStatus(id, "done");
    expect(failTask(id, "поздно")).toBe("done");
    const t = getTask(id)!;
    expect(t.status).toBe("done");
    expect(t.error).toBeNull();
  });

  test("failed остаётся failed с ПЕРВОЙ причиной", () => {
    const id = mk();
    updateTaskStatus(id, "running");
    updateTaskStatus(id, "failed", { error: "первая причина" });
    expect(failTask(id, "вторая причина")).toBe("failed");
    expect(getTask(id)!.error).toBe("первая причина");
  });
});

describe("failTask — границы", () => {
  test("несуществующий id бросает: это ошибка вызывающего, а не состояние", () => {
    expect(() => failTask("нет-такой-задачи", "x")).toThrow(/task not found/);
  });

  test("родитель пересчитывается: провал ребёнка виден наверху", () => {
    const parent = createTask({
      chatId: CHAT,
      createdBy: "orchestrator",
      assignedTo: null,
      title: "родитель",
      inputPayload: { expectedChildren: 1 },
    }).id;
    const child = createTask({
      chatId: CHAT,
      createdBy: "orchestrator",
      assignedTo: "aieng",
      title: "ребёнок",
      parentId: parent,
    }).id;
    // Ребёнок в pending — как раз тот случай, где старый код бросал.
    expect(failTask(child, "упал")).toBe("failed");
    expect(getTask(parent)!.status).toBe("failed");
  });
});
