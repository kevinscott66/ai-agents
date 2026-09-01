/**
 * C4: approvals workflow + command handlers.
 */
import { describe, test, expect, afterEach } from "bun:test";
import {
  createApproval,
  getApproval,
  decideApproval,
  listPendingApprovals,
} from "../lib/approvals.ts";
import { listActions, logAction } from "../lib/audit.ts";
import {
  cmdApprove,
  cmdReject,
  cmdTasks,
  cmdAutonomy,
} from "../lib/commands.ts";
import {
  getAutonomy,
  setAutonomy,
} from "../lib/permissions.ts";
import { listTasksByChat } from "../lib/tasks.ts";
import {
  cleanupChat,
  saveAutonomy,
  restoreAutonomy,
} from "./_helpers.ts";

const TEST_CHAT = 999_444_555;
const TEST_AGENT = "pm";

let savedGlobal = saveAutonomy();
afterEach(() => {
  restoreAutonomy(savedGlobal);
  cleanupChat(TEST_CHAT);
});

describe("approvals: CRUD", () => {
  test("createApproval + getApproval round-trip", () => {
    savedGlobal = saveAutonomy();
    const { id: actionId } = logAction({
      agentKey: TEST_AGENT,
      chatId: TEST_CHAT,
      actionType: "SEND_MESSAGE",
      payload: { text: "x" },
      status: "pending_approval",
    });
    const a = createApproval({
      actionId,
      chatId: TEST_CHAT,
      requestedBy: TEST_AGENT,
      actionType: "SEND_MESSAGE",
      payload: { text: "hello" },
    });
    expect(a.status).toBe("pending");
    expect(a.chat_id).toBe(TEST_CHAT);
    const back = getApproval(a.id);
    expect(back).not.toBeNull();
    expect((back!.payload as { text: string }).text).toBe("hello");
    const pending = listPendingApprovals(TEST_CHAT);
    expect(pending.find((p) => p.id === a.id)).toBeDefined();
  });

  test("decideApproval pending → approved, повторно → throw", () => {
    savedGlobal = saveAutonomy();
    const { id: actionId } = logAction({
      agentKey: TEST_AGENT,
      chatId: TEST_CHAT,
      actionType: "SEND_MESSAGE",
      payload: {},
      status: "pending_approval",
    });
    const a = createApproval({
      actionId,
      chatId: TEST_CHAT,
      requestedBy: TEST_AGENT,
      actionType: "SEND_MESSAGE",
      payload: {},
    });
    const d = decideApproval(a.id, "approved", "tester");
    expect(d.status).toBe("approved");
    expect(d.decided_by).toBe("tester");
    expect(() => decideApproval(a.id, "approved", "tester")).toThrow();
  });
});

describe("cmdApprove: CREATE_TASK", () => {
  test("approves, creates task, logs ok agent_action", async () => {
    savedGlobal = saveAutonomy();
    const { id: actionId } = logAction({
      agentKey: TEST_AGENT,
      chatId: TEST_CHAT,
      actionType: "CREATE_TASK",
      payload: {},
      status: "pending_approval",
    });
    const a = createApproval({
      actionId,
      chatId: TEST_CHAT,
      requestedBy: TEST_AGENT,
      actionType: "CREATE_TASK",
      payload: {
        title: "from-approval",
        createdBy: TEST_AGENT,
        chatId: TEST_CHAT,
      },
    });
    const reply = await cmdApprove({
      approvalId: a.id,
      decidedBy: "human",
      chatId: TEST_CHAT,
    });
    expect(reply).toContain("OK");
    const after = getApproval(a.id);
    expect(after!.status).toBe("approved");
    const tasks = listTasksByChat(TEST_CHAT);
    expect(tasks.find((t) => t.title === "from-approval")).toBeDefined();
    const okActions = listActions({ agentKey: TEST_AGENT }).filter(
      (x) => x.chat_id === TEST_CHAT && x.status === "ok" && x.action_type === "CREATE_TASK",
    );
    expect(okActions.length).toBeGreaterThan(0);
  });
});

describe("cmdReject", () => {
  test("sets rejected + reason", () => {
    savedGlobal = saveAutonomy();
    const { id: actionId } = logAction({
      agentKey: TEST_AGENT,
      chatId: TEST_CHAT,
      actionType: "SEND_MESSAGE",
      payload: {},
      status: "pending_approval",
    });
    const a = createApproval({
      actionId,
      chatId: TEST_CHAT,
      requestedBy: TEST_AGENT,
      actionType: "SEND_MESSAGE",
      payload: { text: "no" },
    });
    const reply = cmdReject({
      approvalId: a.id,
      decidedBy: "human",
      chatId: TEST_CHAT,
      reason: "spammy",
    });
    expect(reply.toLowerCase()).toContain("rejected");
    const after = getApproval(a.id);
    expect(after!.status).toBe("rejected");
    expect(after!.reason).toBe("spammy");
  });
});

describe("cmdAutonomy", () => {
  test("без mode возвращает текущий; смена → auto и обратно", () => {
    savedGlobal = saveAutonomy();
    const initial = getAutonomy(TEST_CHAT);
    const r1 = cmdAutonomy({ chatId: TEST_CHAT });
    expect(r1).toContain(initial);
    cmdAutonomy({ chatId: TEST_CHAT, mode: "auto" });
    expect(getAutonomy(TEST_CHAT)).toBe("auto");
    cmdAutonomy({ chatId: TEST_CHAT, mode: initial });
    expect(getAutonomy(TEST_CHAT)).toBe(initial);
  });
});

describe("cmdTasks", () => {
  test("пустая и непустая выборки", async () => {
    savedGlobal = saveAutonomy();
    const empty = cmdTasks({ chatId: TEST_CHAT });
    expect(empty).toBeString();
    // создадим задачу через approval-обход (минуя gate)
    const { id: actionId } = logAction({
      agentKey: TEST_AGENT,
      chatId: TEST_CHAT,
      actionType: "CREATE_TASK",
      payload: {},
      status: "pending_approval",
    });
    const a = createApproval({
      actionId,
      chatId: TEST_CHAT,
      requestedBy: TEST_AGENT,
      actionType: "CREATE_TASK",
      payload: { title: "for-list", createdBy: TEST_AGENT, chatId: TEST_CHAT },
    });
    await cmdApprove({ approvalId: a.id, decidedBy: "h", chatId: TEST_CHAT });
    const nonEmpty = cmdTasks({ chatId: TEST_CHAT });
    expect(nonEmpty).toContain("for-list");
  });
});
