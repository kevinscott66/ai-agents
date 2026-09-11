/**
 * Аудит 2026-08-21: отказ по бюджету стирал уже сделанную работу.
 *
 * `runViaAgentSdk` проверяет дневной потолок не только на входе. Ветка
 * `overspent` (agent-sdk-runtime.ts) срабатывает ПОСЛЕ хода — когда SDK уже
 * отработал, инструменты выполнены, сообщение отправлено, задача создана, пост
 * выложен. Всё это уже случилось в реальном мире и откату не подлежит: именно
 * поэтому `shouldFallbackToRaw` по этой ошибке отказывается переигрывать ход.
 *
 * Соседняя ветка того же места — `AgentSdkRunError` — ровно для этого носит
 * `sideEffects` и `partialText`, и `tool-loop.ts` отдаёт по ней накопленный
 * текст. `BudgetExceededError` бросалась голой, с одними цифрами.
 *
 * Дальше по цепочке `replyForTurnError` (orchestrator/message-handler.ts —
 * единственный путь, которым сбой хода вообще доезжает до чата) отвечала одной
 * строкой на все случаи: «вернусь после сброса». На ход, который успел
 * отправить сообщение и создать задачу, это читается как «я ничего не сделал»,
 * и человек идёт повторять уже сделанное. Текст, который агент написал до
 * обрыва, выбрасывался целиком.
 *
 * Здесь проверяется и носитель (поля на ошибке), и потребитель (что видно в
 * чате). Живой SDK не нужен: обе половины чистые.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BudgetExceededError } from "../lib/token-budget.ts";
import { shouldFallbackToRaw } from "../lib/agent-sdk-runtime.ts";
import { replyForTurnError } from "../orchestrator/message-handler.ts";

const RUNTIME = readFileSync(
  join(import.meta.dir, "..", "lib", "agent-sdk-runtime.ts"),
  "utf8",
);

describe("BudgetExceededError несёт контекст", () => {
  test("без опций — пусто, а не undefined", () => {
    // checkBudget бросает ДО хода: сообщать нечего, и трёхаргументный вызов
    // обязан остаться валидным.
    const e = new BudgetExceededError("smm", 500, 100);
    expect(e.sideEffects).toBe(false);
    expect(e.partialText).toBe("");
  });

  test("с опциями — оба поля на месте", () => {
    const e = new BudgetExceededError("smm", 500, 100, {
      sideEffects: true,
      partialText: "Задачу создал",
    });
    expect(e.sideEffects).toBe(true);
    expect(e.partialText).toBe("Задачу создал");
  });

  test("мусор в опциях не протекает в поля", () => {
    const e = new BudgetExceededError("smm", 500, 100, {
      sideEffects: "yes" as any,
      partialText: 42 as any,
    });
    expect(e.sideEffects).toBe(false);
    expect(e.partialText).toBe("");
  });

  test("сообщение и цифры прежние", () => {
    const e = new BudgetExceededError("smm", 500, 100, { sideEffects: true });
    expect(e.name).toBe("BudgetExceededError");
    expect(e.agentKey).toBe("smm");
    expect(e.used).toBe(500);
    expect(e.budget).toBe(100);
    expect(e.message).toContain("used=500 budget=100");
  });

  test("откат на raw-путь по-прежнему запрещён — в обеих формах", () => {
    // Побочные эффекты тут ни при чём: raw-путь упрётся в ту же проверку.
    expect(shouldFallbackToRaw(new BudgetExceededError("smm", 5, 1))).toBe(false);
    expect(
      shouldFallbackToRaw(
        new BudgetExceededError("smm", 5, 1, { sideEffects: true }),
      ),
    ).toBe(false);
  });
});

describe("ветка overspent заполняет поля", () => {
  test("бросок несёт stats.executed и накопленный текст", () => {
    const i = RUNTIME.indexOf("throw new BudgetExceededError(");
    expect(i).toBeGreaterThan(0);
    const block = RUNTIME.slice(i, i + 700);
    expect(block).toContain("sideEffects: stats.executed > 0");
    expect(block).toContain("partialText: result || lastAssistant");
  });

  test("та же пара полей, что и у соседней AgentSdkRunError", () => {
    // Две ветки одного места расходились именно этим.
    const j = RUNTIME.indexOf("throw new AgentSdkRunError(");
    expect(j).toBeGreaterThan(0);
    const block = RUNTIME.slice(j, j + 400);
    expect(block).toContain("sideEffects: stats.executed > 0");
    expect(block).toContain("partialText: result || lastAssistant");
  });
});

describe("replyForTurnError: что человек видит в чате", () => {
  test("ход ничего не успел — формулировка прежняя", () => {
    const out = replyForTurnError(new BudgetExceededError("smm", 500, 100));
    expect(out).toContain("Дневной лимит токенов у этой роли исчерпан");
    expect(out).toContain("00:00 UTC");
    expect(out).not.toContain("Часть действий");
  });

  test("действия выполнены — говорим об этом и просим не повторять", () => {
    const out = replyForTurnError(
      new BudgetExceededError("smm", 500, 100, { sideEffects: true }),
    );
    expect(out).toContain("Часть действий уже выполнена");
    expect(out).toContain("повторять их не стал");
    expect(out).toContain("00:00 UTC");
  });

  test("текст агента доезжает до чата, а не выбрасывается", () => {
    const out = replyForTurnError(
      new BudgetExceededError("smm", 500, 100, {
        sideEffects: true,
        partialText: "Создал задачу T-900 и написал в #general.",
      }),
    );
    expect(out).toContain("Создал задачу T-900 и написал в #general.");
    expect(out).toContain("Часть действий уже выполнена");
    // Сначала работа, потом объяснение обрыва.
    expect(out.indexOf("T-900")).toBeLessThan(out.indexOf("Дневной лимит"));
  });

  test("текст есть, действий не было — другая формулировка", () => {
    const out = replyForTurnError(
      new BudgetExceededError("smm", 500, 100, { partialText: "Начал разбирать" }),
    );
    expect(out).toContain("Начал разбирать");
    expect(out).toContain("дописать не успел");
    expect(out).not.toContain("Часть действий");
  });

  test("длинный текст обрезан и не топит объяснение", () => {
    const out = replyForTurnError(
      new BudgetExceededError("smm", 500, 100, {
        sideEffects: true,
        partialText: "щ".repeat(5000),
      }),
    );
    expect(out).toContain("Часть действий уже выполнена");
    expect(out.length).toBeLessThan(1000);
    expect(out).toContain("…");
  });

  test("короткий текст не помечается как обрезанный", () => {
    const out = replyForTurnError(
      new BudgetExceededError("smm", 500, 100, { partialText: "Готово" }),
    );
    expect(out).not.toContain("Готово…");
  });

  test("прочие ошибки не задеты", () => {
    expect(replyForTurnError(new Error("429 rate_limit_error"))).toMatch(
      /перегружена/i,
    );
    expect(replyForTurnError(new Error("boom"))).toMatch(/внутренняя ошибка/i);
  });
});
