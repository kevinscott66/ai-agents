/**
 * Аудит 2026-08-13: делегированный путь к Mac был мёртв, а починка его открывает.
 *
 * `RespondAsOpts` не нёс `triggerUserId`, поэтому у делегата (DELEGATE_TO_ROLE
 * или @-упоминание) в payload MAC_RUN_CLAUDE/MAC_STOP приезжал
 * `_userId: undefined`, а `isUserAllowed(undefined)` — тихий false. То есть:
 *
 *  - документированный сценарий CLAUDE.md §3.10 (design/frontend просят
 *    оркестратора сходить в скиллы на маке) всегда отказывал «forbidden»;
 *  - вместе с ним отказывал аварийный MAC_STOP — тот самый дефект, который
 *    уже чинили на хоп выше (SEC-audit LOW-2), но значения на этом пути не
 *    было, так что чинили пустоту.
 *
 * Одно прокидывание оживило бы и то, чего раньше не существовало: цепочку
 * «любая роль → оркестратор → claude на маке владельца» без человека при
 * MAC_AUTONOMOUS=true. CALLER_RESTRICTED тут не помогает — вызывающий как раз
 * оркестратор. Поэтому вторая половина фикса: делегированный Mac-ход помечается
 * `_delegated` и форсит approval при любой autonomy. Круг ЛЮДЕЙ не меняется —
 * whitelist MAC_USER_IDS по-прежнему считается по исходному пользователю.
 *
 * Обе половины проверяются здесь, потому что по отдельности каждая вредна.
 */
import {
  describe,
  test,
  expect,
  mock,
  beforeEach,
  afterEach,
} from "bun:test";
import { dispatchAction } from "../lib/action-dispatch.ts";
import { respondAs } from "../lib/handoff.ts";
import { executeTool } from "../lib/tools-schema.ts";
import {
  evaluateGate,
  isDelegatedMacAction,
  payloadForcesApproval,
  setPermission,
  setAutonomy,
  type ActionType,
} from "../lib/permissions.ts";
import { _resetRateLimits } from "../lib/rate-limits.ts";
import { getApproval } from "../lib/approvals.ts";
import {
  cleanupChat,
  saveAutonomy,
  restoreAutonomy,
  savePermissions,
} from "./_helpers.ts";
import type { RunningBot } from "../lib/types.ts";
import type { HandoffDeps, RespondAsOpts } from "../lib/handoff.ts";
import type { PayloadFor } from "../lib/action-payload.ts";

const CHAT = -1_000_813;

const fakeBot = (k: string): RunningBot => ({
  def: { key: k as never, name: k, envToken: "", system: "" } as never,
  bot: { telegram: {} } as never,
  username: `${k}_bot`,
  id: 100,
});
const fakeDeps = (): HandoffDeps => ({
  anthropic: {} as never,
  model: "t",
  historyLimit: 10,
  bots: [],
});

/** Мост, который не ходит в сеть: whitelist — только пользователь 42. */
const fakeBridge = () => ({
  isMacConnected: () => true,
  isUserAllowed: (uid?: string) => uid === "42",
  sendToMac: async () => ({ ok: true, code: 0, stdout: "", stderr: "" }),
  stopMac: async () => ({ ok: true }),
});

/** MAC_STOP объявлен без полей — `_userId` кладём приведением (см. c30). */
const stopPayload = (userId?: string, delegated?: boolean) =>
  ({ _userId: userId, _delegated: delegated }) as unknown as PayloadFor<"MAC_STOP">;

/**
 * Права здесь приходится разоружать, чтобы дойти до проверяемой ветки: тесты
 * ниже спрашивают «заведётся ли карточка approval», а без `allowed: true` ход
 * не доживает до этого вопроса. Но таблица `permissions` глобальная, и
 * `cleanupChat` её не чистит — снятое требование пережило бы файл и обесценило
 * бы соседние тесты, которые как раз проверяют, что карточка нужна. Инцидент
 * T-812 состоял ровно в этом.
 */
const MAC_ACTIONS = [
  ["orchestrator", "MAC_RUN_CLAUDE"],
  ["orchestrator", "MAC_STOP"],
] as Array<[string, ActionType]>;
let restorePerms: () => void;
let savedAutonomy = saveAutonomy();
let savedMacAuto: string | undefined;
beforeEach(() => {
  savedAutonomy = saveAutonomy();
  restorePerms = savePermissions(MAC_ACTIONS);
  savedMacAuto = process.env.MAC_AUTONOMOUS;
  _resetRateLimits();
  cleanupChat(CHAT, "orchestrator");
});
afterEach(() => {
  restoreAutonomy(savedAutonomy);
  restorePerms();
  // CLAUDE.md §3.8 п.7: env восстанавливаем, иначе течёт в соседние файлы.
  if (savedMacAuto === undefined) delete process.env.MAC_AUTONOMOUS;
  else process.env.MAC_AUTONOMOUS = savedMacAuto;
  _resetRateLimits();
  cleanupChat(CHAT, "orchestrator");
});

describe("DELEGATE_TO_ROLE → triggerUserId", () => {
  test("делегат получает пользователя исходного хода", async () => {
    let seen: RespondAsOpts | null = null;
    const stub = mock(async (o: RespondAsOpts) => {
      seen = o;
      return "готово";
    });
    await dispatchAction(
      "DELEGATE_TO_ROLE",
      { role: "design", task: "макет" },
      {
        agentKey: "orchestrator",
        chatId: CHAT,
        resolveAgent: (k) => fakeBot(k),
        handoffDeps: fakeDeps(),
        respondAsImpl: stub as never,
        triggerUserId: "42",
      },
    );
    expect(seen).not.toBeNull();
    expect(seen!.triggerUserId).toBe("42");
  });

  test("анонимного хода не выдумываем: было undefined — осталось undefined", async () => {
    let seen: RespondAsOpts | null = null;
    const stub = mock(async (o: RespondAsOpts) => {
      seen = o;
      return "готово";
    });
    await dispatchAction(
      "DELEGATE_TO_ROLE",
      { role: "design", task: "макет" },
      {
        agentKey: "orchestrator",
        chatId: CHAT,
        resolveAgent: (k) => fakeBot(k),
        handoffDeps: fakeDeps(),
        respondAsImpl: stub as never,
      },
    );
    expect(seen).not.toBeNull();
    expect(seen!.triggerUserId).toBeUndefined();
  });
});

describe("isDelegatedMacAction", () => {
  test("только Mac-действия и только с явным флагом", () => {
    expect(isDelegatedMacAction("MAC_RUN_CLAUDE", { _delegated: true })).toBe(true);
    expect(isDelegatedMacAction("MAC_STOP", { _delegated: true })).toBe(true);
    expect(isDelegatedMacAction("SEND_MESSAGE", { _delegated: true })).toBe(false);
    expect(isDelegatedMacAction("MAC_RUN_CLAUDE", { _delegated: false })).toBe(false);
  });

  test("мусорный payload не роняет проверку и не даёт false-positive", () => {
    for (const p of [undefined, null, {}, { _delegated: "true" }, { _delegated: 1 }]) {
      expect(isDelegatedMacAction("MAC_RUN_CLAUDE", p)).toBe(false);
    }
  });
});

describe("payloadForcesApproval: делегирование требует человека", () => {
  test("делегированный запуск форсит approval со своей причиной", () => {
    expect(
      payloadForcesApproval("MAC_RUN_CLAUDE", {
        project: "/x",
        prompt: "p",
        mode: "ask",
        _delegated: true,
      }),
    ).toBe("delegated Mac action requires approval");
  });

  test("делегированный MAC_STOP — тоже", () => {
    expect(payloadForcesApproval("MAC_STOP", { _delegated: true })).toBe(
      "delegated Mac action requires approval",
    );
  });

  test("прямое обращение человека ничего не форсит — opt-in не сломан", () => {
    expect(
      payloadForcesApproval("MAC_RUN_CLAUDE", {
        project: "/x",
        prompt: "p",
        mode: "ask",
        _delegated: false,
      }),
    ).toBeNull();
  });

  test("bypass остаётся приоритетнее: его причина конкретнее", () => {
    expect(
      payloadForcesApproval("MAC_RUN_CLAUDE", { mode: "bypass", _delegated: true }),
    ).toBe("bypass mode requires approval");
  });
});

describe("гейт: MAC_AUTONOMOUS не распространяется на делегированный ход", () => {
  test("делегированный запуск требует человека даже при MAC_AUTONOMOUS=true", () => {
    process.env.MAC_AUTONOMOUS = "true";
    setAutonomy("chat", String(CHAT), "auto");
    const forced = payloadForcesApproval("MAC_RUN_CLAUDE", {
      project: "/x",
      prompt: "p",
      mode: "ask",
      _delegated: true,
    });
    const g = evaluateGate({
      agentKey: "orchestrator",
      actionType: "MAC_RUN_CLAUDE",
      chatId: CHAT,
      forceApproval: forced !== null,
      forceApprovalReason: forced ?? undefined,
    });
    expect(g.decision).toBe("approval");
    expect((g as { reason: string }).reason).toBe(
      "delegated Mac action requires approval",
    );
  });

  test("прямой ход при тех же настройках по-прежнему идёт без approval", () => {
    process.env.MAC_AUTONOMOUS = "true";
    setAutonomy("chat", String(CHAT), "auto");
    const g = evaluateGate({
      agentKey: "orchestrator",
      actionType: "MAC_RUN_CLAUDE",
      chatId: CHAT,
      forceApproval: false,
    });
    expect(g.decision).toBe("allow");
  });
});

describe("whitelist по-прежнему считается по исходному человеку", () => {
  test("делегированный MAC_STOP от разрешённого пользователя доезжает до моста", async () => {
    const res = await dispatchAction("MAC_STOP", stopPayload("42", true), {
      agentKey: "orchestrator",
      chatId: CHAT,
      macBridge: fakeBridge(),
    });
    expect(res.ok).toBe(true);
  });

  test("делегирование не проносит чужого человека", async () => {
    const res = await dispatchAction("MAC_STOP", stopPayload("999", true), {
      agentKey: "orchestrator",
      chatId: CHAT,
      macBridge: fakeBridge(),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("forbidden");
  });

  test("без пользователя (старое поведение делегата) — forbidden", async () => {
    const res = await dispatchAction("MAC_STOP", stopPayload(undefined, true), {
      agentKey: "orchestrator",
      chatId: CHAT,
      macBridge: fakeBridge(),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("forbidden");
  });
});

/**
 * Последняя нога маршрута: respondAs → runWithTools → executeTool. Здесь
 * `triggerUserId` из RespondAsOpts обязан доехать до payload'а, иначе всё
 * прокидывание выше упирается в стену на последнем метре.
 *
 * Наблюдаем по коду ошибки в tool_result: whitelist пропустил → мост отвечает
 * `mac_offline` (сокета в тестах нет); потерял пользователя → `forbidden`.
 */
describe("respondAs → tool-loop: пользователь доезжает до payload", () => {
  /** Первый вызов — tool_use MAC_STOP, второй — текст. */
  function macStopDeps(captured: unknown[]): HandoffDeps {
    let calls = 0;
    return {
      anthropic: {
        messages: {
          create: async (req: unknown) => {
            captured.push(req);
            const first = calls++ === 0;
            return {
              id: "m",
              type: "message",
              role: "assistant",
              model: "t",
              stop_reason: first ? "tool_use" : "end_turn",
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
              content: first
                ? [{ type: "tool_use", id: "tu1", name: "MAC_STOP", input: {} }]
                : [{ type: "text", text: "остановил" }],
            } as never;
          },
        },
      },
      model: "t",
      historyLimit: 5,
      bots: [],
    } as never;
  }

  /** Все tool_result-блоки из запросов к модели. */
  function toolResults(captured: unknown[]): string[] {
    const out: string[] = [];
    for (const req of captured as Array<{ messages: unknown[] }>) {
      for (const m of req.messages as Array<{ content: unknown }>) {
        if (!Array.isArray(m.content)) continue;
        for (const b of m.content as Array<{ type: string; content?: unknown }>) {
          if (b.type === "tool_result") out.push(String(b.content));
        }
      }
    }
    return out;
  }

  const bot = (key: string): RunningBot =>
    ({
      def: { key, name: key, envToken: "", system: "" },
      bot: {
        telegram: {
          sendChatAction: async () => {},
          sendMessage: async () => ({ message_id: 1, date: 0 }),
        },
      },
      username: `${key}_bot`,
      id: 100,
    }) as never;

  test("делегат по @-упоминанию доносит пользователя до карточки approval", async () => {
    const savedIds = process.env.MAC_USER_IDS;
    try {
      process.env.MAC_USER_IDS = "42";
      setAutonomy("chat", String(CHAT), "auto");
      setPermission("orchestrator", "MAC_STOP", {
        allowed: true,
        requires_approval: false,
      });
      const captured: unknown[] = [];
      await respondAs(
        {
          target: bot("orchestrator"),
          chatId: String(CHAT),
          triggerText: "@orchestrator_bot останови процесс на маке",
          triggerAgentKey: "design",
          depth: 1,
          visited: new Set(["design", "orchestrator"]),
          triggerUserId: "42",
        },
        macStopDeps(captured),
      );
      const results = toolResults(captured);
      expect(results.length).toBeGreaterThan(0);
      const first = JSON.parse(results[0]) as {
        status?: string;
        approvalId?: string;
      };
      // Любой ход через respondAs — делегированный по определению, поэтому
      // здесь ждём карточку, а не запуск: это вторая половина фикса.
      expect(first.status).toBe("pending_approval");
      const appr = getApproval(first.approvalId!);
      expect(appr).not.toBeNull();
      // А в отложенном payload'е обязан лежать исходный человек: именно по нему
      // whitelist проверится после нажатия «Одобрить». Без прокидывания тут
      // undefined, и одобренное действие всё равно упало бы в forbidden.
      const stored = appr!.payload as { _userId?: string; _delegated?: boolean };
      expect(stored._userId).toBe("42");
      expect(stored._delegated).toBe(true);
    } finally {
      if (savedIds === undefined) delete process.env.MAC_USER_IDS;
      else process.env.MAC_USER_IDS = savedIds;
    }
  });
});

describe("executeTool: _delegated считается по delegationChain", () => {
  const RUN = { project: "/tmp/x", prompt: "p", mode: "ask" };

  test("ход из цепочки делегирования уходит в approval при MAC_AUTONOMOUS=true", async () => {
    process.env.MAC_AUTONOMOUS = "true";
    setAutonomy("chat", String(CHAT), "auto");
    setPermission("orchestrator", "MAC_RUN_CLAUDE", {
      allowed: true,
      requires_approval: false,
    });
    const out = JSON.parse(
      await executeTool("MAC_RUN_CLAUDE", RUN, {
        agentKey: "orchestrator",
        chatId: CHAT,
        triggerUserId: "42",
        delegationChain: ["design", "orchestrator"],
      }),
    );
    expect(out.status).toBe("pending_approval");
    expect(typeof out.approvalId).toBe("string");
  });

  test("прямой ход при тех же настройках approval не заводит", async () => {
    process.env.MAC_AUTONOMOUS = "true";
    setAutonomy("chat", String(CHAT), "auto");
    setPermission("orchestrator", "MAC_RUN_CLAUDE", {
      allowed: true,
      requires_approval: false,
    });
    const out = JSON.parse(
      await executeTool("MAC_RUN_CLAUDE", RUN, {
        agentKey: "orchestrator",
        chatId: CHAT,
        triggerUserId: "42",
      }),
    );
    // Дальше он упрётся в реальные проверки (whitelist/allowlist/офлайн-мак) —
    // важно, что решение принял гейт, а не карточка approval.
    expect(out.approvalId).toBeUndefined();
    expect(out.status).not.toBe("pending_approval");
  });

  test("прямой ход владельца приходит С цепочкой — и всё равно не делегирован", async () => {
    // Тест выше зовёт executeTool вообще без `delegationChain`, а в проде так
    // не бывает: message-handler засевает её как `[def.key]` для анти-пингпонга
    // C13 на КАЖДОМ ходе, включая тот, что владелец набрал руками. Поэтому
    // признак делегирования — чужой ключ в цепочке, а не её непустота. По длине
    // `> 0` карточка вставала бы на каждый запуск, то есть MAC_AUTONOMOUS не
    // работал бы никогда.
    process.env.MAC_AUTONOMOUS = "true";
    setAutonomy("chat", String(CHAT), "auto");
    setPermission("orchestrator", "MAC_RUN_CLAUDE", {
      allowed: true,
      requires_approval: false,
    });
    const out = JSON.parse(
      await executeTool("MAC_RUN_CLAUDE", RUN, {
        agentKey: "orchestrator",
        chatId: CHAT,
        triggerUserId: "42",
        delegationChain: ["orchestrator"],
      }),
    );
    expect(out.approvalId).toBeUndefined();
    expect(out.status).not.toBe("pending_approval");
  });

  test("тот же ход от чужой роли через оркестратора — делегирован", async () => {
    // Пара к предыдущему: отличается ровно одним чужим ключом в цепочке.
    process.env.MAC_AUTONOMOUS = "true";
    setAutonomy("chat", String(CHAT), "auto");
    setPermission("orchestrator", "MAC_RUN_CLAUDE", {
      allowed: true,
      requires_approval: false,
    });
    const out = JSON.parse(
      await executeTool("MAC_RUN_CLAUDE", RUN, {
        agentKey: "orchestrator",
        chatId: CHAT,
        triggerUserId: "42",
        delegationChain: ["design", "orchestrator"],
      }),
    );
    expect(out.status).toBe("pending_approval");
  });
});
