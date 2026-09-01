/**
 * Аудит 2026-08-28: `_parent_task_id` в DELEGATE_TO_ROLE не сверялся с чатом.
 *
 * У `CREATE_TASK` родитель обязан лежать на той же доске — это `ownTask`
 * (`dispatch/tasks.ts:43-60`), и комментарий там называет причину: «ребёнок
 * ложится в СВОЙ чат, а rollupParent потом пересчитывает по нему статус задачи
 * чужого — и, если та уже закрыта, ещё и переоткрывает её».
 *
 * Второй вход модели — `DELEGATE_TO_ROLE` — этой проверки не получил. Там
 * стоит только `status === "cancelled"` (аудит 2026-08-21), а `chat_id`
 * родителя не смотрит никто: агент из чата A прикреплял ребёнка к родителю
 * чата B, `createTask` переоткрывал закрытого родителя чужой доски в running,
 * и `rollupParent` дальше штамповал его по чужим детям. На доске чата B
 * задача меняла статус без единого действия в чате B.
 *
 * Дорог сюда две: явный `_parent_task_id` от модели и цикл SPLIT_TASK.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { dispatchAction } from "../lib/action-dispatch.ts";
import { createTask, getTask, updateTaskStatus, rollupParent } from "../lib/tasks.ts";
import { db } from "../lib/db.ts";

const CHAT_A = -100_777_281;
const CHAT_B = -100_777_282;
let seq = 0;
const uniq = (s: string) => `${s} #${Date.now()}-${seq++}`;

function cleanup(): void {
  for (const c of [CHAT_A, CHAT_B]) {
    db.prepare(`DELETE FROM tasks WHERE chat_id = ?`).run(c);
  }
}

beforeEach(cleanup);
afterEach(cleanup);

/**
 * Хендлер зовём напрямую — как в аудите 2026-08-21. Тестовый ctx намеренно без
 * `resolveAgent`: отказ по чужому родителю обязан случиться ДО резолва ботов,
 * иначе на боевом ctx порядок проверок был бы другим.
 */
const delegateUnder = (parentId: string, chatId: number) =>
  dispatchAction(
    "DELEGATE_TO_ROLE",
    { role: "backend", task: "подзадача", _parent_task_id: parentId } as never,
    { agentKey: "pm", chatId },
  );

describe("предпосылки: чем оборачивается чужой родитель", () => {
  test("ребёнок из другого чата переоткрывает и перештамповывает родителя", () => {
    const parent = createTask({ chatId: CHAT_B, createdBy: "owner", title: uniq("Релиз B") });
    updateTaskStatus(parent.id, "running");
    updateTaskStatus(parent.id, "done");
    expect(getTask(parent.id)!.status).toBe("done");

    // Ровно то, что делает DELEGATE_TO_ROLE: ребёнок в СВОЙ чат, родитель — чужой.
    const child = createTask({
      chatId: CHAT_A,
      createdBy: "pm",
      title: uniq("подзадача A"),
      parentId: parent.id,
    });
    expect(getTask(parent.id)!.status).toBe("running");

    updateTaskStatus(child.id, "running");
    updateTaskStatus(child.id, "failed", { error: "не вышло" });
    rollupParent(child.id);
    // Задача чата B провалена действиями чата A.
    expect(getTask(parent.id)!.status).toBe("failed");
  });
});

describe("родитель с чужой доски — отказ", () => {
  test("отказ до резолва ботов и без следа на чужой доске", async () => {
    const parent = createTask({ chatId: CHAT_B, createdBy: "owner", title: uniq("Релиз B") });
    const res = await delegateUnder(parent.id, CHAT_A);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(String(res.error)).toContain("parent task not found");
    // Если бы отказ стоял ниже, сюда доехала бы жалоба на ctx, а не на родителя.
    expect(String(res.error)).not.toContain("resolveAgent");
    // Родитель не тронут: ни статуса, ни детей.
    expect(getTask(parent.id)!.status).toBe("pending");
    const kids = db
      .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ?`)
      .get(parent.id) as { n: number };
    expect(kids.n).toBe(0);
  });

  test("закрытый родитель чужой доски не переоткрывается", async () => {
    const parent = createTask({ chatId: CHAT_B, createdBy: "owner", title: uniq("Релиз B") });
    updateTaskStatus(parent.id, "running");
    updateTaskStatus(parent.id, "done");

    const res = await delegateUnder(parent.id, CHAT_A);
    expect(res.ok).toBe(false);
    expect(getTask(parent.id)!.status).toBe("done");
  });

  test("текст отказа не отличает чужую задачу от несуществующей", async () => {
    const parent = createTask({ chatId: CHAT_B, createdBy: "owner", title: uniq("Релиз B") });
    const foreign = await delegateUnder(parent.id, CHAT_A);
    const missing = await delegateUnder("task-которой-нет", CHAT_A);
    expect(foreign.ok).toBe(false);
    if (foreign.ok || missing.ok) return;
    // Иначе перебор id даёт оракул существования по чужим доскам — та же
    // мотивация, что у ownTask.
    expect(String(foreign.error)).not.toContain(String(CHAT_B));
    expect(String(foreign.error).replace(parent.id, "ID")).toBe(
      String(missing.error).replace("task-которой-нет", "ID"),
    );
  });
});

describe("свой родитель по-прежнему проходит", () => {
  test("родитель того же чата до проверки чата не доходит как чужой", async () => {
    const parent = createTask({ chatId: CHAT_A, createdBy: "owner", title: uniq("Релиз A") });
    const res = await delegateUnder(parent.id, CHAT_A);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    // Своего родителя пропустили — дальше упёрлись в тестовый ctx.
    expect(String(res.error)).toContain("resolveAgent");
    expect(getTask(parent.id)!.status).toBe("pending");
  });

  test("отменённый родитель своей доски по-прежнему даёт отказ про отмену", async () => {
    const parent = createTask({ chatId: CHAT_A, createdBy: "owner", title: uniq("Релиз A") });
    updateTaskStatus(parent.id, "cancelled");
    const res = await delegateUnder(parent.id, CHAT_A);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(String(res.error)).toContain("cancelled");
  });

  test("делегирование без родителя не задето", async () => {
    const res = await dispatchAction(
      "DELEGATE_TO_ROLE",
      { role: "backend", task: "без родителя" } as never,
      { agentKey: "pm", chatId: CHAT_A },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(String(res.error)).toContain("resolveAgent");
  });
});
