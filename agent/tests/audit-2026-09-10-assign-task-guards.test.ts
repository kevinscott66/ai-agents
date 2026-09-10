/**
 * Аудит 2026-09-10: `assignTask` был единственной пишущей функцией tasks.ts
 * без единой проверки — голый UPDATE по id.
 *
 * Рядом стоят соседи с полным набором: у `updateTaskStatus` есть и таблица
 * переходов, и CAS по статусу (аудит 2026-08-29), у отмены — ещё и проверка
 * авторства (аудит 2026-08-28). У `assignTask` не было ни FSM, ни CAS, ни
 * докблока, при том что `ASSIGN_TASK` засеян ВСЕМ 12 ролям как `allowed=1,
 * requires_approval=0`, в `CALLER_RESTRICTED` его нет, и единственный барьер в
 * хендлере — граница чата и каноничность ключа роли.
 *
 * Главный сценарий — не «переназначили не тому», а «работа исчезла молча».
 * `assigned_to` у диагностической задачи это АДРЕС ИСПОЛНЕНИЯ: петля C15
 * создаёт её строго с `assignedTo: "aieng"` и `_diag: true`, а поллер выбирает
 * работу запросом `WHERE assigned_to = 'aieng' AND status = 'pending' AND
 * input LIKE '%"_diag":true%'` (self-diag.ts). Достаточно одного `ASSIGN_TASK`
 * от любой роли на той же доске — и ретрая упавшего действия не будет никогда,
 * а модель получит `ok: true`.
 *
 * Второе — терминальные задачи: `done`/`failed`/`cancelled` переписывались на
 * другого исполнителя задним числом. В очередь такая задача не вернётся
 * (`listTasksByAssignee` зовут с открытыми статусами), то есть портится не
 * работа, а история — та самая, которую читают в разборе «кто это сделал».
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  assignTask,
  createTask,
  getTask,
  updateTaskStatus,
} from "../lib/tasks.ts";
import { handleAssignTask } from "../lib/dispatch/tasks.ts";
import { cleanupChat } from "./_helpers.ts";

const TEST_CHAT = 999_111_910;
const TEST_AGENT = "__assign_guard_test__";

afterEach(() => {
  cleanupChat(TEST_CHAT, TEST_AGENT);
});

function diagTask() {
  return createTask({
    chatId: TEST_CHAT,
    createdBy: TEST_AGENT,
    assignedTo: "aieng",
    title: "Tool error: SEND_MESSAGE",
    inputPayload: { actionType: "SEND_MESSAGE", error: "boom", _diag: true },
  });
}

describe("задача самопочинки адресована aieng", () => {
  test("увести её другой роли нельзя", () => {
    const t = diagTask();
    expect(() => assignTask(t.id, "smm")).toThrow(/diagnostic task/);
    expect(getTask(t.id)?.assigned_to).toBe("aieng");
  });

  test("признак тот же, что у запроса поллера — `_diag: true` в input", () => {
    // Запрос ищет подстроку `"_diag":true` в JSON. Если признак здесь и там
    // разъедется, тест поймает именно это.
    const t = diagTask();
    const raw = JSON.stringify(getTask(t.id)?.input);
    expect(raw).toContain('"_diag":true');
    const src = readFileSync(new URL("../lib/self-diag.ts", import.meta.url), "utf-8");
    expect(src).toContain(`assigned_to = 'aieng'`);
    expect(src).toContain(`"_diag":true`);
  });

  test("переназначение на того же aieng — не ошибка", () => {
    const t = diagTask();
    expect(assignTask(t.id, "aieng").assigned_to).toBe("aieng");
  });

  test("обычная задача переназначается как раньше", () => {
    const t = createTask({
      chatId: TEST_CHAT,
      createdBy: TEST_AGENT,
      assignedTo: "aieng",
      title: "обычная",
      inputPayload: { actionType: "SEND_MESSAGE" },
    });
    expect(assignTask(t.id, "smm").assigned_to).toBe("smm");
  });
});

describe("терминальную задачу не переназначают", () => {
  for (const path of [
    ["running", "done"],
    ["running", "failed"],
  ] as const) {
    test(`${path.join(" → ")}`, () => {
      const t = createTask({
        chatId: TEST_CHAT,
        createdBy: TEST_AGENT,
        title: `terminal-${path[1]}`,
      });
      for (const st of path) updateTaskStatus(t.id, st);
      expect(() => assignTask(t.id, "smm")).toThrow(/terminal status/);
      expect(getTask(t.id)?.assigned_to).toBeNull();
    });
  }

  test("открытые статусы по-прежнему переназначаются", () => {
    const t = createTask({
      chatId: TEST_CHAT,
      createdBy: TEST_AGENT,
      title: "open-running",
    });
    updateTaskStatus(t.id, "running");
    expect(assignTask(t.id, "smm").assigned_to).toBe("smm");
  });
});

describe("прочее", () => {
  test("несуществующая задача — прежняя ошибка", () => {
    expect(() => assignTask("no-such-task", "pm")).toThrow(/task not found/);
  });
});

/**
 * Инвариант стоит в `assignTask` — это последний рубеж у самой записи. Но
 * брошенное оттуда исключение доходит до модели как `dispatch/audit failed: …`
 * и пишет ERROR-строку «dispatch threw», то есть отказ по правилу выглядит
 * внутренней поломкой. Поэтому тот же отказ продублирован в хендлере в форме
 * `{ ok: false, error }` — ровно как проверка авторства у отмены рядом.
 */
describe("хендлер ASSIGN_TASK отказывает, а не бросает", () => {
  const ctx = { agentKey: "smm", chatId: TEST_CHAT };

  test("задача самопочинки: ok=false с указанием, что делать", () => {
    const t = diagTask();
    const res = handleAssignTask({ taskId: t.id, assignedTo: "smm" } as never, ctx);
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain("самодиагностики");
    expect((res as { error: string }).error).toContain("CREATE_TASK");
    expect(getTask(t.id)?.assigned_to).toBe("aieng");
  });

  test("терминальная задача: ok=false, без исключения наружу", () => {
    const t = createTask({
      chatId: TEST_CHAT,
      createdBy: TEST_AGENT,
      title: "terminal-handler",
    });
    updateTaskStatus(t.id, "running");
    updateTaskStatus(t.id, "done");
    const res = handleAssignTask({ taskId: t.id, assignedTo: "smm" } as never, ctx);
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain("терминальный");
  });

  test("обычная открытая задача по-прежнему переназначается", () => {
    const t = createTask({
      chatId: TEST_CHAT,
      createdBy: TEST_AGENT,
      title: "handler-happy",
    });
    const res = handleAssignTask({ taskId: t.id, assignedTo: "smm" } as never, ctx);
    expect(res.ok).toBe(true);
    expect(getTask(t.id)?.assigned_to).toBe("smm");
  });

  test("задача с чужой доски — прежний ответ «не найдена»", () => {
    const t = createTask({
      chatId: TEST_CHAT,
      createdBy: TEST_AGENT,
      title: "foreign-board",
    });
    const res = handleAssignTask(
      { taskId: t.id, assignedTo: "smm" } as never,
      { agentKey: "smm", chatId: TEST_CHAT + 1 },
    );
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain("task not found");
  });
});
