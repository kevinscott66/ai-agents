/**
 * Аудит 2026-08-12: исполнитель задачи не проверялся — задача пропадала молча.
 *
 * `assigned_to` — это НЕ подпись, а адрес: очередь роли выбирается точным
 * равенством `SELECT * FROM tasks WHERE assigned_to = ?` (tasks.ts
 * listTasksByAssignee), и тем же ключом фильтруют /tasks, fix-chain и self-diag.
 * Ключей ровно двенадцать (CHARACTERS), и остальная кодовая база это знает:
 * DELEGATE_TO_ROLE, GRANT_PERMISSION, диагностика, agent-status — все сверяют
 * ключ с CHARACTERS и отказывают по неизвестному.
 *
 * CREATE_TASK и ASSIGN_TASK не сверяли ничего. Enum в tools-schema.ts — это
 * подсказка модели, а не проверка: модель пишет «Backend», «бэкенд»,
 * «backend-dev» — и всё это ложится в БД как есть. Дальше задача не совпадает
 * ни с одной очередью и не видна НИКОМУ: ни исполнителю, ни в /tasks по роли.
 * При этом действие возвращает ok:true с taskId, и делегировавший агент честно
 * рапортует «передал бэкенду». Задача не падает — она исчезает.
 *
 * Тот же вход есть и снаружи модели: POST /api/tasks в Mini App кладёт
 * body.assignee/assigned_to в БД без единой проверки.
 *
 * Инвариант: `assigned_to` — либо существующий ключ роли, либо null. Где намерение
 * однозначно («Backend », «QA»), ключ приводится к каноническому виду — отказ там
 * ничего не спасает, а очередь ломает; где нет — отказ с перечислением допустимых,
 * чтобы модель исправилась на следующем раунде, а не потеряла задачу.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { handleCreateTask, handleAssignTask } from "../lib/dispatch/tasks.ts";
import { createTask, listTasksByAssignee, getTask } from "../lib/tasks.ts";
import { db } from "../lib/db.ts";

const CHAT = 556001;
const ctx = { agentKey: "pm", chatId: CHAT };

beforeEach(() => {
  db.prepare(`DELETE FROM tasks WHERE chat_id = ?`).run(CHAT);
});

describe("CREATE_TASK: исполнитель обязан существовать", () => {
  test("выдуманная роль отвергается, а не создаёт невидимую задачу", () => {
    const res = handleCreateTask(
      { title: "написать пост", assignedTo: "маркетолог" } as never,
      ctx,
    );

    expect(res.ok).toBe(false);
    // Ошибка должна перечислять допустимые ключи: у модели есть ещё раунды,
    // и без списка она повторит ту же догадку.
    if (!res.ok) expect(res.error).toContain("backend");
    expect(db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE chat_id = ?`).get(CHAT)).toEqual({
      n: 0,
    });
  });

  test("регистр и пробелы приводятся к канону, а не роняют задачу", () => {
    const res = handleCreateTask(
      { title: "поднять индекс", assignedTo: " Backend " } as never,
      ctx,
    );
    expect(res.ok).toBe(true);
    const mine = listTasksByAssignee("backend").filter((t) => t.chat_id === CHAT);
    expect(mine.length).toBe(1);
  });

  test("настоящая роль проходит и задача видна в её очереди", () => {
    const res = handleCreateTask(
      { title: "поднять индекс", assignedTo: "backend" } as never,
      ctx,
    );
    expect(res.ok).toBe(true);
    const mine = listTasksByAssignee("backend").filter((t) => t.chat_id === CHAT);
    expect(mine.length).toBe(1);
  });

  test("задача без исполнителя по-прежнему создаётся", () => {
    const res = handleCreateTask({ title: "разобраться" } as never, ctx);
    expect(res.ok).toBe(true);
  });
});

describe("ASSIGN_TASK: переназначение на несуществующую роль", () => {
  test("исполнитель не затирается мусором", () => {
    const t = createTask({
      chatId: CHAT,
      createdBy: "pm",
      title: "релиз",
      assignedTo: "backend",
    });

    const res = handleAssignTask(
      { taskId: t.id, assignedTo: "devops" } as never,
      ctx,
    );

    expect(res.ok).toBe(false);
    // Худший вариант — «переназначили» и потеряли: прежний исполнитель обязан
    // остаться на месте.
    expect(getTask(t.id)?.assigned_to).toBe("backend");
    expect(listTasksByAssignee("backend").some((x) => x.id === t.id)).toBe(true);
  });

  test("переназначение на настоящую роль работает", () => {
    const t = createTask({
      chatId: CHAT,
      createdBy: "pm",
      title: "релиз",
      assignedTo: "backend",
    });
    const res = handleAssignTask({ taskId: t.id, assignedTo: "qa" } as never, ctx);
    expect(res.ok).toBe(true);
    expect(getTask(t.id)?.assigned_to).toBe("qa");
  });
});
