/**
 * Дневной бюджет ограничивает ход, а не только вход в него (аудит 2026-08-04).
 *
 * checkBudget звался один раз — до спавна CLI. Но один ход SDK это до maxTurns
 * (14) вызовов модели, а расход писался единственным recordSdkUsage в самом
 * конце. Значит агент с лимитом 100k мог за ОДИН ход потратить сколько угодно:
 * проверка на входе видела нулевой расход, а сработал бы лимит только на
 * следующем триггере. На raw-пути проверка идёт на каждый вызов
 * (anthropic-client), и это ровно та разница, которой быть не должно.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { db } from "../lib/db.ts";
import {
  budgetRemaining,
  recordUsage,
  getBudget,
  todayUTC,
} from "../lib/token-budget.ts";
import { sdkUsageTokens } from "../lib/agent-sdk-runtime.ts";

const AGENT = "_test_midturn";
const ENV_KEY = `TOKEN_BUDGET_${AGENT.toUpperCase()}`;
const ENV_BEFORE = process.env[ENV_KEY];

afterEach(() => {
  db.prepare(`DELETE FROM agent_token_usage WHERE agent_key = ?`).run(AGENT);
  // Восстанавливаем, а не удаляем: удаление протекло бы в другие тесты, если
  // переменная задана снаружи.
  if (ENV_BEFORE === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = ENV_BEFORE;
});

describe("budgetRemaining", () => {
  test("без лимита — Infinity", () => {
    delete process.env[ENV_KEY];
    const before = process.env.TOKEN_BUDGET_DEFAULT;
    delete process.env.TOKEN_BUDGET_DEFAULT;
    try {
      expect(budgetRemaining(AGENT)).toBe(Infinity);
    } finally {
      if (before !== undefined) process.env.TOKEN_BUDGET_DEFAULT = before;
    }
  });

  test("с лимитом — остаток за вычетом расхода", () => {
    process.env[ENV_KEY] = "1000";
    expect(getBudget(AGENT)).toBe(1000);
    recordUsage(AGENT, 300, 10, todayUTC());
    expect(budgetRemaining(AGENT)).toBe(700);
  });

  test("перерасход — ноль, не отрицательное", () => {
    // Иначе сравнение «потрачено >= остатка» в ходе сработало бы наоборот.
    process.env[ENV_KEY] = "100";
    recordUsage(AGENT, 500, 0, todayUTC());
    expect(budgetRemaining(AGENT)).toBe(0);
  });

  test("без agentKey — Infinity", () => {
    expect(budgetRemaining(undefined)).toBe(Infinity);
    expect(budgetRemaining("")).toBe(Infinity);
  });
});

describe("sdkUsageTokens", () => {
  test("кэш-чтение и кэш-запись идут в input", () => {
    // Так же считает recordSdkUsage: расход на кэш — реальные оплаченные
    // токены, и не учитывать их значит занижать бюджет.
    expect(
      sdkUsageTokens({
        input_tokens: 10,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 5,
        output_tokens: 7,
      }),
    ).toEqual({ input: 115, output: 7 });
  });

  test("пустой usage не роняет счёт", () => {
    expect(sdkUsageTokens(undefined)).toEqual({ input: 0, output: 0 });
    expect(sdkUsageTokens({})).toEqual({ input: 0, output: 0 });
  });
});

describe("прогон обрывается по бюджету", () => {
  // Живой прогон требует CLI, поэтому проверяем структуру: где именно стоит
  // счётчик и что происходит после обрыва.
  const SRC = readFileSync(
    new URL("../lib/agent-sdk-runtime.ts", import.meta.url),
    "utf8",
  );

  test("счёт идёт на каждом assistant-сообщении, а не один раз в конце", () => {
    // Якорь — именно runViaAgentSdk: у runTextViaAgentSdk выше по файлу такая
    // же ветка, и без якоря тест проверял бы не ту функцию.
    const fn = SRC.indexOf("export async function runViaAgentSdk");
    const branch = SRC.slice(
      SRC.indexOf('if (type === "assistant")', fn),
      SRC.indexOf('} else if (type === "result")', fn),
    );
    expect(branch).toMatch(/spentInput \+= /);
    // Расход пишется прямо здесь. Раньше он копился в переменной и уезжал в
    // БД одним recordSdkUsage в самом конце — соседний ход его не видел.
    expect(branch).toMatch(/spend\(spentInput, spentOutput\)/);
    // И остаток перечитывается, а не сравнивается с замороженным снимком.
    expect(branch).toMatch(/budgetRemaining\(opts\.agentKey\) <= 0/);
    expect(branch).toMatch(/\bbreak;/);
  });

  test("выход по исключению тоже дописывает расход", () => {
    // Аудит 2026-08-12: из цикла есть три выхода — result, обрыв по бюджету и
    // исключение, — и последний не записывал ничего. На проде это значит: SDK
    // сделал 4 хода по ~40k input, затем CLI умер (OOM, обрыв сокета) — 160k
    // токенов оплачены, в agent_token_usage ноль, и следующий триггер снова
    // проходит checkBudget. Для падающего агента лимит не ограничивал ничего.
    const cat = SRC.slice(
      SRC.indexOf("} catch (e) {", SRC.indexOf('const promptInput: any')),
      SRC.indexOf("if (overspent) {"),
    );
    expect(cat).toMatch(/spend\(spentInput, spentOutput\)/);
  });

  test("вспомогательный текстовый вызов тоже пишет расход при падении", () => {
    // runTextViaAgentSdk (компактор, self-diag) писал расход ТОЛЬКО на
    // result-сообщении успешного прогона — try/catch там не было вовсе.
    // Больнее всего по self-diag: он зовёт эту функцию с agentKey живой роли
    // aieng (lib/self-diag.ts), то есть падающая самодиагностика жгла бюджет
    // роли без всякого учёта, а цикл отказов шёл молча.
    const fn = SRC.indexOf("export async function runTextViaAgentSdk");
    const end = SRC.indexOf("export async function runViaAgentSdk");
    const body = SRC.slice(fn, end);
    expect(body).toMatch(/\} catch \(e\) \{\s*spend\(spentInput, spentOutput\);/);
    expect(body).toMatch(/if \(type === "assistant"\)/);
  });

  test("бросается именно BudgetExceededError", () => {
    // От типа зависит откат: по BudgetExceededError tool-loop на raw-путь НЕ
    // откатывается, иначе тот же ход переигрался бы за счёт API-кредитов и
    // повторил уже выполненные действия.
    // Границы — сама ветка, а не окно в N символов: комментарий внутри неё
    // растёт, и окно на 800 символов уже переставало доставать до throw.
    const from = SRC.indexOf("if (overspent) {");
    const block = SRC.slice(from, SRC.indexOf('if (subtype && subtype !== "success")', from));
    expect(block).toMatch(/throw new BudgetExceededError/);
  });
});
