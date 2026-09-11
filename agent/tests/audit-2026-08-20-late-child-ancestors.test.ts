/**
 * Аудит 2026-08-20: поздний ребёнок переоткрывает ровно один уровень.
 *
 * `createTask` переоткрывает ТОЛЬКО прямого родителя (tasks.ts), а
 * `rollupParent` на терминальном узле выходит первой же строкой. Значит
 * исправленный статус родителя никогда не поднимается выше: дед так и остаётся
 * с выводом, который сам же код называет преждевременным.
 *
 * Путь штатный, MAX_DEPTH = 5:
 *   CREATE_TASK("Релиз")             → G
 *   CREATE_TASK("Бэкенд", parent=G)  → P
 *   CREATE_TASK("api", parent=P)     → C1
 *   C1 → done ⇒ rollupParent(P): expectedChildren не объявлен (его ставит
 *        только SPLIT_TASK), набор из одной строки считается полным ⇒ P=done
 *        ⇒ каскад ⇒ G=done.
 *   CREATE_TASK("миграции", parent=P) → C2 — переоткрывается P, но не G.
 *   C2 → failed ⇒ P=failed ⇒ каскад к G упирается в ранний return.
 * Итог: провалившийся релиз навсегда числится `done`.
 *
 * Второй тест — про атомарность. INSERT ребёнка и переоткрытие родителя шли
 * тремя отдельными автокоммитами. Обрыв между ними (рестарт agent-team при
 * деплое, kill) оставлял ребёнка под терминальным родителем, а триггер
 * переоткрытия срабатывает только внутри createTask — то есть больше не
 * сработает никогда. Соседняя `forceTerminalStatus` свою многошаговую запись
 * обернула в транзакцию ровно по этой причине (аудит 2026-08-14).
 */
import { test, expect, describe, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import { createTask, getTask, updateTaskStatus } from "../lib/tasks.ts";

const CHAT = -100820020;
const realPrepare = db.prepare.bind(db);

afterEach(() => {
  (db as unknown as { prepare: typeof realPrepare }).prepare = realPrepare;
});

/** Дерево «Релиз → Бэкенд → api», где api уже закрыл всю ветку. */
function seedPrematurelyClosedTree(): { g: string; p: string } {
  const g = createTask({ title: "Релиз", createdBy: "orchestrator", chatId: CHAT });
  const p = createTask({ title: "Бэкенд", createdBy: "orchestrator", chatId: CHAT, parentId: g.id });
  const c1 = createTask({ title: "api", createdBy: "orchestrator", chatId: CHAT, parentId: p.id });
  updateTaskStatus(c1.id, "running");
  updateTaskStatus(c1.id, "done");
  // Предусловие дефекта, а не утверждение о желаемом: набор был неполон, но
  // и P, и G уже закрыты. Если это перестанет быть правдой, тест ниже сам
  // потеряет смысл — поэтому фиксируем здесь.
  expect(getTask(p.id)!.status).toBe("done");
  expect(getTask(g.id)!.status).toBe("done");
  return { g: g.id, p: p.id };
}

describe("поздний ребёнок переоткрывает всю цепочку предков", () => {
  test("провал позднего ребёнка доходит до деда", () => {
    const { g, p } = seedPrematurelyClosedTree();

    const c2 = createTask({ title: "миграции", createdBy: "orchestrator", chatId: CHAT, parentId: p });
    updateTaskStatus(c2.id, "running");
    updateTaskStatus(c2.id, "failed", { error: "миграция не накатилась" });

    expect(getTask(p)!.status).toBe("failed");
    // Суть находки: до фикса здесь оставался "done" — провалившийся релиз
    // числился успешным, и никакой последующий исход этого уже не исправлял.
    expect(getTask(g)!.status).toBe("failed");
  });

  test("успех позднего ребёнка деда не ломает", () => {
    const { g, p } = seedPrematurelyClosedTree();

    const c2 = createTask({ title: "миграции", createdBy: "orchestrator", chatId: CHAT, parentId: p });
    // Пока поздний ребёнок в работе, предки не терминальны — иначе
    // переоткрытие было бы косметикой.
    expect(getTask(g)!.status).toBe("running");
    updateTaskStatus(c2.id, "running");
    updateTaskStatus(c2.id, "done");

    expect(getTask(p)!.status).toBe("done");
    expect(getTask(g)!.status).toBe("done");
  });
});

describe("создание ребёнка и переоткрытие родителя атомарны", () => {
  test("обрыв на переоткрытии не оставляет ребёнка под закрытым родителем", () => {
    const { p } = seedPrematurelyClosedTree();
    const before = db
      .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ?`)
      .get(p) as { n: number };

    // Рестарт ровно между INSERT ребёнка и UPDATE родителя.
    (db as unknown as { prepare: typeof realPrepare }).prepare = ((sql: string) => {
      if (sql.includes("status='running'") && sql.includes("error=NULL")) {
        throw new Error("boom: рестарт между записями");
      }
      return realPrepare(sql);
    }) as typeof realPrepare;

    expect(() =>
      createTask({ title: "миграции", createdBy: "orchestrator", chatId: CHAT, parentId: p }),
    ).toThrow();

    (db as unknown as { prepare: typeof realPrepare }).prepare = realPrepare;
    const after = db
      .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ?`)
      .get(p) as { n: number };
    // До фикса ребёнок оставался в таблице: родитель закрыт, триггер
    // переоткрытия живёт только внутри createTask — значит не сработает уже
    // никогда, и ветка тихо выпадает из подсчёта rollup'а.
    expect(after.n).toBe(before.n);
  });
});
