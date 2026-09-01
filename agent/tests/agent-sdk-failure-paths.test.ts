/**
 * SDK-путь: что происходит, когда прогон НЕ удался (аудит 2026-08-03).
 *
 * На проде USE_AGENT_SDK=true, то есть это основной inference-путь, а его
 * ветки отказа до сих пор были не покрыты вовсе. Три разных бага в одной
 * точке:
 *
 *  1. `result = m.result ?? ""` — при subtype error_max_turns у result-сообщения
 *     поля `result` нет, агент возвращал пустую строку, оркестратор делал
 *     `if (!reply) return` и бот в чате просто МОЛЧАЛ.
 *  2. Откат на raw-путь в tool-loop был безусловным. Ход переигрывается
 *     целиком — значит любой сбой ПОСЛЕ успешного SEND_MESSAGE давал дубль
 *     в чате (и второй раз создавал задачу / выкладывал пост).
 *  3. checkBudget звался только из callAnthropic, то есть на raw-пути. При
 *     USE_AGENT_SDK=true дневной лимит токенов не действовал вообще:
 *     recordUsage расход писал, но перед вызовом его никто не читал.
 */
import { describe, test, expect, afterEach } from "bun:test";
import {
  AgentSdkRunError,
  shouldFallbackToRaw,
  assistantText,
  runTextViaAgentSdk,
} from "../lib/agent-sdk-runtime.ts";
import {
  BudgetExceededError,
  checkBudget,
  recordUsage,
  todayUTC,
} from "../lib/token-budget.ts";
import { db } from "../lib/db.ts";

const AGENT = "_test_sdk_budget";
const ENV_KEY = `TOKEN_BUDGET_${AGENT.toUpperCase()}`;
const ENV_BEFORE = process.env[ENV_KEY];

afterEach(() => {
  db.prepare(`DELETE FROM agent_token_usage WHERE agent_key = ?`).run(AGENT);
  // Восстанавливаем, а не удаляем: удаление протекало бы в другие тесты, если
  // переменная была задана снаружи.
  if (ENV_BEFORE === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = ENV_BEFORE;
});

describe("assistantText — запасной текст, когда result пуст", () => {
  test("склеивает text-блоки и игнорирует tool_use", () => {
    const m = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "первая часть" },
          { type: "tool_use", name: "SEND_MESSAGE", input: {} },
          { type: "text", text: "вторая часть" },
        ],
      },
    };
    expect(assistantText(m)).toBe("первая часть\nвторая часть");
  });

  test("сообщение без content не роняет разбор", () => {
    expect(assistantText({ type: "assistant" })).toBe("");
    expect(assistantText(null)).toBe("");
    expect(assistantText({ message: { content: "строка" } })).toBe("");
  });
});

describe("откат на raw-путь", () => {
  test("побочные эффекты уже случились → НЕ откатываемся", () => {
    const e = new AgentSdkRunError("max turns", {
      sideEffects: true,
      partialText: "успел написать вот это",
      subtype: "error_max_turns",
    });
    expect(shouldFallbackToRaw(e)).toBe(false);
    expect(e.partialText).toBe("успел написать вот это");
    expect(e.subtype).toBe("error_max_turns");
  });

  test("ни один инструмент не выполнялся → откат безопасен", () => {
    const e = new AgentSdkRunError("CLI exited with code 1", {
      sideEffects: false,
      partialText: "",
    });
    expect(shouldFallbackToRaw(e)).toBe(true);
  });

  test("subscription-only режим не переигрывает ход через raw API", () => {
    expect(shouldFallbackToRaw(new Error("CLI exited with code 1"), false)).toBe(false);
  });

  test("исчерпанный бюджет → откат бессмыслен (та же проверка на raw-пути)", () => {
    expect(shouldFallbackToRaw(new BudgetExceededError(AGENT, 10, 5))).toBe(
      false,
    );
  });

  test("посторонняя ошибка → откат разрешён (прежнее поведение)", () => {
    expect(shouldFallbackToRaw(new Error("ECONNRESET"))).toBe(true);
    expect(shouldFallbackToRaw("не-ошибка")).toBe(true);
  });
});

describe("дневной бюджет действует и на подписочном пути", () => {
  test("перебор лимита → BudgetExceededError ДО спавна CLI", async () => {
    process.env[ENV_KEY] = "100";
    recordUsage(AGENT, 500, 0, todayUTC());
    // Проверка бюджета стоит первой строкой, до query(): CLI не спавнится,
    // поэтому тест не зависит ни от CLAUDE_BIN, ни от сети.
    await expect(
      runTextViaAgentSdk({ system: "s", prompt: "p", agentKey: AGENT }),
    ).rejects.toThrow(BudgetExceededError);
  });

  test("в пределах лимита проверка пропускает", () => {
    process.env[ENV_KEY] = "1000";
    recordUsage(AGENT, 10, 0, todayUTC());
    expect(() => checkBudget(AGENT)).not.toThrow();
  });
});
