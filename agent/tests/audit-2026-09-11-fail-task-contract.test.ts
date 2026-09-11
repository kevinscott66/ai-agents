/**
 * Аудит 2026-09-11, круг 23: `failTask` обещала вернуть статус, в котором
 * задача осталась, и всегда возвращала `"failed"`.
 *
 * Докблок формулирует контракт прямо: «вызывающему это единственный способ
 * отличить „пометили“ от „уже было решено без нас“». Тело же кончалось
 * безусловным `return "failed"`, хотя шагом выше `forceTerminalStatus` умеет
 * не записать НИЧЕГО: проиграв CAS, она ловит `StaleTaskStatus`, пишет WARN и
 * возвращается. Единственный способ отличить одно от другого врал ровно в том
 * случае, ради которого заведён.
 *
 * Почему не поймали раньше. Гонку пинит audit-2026-09-10-force-terminal-cas —
 * но по состоянию БД: «после гонки статус `cancelled`». Возвращаемое значение
 * там проверено только в контроле БЕЗ гонки (`expect(failTask(...))` →
 * `"failed"`), то есть закреплено поведение в случае, где ошибки не было.
 * Дыра между «поведение верное» и «поведение проверенное» продержалась круг.
 *
 * Сценарий: поллер self-diag валит зависшую задачу, владелец в то же окно
 * отменяет её из Mini App. Задача остаётся `cancelled` — правильно; вызывающий
 * слышит «failed» — неправильно. Сегодня ни один из вызывающих
 * (`lib/self-diag.ts`) возврат не читает, так что ущерба нет; чинится до того,
 * как прочитает первый.
 *
 * Здесь же — вторая дверь к задаче-роли и два врущих WARN'а из `createTask`.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { db } from "../lib/db.ts";
import { log } from "../lib/log.ts";
import { createTask, getTask, failTask, updateTaskStatus } from "../lib/tasks.ts";

const CHAT = -99233;

/** Та же подмена, что в audit-2026-09-10-force-terminal-cas: чужой UPDATE
 *  сразу после SELECT'а, которым реконсилятор берёт снимок. */
function raceAfterSnapshot<T>(taskId: string, intruder: string, fn: () => T): T {
  const origPrepare = db.prepare.bind(db);
  let fired = false;
  (db as unknown as { prepare: unknown }).prepare = (sql: string) => {
    const stmt = origPrepare(sql);
    if (!/^\s*SELECT \* FROM tasks WHERE id/i.test(sql)) return stmt;
    const origGet = stmt.get.bind(stmt);
    (stmt as unknown as { get: unknown }).get = (...args: unknown[]) => {
      const row = origGet(...(args as never[]));
      if (!fired && args[0] === taskId) {
        fired = true;
        origPrepare(`UPDATE tasks SET status=?, updated_at=? WHERE id=?`).run(
          intruder,
          Date.now(),
          taskId,
        );
      }
      return row;
    };
    return stmt;
  };
  try {
    return fn();
  } finally {
    (db as unknown as { prepare: unknown }).prepare = origPrepare;
  }
}

/**
 * Прогон роли заводит воркер — сюда он не ходит, поэтому строим руками.
 *
 * Метка `_spawn_role` ставится ПОСЛЕДНЕЙ: с ней `updateTaskStatus` отказывает
 * (тот самый запрет, который проверяется ниже), так что статус выставляем,
 * пока задача ещё обычная.
 */
function spawnRoleTask(title: string, status?: "running" | "done") {
  const t = createTask({ chatId: CHAT, createdBy: "pm", title });
  if (status === "running") updateTaskStatus(t.id, "running");
  if (status === "done") {
    updateTaskStatus(t.id, "running");
    updateTaskStatus(t.id, "done");
  }
  db.prepare(`UPDATE tasks SET input=? WHERE id=?`).run(
    JSON.stringify({ _spawn_role: true, slug: "tmp-role" }),
    t.id,
  );
  return getTask(t.id)!;
}

function warnings(fn: () => void): { msg: string; meta: unknown }[] {
  const seen: { msg: string; meta: unknown }[] = [];
  const spy = spyOn(log, "warn").mockImplementation((msg: string, meta?: unknown) => {
    seen.push({ msg, meta });
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return seen;
}

describe("failTask возвращает то, что есть, а не то, что хотела", () => {
  beforeEach(() => {
    db.prepare(`DELETE FROM tasks WHERE chat_id=?`).run(CHAT);
  });
  afterEach(() => {
    db.prepare(`DELETE FROM tasks WHERE chat_id=?`).run(CHAT);
  });

  test("проигранный CAS: возврат совпадает с БД, а не с намерением", () => {
    const t = createTask({ chatId: CHAT, createdBy: "pm", title: "гонка" });
    const returned = raceAfterSnapshot(t.id, "cancelled", () =>
      failTask(t.id, "gc_stale"),
    );
    // Было: "failed" при `cancelled` в базе — то самое расхождение.
    expect(returned).toBe("cancelled");
    expect(getTask(t.id)!.status).toBe("cancelled");
  });

  test("контроль: без гонки по-прежнему failed", () => {
    const t = createTask({ chatId: CHAT, createdBy: "pm", title: "контроль" });
    expect(failTask(t.id, "boom")).toBe("failed");
    expect(getTask(t.id)!.status).toBe("failed");
  });

  test("терминальная задача — no-op, возврат её собственный", () => {
    const t = createTask({ chatId: CHAT, createdBy: "pm", title: "терминал" });
    updateTaskStatus(t.id, "cancelled");
    expect(failTask(t.id, "поздно")).toBe("cancelled");
    expect(getTask(t.id)!.error).toBe(null);
  });

  test("прогон роли не трогается: статусом владеет воркер", () => {
    const t = spawnRoleTask("роль", "running");
    const w = warnings(() => {
      expect(failTask(t.id, "boom")).toBe(t.status);
    });
    expect(getTask(t.id)!.status).toBe(t.status);
    expect(getTask(t.id)!.error).toBe(null);
    expect(w.some((x) => x.msg.includes("failTask по прогону роли"))).toBe(true);
  });
});

describe("createTask: WARN называет ту причину, по которой остановились", () => {
  beforeEach(() => {
    db.prepare(`DELETE FROM tasks WHERE chat_id=?`).run(CHAT);
  });
  afterEach(() => {
    db.prepare(`DELETE FROM tasks WHERE chat_id=?`).run(CHAT);
  });

  test("живой прогон роли выше по цепочке — остановка штатная, без WARN", () => {
    // Цикл подъёма кончается на нетерминальном предке всегда: это его
    // обычный выход. Условие WARN'а про роль терминальность не проверяло, и
    // на `running`-роли в лог уходило «завершённый прогон роли» — слово
    // «завершённый» ложно, и названа не та причина остановки.
    const role = spawnRoleTask("живая роль", "running");
    const mid = createTask({
      chatId: CHAT,
      createdBy: "pm",
      title: "середина",
      parentId: role.id,
    });
    updateTaskStatus(mid.id, "running");
    updateTaskStatus(mid.id, "done");

    const w = warnings(() => {
      createTask({ chatId: CHAT, createdBy: "pm", title: "внук", parentId: mid.id });
    });
    expect(w.filter((x) => x.msg.includes("прогон роли"))).toEqual([]);
    // Переоткрытие среднего узла при этом состоялось — остановка не отменяет
    // работу, она только её ограничивает.
    expect(getTask(mid.id)!.status).toBe("running");
  });

  test("завершённый прогон роли выше — WARN на месте", () => {
    const role = spawnRoleTask("мёртвая роль", "done");
    const mid = createTask({
      chatId: CHAT,
      createdBy: "pm",
      title: "середина",
      parentId: role.id,
    });
    updateTaskStatus(mid.id, "running");
    updateTaskStatus(mid.id, "done");

    const w = warnings(() => {
      createTask({ chatId: CHAT, createdBy: "pm", title: "внук", parentId: mid.id });
    });
    expect(w.some((x) => x.msg.includes("завершённый прогон роли"))).toBe(true);
  });

  test("битая цепочка parent_id: усечение больше не молчит", () => {
    // depth в таблице может врать — ровно против этого и заведён ограничитель.
    // Строим цепочку длиннее предела с depth=0 у каждого узла: createTask
    // считает глубину от родителя, поэтому по своей проверке она проходит, а
    // подъём упирается в длину.
    let prev: string | null = null;
    const chain: string[] = [];
    for (let i = 0; i < 8; i++) {
      const t = createTask({ chatId: CHAT, createdBy: "pm", title: `узел ${i}` });
      db.prepare(`UPDATE tasks SET parent_id=?, status='done', depth=0 WHERE id=?`).run(
        prev,
        t.id,
      );
      chain.push(t.id);
      prev = t.id;
    }
    const w = warnings(() => {
      createTask({
        chatId: CHAT,
        createdBy: "pm",
        title: "лист",
        parentId: chain[chain.length - 1],
      });
    });
    expect(w.some((x) => x.msg.includes("цепочка предков длиннее предела"))).toBe(true);
  });
});
