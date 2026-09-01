/**
 * Аудит 2026-08-28: упавший тик таймера логировался без стека.
 *
 * Докблок `lib/safe-timer.ts` написан ровно против строки «без модуля и без
 * стека», но сам оставлял в логе только `getErrorMessage(e)`. Имя таймера
 * говорит, ЧТО сломалось, и молчит о том, ГДЕ: под всеми шестью рабочими
 * тиками (db-maint.gc/daily/alerting/storm, watchdog, mac-bridge.ping) лежит
 * длинная цепочка, а `database is locked` одинаково для десятка запросов
 * внутри неё.
 *
 * Стек чистим тем же скраббером, что и сообщение: в кадрах бывают URL, а
 * telegraf ходит по `https://api.telegram.org/bot<ТОКЕН>/…`.
 */
import { describe, expect, test, spyOn, afterEach } from "bun:test";
import { log } from "../lib/log.ts";
import { safeTick } from "../lib/safe-timer.ts";

type Entry = { msg: string; data: Record<string, unknown> };

let spy: ReturnType<typeof spyOn> | null = null;

afterEach(() => {
  spy?.mockRestore();
  spy = null;
});

function capture(): Entry[] {
  const out: Entry[] = [];
  spy = spyOn(log, "error").mockImplementation((msg: string, data?: unknown) => {
    out.push({ msg, data: (data ?? {}) as Record<string, unknown> });
  });
  return out;
}

function deep(): never {
  throw new Error("database is locked");
}

describe("стек упавшего тика", () => {
  test("синхронный сбой пишет стек с кадром места падения", () => {
    const out = capture();
    safeTick("db-maint.gc", () => deep())();
    expect(out.length).toBe(1);
    expect(out[0].data.timer).toBe("db-maint.gc");
    expect(out[0].data.error).toBe("database is locked");
    expect(String(out[0].data.stack)).toContain("deep");
  });

  test("reject промиса пишет стек тем же путём", async () => {
    const out = capture();
    safeTick("watchdog", async () => deep())();
    await new Promise((r) => setTimeout(r, 5));
    expect(out.length).toBe(1);
    expect(String(out[0].data.stack)).toContain("deep");
  });

  test("брошено не-Error — поле стека отсутствует, а не 'undefined' строкой", () => {
    const out = capture();
    safeTick("t", () => {
      throw "строка";
    })();
    expect(out[0].data.error).toBe("строка");
    expect(out[0].data.stack).toBeUndefined();
  });

  test("Error без стека не ломает лог", () => {
    const out = capture();
    const e = new Error("нет стека");
    // Воспроизводим объект, пришедший из чужого рантайма: `Error.stack`
    // необязателен по спецификации, и в bun он объявлен как string | undefined.
    e.stack = undefined;
    safeTick("t", () => {
      throw e;
    })();
    expect(out[0].data.error).toBe("нет стека");
    expect(out[0].data.stack).toBeUndefined();
  });

  test("токен бота из кадра стека в лог не попадает", () => {
    const out = capture();
    const e = new Error("request failed");
    e.stack = "Error: request failed\n    at f (https://api.telegram.org/bot123456:AAHfake_token_value_padded_to_thirty_plus/sendMessage:1:1)";
    safeTick("t", () => {
      throw e;
    })();
    expect(String(out[0].data.stack)).not.toContain("AAHfake_token_value_padded_to_thirty_plus");
  });

  test("стек обрезан по потолку", () => {
    const out = capture();
    const e = new Error("длинный");
    e.stack = `Error: длинный\n${"    at frame (a.ts:1:1)\n".repeat(200)}`;
    expect(e.stack.length).toBeGreaterThan(1000);
    safeTick("t", () => {
      throw e;
    })();
    expect(String(out[0].data.stack).length).toBe(1000);
  });
});

describe("прежнее поведение не задето", () => {
  test("успешный тик ничего не логирует", () => {
    const out = capture();
    let ran = 0;
    safeTick("t", () => {
      ran += 1;
    })();
    expect(ran).toBe(1);
    expect(out).toEqual([]);
  });

  test("исключение наружу не выходит", () => {
    capture();
    expect(() => safeTick("t", () => deep())()).not.toThrow();
  });
});
