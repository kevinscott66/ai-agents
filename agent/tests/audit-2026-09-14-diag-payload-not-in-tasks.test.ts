/**
 * Аудит 2026-09-14: payload упавшего действия лежал копией в `tasks.input`.
 *
 * `agent_actions` и её архив закрыты для QUERY_DB: там тела сообщений, посты,
 * аргументы MAC_RUN_CLAUDE — всё, что роли отправляли наружу. Но C15 self-diag
 * (`dispatchAndAudit` → задача «Tool error: …» на aieng) клал в `tasks.input`
 * payload целиком, а `tasks` читаема намеренно. Запрос
 * `SELECT input FROM tasks WHERE title LIKE 'Tool error:%'` проходил валидатор
 * и отдавал содержимое любого упавшего действия любого чата. Тот же класс, что
 * промпт временной роли (audit-2026-09-11-role-prompt-not-in-tasks, миграция
 * 052), и чинится так же — у источника: задача несёт ссылку на строку действия,
 * а сам payload `processDiagTask` берёт из закрытой таблицы.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { db } from "../lib/db.ts";
import { dispatchAndAudit } from "../lib/action-dispatch.ts";
import { processDiagTask, type SelfDiagDeps } from "../lib/self-diag.ts";
import { createTask, getTask, type Task } from "../lib/tasks.ts";
import { setAutonomy } from "../lib/permissions.ts";
import { MIGRATIONS } from "../lib/migrations.ts";
import { cleanupChat, saveAutonomy, restoreAutonomy } from "./_helpers.ts";

const CHAT = -1_000_914_21;
const OTHER_CHAT = -1_000_914_22;
const AGENT = "orchestrator";
const MARKER = "приватный текст 5f3a — не для чужих глаз";

let saved = saveAutonomy();
beforeEach(() => {
  saved = saveAutonomy();
});
afterEach(() => {
  restoreAutonomy(saved);
  for (const chat of [CHAT, OTHER_CHAT]) {
    cleanupChat(chat, AGENT);
    cleanupChat(chat, "aieng");
  }
});

function diagTasks(chat = CHAT): Array<{ id: string; input: string }> {
  return db
    .prepare(`SELECT id, input FROM tasks WHERE chat_id = ? AND title LIKE 'Tool error:%'`)
    .all(chat) as Array<{ id: string; input: string }>;
}

async function failSend(): Promise<{ taskId: string; actionId: string }> {
  // SEND_MESSAGE без telegram в ctx — рантайм-ошибка, как в c7.test.ts.
  const res = await dispatchAndAudit("SEND_MESSAGE", { text: MARKER } as any, {
    agentKey: AGENT,
    chatId: CHAT,
  });
  expect(res.ok).toBe(false);
  const rows = diagTasks();
  expect(rows.length).toBe(1);
  return { taskId: rows[0].id, actionId: (res as { actionId: string }).actionId };
}

function capture(): { deps: SelfDiagDeps; prompts: string[] } {
  const prompts: string[] = [];
  const deps = {
    runTextImpl: async (_system: string, prompt: string) => {
      prompts.push(prompt);
      return JSON.stringify({ giveup: true, reason: "test" });
    },
    buildDispatchCtx: () => null,
  } as unknown as SelfDiagDeps;
  return { deps, prompts };
}

describe("diag-задача не хранит payload упавшего действия", () => {
  test("в tasks.input нет текста действия, есть ссылка на строку аудита", async () => {
    const { taskId, actionId } = await failSend();
    const raw = getTask(taskId) && (db.prepare(`SELECT input FROM tasks WHERE id = ?`).get(taskId) as { input: string }).input;
    expect(raw).not.toContain(MARKER);
    const input = JSON.parse(raw!) as Record<string, unknown>;
    expect("payload" in input).toBe(false);
    expect(input.failedActionId).toBe(actionId);
    // Остальное, на чём держится конвейер, на месте.
    expect(input._diag).toBe(true);
    expect(input.actionType).toBe("SEND_MESSAGE");
    expect(input._retry_count).toBe(0);
  });

  test("processDiagTask по-прежнему видит исходный payload", async () => {
    setAutonomy("chat", String(CHAT), "auto");
    const { taskId } = await failSend();
    const { deps, prompts } = capture();
    await processDiagTask(getTask(taskId)!, deps);
    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain(MARKER);
  });

  test("строка действия ушла в архив — payload берётся оттуда", async () => {
    setAutonomy("chat", String(CHAT), "auto");
    const { taskId, actionId } = await failSend();
    const cols = (db.prepare(`PRAGMA table_info(agent_actions_archive)`).all() as Array<{ name: string }>)
      .map((c) => c.name)
      .filter((n) => n !== "archived_at");
    const list = cols.join(", ");
    db.prepare(
      `INSERT INTO agent_actions_archive(${list}, archived_at) SELECT ${list}, ? FROM agent_actions WHERE id = ?`,
    ).run(Date.now(), actionId);
    db.prepare(`DELETE FROM agent_actions WHERE id = ?`).run(actionId);
    try {
      const { deps, prompts } = capture();
      await processDiagTask(getTask(taskId)!, deps);
      expect(prompts.length).toBe(1);
      expect(prompts[0]).toContain(MARKER);
    } finally {
      db.prepare(`DELETE FROM agent_actions_archive WHERE id = ?`).run(actionId);
    }
  });

  test("строки действия нет нигде — задача закрывается внятной причиной", async () => {
    setAutonomy("chat", String(CHAT), "auto");
    const { taskId, actionId } = await failSend();
    db.prepare(`DELETE FROM agent_actions WHERE id = ?`).run(actionId);
    const { deps, prompts } = capture();
    await processDiagTask(getTask(taskId)!, deps);
    expect(prompts.length).toBe(0);
    const t = getTask(taskId)!;
    expect(t.status).toBe("failed");
    expect(String(t.error)).toContain("payload");
  });

  test("ссылка на действие другого чата не разыменовывается", async () => {
    // Ссылка — это ключ к закрытой таблице. Задача одного чата не должна
    // доставать payload действия из другого, даже если id подставлен вручную.
    setAutonomy("chat", String(OTHER_CHAT), "auto");
    const { actionId } = await failSend();
    const forged = createTask({
      title: "Tool error: SEND_MESSAGE",
      chatId: OTHER_CHAT,
      createdBy: AGENT,
      assignedTo: "aieng",
      inputPayload: {
        _diag: true,
        actionType: "SEND_MESSAGE",
        failedActionId: actionId,
        error: "x",
        _retry_count: 0,
      },
    });
    const { deps, prompts } = capture();
    await processDiagTask(getTask(forged.id)! as Task, deps);
    expect(prompts.length).toBe(0);
    expect(getTask(forged.id)!.status).toBe("failed");
  });

  test("старая форма с payload внутри задачи обрабатывается как раньше", async () => {
    setAutonomy("chat", String(CHAT), "auto");
    const legacy = createTask({
      title: "Tool error: SEND_MESSAGE",
      chatId: CHAT,
      createdBy: AGENT,
      assignedTo: "aieng",
      inputPayload: {
        _diag: true,
        actionType: "SEND_MESSAGE",
        payload: { text: MARKER },
        error: "x",
        _retry_count: 0,
      },
    });
    const { deps, prompts } = capture();
    await processDiagTask(getTask(legacy.id)!, deps);
    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain(MARKER);
  });
});

describe("миграция 056 вычищает payload из закрытых diag-задач", () => {
  function run(rows: Array<{ id: string; status: string; input: string }>) {
    const mem = new Database(":memory:");
    mem.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, status TEXT, input TEXT, updated_at INTEGER)`);
    const ins = mem.prepare(`INSERT INTO tasks(id, title, status, input, updated_at) VALUES (?, ?, ?, ?, 7)`);
    for (const r of rows) ins.run(r.id, "Tool error: SEND_MESSAGE", r.status, r.input);
    const m = MIGRATIONS.find((x) => x.name === "056_tasks_input_drop_diag_payload");
    expect(m).toBeDefined();
    m!.up(mem);
    const out = Object.fromEntries(
      (mem.prepare(`SELECT id, input, updated_at FROM tasks`).all() as Array<{ id: string; input: string; updated_at: number }>)
        .map((r) => [r.id, r]),
    );
    mem.close();
    return out;
  }

  test("терминальные — без payload, прочие поля и updated_at на месте", () => {
    const legacy = JSON.stringify({ _diag: true, actionType: "SEND_MESSAGE", payload: { text: MARKER }, error: "e", _retry_count: 0 });
    const out = run([
      { id: "done", status: "done", input: legacy },
      { id: "failed", status: "failed", input: legacy },
      { id: "cancelled", status: "cancelled", input: legacy },
    ]);
    for (const id of ["done", "failed", "cancelled"]) {
      expect(out[id].input).not.toContain(MARKER);
      const p = JSON.parse(out[id].input);
      expect(p._diag).toBe(true);
      expect(p.actionType).toBe("SEND_MESSAGE");
      expect(p.error).toBe("e");
      expect(out[id].updated_at).toBe(7);
    }
  });

  test("живые diag-задачи, чужие задачи и битый JSON не трогает", () => {
    const legacy = JSON.stringify({ _diag: true, actionType: "SEND_MESSAGE", payload: { text: MARKER } });
    const foreign = JSON.stringify({ payload: { text: MARKER } });
    const broken = `{"_diag":true,"payload":{"text":"${MARKER}"`;
    const out = run([
      { id: "pending", status: "pending", input: legacy },
      { id: "running", status: "running", input: legacy },
      { id: "foreign", status: "done", input: foreign },
      { id: "broken", status: "done", input: broken },
    ]);
    expect(out.pending.input).toBe(legacy);
    expect(out.running.input).toBe(legacy);
    expect(out.foreign.input).toBe(foreign);
    expect(out.broken.input).toBe(broken);
  });
});
