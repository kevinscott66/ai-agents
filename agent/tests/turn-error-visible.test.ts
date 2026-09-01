/**
 * Сбой хода перестаёт быть молчанием (аудит 2026-08-04).
 *
 * `catch (err) { log.error(...) }` в message-handler глотал ВСЁ: исчерпанный
 * дневной бюджет, 429 после пяти ретраев, 400 от API. Пользователь видел не
 * ошибку, а бота, который просто не ответил — и повторял вопрос, запуская тот
 * же сбой заново. Лог при этом читает только владелец VPS.
 *
 * Текст самой ошибки в чат НЕ уходит: в нём бывают URL с токенами и куски
 * запроса. Пользователю нужно другое — ждать, повторять или звать человека.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { replyForTurnError } from "../orchestrator/message-handler.ts";
import { BudgetExceededError } from "../lib/token-budget.ts";

describe("replyForTurnError", () => {
  test("бюджет — говорит, что ждать до сброса", () => {
    const out = replyForTurnError(new BudgetExceededError("smm", 500, 100));
    expect(out).toMatch(/лимит/i);
    expect(out).toMatch(/UTC/);
  });

  test("429 — говорит, что повторить", () => {
    expect(replyForTurnError(new Error("429 rate_limit_error"))).toMatch(
      /повтори/i,
    );
    expect(replyForTurnError(new Error("overloaded_error"))).toMatch(/повтори/i);
  });

  test("прочее — честная внутренняя ошибка", () => {
    const out = replyForTurnError(new Error("boom"));
    expect(out).toMatch(/внутренняя ошибка/i);
  });

  test("текст ошибки в чат не пересказывается", () => {
    // Самое важное свойство: в message ошибки Anthropic попадает URL запроса, а
    // в ошибках Telegram — токен бота в составе api-URL.
    const leaky = new Error(
      "connect ECONNREFUSED https://api.telegram.org/bot123456:AAH-SECRET/sendMessage",
    );
    const out = replyForTurnError(leaky);
    expect(out).not.toMatch(/SECRET/);
    expect(out).not.toMatch(/telegram\.org/);
    expect(out).not.toMatch(/123456/);
  });

  test("не бросает на не-Error", () => {
    expect(typeof replyForTurnError("строка")).toBe("string");
    expect(typeof replyForTurnError(null)).toBe("string");
    expect(typeof replyForTurnError(undefined)).toBe("string");
  });
});

describe("обработчик действительно отвечает на сбой", () => {
  const SRC = readFileSync(
    new URL("../orchestrator/message-handler.ts", import.meta.url),
    "utf8",
  );

  test("catch хода вызывает ctx.reply, а не только log", () => {
    const cat = SRC.slice(SRC.lastIndexOf("} catch (err) {"));
    expect(cat).toMatch(/replyForTurnError\(err\)/);
    expect(cat).toMatch(/ctx\.reply\(/);
  });

  test("ответ привязан к исходному сообщению", () => {
    // В группе с 12 ботами безадресная строка «ошибка» непонятно к чему.
    const cat = SRC.slice(SRC.lastIndexOf("} catch (err) {"));
    expect(cat).toMatch(/reply_parameters/);
  });

  test("сбой самого ответа не роняет обработчик", () => {
    // Причиной могла быть недоступность Telegram — тогда и извиниться не выйдет.
    const cat = SRC.slice(SRC.lastIndexOf("} catch (err) {"));
    expect(cat).toMatch(/catch \(e\)/);
  });
});
