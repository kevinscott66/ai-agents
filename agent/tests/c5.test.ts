/**
 * C5: tool_use схема + диспатчер.
 *
 * Tестируем executeTool() напрямую — без Anthropic SDK и telegraf.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { executeTool, TOOLS } from "../lib/tools-schema.ts";
import { listTasksByChat, createTask } from "../lib/tasks.ts";
import { listActions } from "../lib/audit.ts";
import { setAutonomy } from "../lib/permissions.ts";
import {
  cleanupChat,
  saveAutonomy,
  restoreAutonomy,
} from "./_helpers.ts";

const TEST_CHAT = 999_111_222;
const TEST_AGENT = "pm";

let savedGlobal = saveAutonomy();
afterEach(() => {
  restoreAutonomy(savedGlobal);
  cleanupChat(TEST_CHAT);
});

describe("TOOLS schema", () => {
  test("содержит task-инструменты", () => {
    const names = new Set(TOOLS.map((t) => t.name));
    for (const t of [
      "ASSIGN_TASK",
      "COMMENT_TASK",
      "CREATE_TASK",
      "REQUEST_REVIEW",
      "UPDATE_TASK_STATUS",
    ]) {
      expect(names.has(t)).toBe(true);
    }
  });
});

describe("executeTool: CREATE_TASK", () => {
  test("создаёт задачу, возвращает ok:true и taskId", async () => {
    savedGlobal = saveAutonomy();
    setAutonomy("global", "*", "auto");
    const out = await executeTool(
      "CREATE_TASK",
      {
        title: "c5-create",
        description: "via tool",
        assignedTo: "backend",
        priority: 5,
      },
      { agentKey: TEST_AGENT, chatId: TEST_CHAT },
    );
    const parsed = JSON.parse(out) as {
      ok: boolean;
      taskId?: string;
      status?: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.taskId).toBeString();
    const tasks = listTasksByChat(TEST_CHAT);
    const t = tasks.find((x) => x.id === parsed.taskId);
    expect(t).toBeDefined();
    expect(t!.title).toBe("c5-create");
    expect(t!.assigned_to).toBe("backend");
  });
});

describe("executeTool: COMMENT_TASK", () => {
  test("пишет agent_action c COMMENT_TASK", async () => {
    savedGlobal = saveAutonomy();
    setAutonomy("global", "*", "auto");
    // создадим задачу напрямую, чтобы был валидный taskId
    const t = createTask({
      chatId: TEST_CHAT,
      createdBy: TEST_AGENT,
      title: "for-comment",
    });
    const out = await executeTool(
      "COMMENT_TASK",
      { taskId: t.id, text: "looks good" },
      { agentKey: TEST_AGENT, chatId: TEST_CHAT },
    );
    const parsed = JSON.parse(out) as { ok: boolean; actionId?: string };
    expect(parsed.ok).toBe(true);
    const acts = listActions({ agentKey: TEST_AGENT }).filter(
      (a) =>
        a.chat_id === TEST_CHAT &&
        a.action_type === "COMMENT_TASK" &&
        a.task_id === t.id,
    );
    expect(acts.length).toBeGreaterThan(0);
  });
});

describe("executeTool: UPDATE_TASK_STATUS invalid transition", () => {
  test("ok:false (pending→done запрещён FSM)", async () => {
    savedGlobal = saveAutonomy();
    setAutonomy("global", "*", "auto");
    const t = createTask({
      chatId: TEST_CHAT,
      createdBy: TEST_AGENT,
      title: "fsm-test",
    });
    // pending → done — невалидно (нужно через running)
    const out = await executeTool(
      "UPDATE_TASK_STATUS",
      { taskId: t.id, status: "done" },
      { agentKey: TEST_AGENT, chatId: TEST_CHAT },
    );
    const parsed = JSON.parse(out) as { ok: boolean; error?: string };
    expect(parsed.ok).toBe(false);
    expect(String(parsed.error ?? "")).toContain("invalid status transition");
  });
});

describe("executeTool: unknown tool", () => {
  test("несуществующее имя → ok:false, error:unknown", async () => {
    const out = await executeTool(
      "NOPE_TOOL",
      { foo: 1 },
      { agentKey: TEST_AGENT, chatId: TEST_CHAT },
    );
    const parsed = JSON.parse(out) as { ok: boolean; error?: string };
    expect(parsed.ok).toBe(false);
    expect(String(parsed.error ?? "")).toContain("unknown tool");
  });
});
