/**
 * Аудит 2026-09-11, круг 24: сервер завёл второй запрет на смену статуса, и
 * тот снова оказался известен только серверу.
 *
 * lib/task-fsm.ts заведён в августе ровно затем, чтобы «куда можно» знали обе
 * стороны одинаково: сервер валидирует запись таблицей, Mini App по ней же
 * рисует кнопки. Докблок таблицы так и говорил — «расходиться им больше
 * нечем». К 2026-09-10 это перестало быть правдой: `updateTaskStatus` начал
 * отказывать ещё и по САМОЙ задаче — прогону временной роли (`_spawn_role`)
 * статус двигает только воркер вместе со строкой `role_runtime_queue`.
 * Таблица про задачи не знает, Mini App читал таблицу — и честно рисовал
 * такому прогону «→ done», «→ failed».
 *
 * Сценарий: админ открывает доску, видит у прогона роли обычные кнопки, жмёт
 * «→ Готово», получает 400 «это прогон временной роли». Кнопка, которая не
 * может сработать никогда, — та же болезнь, от которой файл заведён, просто
 * этажом выше: тогда сервер разрешал больше, чем показывал интерфейс, теперь
 * интерфейс показывал больше, чем разрешает сервер.
 *
 * Починка не в том, чтобы ослабить докстроку, а в том, чтобы вернуть ей
 * правду: вопрос «куда можно» задаётся ОДНОЙ функцией `nextStatuses(task)`,
 * и её же спрашивает сервер. Ниже проверяется и поведение функции, и то, что
 * страница действительно ходит через неё, — иначе копия отрастает заново.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  TASK_TRANSITIONS,
  nextStatuses,
  isSpawnRoleTaskInput,
  type TaskStatus,
} from "../lib/task-fsm.ts";
import { db } from "../lib/db.ts";
import { createTask, updateTaskStatus, getTask } from "../lib/tasks.ts";

const SRC = readFileSync(
  join(import.meta.dir, "..", "miniapp", "src", "pages", "Tasks.tsx"),
  "utf8",
);

const CHAT = -99244;

/**
 * Метку `_spawn_role` ставим ПОСЛЕДНЕЙ: с ней `updateTaskStatus` уже
 * отказывает, и довести задачу до нужного статуса штатным путём нельзя.
 */
function spawnRoleTask(title: string, status?: "running") {
  const t = createTask({ chatId: CHAT, createdBy: "pm", title });
  if (status === "running") updateTaskStatus(t.id, "running");
  db.prepare(`UPDATE tasks SET input=? WHERE id=?`).run(
    JSON.stringify({ _spawn_role: true, slug: "tmp-role" }),
    t.id,
  );
  return getTask(t.id)!;
}

beforeEach(() => {
  db.prepare(`DELETE FROM tasks WHERE chat_id = ?`).run(CHAT);
});

describe("nextStatuses — единственный ответ на «куда можно»", () => {
  test("обычная задача получает ровно строку таблицы", () => {
    for (const status of Object.keys(TASK_TRANSITIONS) as TaskStatus[]) {
      expect(nextStatuses({ status, input: null })).toEqual(
        TASK_TRANSITIONS[status] as TaskStatus[],
      );
    }
  });

  test("прогон временной роли не выпускают никуда", () => {
    const input = { _spawn_role: true, slug: "tmp-role" };
    expect(isSpawnRoleTaskInput(input)).toBe(true);
    for (const status of Object.keys(TASK_TRANSITIONS) as TaskStatus[]) {
      expect(nextStatuses({ status, input })).toEqual([]);
    }
  });

  test("незнакомый статус — пустой список, а не исключение", () => {
    // Приходит из БД старше миграции; вызывающие рисуют кнопки, им нужен ответ.
    expect(nextStatuses({ status: "zombie" as TaskStatus })).toEqual([]);
  });

  test("`input` без метки ничего не запрещает", () => {
    for (const input of [null, undefined, {}, { _spawn_role: false }, "строка", 7]) {
      expect(nextStatuses({ status: "running", input })).toEqual(
        TASK_TRANSITIONS.running as TaskStatus[],
      );
    }
  });
});

describe("сервер отказывает ровно в том, что запретил nextStatuses", () => {
  test("переход, которого нет в списке, отклонён", () => {
    const t = createTask({ chatId: CHAT, createdBy: "pm", title: "обычная" });
    expect(nextStatuses(t)).not.toContain("done");
    expect(() => updateTaskStatus(t.id, "done")).toThrow(/invalid status transition/);
  });

  test("прогону роли отказывают в КАЖДОМ переходе, который показала бы таблица", () => {
    const t = spawnRoleTask("прогон", "running");
    expect(nextStatuses(t)).toEqual([]);
    for (const next of TASK_TRANSITIONS.running) {
      expect(() => updateTaskStatus(t.id, next)).toThrow(/прогон временной роли/);
    }
    expect(getTask(t.id)!.status).toBe("running");
  });

  test("разрешённый переход по-прежнему проходит", () => {
    const t = createTask({ chatId: CHAT, createdBy: "pm", title: "обычная" });
    expect(nextStatuses(t)).toContain("running");
    expect(updateTaskStatus(t.id, "running").status).toBe("running");
  });
});

describe("страница спрашивает то же самое", () => {
  test("кнопки в списке и в карточке строятся из nextStatuses", () => {
    expect(SRC).toContain("nextStatuses(selected).map");
    expect(SRC).toContain("const possible = nextStatuses(t)");
  });

  test("проверка перед отправкой — та же функция", () => {
    expect(SRC).toContain("if (!nextStatuses(t).includes(next))");
  });

  test("по таблице напрямую страница кнопок больше не строит", () => {
    // Прежняя форма: индексирование таблицы статусом задачи.
    expect(SRC).not.toMatch(/NEXT_STATUS\[\s*(t|selected)\.status\s*\]/);
    // И своей копии таблицы у страницы по-прежнему нет.
    expect(SRC).not.toMatch(/NEXT_STATUS\s*:\s*Record<TaskStatus/);
  });
});
