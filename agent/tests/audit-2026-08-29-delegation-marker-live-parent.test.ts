/**
 * Аудит 2026-08-29 — маркер `delegationError` снимался только у ТЕРМИНАЛЬНОГО
 * родителя.
 *
 * Снятие стояло внутри ветки переоткрытия (`reopenChain.length > 0`), а та
 * входит только когда `FSM[parent.status].length === 0`. Но пишется маркер и
 * на живом родителе: `reconcileExpectedChildren` кладёт его в ветке
 * `actual > 0`, где `rollupParent` выходит на незавершённых детях и родитель
 * остаётся `pending`/`running`.
 *
 * Разница между починенным и непочиненным случаем — только порядок событий:
 *
 *   аппрув ПОСЛЕ финиша остальных  -> родитель уже failed -> reopen -> снято
 *   аппрув ДО   финиша остальных   -> родитель ещё жив    -> reopen нет -> НЕ снято
 *
 * Второй порядок ничем не экзотичен: владелец видит заявку в Mini App и жмёт
 * «одобрить», пока backend и frontend ещё работают. Итог — сплит, у которого
 * все дети `done`, навсегда числится `failed`, и эта ложь каскадом уезжает на
 * всех предков.
 *
 * Прежний регрессионный тест (task-lifecycle-audit-2026-08-13.test.ts:139)
 * покрывал только первый порядок.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import {
  createTask,
  getTask,
  updateTaskStatus,
  reconcileExpectedChildren,
} from "../lib/tasks.ts";

const CHAT = -1_000_829;

function cleanup() {
  db.prepare(`DELETE FROM tasks WHERE chat_id = ?`).run(CHAT);
}

const root = (title: string, parentId?: string) =>
  createTask({
    chatId: CHAT,
    createdBy: "orchestrator",
    title,
    ...(parentId ? { parentId } : {}),
  });

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

const marker = (id: string) =>
  (getTask(id)!.input as { delegationError?: unknown }).delegationError;

describe("аудит 2026-08-29: маркер снимается и на живом родителе", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  test("аппрув раньше финиша остальных не делает успешный сплит провалом", () => {
    const parent = root("сплит на три роли");
    const backend = kid(parent.id, "backend");
    const frontend = kid(parent.id, "frontend");

    // qa на autonomy=manual: делегирование ушло в апрув и строки не создало.
    reconcileExpectedChildren(parent.id, 2, {
      error: "qa: pending_approval:a1b2",
    });

    // Родитель ещё жив — именно поэтому ветка переоткрытия не сработает.
    expect(getTask(parent.id)!.status).toBe("pending");
    expect(marker(parent.id)).toBe("qa: pending_approval:a1b2");

    // Владелец аппрувит, пока backend и frontend ещё работают.
    const qa = kid(parent.id, "qa");
    expect(marker(parent.id)).toBeUndefined();

    finish(backend.id, "done");
    finish(frontend.id, "done");
    finish(qa.id, "done");

    const final = getTask(parent.id)!;
    expect({ status: final.status, error: final.error }).toEqual({
      status: "done",
      error: null,
    });
  });

  test("ложный провал не каскадит на предков", () => {
    const grand = root("релиз");
    const parent = root("сплит на три роли", grand.id);
    const backend = kid(parent.id, "backend");
    const frontend = kid(parent.id, "frontend");
    reconcileExpectedChildren(parent.id, 2, { error: "qa: pending_approval:c3" });

    const qa = kid(parent.id, "qa");
    finish(backend.id, "done");
    finish(frontend.id, "done");
    finish(qa.id, "done");

    expect(getTask(parent.id)!.status).toBe("done");
    // Было: failed у родителя -> failed у деда. Отменённый по ошибке релиз.
    expect(getTask(grand.id)!.status).toBe("done");
  });

  test("маркер гасится только у прямого родителя", () => {
    // Инвариант прежней правки: у предков выше маркер описывает их
    // собственные невыданные делегирования.
    const grand = root("релиз");
    const parent = root("бэкенд", grand.id);
    reconcileExpectedChildren(grand.id, 1, { error: "design: pending_approval:z9" });
    reconcileExpectedChildren(parent.id, 0, { error: "никто не взялся" });

    kid(parent.id, "api");

    expect(marker(parent.id)).toBeUndefined();
    expect(marker(grand.id)).toBe("design: pending_approval:z9");
  });

  test("делегирование, которое так и не доехало, остаётся провалом", () => {
    // Страховка от «сняли маркер, заодно разучились видеть невыданную работу».
    const parent = root("сплит без догоняющего");
    const backend = kid(parent.id, "backend");
    const frontend = kid(parent.id, "frontend");
    reconcileExpectedChildren(parent.id, 2, { error: "qa: pending_approval:d4" });

    finish(backend.id, "done");
    finish(frontend.id, "done");

    const final = getTask(parent.id)!;
    expect({ status: final.status, error: final.error }).toEqual({
      status: "failed",
      error: "qa: pending_approval:d4",
    });
  });

  test("настоящий провал догнавшего ребёнка по-прежнему валит родителя", () => {
    const parent = root("сплит с провалом");
    const backend = kid(parent.id, "backend");
    reconcileExpectedChildren(parent.id, 1, { error: "qa: pending_approval:e5" });

    const qa = kid(parent.id, "qa");
    finish(backend.id, "done");
    finish(qa.id, "failed", "не смог");

    const final = getTask(parent.id)!;
    expect({ status: final.status, error: final.error }).toEqual({
      status: "failed",
      error: "не смог",
    });
  });

  test("родитель без маркера не переписывается впустую", () => {
    // Снятие теперь идёт по каждому созданию ребёнка — оно обязано быть
    // no-op'ом, когда снимать нечего.
    const parent = root("обычный родитель");
    const before = getTask(parent.id)!;
    kid(parent.id, "backend");
    const after = getTask(parent.id)!;
    expect({ input: after.input, updated_at: after.updated_at }).toEqual({
      input: before.input,
      updated_at: before.updated_at,
    });
  });
});
