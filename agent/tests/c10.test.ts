/**
 * C10: DELEGATE_TO_ROLE tool.
 *
 * Покрытие:
 *  - миграция 012 засеяла permissions для всех 12 агентов;
 *  - tool-schema содержит DELEGATE_TO_ROLE и валидирует input;
 *  - dispatchAction: ошибки self-delegation / unknown role / target not found;
 *  - happy path с заглушкой respondAsImpl;
 *  - gate под semi_auto → allow;
 *  - rate-limit срабатывает после 7-го вызова за минуту.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { db } from "../lib/db.ts";
import { TOOLS, executeTool } from "../lib/tools-schema.ts";
import {
  dispatchAction,
  gateOrDispatch,
} from "../lib/action-dispatch.ts";
import {
  evaluateGate,
  getPermission,
  setAutonomy,
} from "../lib/permissions.ts";
import { _resetRateLimits } from "../lib/rate-limits.ts";
import { CHARACTERS } from "../characters/index.ts";
import type { HandoffDeps, RespondAsOpts } from "../lib/handoff.ts";
import type { RunningBot } from "../lib/types.ts";
import { cleanupChat, saveAutonomy, restoreAutonomy } from "./_helpers.ts";

const TEST_CHAT = -1_000_910;
const TEST_AGENT = "pm";

let savedGlobal = saveAutonomy();

beforeEach(() => {
  _resetRateLimits();
  cleanupChat(TEST_CHAT);
  cleanupChat(TEST_CHAT, TEST_AGENT);
  savedGlobal = saveAutonomy();
});

afterEach(() => {
  restoreAutonomy(savedGlobal);
  _resetRateLimits();
  cleanupChat(TEST_CHAT);
  cleanupChat(TEST_CHAT, TEST_AGENT);
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

describe("migration 012 / permissions", () => {
  test("DELEGATE_TO_ROLE permission засеяна для всех 12 ролей", () => {
    for (const c of CHARACTERS) {
      const p = getPermission(c.key, "DELEGATE_TO_ROLE");
      expect(p.allowed).toBe(true);
      expect(p.requires_approval).toBe(false);
    }
  });

  test("schema_migrations содержит 012_seed_delegate_to_role", () => {
    const row = db
      .prepare(`SELECT name FROM schema_migrations WHERE name = ?`)
      .get("012_seed_delegate_to_role") as { name: string } | undefined;
    expect(row).toBeDefined();
  });
});

describe("tool-schema", () => {
  test("TOOLS содержит DELEGATE_TO_ROLE с required role+task", () => {
    const tool = TOOLS.find((t) => t.name === "DELEGATE_TO_ROLE");
    expect(tool).toBeDefined();
    const req = (tool!.input_schema as { required?: string[] }).required ?? [];
    expect(req).toContain("role");
    expect(req).toContain("task");
  });

  test("executeTool: неизвестная роль → ok:false", async () => {
    const out = await executeTool(
      "DELEGATE_TO_ROLE",
      { role: "nobody", task: "do thing" },
      { agentKey: TEST_AGENT, chatId: TEST_CHAT },
    );
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/unknown role/);
  });

  test("executeTool: пустой task → ok:false", async () => {
    const out = await executeTool(
      "DELEGATE_TO_ROLE",
      { role: "design", task: "  " },
      { agentKey: TEST_AGENT, chatId: TEST_CHAT },
    );
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/task is required/);
  });
});

describe("dispatchAction(DELEGATE_TO_ROLE)", () => {
  test("self-delegation → ok:false", async () => {
    const res = await dispatchAction(
      "DELEGATE_TO_ROLE",
      { role: TEST_AGENT, task: "self" },
      { agentKey: TEST_AGENT, chatId: TEST_CHAT },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/cannot delegate to self/);
  });

  test("без resolveAgent → ok:false", async () => {
    const res = await dispatchAction(
      "DELEGATE_TO_ROLE",
      { role: "design", task: "make banner" },
      { agentKey: TEST_AGENT, chatId: TEST_CHAT },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no resolveAgent/);
  });

  test("target не найден через resolveAgent → ok:false", async () => {
    const res = await dispatchAction(
      "DELEGATE_TO_ROLE",
      { role: "design", task: "make banner" },
      {
        agentKey: TEST_AGENT,
        chatId: TEST_CHAT,
        resolveAgent: () => undefined,
        handoffDeps: fakeDeps(),
      },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/target agent not found/);
  });

  test("happy path: respondAsImpl вызван с правильным target", async () => {
    const stub = mock(
      async (_o: RespondAsOpts, _d: HandoffDeps) => "",
    );
    const target = fakeBot("design");
    const res = await dispatchAction(
      "DELEGATE_TO_ROLE",
      { role: "design", task: "сделай баннер" },
      {
        agentKey: TEST_AGENT,
        chatId: TEST_CHAT,
        resolveAgent: (k) => (k === "design" ? target : undefined),
        handoffDeps: fakeDeps(),
        respondAsImpl: stub as never,
      },
    );
    expect(res.ok).toBe(true);
    expect(stub).toHaveBeenCalledTimes(1);
    const opts = stub.mock.calls[0][0] as RespondAsOpts;
    expect(opts.target.def.key).toBe("design");
    expect(opts.triggerAgentKey).toBe(TEST_AGENT);
    expect(opts.triggerText).toMatch(/DELEGATE: сделай баннер/);
    expect(opts.depth).toBe(1);
  });

  /**
   * Аудит 2026-08-10. Раньше здесь стоял тест «превышение MAX_HANDOFF_DEPTH
   * через _depth → ok:false»: он руками клал в payload _depth: 3 и проверял,
   * что дальше дело не пошло. Проверка проходила — и не значила ничего.
   *
   * _depth объявлен как «set by dispatch, not by LLM», но не ставился ни
   * dispatch'ем, ни кем-либо ещё: в схеме инструмента, которую видит модель,
   * поля нет, а единственная его запись во всём репозитории была вот в этой
   * строке теста. Гейт `depth >= MAX_HANDOFF_DEPTH` не срабатывал в проде
   * никогда, а тест создавал уверенность, что глубина делегирования чем-то
   * ограничена сверху именно тут.
   *
   * Ограничена она на самом деле длиной цепочки (C28): chain растёт на каждом
   * хопе — dispatch кладёт `[...chain, role]` в respondAs, handoff дописывает
   * ключ цели и прокидывает дальше в runWithTools. Это и пинится ниже, а
   * мёртвый счётчик удалён: два независимых счётчика одного и того же — ровно
   * то, из-за чего они расходятся.
   */
  test("потолок держит длина цепочки, а не поле в payload", async () => {
    const stub = mock(async (_o: RespondAsOpts, _d: HandoffDeps) => "");
    const target = fakeBot("design");
    const ctx = {
      agentKey: TEST_AGENT,
      chatId: TEST_CHAT,
      resolveAgent: () => target,
      handoffDeps: fakeDeps(),
      respondAsImpl: stub as never,
    };

    // Поле в payload ничего не решает — даже заведомо запредельное значение.
    const withField = await dispatchAction(
      "DELEGATE_TO_ROLE",
      { role: "design", task: "do", _depth: 99 } as never,
      ctx,
    );
    expect(withField.ok).toBe(true);
    expect(stub).toHaveBeenCalledTimes(1);

    // Решает цепочка, и она приходит из ctx, а не из модели.
    const withChain = await dispatchAction("DELEGATE_TO_ROLE", { role: "design", task: "do" }, {
      ...ctx,
      delegationChain: ["a", "b", "c", "d", "e", "f"],
    });
    expect(withChain.ok).toBe(false);
    if (!withChain.ok) expect(withChain.error).toMatch(/exceeds max length 5/);
    expect(stub).toHaveBeenCalledTimes(1);
  });

  test("глубина каскада у делегата берётся из цепочки", async () => {
    // `depth` уходит в respondAs и ограничивает уже не делегирование, а каскад
    // по упоминаниям внутри делегата (handoff: рекурсия только при
    // depth < MAX_HANDOFF_DEPTH). Раньше сюда шло _depth + 1 при вечном
    // _depth = 0, то есть ровно 1 на любой глубине: делегат на четвёртом хопе
    // получал такой же запас каскада, как первый.
    const stub = mock(async (_o: RespondAsOpts, _d: HandoffDeps) => "");
    const target = fakeBot("design");
    const res = await dispatchAction("DELEGATE_TO_ROLE", { role: "design", task: "do" }, {
      agentKey: TEST_AGENT,
      chatId: TEST_CHAT,
      resolveAgent: () => target,
      handoffDeps: fakeDeps(),
      respondAsImpl: stub as never,
      delegationChain: ["orchestrator", TEST_AGENT, "qa"],
    });
    expect(res.ok).toBe(true);
    const opts = stub.mock.calls[0][0] as RespondAsOpts;
    expect(opts.depth).toBe(3);
    // Обычное делегирование (цепочка из одного отправителя) — по-прежнему 1,
    // иначе это была бы не починка счётчика, а урезание каскада всем подряд.
    await dispatchAction("DELEGATE_TO_ROLE", { role: "design", task: "do" }, {
      agentKey: TEST_AGENT,
      chatId: TEST_CHAT,
      resolveAgent: () => target,
      handoffDeps: fakeDeps(),
      respondAsImpl: stub as never,
    });
    expect((stub.mock.calls[1][0] as RespondAsOpts).depth).toBe(1);
  });

  test("цепочка растёт на хоп — иначе потолок недостижим", () => {
    // Потолок по длине имеет смысл только если длина увеличивается. Ветку
    // «dispatch передаёт [...chain, role]» пинит c28-delegation; здесь —
    // вторая половина пути, дописывание ключа цели в handoff.
    const src = require("node:fs").readFileSync(
      new URL("../lib/handoff.ts", import.meta.url),
      "utf8",
    ) as string;
    expect(src).toContain("[...delegationChain, target.def.key]");
  });
});

describe("gate + rate-limit", () => {
  test("evaluateGate под semi_auto → allow", () => {
    setAutonomy("global", "*", "semi_auto");
    const g = evaluateGate({
      agentKey: TEST_AGENT,
      actionType: "DELEGATE_TO_ROLE",
      chatId: TEST_CHAT,
    });
    expect(g.decision).toBe("allow");
  });

  test("rate-limit: 7-й вызов в минуту отказан", async () => {
    setAutonomy("global", "*", "auto");
    const stub = mock(
      async (_o: RespondAsOpts, _d: HandoffDeps) => "",
    );
    const target = fakeBot("design");
    const ctx = {
      agentKey: TEST_AGENT,
      chatId: TEST_CHAT,
      resolveAgent: () => target,
      handoffDeps: fakeDeps(),
      respondAsImpl: stub as never,
    };
    for (let i = 0; i < 6; i++) {
      const r = await gateOrDispatch(
        "DELEGATE_TO_ROLE",
        { role: "design", task: `t${i}` },
        ctx,
      );
      expect(r.kind).toBe("ok");
    }
    const r7 = await gateOrDispatch(
      "DELEGATE_TO_ROLE",
      { role: "design", task: "too many" },
      ctx,
    );
    expect(r7.kind).toBe("rate_limited");
  });
});
