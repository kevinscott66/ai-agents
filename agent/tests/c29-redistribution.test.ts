/**
 * C29: smart task redistribution.
 *
 *  1. Skill-based fallback for DELEGATE_TO_ROLE when primary unavailable
 *     (paused or silent per health snapshot).
 *  2. SPLIT_TASK action creates parent + N child tasks.
 *  3. Parent completion tracking: rolls up when all children terminal.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { dispatchAction } from "../lib/action-dispatch.ts";
import { _resetRateLimits } from "../lib/rate-limits.ts";
import {
  listTasksByChat,
  getTask,
  updateTaskStatus,
  createTask,
} from "../lib/tasks.ts";
import type { HandoffDeps, RespondAsOpts } from "../lib/handoff.ts";
import type { RunningBot } from "../lib/types.ts";
import type { HealthSnapshot } from "../lib/health.ts";
import { cleanupChat, saveAutonomy, restoreAutonomy } from "./_helpers.ts";

const TEST_CHAT = -1_000_929;

let savedGlobal = saveAutonomy();

beforeEach(() => {
  _resetRateLimits();
  cleanupChat(TEST_CHAT);
  savedGlobal = saveAutonomy();
});

afterEach(() => {
  restoreAutonomy(savedGlobal);
  _resetRateLimits();
  cleanupChat(TEST_CHAT);
});

function fakeBot(key: string): RunningBot {
  return {
    def: { key: key as never, name: key, envToken: "", system: "" } as never,
    bot: { telegram: {} } as never,
    username: `${key}_bot`,
    id: 100,
  };
}

function fakeDeps(): HandoffDeps {
  return {
    anthropic: {} as never,
    model: "test",
    historyLimit: 10,
    bots: [],
  };
}

function silentSnap(key: string): HealthSnapshot {
  return {
    agentKey: key,
    username: `${key}_bot`,
    alive: false,
    lastOkAt: null,
    lastErrorAt: Date.now(),
    consecutiveFailures: 5,
    lastError: "silent",
  };
}

describe("C29 DELEGATE_TO_ROLE skill-based fallback", () => {
  test("fallback when primary is paused → reroutes to first available skill peer", async () => {
    const captured: RespondAsOpts[] = [];
    const stub = mock(async (o: RespondAsOpts, _d: HandoffDeps) => {
      captured.push(o);
      return "";
    });
    const res = await dispatchAction(
      "DELEGATE_TO_ROLE",
      { role: "backend", task: "build api" },
      {
        agentKey: "pm",
        chatId: TEST_CHAT,
        resolveAgent: (k) => fakeBot(k),
        handoffDeps: fakeDeps(),
        respondAsImpl: stub as never,
        availability: {
          isStopped: (k) => k === "backend",
          getHealth: () => undefined,
        },
      },
    );
    expect(res.ok).toBe(true);
    // ROLE_FALLBACKS.backend = ["tgdev", "aieng"] → tgdev wins.
    if (res.ok) {
      const result = res.result as { role: string; _rerouted_from?: string };
      expect(result.role).toBe("tgdev");
      expect(result._rerouted_from).toBe("backend");
    }
    expect(captured[0].target.def.key).toBe("tgdev");
  });

  test("fallback when primary is silent (mock health snapshot)", async () => {
    const stub = mock(async (_o: RespondAsOpts, _d: HandoffDeps) => "");
    const res = await dispatchAction(
      "DELEGATE_TO_ROLE",
      { role: "design", task: "make banner" },
      {
        agentKey: "pm",
        chatId: TEST_CHAT,
        resolveAgent: (k) => fakeBot(k),
        handoffDeps: fakeDeps(),
        respondAsImpl: stub as never,
        availability: {
          isStopped: () => false,
          getHealth: (k) => (k === "design" ? silentSnap(k) : undefined),
        },
      },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      const result = res.result as { role: string; _rerouted_from?: string };
      // ROLE_FALLBACKS.design = ["frontend", "copy"] → frontend wins.
      expect(result.role).toBe("frontend");
      expect(result._rerouted_from).toBe("design");
    }
  });

  test("no_available_agent when primary and all fallbacks are unavailable", async () => {
    const stub = mock(async (_o: RespondAsOpts, _d: HandoffDeps) => "");
    const res = await dispatchAction(
      "DELEGATE_TO_ROLE",
      { role: "backend", task: "x" },
      {
        agentKey: "pm",
        chatId: TEST_CHAT,
        resolveAgent: (k) => fakeBot(k),
        handoffDeps: fakeDeps(),
        respondAsImpl: stub as never,
        availability: {
          // backend + tgdev + aieng all unavailable.
          isStopped: (k) => k === "backend" || k === "tgdev" || k === "aieng",
          getHealth: () => undefined,
        },
      },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no_available_agent/);
    expect(stub).not.toHaveBeenCalled();
  });

  test("_rerouted_from annotation persisted in created task input payload", async () => {
    const stub = mock(async (_o: RespondAsOpts, _d: HandoffDeps) => "");
    await dispatchAction(
      "DELEGATE_TO_ROLE",
      { role: "smm", task: "promo post" },
      {
        agentKey: "pm",
        chatId: TEST_CHAT,
        resolveAgent: (k) => fakeBot(k),
        handoffDeps: fakeDeps(),
        respondAsImpl: stub as never,
        availability: {
          isStopped: (k) => k === "smm",
          getHealth: () => undefined,
        },
      },
    );
    const rows = listTasksByChat(TEST_CHAT);
    expect(rows.length).toBe(1);
    expect(rows[0].assigned_to).toBe("copy");
    const input = rows[0].input as { _rerouted_from?: string; role: string };
    expect(input._rerouted_from).toBe("smm");
    expect(input.role).toBe("copy");
  });
});

describe("C29 SPLIT_TASK", () => {
  test("creates parent + N child tasks with correct parent_id", async () => {
    const stub = mock(async (_o: RespondAsOpts, _d: HandoffDeps) => "");
    const res = await dispatchAction(
      "SPLIT_TASK",
      {
        title: "Launch campaign",
        description: "coordinated launch",
        roles: ["copy", "design", "smm"],
      },
      {
        agentKey: "orchestrator",
        chatId: TEST_CHAT,
        resolveAgent: (k) => fakeBot(k),
        handoffDeps: fakeDeps(),
        respondAsImpl: stub as never,
      },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const result = res.result as {
      parentTaskId: string;
      childTaskIds: string[];
      roles: string[];
    };
    expect(result.parentTaskId).toBeTruthy();
    expect(result.childTaskIds.length).toBe(3);
    const all = listTasksByChat(TEST_CHAT);
    const parent = all.find((t) => t.id === result.parentTaskId)!;
    expect(parent.title).toMatch(/^\[split\]/);
    const children = all.filter((t) => t.parent_id === result.parentTaskId);
    expect(children.length).toBe(3);
    const childRoles = children.map((c) => c.assigned_to).sort();
    expect(childRoles).toEqual(["copy", "design", "smm"]);
  });

  test("parent rolls up to 'done' when all children are done", async () => {
    const parent = createTask({
      chatId: TEST_CHAT,
      createdBy: "orchestrator",
      title: "[split] parent",
    });
    const c1 = createTask({
      chatId: TEST_CHAT,
      createdBy: "orchestrator",
      assignedTo: "design",
      title: "child 1",
      parentId: parent.id,
    });
    const c2 = createTask({
      chatId: TEST_CHAT,
      createdBy: "orchestrator",
      assignedTo: "smm",
      title: "child 2",
      parentId: parent.id,
    });
    updateTaskStatus(c1.id, "running");
    updateTaskStatus(c1.id, "done");
    // Parent should still be pending (c2 not done yet).
    expect(getTask(parent.id)!.status).toBe("pending");
    updateTaskStatus(c2.id, "running");
    updateTaskStatus(c2.id, "done");
    expect(getTask(parent.id)!.status).toBe("done");
  });

  test("parent rolls up to 'failed' when any child failed and others terminal", async () => {
    const parent = createTask({
      chatId: TEST_CHAT,
      createdBy: "orchestrator",
      title: "[split] parent",
    });
    const c1 = createTask({
      chatId: TEST_CHAT,
      createdBy: "orchestrator",
      assignedTo: "design",
      title: "child 1",
      parentId: parent.id,
    });
    const c2 = createTask({
      chatId: TEST_CHAT,
      createdBy: "orchestrator",
      assignedTo: "smm",
      title: "child 2",
      parentId: parent.id,
    });
    updateTaskStatus(c1.id, "running");
    updateTaskStatus(c1.id, "failed", { error: "boom" });
    expect(getTask(parent.id)!.status).toBe("pending");
    updateTaskStatus(c2.id, "running");
    updateTaskStatus(c2.id, "done");
    const p = getTask(parent.id)!;
    expect(p.status).toBe("failed");
    expect(p.error).toBe("boom");
  });

  // T-730a регресс: когда НИ ОДНО делегирование не создало ребёнка, сведение
  // счётчика к нулю не закрывало родителя — expectedChildCount трактует 0 как
  // «ничего не обещали» и отдаёт null, а rollupParent выходит на пустом наборе
  // детей. Родитель висел pending до gc_stale (24ч), и при этом SPLIT_TASK
  // рапортовал ok:true с пустым childTaskIds — модель считала работу розданной.
  test("all delegations failed → parent closed as failed, action returns ok:false", async () => {
    const res = await dispatchAction(
      "SPLIT_TASK",
      { title: "Nobody can take this", roles: ["copy", "design"] },
      {
        agentKey: "orchestrator",
        chatId: TEST_CHAT,
        // Ни одна роль не резолвится → DELEGATE_TO_ROLE падает на каждой.
        resolveAgent: () => null as never,
        handoffDeps: fakeDeps(),
      },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/no roles accepted/);
    expect(res.taskId).toBeTruthy();

    const parent = getTask(res.taskId!)!;
    expect(parent.status).toBe("failed");
    expect(parent.error).toBeTruthy();
    // Причина каждой роли доезжает до строки, а не теряется в логе.
    expect(parent.error).toMatch(/copy/);
    expect(parent.error).toMatch(/design/);
    // Детей действительно нет — родитель закрыт не через rollup.
    expect(listTasksByChat(TEST_CHAT).filter((t) => t.parent_id === parent.id))
      .toHaveLength(0);
  });

  // Частичный провал остаётся успехом: часть ролей взялась, счётчик сводится
  // к факту, и родитель не ждёт вечно обещанных, но не созданных детей.
  test("partial delegation failure → parent tracks only the children that exist", async () => {
    const stub = mock(async (_o: RespondAsOpts, _d: HandoffDeps) => "");
    const res = await dispatchAction(
      "SPLIT_TASK",
      { title: "Half the team", roles: ["copy", "design"] },
      {
        agentKey: "orchestrator",
        chatId: TEST_CHAT,
        resolveAgent: (k) => (k === "copy" ? fakeBot(k) : (null as never)),
        handoffDeps: fakeDeps(),
        respondAsImpl: stub as never,
      },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const result = res.result as { parentTaskId: string; childTaskIds: string[] };
    expect(result.childTaskIds).toHaveLength(1);

    const parentId = result.parentTaskId;
    expect((getTask(parentId)!.input as { expectedChildren: number })
      .expectedChildren).toBe(1);
    // Единственный существующий ребёнок закрывается → родитель закрывается
    // вместе с ним, не дожидаясь второй роли, которой не существует.
    const child = getTask(result.childTaskIds[0]!)!;
    if (child.status !== "done" && child.status !== "failed") {
      if (child.status === "pending") updateTaskStatus(child.id, "running");
      updateTaskStatus(child.id, "done");
    }
    expect(getTask(parentId)!.status).not.toBe("pending");
  });
});
