/**
 * C28: production-bug fixes.
 *
 *  1. Delegation chain longer than 5 → refused with "delegation cycle detected".
 *  2. Back-compat `_delegation_path` in payload is honoured when ctx lacks
 *     `delegationChain` (perm → tgdev → perm → tgdev ping-pong scenario).
 *  3. Normal a→b dispatch records the extended chain on respondAs.
 *  4. DELEGATE_TO_ROLE creates a corresponding row in the `tasks` table so
 *     the Mini App "Задачи" tab is no longer blind to in-flight delegations.
 *  5. CREATE_POLL action is wired through dispatch (handler + payload typing).
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { dispatchAction } from "../lib/action-dispatch.ts";
import { _resetRateLimits } from "../lib/rate-limits.ts";
import { listTasksByChat } from "../lib/tasks.ts";
import type { HandoffDeps, RespondAsOpts } from "../lib/handoff.ts";
import type { RunningBot } from "../lib/types.ts";
import { cleanupChat, saveAutonomy, restoreAutonomy } from "./_helpers.ts";

const TEST_CHAT = -1_000_928;

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

describe("C28 delegation cycle detection (path length cap)", () => {
  test("chain longer than 5 → refused with 'delegation cycle detected'", async () => {
    const stub = mock(async (_o: RespondAsOpts, _d: HandoffDeps) => "");
    // 6-element chain is already over the cap (≥6 means length > 5).
    const res = await dispatchAction(
      "DELEGATE_TO_ROLE",
      { role: "design", task: "x" },
      {
        agentKey: "qa",
        chatId: TEST_CHAT,
        resolveAgent: (k) => fakeBot(k),
        handoffDeps: fakeDeps(),
        respondAsImpl: stub as never,
        delegationChain: ["a", "b", "c", "d", "e", "qa"],
      },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/delegation cycle detected/);
    expect(stub).not.toHaveBeenCalled();
  });

  test("immediate back-and-forth a→b→a is refused via last-2 check", async () => {
    const stub = mock(async (_o: RespondAsOpts, _d: HandoffDeps) => "");
    const res = await dispatchAction(
      "DELEGATE_TO_ROLE",
      { role: "perm", task: "approve" },
      {
        agentKey: "tgdev",
        chatId: TEST_CHAT,
        resolveAgent: (k) => fakeBot(k),
        handoffDeps: fakeDeps(),
        respondAsImpl: stub as never,
        delegationChain: ["perm", "tgdev"],
      },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/cycle/);
    expect(stub).not.toHaveBeenCalled();
  });

  test("back-compat: _delegation_path on payload is honoured when ctx omits it", async () => {
    const stub = mock(async (_o: RespondAsOpts, _d: HandoffDeps) => "");
    const res = await dispatchAction(
      "DELEGATE_TO_ROLE",
      {
        role: "tgdev",
        task: "delete service",
        _delegation_path: ["perm", "tgdev", "perm"],
      },
      {
        agentKey: "perm",
        chatId: TEST_CHAT,
        resolveAgent: (k) => fakeBot(k),
        handoffDeps: fakeDeps(),
        respondAsImpl: stub as never,
        // No delegationChain in ctx — must fall back to _delegation_path.
      },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/cycle/);
    expect(stub).not.toHaveBeenCalled();
  });

  test("normal a→b: ok, respondAs sees path=[a,b]", async () => {
    const captured: RespondAsOpts[] = [];
    const stub = mock(async (o: RespondAsOpts, _d: HandoffDeps) => {
      captured.push(o);
      return "";
    });
    const res = await dispatchAction(
      "DELEGATE_TO_ROLE",
      { role: "design", task: "make banner" },
      {
        agentKey: "pm",
        chatId: TEST_CHAT,
        resolveAgent: (k) => fakeBot(k),
        handoffDeps: fakeDeps(),
        respondAsImpl: stub as never,
      },
    );
    expect(res.ok).toBe(true);
    expect(captured[0].delegationChain).toEqual(["pm", "design"]);
  });
});

describe("C28 DELEGATE_TO_ROLE creates a task row", () => {
  test("on successful dispatch, a tasks row exists for the chat", async () => {
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
      },
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.taskId).toBeTruthy();
    const rows = listTasksByChat(TEST_CHAT);
    expect(rows.length).toBe(1);
    expect(rows[0].assigned_to).toBe("design");
    expect(rows[0].created_by).toBe("pm");
    expect(rows[0].title).toMatch(/delegate→design/);
    // input payload preserves the original task text and source agent.
    const input = rows[0].input as {
      task: string;
      fromAgent: string;
      provider: string;
      execution: string;
    };
    expect(input.task).toBe("make banner");
    expect(input.fromAgent).toBe("pm");
    expect(input.provider).toBe("internal");
    expect(input.execution).toBe("in_process_handoff");
    expect(JSON.stringify(res)).toContain('"provider":"internal"');
    expect(JSON.stringify(res)).toContain('"execution":"in_process_handoff"');
  });

  test("refused cycle does NOT create a task row", async () => {
    const stub = mock(async (_o: RespondAsOpts, _d: HandoffDeps) => "");
    const res = await dispatchAction(
      "DELEGATE_TO_ROLE",
      { role: "perm", task: "loop" },
      {
        agentKey: "tgdev",
        chatId: TEST_CHAT,
        resolveAgent: (k) => fakeBot(k),
        handoffDeps: fakeDeps(),
        respondAsImpl: stub as never,
        delegationChain: ["perm", "tgdev"],
      },
    );
    expect(res.ok).toBe(false);
    expect(listTasksByChat(TEST_CHAT).length).toBe(0);
  });
});

describe("C28 CREATE_POLL is wired through dispatch", () => {
  test("payload validates and tgCreatePoll is invoked via telegram stub", async () => {
    const calls: unknown[] = [];
    const telegramStub = {
      sendPoll: async (
        chatId: number,
        question: string,
        options: string[],
        extra?: unknown,
      ) => {
        calls.push({ chatId, question, options, extra });
        return { message_id: 42, poll: { id: "p1" } };
      },
    } as unknown as import("telegraf").Telegram;
    const res = await dispatchAction(
      "CREATE_POLL",
      {
        question: "Lunch?",
        options: ["Pizza", "Salad"],
        isAnonymous: false,
      },
      {
        agentKey: "pm",
        chatId: TEST_CHAT,
        telegram: telegramStub,
      },
    );
    expect(res.ok).toBe(true);
    expect(calls.length).toBe(1);
    const c = calls[0] as { chatId: number; question: string; options: string[] };
    expect(c.chatId).toBe(TEST_CHAT);
    expect(c.question).toBe("Lunch?");
    expect(c.options).toEqual(["Pizza", "Salad"]);
  });
});

/**
 * T-730: делегированный таск обязан закрываться.
 *
 * Прод 2026-08-02: DELEGATE_TO_ROLE создавал строку и оставлял её в pending
 * навсегда — через 24ч gcStaleTasks штамповал failed/gc_stale. 148 из 154
 * «провалов» в БД при 116 успешных делегированиях; дневной дайджест показывал
 * «(no data)», потому что доска состояла из мусора.
 */
describe("T-730 delegated task reaches a terminal status", () => {
  test("delegate returns a reply → task done, output carries the reply", async () => {
    const stub = mock(async (_o: RespondAsOpts, _d: HandoffDeps) => "баннер готов");
    const res = await dispatchAction(
      "DELEGATE_TO_ROLE",
      { role: "design", task: "make banner" },
      {
        agentKey: "pm",
        chatId: TEST_CHAT,
        resolveAgent: (k) => fakeBot(k),
        handoffDeps: fakeDeps(),
        respondAsImpl: stub as never,
      },
    );
    expect(res.ok).toBe(true);
    const rows = listTasksByChat(TEST_CHAT);
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("done");
    const out = rows[0].output as { role: string; reply: string };
    expect(out.reply).toBe("баннер готов");
  });

  // Аудит 2026-08-13: раньше здесь проверялось «пустой ответ → failed», и это
  // сваливало в одну кучу два разных исхода. Ход, закрытый инструментом
  // (`acted`), — успех: у makers это штатный конец, картинка уже в чате.
  // Провал и пропуск — провал. Общее у всех троих одно: строка закрыта, а не
  // оставлена в running до gc_stale, ради чего тест и заводился (T-730).
  test("делегат ответил действием → задача done, а не failed", async () => {
    const stub = mock(async (_o: RespondAsOpts, _d: HandoffDeps) => ({
      status: "acted" as const,
    }));
    const res = await dispatchAction(
      "DELEGATE_TO_ROLE",
      { role: "design", task: "make banner" },
      {
        agentKey: "pm",
        chatId: TEST_CHAT,
        resolveAgent: (k) => fakeBot(k),
        handoffDeps: fakeDeps(),
        respondAsImpl: stub as never,
      },
    );
    expect(res.ok).toBe(true);
    const rows = listTasksByChat(TEST_CHAT);
    expect(rows[0].status).toBe("done");
  });

  test("делегат пропущен → задача failed И модель видит ok:false с причиной", async () => {
    const stub = mock(async (_o: RespondAsOpts, _d: HandoffDeps) => ({
      status: "skipped" as const,
      reason: "роль design остановлена (paused)",
    }));
    const res = await dispatchAction(
      "DELEGATE_TO_ROLE",
      { role: "design", task: "make banner" },
      {
        agentKey: "pm",
        chatId: TEST_CHAT,
        resolveAgent: (k) => fakeBot(k),
        handoffDeps: fakeDeps(),
        respondAsImpl: stub as never,
      },
    );
    // Ровно то, из-за чего заводилась правка: доска говорила «failed», а модель
    // получала ok:true и рапортовала в чат «готово».
    if (res.ok) throw new Error("ожидался отказ, получен ok:true");
    expect(String(res.error)).toContain("delegate_skipped");
    expect(String(res.error)).toContain("остановлена");
    const rows = listTasksByChat(TEST_CHAT);
    expect(rows[0].status).toBe("failed");
    expect(String(rows[0].error)).toContain("остановлена");
  });

  // dispatchAction ловит исключения сама и отдаёт {ok:false} — важно, что таск
  // при этом закрыт как failed, а не завис в running до gc_stale.
  test("delegate throws → task failed with the error, dispatch reports ok:false", async () => {
    const stub = mock(async (_o: RespondAsOpts, _d: HandoffDeps) => {
      throw new Error("downstream boom");
    });
    const res = await dispatchAction(
      "DELEGATE_TO_ROLE",
      { role: "design", task: "make banner" },
      {
        agentKey: "pm",
        chatId: TEST_CHAT,
        resolveAgent: (k) => fakeBot(k),
        handoffDeps: fakeDeps(),
        respondAsImpl: stub as never,
      },
    );
    expect(res.ok).toBe(false);
    const rows = listTasksByChat(TEST_CHAT);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].error).toMatch(/downstream boom/);
  });

  // T-730a: закрытие детей включило rollupParent на пути, который до этого был
  // мёртв. SPLIT_TASK создаёт детей строго последовательно, поэтому первый
  // закрывшийся ребёнок видел набор из одной строки, считал его полным и
  // отдавал родителю свой статус: 3 роли, 2 провалились → родитель «done».
  // Доска снова врала, только теперь в обратную сторону.
  test("SPLIT_TASK: родитель ждёт ВСЕХ детей, а не первого", async () => {
    let n = 0;
    const stub = mock(async (_o: RespondAsOpts, _d: HandoffDeps) =>
      ++n === 1 ? "готово" : undefined,
    );
    await dispatchAction(
      "SPLIT_TASK",
      { title: "релиз", roles: ["design", "copy", "qa"] },
      {
        agentKey: "pm",
        chatId: TEST_CHAT,
        resolveAgent: (k) => fakeBot(k),
        handoffDeps: fakeDeps(),
        respondAsImpl: stub as never,
      },
    );
    const rows = listTasksByChat(TEST_CHAT);
    const parent = rows.find((r) => r.title.startsWith("[split]"))!;
    expect(rows.filter((r) => r.title.startsWith("[delegate→"))).toHaveLength(3);
    expect(parent.status).toBe("failed");
  });

  test("SPLIT_TASK: все дети успешны → родитель done", async () => {
    const stub = mock(async (_o: RespondAsOpts, _d: HandoffDeps) => "готово");
    await dispatchAction(
      "SPLIT_TASK",
      { title: "релиз", roles: ["design", "copy"] },
      {
        agentKey: "pm",
        chatId: TEST_CHAT,
        resolveAgent: (k) => fakeBot(k),
        handoffDeps: fakeDeps(),
        respondAsImpl: stub as never,
      },
    );
    const parent = listTasksByChat(TEST_CHAT).find((r) =>
      r.title.startsWith("[split]"),
    )!;
    expect(parent.status).toBe("done");
  });

  // Если часть делегирований не создала строку (отказ по циклу), обещанное
  // число детей никогда не сойдётся — родитель обязан быть сведён по факту,
  // иначе провиснет в pending до gc_stale.
  test("SPLIT_TASK: отказанное делегирование не подвешивает родителя", async () => {
    const stub = mock(async (_o: RespondAsOpts, _d: HandoffDeps) => "готово");
    await dispatchAction(
      "SPLIT_TASK",
      { title: "релиз", roles: ["design", "perm"] },
      {
        agentKey: "tgdev",
        chatId: TEST_CHAT,
        resolveAgent: (k) => fakeBot(k),
        handoffDeps: fakeDeps(),
        respondAsImpl: stub as never,
        // perm↔tgdev — цикл: этот ребёнок будет отказан и строку не создаст.
        delegationChain: ["perm", "tgdev"],
      },
    );
    const rows = listTasksByChat(TEST_CHAT);
    const parent = rows.find((r) => r.title.startsWith("[split]"))!;
    expect(rows.filter((r) => r.title.startsWith("[delegate→"))).toHaveLength(1);
    expect(parent.status).not.toBe("pending");
    expect(parent.status).not.toBe("running");
  });

  test("no delegated task survives in pending — gcStaleTasks has nothing to reap", async () => {
    const stub = mock(async (_o: RespondAsOpts, _d: HandoffDeps) => "ok");
    for (const role of ["design", "copy", "qa"]) {
      await dispatchAction(
        "DELEGATE_TO_ROLE",
        { role, task: `task for ${role}` },
        {
          agentKey: "pm",
          chatId: TEST_CHAT,
          resolveAgent: (k) => fakeBot(k),
          handoffDeps: fakeDeps(),
          respondAsImpl: stub as never,
        },
      );
    }
    const rows = listTasksByChat(TEST_CHAT);
    expect(rows.length).toBe(3);
    expect(rows.filter((r) => r.status === "pending" || r.status === "running")).toEqual([]);
  });
});
