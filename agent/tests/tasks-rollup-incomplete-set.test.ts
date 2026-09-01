/**
 * Аудит 2026-08-10: родитель закрывался по НЕПОЛНОМУ набору детей — двумя
 * разными путями.
 *
 * (1) Родитель без объявленного числа детей. rollupParent считает набор полным,
 *     если `expectedChildren` не задан, а строк хоть одна. Счётчик проставляет
 *     ровно один производитель — SPLIT_TASK (action-dispatch.ts:870). Второй
 *     производитель детей, CREATE_TASK(parentTaskId), не проставляет его
 *     никогда. Гарантия оказалась применена к одному входу из двух — ровно тот
 *     класс, который комментарий в rollupParent описывает и считает закрытым.
 *
 *     Оркестратору предписано вести план последовательно (agent-prompts.ts:64):
 *     создать родителя, потом подзадачи по одной. Первая же закрытая подзадача
 *     штампует родителя терминальным статусом; остальные создаются под уже
 *     закрытым родителем, и rollupParent для них выходит на первой строке. На
 *     доске и в дайджесте «Релиз 2.0» — done, при двух не начатых подзадачах.
 *
 * (2) Частично провалившийся SPLIT_TASK. reconcileExpectedChildren получает
 *     текст ошибки делегирования, но читает его только в ветке actual === 0.
 *     При actual > 0 обещание молча переписывается с 3 на 2, а несостоявшийся
 *     ребёнок не существует в БД — значит и «провалившегося ребёнка» rollup не
 *     видит. Родитель выходит done с error = NULL, хотя треть работы никому не
 *     выдали и никто её уже не сделает.
 *
 * Инвариант: терминальный статус родителя означает «набор детей полон и все
 * терминальны». Неизвестный набор — не повод закрывать; недоставленное
 * делегирование — провал, а не успех.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { db } from "../lib/db.ts";
import {
  createTask,
  getTask,
  updateTaskStatus,
  reconcileExpectedChildren,
  rollupParent,
} from "../lib/tasks.ts";

const CHAT = -99884;

function mkChild(parentId: string, title: string) {
  return createTask({
    chatId: CHAT,
    createdBy: "orchestrator",
    title,
    parentId,
  });
}

/** Провести ребёнка через легальный путь до терминала. */
function finish(id: string, status: "done" | "failed" | "cancelled") {
  updateTaskStatus(id, "running");
  updateTaskStatus(id, status);
}

beforeEach(() => {
  db.prepare(`DELETE FROM tasks WHERE chat_id = ?`).run(CHAT);
});

describe("поздний ребёнок переоткрывает преждевременно закрытого родителя", () => {
  test("план по одной подзадаче: итоговый статус учитывает весь набор", () => {
    const parent = createTask({
      chatId: CHAT,
      createdBy: "orchestrator",
      title: "Релиз 2.0",
    });
    const c1 = mkChild(parent.id, "бэкенд");
    finish(c1.id, "done");
    // Автозакрытие по неизвестному набору — документированное поведение
    // (c29-redistribution), его не трогаем: тут набор действительно выглядит полным.
    expect(getTask(parent.id)!.status).toBe("done");

    // Появление второй подзадачи доказывает, что набор был неполон.
    const c2 = mkChild(parent.id, "фронтенд");
    // До фикса: родитель навсегда остаётся done, rollupParent для c2 выходит
    // на первой строке, и «Релиз 2.0» числится готовым при незапущенном фронте.
    expect(getTask(parent.id)!.status).toBe("running");

    const c3 = mkChild(parent.id, "qa");
    finish(c2.id, "done");
    // c3 ещё не терминален — закрывать нечего.
    expect(getTask(parent.id)!.status).toBe("running");

    finish(c3.id, "done");
    expect(getTask(parent.id)!.status).toBe("done");
  });

  test("провал поздней подзадачи доносится до родителя, а не теряется", () => {
    const parent = createTask({
      chatId: CHAT,
      createdBy: "orchestrator",
      title: "Релиз 2.1",
    });
    finish(mkChild(parent.id, "бэкенд").id, "done");
    expect(getTask(parent.id)!.status).toBe("done");

    const late = mkChild(parent.id, "qa");
    finish(late.id, "failed");

    const after = getTask(parent.id)!;
    // Именно ради этого: раньше провал поздней подзадачи не мог изменить
    // родителя вообще — тот был терминален и rollup его не касался.
    expect(after.status).toBe("failed");
  });

  test("переоткрытие гасит устаревшую ошибку прошлого вывода", () => {
    const parent = createTask({
      chatId: CHAT,
      createdBy: "orchestrator",
      title: "Релиз 2.2",
    });
    finish(mkChild(parent.id, "первая").id, "failed");
    expect(getTask(parent.id)!.status).toBe("failed");
    expect(getTask(parent.id)!.error).toBeTruthy();

    mkChild(parent.id, "вторая");
    const reopened = getTask(parent.id)!;
    expect(reopened.status).toBe("running");
    expect(reopened.error).toBeNull();
  });

  test("нетерминального родителя создание ребёнка не трогает", () => {
    const parent = createTask({
      chatId: CHAT,
      createdBy: "orchestrator",
      title: "Релиз 2.3",
    });
    mkChild(parent.id, "одна");
    expect(getTask(parent.id)!.status).toBe("pending");
  });

  test("объявленный набор по-прежнему закрывается автоматически", () => {
    const parent = createTask({
      chatId: CHAT,
      createdBy: "orchestrator",
      title: "[split] объявленный",
      inputPayload: { type: "split", expectedChildren: 2 },
    });
    const a = mkChild(parent.id, "a");
    const b = mkChild(parent.id, "b");

    finish(a.id, "done");
    expect(getTask(parent.id)!.status).toBe("pending");

    finish(b.id, "done");
    expect(getTask(parent.id)!.status).toBe("done");
  });

  test("провал ребёнка в объявленном наборе доносится до родителя", () => {
    const parent = createTask({
      chatId: CHAT,
      createdBy: "orchestrator",
      title: "[split] с провалом",
      inputPayload: { type: "split", expectedChildren: 2 },
    });
    const a = mkChild(parent.id, "a");
    const b = mkChild(parent.id, "b");
    finish(a.id, "done");
    finish(b.id, "failed");

    const after = getTask(parent.id)!;
    expect(after.status).toBe("failed");
  });
});

describe("частичный SPLIT_TASK не выдаёт себя за успех", () => {
  test("недоставленная роль делает родителя failed, а не done", () => {
    const parent = createTask({
      chatId: CHAT,
      createdBy: "orchestrator",
      title: "[split] backend+qa+design",
      inputPayload: { type: "split", expectedChildren: 3 },
    });
    // design не взялся: pickAvailableAgent вернул null ДО createTask, строки нет.
    const backend = mkChild(parent.id, "backend");
    const qa = mkChild(parent.id, "qa");

    reconcileExpectedChildren(parent.id, 2, {
      error: "design: no_available_agent",
    });

    // На момент сверки дети ещё работают — родителя закрывать нечем.
    expect(getTask(parent.id)!.status).toBe("pending");

    finish(backend.id, "done");
    finish(qa.id, "done");

    const after = getTask(parent.id)!;
    // До фикса: "done" с error = NULL. Оба ребёнка успешны, а треть работы
    // не выдана никому — и об этом не осталось следа.
    expect(after.status).toBe("failed");
    expect(after.error).toContain("design: no_available_agent");
  });

  test("текст ошибки переживает разрыв во времени между сверкой и финишем", () => {
    const parent = createTask({
      chatId: CHAT,
      createdBy: "orchestrator",
      title: "[split] отложенный финиш",
      inputPayload: { type: "split", expectedChildren: 2 },
    });
    const only = mkChild(parent.id, "backend");
    reconcileExpectedChildren(parent.id, 1, { error: "qa: delegation cycle" });

    // Сверка происходит сразу после сплита, а ребёнок финиширует много позже:
    // причина обязана лежать в строке родителя, а не в стеке вызова.
    finish(only.id, "done");

    const after = getTask(parent.id)!;
    expect(after.status).toBe("failed");
    expect(after.error).toContain("qa: delegation cycle");
  });

  test("полный сплит без потерь остаётся успехом", () => {
    const parent = createTask({
      chatId: CHAT,
      createdBy: "orchestrator",
      title: "[split] всё доставлено",
      inputPayload: { type: "split", expectedChildren: 2 },
    });
    const a = mkChild(parent.id, "a");
    const b = mkChild(parent.id, "b");
    // reconcile не зовётся вовсе: childIds.length === roles.length.
    finish(a.id, "done");
    finish(b.id, "done");

    const after = getTask(parent.id)!;
    expect(after.status).toBe("done");
    expect(after.error).toBeNull();
  });

  test("сверка без ошибки (все роли доставлены) не пятнает родителя", () => {
    const parent = createTask({
      chatId: CHAT,
      createdBy: "orchestrator",
      title: "[split] сверка без потерь",
      inputPayload: { type: "split", expectedChildren: 2 },
    });
    const a = mkChild(parent.id, "a");
    reconcileExpectedChildren(parent.id, 1);
    finish(a.id, "done");

    const after = getTask(parent.id)!;
    expect(after.status).toBe("done");
    expect(after.error).toBeNull();
  });
});

describe("каскад наверх", () => {
  test("поздний ребёнок переоткрывает деда через отца", () => {
    const grand = createTask({
      chatId: CHAT,
      createdBy: "orchestrator",
      title: "дед",
    });
    const parent = createTask({
      chatId: CHAT,
      createdBy: "orchestrator",
      title: "[split] отец",
      parentId: grand.id,
      inputPayload: { type: "split", expectedChildren: 1 },
    });
    finish(mkChild(parent.id, "внук").id, "done");
    expect(getTask(parent.id)!.status).toBe("done");
    expect(getTask(grand.id)!.status).toBe("done");

    // Второй отец у деда — набор деда был неполон.
    const parent2 = createTask({
      chatId: CHAT,
      createdBy: "orchestrator",
      title: "[split] второй отец",
      parentId: grand.id,
      inputPayload: { type: "split", expectedChildren: 1 },
    });
    expect(getTask(grand.id)!.status).toBe("running");

    finish(mkChild(parent2.id, "внук 2").id, "failed");
    expect(getTask(parent2.id)!.status).toBe("failed");
    expect(getTask(grand.id)!.status).toBe("failed");
  });

  test("rollupParent на несуществующем id не бросает", () => {
    expect(() => rollupParent("no-such-task")).not.toThrow();
  });
});
