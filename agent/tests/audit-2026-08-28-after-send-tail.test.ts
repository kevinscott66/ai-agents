/**
 * Аудит 2026-08-28: сбой ПОСЛЕ отправки подавался как «не смог обработать».
 *
 * Ответ отправлен, человек его прочитал — а дальше в том же `try` шла
 * бухгалтерия: запись в `messages`, компактор, каскад по упоминаниям. Любой
 * бросок оттуда уводил выполнение во внешний `catch`, и следом за полным
 * ответом в чат прилетало «Не смог обработать сообщение: внутренняя ошибка…
 * Повтори запрос».
 *
 * Причина не гипотетическая: `recordMessage` и `getDiscussionMode` — это
 * записи и чтения SQLite, а второй процесс на той же базе назван штатным
 * риском в memory.ts (SQLITE_BUSY). `chat-settings.ts` читает БД вообще без
 * `try`, в отличие от `permissions.ts`.
 *
 * Повторять тут нечего — работа сделана, повтор её продублирует (ещё один ход
 * модели и второй экземпляр ответа в чате). Но и молчать нельзя: записи
 * ответа в `messages` не будет, и следующий ход переделает работу. Значит —
 * в лог.
 */
import { describe, expect, test, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { afterSend } from "../orchestrator/message-handler.ts";
import { log } from "../lib/log.ts";

async function warns(fn: () => void | Promise<void>): Promise<unknown[][]> {
  const calls: unknown[][] = [];
  const spy = spyOn(log, "warn").mockImplementation((...a: unknown[]) => {
    calls.push(a);
  });
  try {
    await afterSend("pm", fn);
  } finally {
    spy.mockRestore();
  }
  return calls;
}

describe("afterSend", () => {
  test("синхронный бросок наружу не выходит", async () => {
    const calls = await warns(() => {
      throw new Error("SQLITE_BUSY: database is locked");
    });
    expect(calls.length).toBe(1);
  });

  test("отказ промиса наружу не выходит", async () => {
    const calls = await warns(async () => {
      await Promise.reject(new Error("SQLITE_FULL"));
    });
    expect(calls.length).toBe(1);
  });

  test("не-Error тоже не роняет", async () => {
    for (const thrown of ["строка", null, undefined, { code: 5 }]) {
      const calls = await warns(() => {
        throw thrown;
      });
      expect(calls.length).toBe(1);
    }
  });

  test("в лог попадают роль и причина", async () => {
    const calls = await warns(() => {
      throw new Error("SQLITE_BUSY: database is locked");
    });
    expect(String(calls[0]?.[0])).toContain("pm");
    expect(JSON.stringify(calls[0]?.[1])).toContain("SQLITE_BUSY");
  });

  test("успешный ход ничего не пишет и дожидается работы", async () => {
    let done = false;
    const calls = await warns(async () => {
      await new Promise((r) => setTimeout(r, 5));
      done = true;
    });
    expect(done).toBe(true);
    expect(calls).toEqual([]);
  });

  test("это log.warn, а не log.error: ход состоялся", async () => {
    const errs: unknown[][] = [];
    const spy = spyOn(log, "error").mockImplementation((...a: unknown[]) => {
      errs.push(a);
    });
    try {
      await warns(() => {
        throw new Error("boom");
      });
    } finally {
      spy.mockRestore();
    }
    expect(errs).toEqual([]);
  });
});

describe("применение", () => {
  const SRC = readFileSync(
    new URL("../orchestrator/message-handler.ts", import.meta.url),
    "utf8",
  );

  test("бухгалтерия после отправки завёрнута в afterSend", () => {
    expect(SRC).toContain("await afterSend(def.key, async () => {");
  });

  test("под обёрткой лежат именно записи и каскад, а не что-то одно", () => {
    const from = SRC.indexOf("await afterSend(def.key, async () => {");
    const to = SRC.indexOf("} catch (err) {", from);
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const region = SRC.slice(from, to);
    for (const needle of ["recordMessage({", "runCompactor(", "getDiscussionMode(", "findHandoffTargets("]) {
      expect(region).toContain(needle);
    }
    // Отправка осталась СНАРУЖИ: её сбой по-прежнему обязан дойти до человека.
    expect(region).not.toContain("sendChunked(");
  });

  test("обёртка не отвечает в чат — там уже лежит ответ", () => {
    const from = SRC.indexOf("export async function afterSend(");
    const to = SRC.indexOf("export function replyForTurnError", from);
    expect(from).toBeGreaterThan(0);
    const body = SRC.slice(from, to);
    expect(body).not.toContain("ctx.reply");
    expect(body).not.toContain("replyForTurnError");
  });
});
