/**
 * Аудит 2026-08-12: потолок «16 handoff-вызовов на ход» считался по ветке.
 *
 * `HANDOFF_MAX_INVOCATIONS` ограничивает ОБЩЕЕ число делегирований в одном ходе
 * пользователя: `visited` режет только линейный путь, а каждый узел дерева —
 * отдельный LLM-вызов ($0.5–1.5). Счётчик — один объект, который все ветки
 * делят по ссылке.
 *
 * Заводился он ровно в одном месте: orchestrator/message-handler.ts, СТРОКОЙ
 * ПОСЛЕ runWithTools, и уходил только в каскад по @-упоминаниям. До
 * DELEGATE_TO_ROLE он не доезжал вовсе. Замер (три делегирования подряд через
 * настоящий dispatch):
 *
 *   HANDOFF_MAX_INVOCATIONS = 16
 *   делегирований: 3
 *   budget в opts respondAs: null, null, null
 *   ключи opts: target,chatId,triggerText,triggerAgentKey,depth,visited,
 *               triggerMessageId,delegationChain,requestId
 *
 * `null` здесь значит «заводи свой»: handoff.ts на каждый вызов без budget
 * создаёт новое `{n:0,max:16}`. То есть собственные делегирования оркестратора
 * не считались никем, а внутри каждого делегата открывался свежий запас на 16 —
 * и так на каждом хопе. Потолок хода превращался в потолок ветки.
 *
 * Инвариант: счётчик заводит tool-loop — один на ход, каким бы входом ход ни
 * начался (Telegram, userbot, Mini App, планировщик, mac-bridge), — и он же
 * доезжает до DELEGATE_TO_ROLE и до хода делегата.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { readFileSync } from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import { dispatchAction } from "../lib/action-dispatch.ts";
import { runWithTools } from "../lib/tool-loop.ts";
import { respondAs, HANDOFF_MAX_INVOCATIONS } from "../lib/handoff.ts";
import type { HandoffDeps, RespondAsOpts } from "../lib/handoff.ts";
import type { RunningBot } from "../lib/types.ts";
import { _resetRateLimits } from "../lib/rate-limits.ts";
import { cleanupChat, saveAutonomy, restoreAutonomy } from "./_helpers.ts";

const TEST_CHAT = -1_000_918;

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
    bot: {
      telegram: {
        sendChatAction: async () => {},
        sendMessage: async () => ({ message_id: 1, date: 0 }),
      },
    } as never,
    username: `${key}_bot`,
    id: 100,
  };
}

/**
 * Депсы делегата: клиент, который бросает вместо похода в сеть. respondAs
 * ловит это своим catch и возвращает null — счётчик к этому моменту уже
 * потрачен, а тест не делает ни одного платного вызова.
 */
function brokenDeps(): HandoffDeps {
  return {
    anthropic: {
      messages: {
        create: async () => {
          throw new Error("сеть в тесте недоступна");
        },
      },
    },
    model: "t",
    historyLimit: 5,
    bots: [],
  } as never;
}

/** Модель, которая на первой итерации зовёт DELEGATE_TO_ROLE, потом молчит. */
function anthropicDelegatingTwice(): Anthropic {
  let turn = 0;
  return {
    messages: {
      create: async () => {
        turn += 1;
        const content =
          turn === 1
            ? [
                {
                  type: "tool_use",
                  id: "t1",
                  name: "DELEGATE_TO_ROLE",
                  input: { role: "backend", task: "первая" },
                },
                {
                  type: "tool_use",
                  id: "t2",
                  name: "DELEGATE_TO_ROLE",
                  input: { role: "frontend", task: "вторая" },
                },
              ]
            : [{ type: "text", text: "готово" }];
        return {
          id: "m",
          type: "message",
          role: "assistant",
          model: "t",
          stop_reason: turn === 1 ? "tool_use" : "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
          content,
        } as unknown as Anthropic.Message;
      },
    },
  } as unknown as Anthropic;
}

describe("счётчик доезжает до DELEGATE_TO_ROLE", () => {
  test("замер из шапки: budget из ctx уходит в opts respondAs той же ссылкой", async () => {
    const seen: RespondAsOpts[] = [];
    const stub = mock(async (o: RespondAsOpts) => {
      seen.push(o);
      return "ok";
    });
    const budget = { n: 0, max: HANDOFF_MAX_INVOCATIONS };
    const res = await dispatchAction(
      "DELEGATE_TO_ROLE",
      { role: "backend", task: "сделай" },
      {
        agentKey: "orchestrator",
        chatId: TEST_CHAT,
        resolveAgent: (k) => fakeBot(k),
        handoffDeps: brokenDeps(),
        respondAsImpl: stub as never,
        delegationChain: ["orchestrator"],
        handoffBudget: budget,
      },
    );
    expect(res.ok).toBe(true);
    expect(seen).toHaveLength(1);
    // Именно тот же объект, а не копия: иначе ветки считали бы порознь.
    expect(seen[0].budget).toBe(budget);
  });

  test("легаси-вызов без счётчика в ctx по-прежнему работает", async () => {
    const seen: RespondAsOpts[] = [];
    const stub = mock(async (o: RespondAsOpts) => {
      seen.push(o);
      return "ok";
    });
    const res = await dispatchAction(
      "DELEGATE_TO_ROLE",
      { role: "backend", task: "сделай" },
      {
        agentKey: "orchestrator",
        chatId: TEST_CHAT,
        resolveAgent: (k) => fakeBot(k),
        handoffDeps: brokenDeps(),
        respondAsImpl: stub as never,
        delegationChain: ["orchestrator"],
      },
    );
    expect(res.ok).toBe(true);
    expect(seen[0].budget).toBeUndefined();
  });
});

describe("потолок хода, а не ветки", () => {
  test("двадцать делегирований подряд дают ровно HANDOFF_MAX_INVOCATIONS вызовов", async () => {
    const budget = { n: 0, max: HANDOFF_MAX_INVOCATIONS };
    for (let i = 0; i < 20; i++) {
      await dispatchAction(
        "DELEGATE_TO_ROLE",
        { role: "backend", task: `задача ${i}` },
        {
          agentKey: "orchestrator",
          chatId: TEST_CHAT,
          resolveAgent: (k) => fakeBot(k),
          // Настоящий respondAs: считает именно он, стаб бы это спрятал.
          handoffDeps: brokenDeps(),
          delegationChain: ["orchestrator"],
          handoffBudget: budget,
        },
      );
    }
    expect(budget.n).toBe(HANDOFF_MAX_INVOCATIONS);
  });

  test("исчерпанный счётчик отсекает делегата до LLM-вызова", async () => {
    const budget = { n: HANDOFF_MAX_INVOCATIONS, max: HANDOFF_MAX_INVOCATIONS };
    const outcome = await respondAs(
      {
        target: fakeBot("backend"),
        chatId: String(TEST_CHAT),
        triggerText: "x",
        triggerAgentKey: "orchestrator",
        depth: 1,
        visited: new Set(["orchestrator", "backend"]),
        budget,
      },
      brokenDeps(),
    );
    // `brokenDeps` роняет любой дошедший до модели ход, поэтому «не упало, а
    // именно пропущено» — это и есть проверка того, что отсекли ДО вызова.
    expect(outcome.status).toBe("skipped");
    if (outcome.status !== "skipped") throw new Error("ожидался skipped");
    expect(outcome.reason).toContain("бюджет");
    expect(budget.n).toBe(HANDOFF_MAX_INVOCATIONS);
  });
});

describe("вход не может забыть счётчик", () => {
  test("tool-loop заводит один общий объект на ход", async () => {
    const seen: RespondAsOpts[] = [];
    const stub = mock(async (o: RespondAsOpts) => {
      seen.push(o);
      return "ok";
    });
    await runWithTools({
      anthropic: anthropicDelegatingTwice(),
      model: "t",
      system: [{ type: "text", text: "s" }],
      messages: [{ role: "user", content: "собери фичу" }],
      agentKey: "orchestrator",
      chatId: TEST_CHAT,
      resolveAgent: (k) => fakeBot(k),
      handoffDeps: brokenDeps(),
      respondAsImpl: stub as never,
      delegationChain: ["orchestrator"],
      // handoffBudget НЕ передаём — так входит userbot, Mini App, планировщик.
    });
    expect(seen).toHaveLength(2);
    expect(seen[0].budget).toBeDefined();
    expect(seen[0].budget?.max).toBe(HANDOFF_MAX_INVOCATIONS);
    // Одна ссылка на оба делегирования — иначе потолок снова стал бы веточным.
    expect(seen[1].budget).toBe(seen[0].budget!);
  });

  test("на SDK-пути счётчик заводится ДО раннего возврата", () => {
    // Аудит 2026-08-13. Тест выше проходит по raw-пути: он подсовывает фейковый
    // anthropic-клиент. А дефолт `opts.handoffBudget ?? {...}` стоял НИЖЕ ветки
    // `if (useAgentSdk()) return await runViaAgentSdk(opts)`, то есть на проде
    // (USE_AGENT_SDK=true) не выполнялся вовсе. undefined уезжал в handoff.ts,
    // где такой же `??` — и каждый DELEGATE_TO_ROLE заводил свой счётчик с
    // полным запасом: до SDK_MAX_CALLS_PER_TOOL (8) независимых поддеревьев по
    // HANDOFF_MAX_INVOCATIONS вызовов вместо одного общего потолка.
    //
    // Проверка структурная, а не поведенческая, осознанно: runViaAgentSdk
    // спавнит настоящий CLI, подменять его через mock.module в общем процессе
    // bun test — значит протечь мок в соседние файлы. Порядок двух строк
    // проверить дешевле, чем городить гарнитуру ради него.
    const src = readFileSync(
      new URL("../lib/tool-loop.ts", import.meta.url),
      "utf8",
    );
    const fn = src.indexOf("export async function runWithTools");
    const dflt = src.indexOf("opts.handoffBudget ??", fn);
    const sdkBranch = src.indexOf("if (useAgentSdk())", fn);
    expect(dflt).toBeGreaterThan(-1);
    expect(sdkBranch).toBeGreaterThan(dflt);
    // И сам счётчик должен доехать до SDK-прогона, а не потеряться по дороге.
    const call = src.slice(sdkBranch, src.indexOf("} catch (e) {", sdkBranch));
    expect(call).toMatch(/runViaAgentSdk\(\{ \.\.\.opts, handoffBudget \}\)/);
  });
});
