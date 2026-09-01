/**
 * Аудит 2026-08-27: отмену человеком воскрешал ВНУК, а не ребёнок.
 *
 * Аудит 2026-08-21 закрыл маршрут «отменённого родителя переоткрывает новый
 * ребёнок» — со стороны входов модели (CREATE_TASK, DELEGATE_TO_ROLE), потому
 * что в самой `createTask` резать нельзя: ту же функцию зовут аппрувы и Mini
 * App, где снятие отмены человеком законно. Оба гейта смотрят на ПРЯМОГО
 * родителя.
 *
 * Днём раньше (аудит 2026-08-20) в `createTask` появился подъём по всей
 * цепочке предков: терминальные `done`/`failed` деды тоже переоткрываются,
 * иначе исправленный статус родителя до них не доходил. `cancelled` — такой же
 * терминал с пустым списком переходов, и в этот подъём попадал наравне.
 * Прямого родителя гейт проверяет, деда — никто.
 *
 * Замер до правки (штатный путь, MAX_DEPTH = 5):
 *   «Релиз» отменён человеком          → cancelled
 *   «Бэкенд» done, под ним новый внук  → дед running, error = null
 *   внук закрыт, rollup                → дед done
 *
 * То есть отменённый человеком релиз выезжал на доску выполненным, и следа
 * отмены не оставалось нигде — ровно тот исход, который правка 2026-08-21
 * называла недопустимым, только на уровень выше.
 *
 * Чиним в самом подъёме: `cancelled` его останавливает. Обоснование
 * переоткрытия — «новый ребёнок опровергает вывод кода о полноте набора»;
 * `done`/`failed` предок таким выводом и получен (rollupParent), а `cancelled`
 * rollup не ставит никогда. Прямой родитель остаётся как был.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import { createTask, getTask, updateTaskStatus, rollupParent } from "../lib/tasks.ts";
import { TASK_TRANSITIONS } from "../lib/task-fsm.ts";

const CHAT = -100827027;

afterEach(() => {
  db.prepare("DELETE FROM tasks WHERE chat_id = ?").run(CHAT);
});

const mk = (title: string, parentId?: string) =>
  createTask({ title, createdBy: "orchestrator", chatId: CHAT, parentId });

/** Отмена человеком: из running в cancelled FSM не ведёт, Mini App пишет прямо. */
const cancelByHuman = (id: string) =>
  db.prepare("UPDATE tasks SET status='cancelled' WHERE id=?").run(id);

/** «Релиз(отменён) → Бэкенд(done) → api(done)». Возвращает id деда и родителя. */
function seedCancelledGrandparent(): { g: string; p: string } {
  const g = mk("Релиз");
  const p = mk("Бэкенд", g.id);
  const c1 = mk("api", p.id);
  cancelByHuman(g.id);
  updateTaskStatus(c1.id, "running");
  updateTaskStatus(c1.id, "done");
  // Предусловие: отменённый дед каскад не пропускает, родитель закрыт по
  // неизвестному набору. Если это перестанет быть правдой — тест ниже
  // потеряет смысл.
  expect(getTask(p.id)!.status).toBe("done");
  expect(getTask(g.id)!.status).toBe("cancelled");
  return { g: g.id, p: p.id };
}

describe("отменённый предок не воскресает", () => {
  test("предпосылка: cancelled — терминал, как done и failed", () => {
    expect(TASK_TRANSITIONS.cancelled.length).toBe(0);
    expect(TASK_TRANSITIONS.done.length).toBe(0);
  });

  test("поздний внук не переоткрывает отменённого деда", () => {
    const { g, p } = seedCancelledGrandparent();
    mk("миграции", p);
    // До правки здесь было running с погашенным error.
    expect(getTask(g)!.status).toBe("cancelled");
    // Родитель переоткрыт — это и есть смысл подъёма, его не трогаем.
    expect(getTask(p)!.status).toBe("running");
  });

  test("успех внука не доводит отменённого деда до done", () => {
    const { g, p } = seedCancelledGrandparent();
    const c2 = mk("миграции", p);
    updateTaskStatus(c2.id, "running");
    updateTaskStatus(c2.id, "done");
    rollupParent(p);
    expect(getTask(p)!.status).toBe("done");
    // Суть находки: до правки — "done" на задаче, которую человек отменил.
    expect(getTask(g)!.status).toBe("cancelled");
  });

  test("провал внука тоже не переписывает отмену", () => {
    const { g, p } = seedCancelledGrandparent();
    const c2 = mk("миграции", p);
    updateTaskStatus(c2.id, "running");
    updateTaskStatus(c2.id, "failed", { error: "не накатилось" });
    expect(getTask(p)!.status).toBe("failed");
    expect(getTask(g)!.status).toBe("cancelled");
  });

  test("отмена на середине цепочки глушит подъём выше себя", () => {
    // Прадед done, дед отменён, родитель done. Подъём обязан остановиться на
    // отмене, а не перепрыгнуть её.
    const gg = mk("Программа");
    const g = mk("Релиз", gg.id);
    const p = mk("Бэкенд", g.id);
    const c1 = mk("api", p.id);
    updateTaskStatus(c1.id, "running");
    updateTaskStatus(c1.id, "done");
    expect(getTask(gg.id)!.status).toBe("done");
    cancelByHuman(g.id);

    mk("миграции", p.id);
    expect(getTask(p.id)!.status).toBe("running");
    expect(getTask(g.id)!.status).toBe("cancelled");
    expect(getTask(gg.id)!.status).toBe("done");
  });
});

describe("подъём по здоровой цепочке не сломан", () => {
  test("done-дед по-прежнему переоткрывается поздним внуком", () => {
    const g = mk("Релиз");
    const p = mk("Бэкенд", g.id);
    const c1 = mk("api", p.id);
    updateTaskStatus(c1.id, "running");
    updateTaskStatus(c1.id, "done");
    expect(getTask(g.id)!.status).toBe("done");

    const c2 = mk("миграции", p.id);
    expect(getTask(g.id)!.status).toBe("running");
    updateTaskStatus(c2.id, "running");
    updateTaskStatus(c2.id, "failed", { error: "миграция не накатилась" });
    // Регресс-пин к аудиту 2026-08-20: провал позднего ребёнка доходит до деда.
    expect(getTask(g.id)!.status).toBe("failed");
  });

  test("отменённый ПРЯМОЙ родитель переоткрывается как раньше", () => {
    // Граница из аудита 2026-08-20/21: в createTask не режем, режут входы
    // модели. Правка обязана оставить это ровно как было.
    const p = mk("План");
    cancelByHuman(p.id);
    mk("подзадача", p.id);
    expect(getTask(p.id)!.status).toBe("running");
  });
});
