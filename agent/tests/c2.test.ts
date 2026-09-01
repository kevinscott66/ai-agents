/**
 * C2: data-layer для tasks/audit/actions.
 *
 * Тесты пишут реальную БД (data/memory.db), но используют выделенный
 * test chat_id и чистят за собой данные.
 */
import { describe, test, expect, afterEach } from "bun:test";
import {
  createTask,
  getTask,
  assignTask,
  updateTaskStatus,
  listTasksByAssignee,
} from "../lib/tasks.ts";
import { logAction, getAction } from "../lib/audit.ts";
import { cleanupChat } from "./_helpers.ts";

const TEST_CHAT = 999_111_222;
const TEST_AGENT = "__c2_test__";

afterEach(() => {
  cleanupChat(TEST_CHAT, TEST_AGENT);
});

describe("tasks: createTask + getTask", () => {
  test("round-trip", () => {
    const t = createTask({
      chatId: TEST_CHAT,
      createdBy: TEST_AGENT,
      title: "hello",
      description: "desc",
      inputPayload: { foo: "bar", n: 42 },
    });
    expect(t.id).toBeString();
    expect(t.status).toBe("pending");
    expect(t.depth).toBe(0);
    expect(t.chat_id).toBe(TEST_CHAT);
    expect(t.title).toBe("hello");

    const back = getTask(t.id);
    expect(back).not.toBeNull();
    expect(back!.input).toEqual({ foo: "bar", n: 42 });
    expect(back!.created_at).toBe(t.created_at);
  });
});

describe("tasks: depth", () => {
  test("parent → child → grandchild", () => {
    const p = createTask({
      chatId: TEST_CHAT,
      createdBy: TEST_AGENT,
      title: "p",
    });
    const c = createTask({
      chatId: TEST_CHAT,
      createdBy: TEST_AGENT,
      title: "c",
      parentId: p.id,
    });
    const g = createTask({
      chatId: TEST_CHAT,
      createdBy: TEST_AGENT,
      title: "g",
      parentId: c.id,
    });
    expect(p.depth).toBe(0);
    expect(c.depth).toBe(1);
    expect(g.depth).toBe(2);
  });

  test("depth > 5 throws", () => {
    let parentId: string | undefined;
    // depth = 0..5 — допустимо (6 уровней), создаём 6 задач.
    for (let i = 0; i <= 5; i++) {
      const t = createTask({
        chatId: TEST_CHAT,
        createdBy: TEST_AGENT,
        title: `lvl-${i}`,
        parentId: parentId,
      });
      expect(t.depth).toBe(i);
      parentId = t.id;
    }
    // Седьмой уровень — depth=6 > MAX_DEPTH=5 → throw.
    expect(() =>
      createTask({
        chatId: TEST_CHAT,
        createdBy: TEST_AGENT,
        title: "too-deep",
        parentId,
      }),
    ).toThrow();
  });
});

describe("tasks: FSM transitions", () => {
  test("pending → running → done OK", () => {
    const t = createTask({
      chatId: TEST_CHAT,
      createdBy: TEST_AGENT,
      title: "fsm-ok",
    });
    const r = updateTaskStatus(t.id, "running");
    expect(r.status).toBe("running");
    const d = updateTaskStatus(t.id, "done", { output: { result: "yay" } });
    expect(d.status).toBe("done");
    expect(d.output).toEqual({ result: "yay" });
  });

  test("pending → done throws", () => {
    const t = createTask({
      chatId: TEST_CHAT,
      createdBy: TEST_AGENT,
      title: "fsm-bad",
    });
    expect(() => updateTaskStatus(t.id, "done")).toThrow();
  });

  test("done → running throws (terminal)", () => {
    const t = createTask({
      chatId: TEST_CHAT,
      createdBy: TEST_AGENT,
      title: "fsm-terminal",
    });
    updateTaskStatus(t.id, "running");
    updateTaskStatus(t.id, "done");
    expect(() => updateTaskStatus(t.id, "running")).toThrow();
  });
});

describe("tasks: assignTask", () => {
  test("changes assigned_to", () => {
    const t = createTask({
      chatId: TEST_CHAT,
      createdBy: TEST_AGENT,
      title: "assign-me",
    });
    expect(t.assigned_to).toBeNull();
    const a = assignTask(t.id, "pm");
    expect(a.assigned_to).toBe("pm");
    const list = listTasksByAssignee("pm");
    expect(list.find((x) => x.id === t.id)).toBeDefined();
  });
});

describe("audit: logAction + getAction", () => {
  test("round-trip with JSON payload", () => {
    const { id } = logAction({
      agentKey: TEST_AGENT,
      chatId: TEST_CHAT,
      actionType: "CREATE_TASK",
      payload: { hello: "world", nested: { k: [1, 2, 3] } },
      status: "ok",
      result: { ok: true },
    });
    const a = getAction(id);
    expect(a).not.toBeNull();
    expect(a!.agent_key).toBe(TEST_AGENT);
    expect(a!.action_type).toBe("CREATE_TASK");
    expect(a!.status).toBe("ok");
    expect(a!.payload).toEqual({ hello: "world", nested: { k: [1, 2, 3] } });
    expect(a!.result).toEqual({ ok: true });
  });
});

// Блок «actions: doRequestReview» убран вместе с lib/actions.ts (аудит
// 2026-08-12): фасад был мёртвой и более слабой копией живого пути. Тот же
// переход в awaiting_review проверяют tests/tasks-chat-pinning.test.ts и
// tests/diag-cross-chat-action.test.ts — уже на handleRequestReview, то есть
// вместе с проверкой чата, ради которой хендлер и существует.
