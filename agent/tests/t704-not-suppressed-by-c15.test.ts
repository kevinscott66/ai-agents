/**
 * Аудит 2026-08-12: блок, про который в коде написано «ORTHOGONAL to the C15
 * self-diag loop above», ортогональным не был — два `return` из C15 выходили из
 * dispatchAndAudit целиком и уносили T-704 с собой.
 *
 *   if (parentChain.length >= maxDepth) { … return { ok: false, error: `circuit breaker…` } }
 *   if (isDiagTaskThrottled(diagTitle))  { … return { ok: false, error: res.error } }
 *   …
 *   // T-704: … ORTHOGONAL to the C15 self-diag loop above: C15 fixes
 *   // payload-shape via aieng; T-704 routes the failure to the responsible ROLE
 *   // (perm / aieng / orchestrator) to address the underlying class of problem.
 *
 * Два блока решают разные задачи и адресуют разным ролям, но выключались одним
 * условием. Причём выключались именно там, где T-704 нужнее всего: цепочка
 * упёрлась в потолок или падений столько, что сработал анти-шторм — это и есть
 * «класс проблемы», ради которого T-704 и заводили. Отказ с категорией
 * permission_denied в такой момент не доезжал до perm вообще никогда.
 *
 * Своя защита от шторма у T-704 есть (createDiagnosticTask: дедуп по
 * (action, category) + собственный троттл по любому исполнителю), так что
 * пропускать его дальше безопасно — он не превращает потолок C15 в лазейку.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import { dispatchAndAudit } from "../lib/action-dispatch.ts";
import { createTask } from "../lib/tasks.ts";
import { cleanupChat } from "./_helpers.ts";

const TEST_CHAT = -1_000_7041;

let savedDepth: string | undefined;
let savedMax: string | undefined;

beforeEach(() => {
  savedDepth = process.env.INTER_AGENT_FIX_CHAIN_MAX_DEPTH;
  savedMax = process.env.DIAG_TASK_MAX_PER_HOUR;
});

afterEach(() => {
  if (savedDepth === undefined) delete process.env.INTER_AGENT_FIX_CHAIN_MAX_DEPTH;
  else process.env.INTER_AGENT_FIX_CHAIN_MAX_DEPTH = savedDepth;
  if (savedMax === undefined) delete process.env.DIAG_TASK_MAX_PER_HOUR;
  else process.env.DIAG_TASK_MAX_PER_HOUR = savedMax;
  db.prepare(`DELETE FROM tasks WHERE chat_id = ?`).run(TEST_CHAT);
  db.prepare(`DELETE FROM agent_actions WHERE chat_id = ?`).run(TEST_CHAT);
  cleanupChat(TEST_CHAT, "orchestrator");
});

/** Задачи T-704 в этом чате (их заголовок начинается с «[diagnostic] »). */
function t704Tasks(): { title: string; assigned_to: string }[] {
  return db
    .prepare(
      `SELECT title, assigned_to FROM tasks
       WHERE chat_id = ? AND title LIKE '[diagnostic] %'`,
    )
    .all(TEST_CHAT) as { title: string; assigned_to: string }[];
}

/** Задачи C15 (ретрай формы payload'а, всегда на aieng). */
function c15Tasks(): { title: string }[] {
  return db
    .prepare(`SELECT title FROM tasks WHERE chat_id = ? AND title LIKE 'Tool error: %'`)
    .all(TEST_CHAT) as { title: string }[];
}

describe("T-704 переживает предохранители C15", () => {
  test("цепочка упёрлась в потолок — C15 молчит, T-704 работает", async () => {
    process.env.INTER_AGENT_FIX_CHAIN_MAX_DEPTH = "1";
    const res = await dispatchAndAudit(
      "SEND_MESSAGE",
      { text: "hi", _fix_chain: ["only-one"] } as any,
      { agentKey: "orchestrator", chatId: TEST_CHAT },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("circuit breaker");
    // C15 не создаёт — это и есть смысл предохранителя.
    expect(c15Tasks()).toEqual([]);
    // А T-704 обязан: он адресует не aieng, а ответственную роль по категории.
    expect(t704Tasks().length).toBe(1);
  });

  test("анти-шторм C15 не выключает маршрутизацию по классу ошибки", async () => {
    process.env.DIAG_TASK_MAX_PER_HOUR = "1";
    // Заводим ровно ту задачу, по которой считает троттл C15
    // (title = `Tool error: <actionType>`, исполнитель aieng).
    createTask({
      chatId: TEST_CHAT,
      createdBy: "orchestrator",
      assignedTo: "aieng",
      title: "Tool error: SEND_MESSAGE",
      description: "seed",
    });

    const res = await dispatchAndAudit(
      "SEND_MESSAGE",
      { text: "hi" } as any,
      { agentKey: "orchestrator", chatId: TEST_CHAT },
    );
    expect(res.ok).toBe(false);
    // Троттл не подменяет текст ошибки — возвращаем исходную причину.
    if (!res.ok) expect(res.error).not.toContain("circuit breaker");
    // Второй C15-задачи не появилось: троттл отработал.
    expect(c15Tasks().length).toBe(1);
    expect(t704Tasks().length).toBe(1);
  });
});
