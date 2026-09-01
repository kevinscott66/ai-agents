/**
 * Аудит 2026-08-13: ретраев было два слоя, и они перемножались.
 *
 * `new Anthropic({ apiKey })` — это `maxRetries: 2`, то есть три HTTP-запроса
 * на каждый наш `messages.create`. Сверху цикл `callAnthropic` с шестью
 * попытками: до 18 запросов на один логический вызов. Хуже, чем просто «дорого»:
 *
 *  - на 429 SDK ретраит через ~0.5 с, между нашими вежливыми паузами по
 *    `retry-after` — то есть усиливает ровно тот лимит, который мы обходим;
 *  - `MAX_RETRY_AFTER_MS` (потолок минута) существовал только в комментарии:
 *    SDK внутри нашей же попытки спит по заголовку без потолка, держа слот
 *    конкурентности;
 *  - `attempt 1/5` в логе на деле был третьим запросом.
 *
 * Теперь ретраит один слой — наш. Второй половиной фикса цикл забирает себе то,
 * что раньше покрывал SDK: обрывы соединения, таймауты, 408, 409. Бюджет у них
 * отдельный и маленький (2 ретрая = 3 запроса), чтобы упавшая сеть не держала
 * слот минуту.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
} from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import {
  callAnthropic,
  createAnthropic,
  getAnthropic,
  isTransientFailure,
  __setAnthropicClientForTests,
  __setSleepForTests,
} from "../lib/anthropic-client.ts";

function src(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

/**
 * Строки с `new Anthropic(` в коде файла. Комментарии отбрасываем: они этот же
 * вызов и цитируют, а искать нужно живые конструкции.
 */
function ctors(rel: string): string[] {
  return src(rel)
    .split("\n")
    .filter((l) => !/^\s*(\*|\/\/)/.test(l) && l.includes("new Anthropic("));
}

class HttpError extends Error {
  constructor(
    public status: number,
    public headers: Record<string, string> = {},
  ) {
    super(`http ${status}`);
  }
}

const params = {
  model: "t",
  max_tokens: 16,
  messages: [{ role: "user" as const, content: "hi" }],
} as Anthropic.MessageCreateParamsNonStreaming;

const OK = {
  id: "m",
  type: "message",
  role: "assistant",
  model: "t",
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
  content: [{ type: "text", text: "ok" }],
} as unknown as Anthropic.Message;

/** Клиент, который бросает по списку, а дальше отвечает успехом. */
function throwsInOrder(errs: Array<() => Error>) {
  let calls = 0;
  return {
    client: {
      messages: {
        create: async () => {
          const mk = errs[calls++];
          if (mk) throw mk();
          return OK;
        },
      },
    } as unknown as Anthropic,
    calls: () => calls,
  };
}

const conn = () => new APIConnectionError({ message: "socket hung up" });

/**
 * Паузы между попытками записываем вместо того, чтобы их спать.
 *
 * Аудит 2026-08-20: файл ждал настоящие 500 → 1000 → 2000 мс. В одиночку он
 * проходил, а в полном прогоне на нагруженной машине упирался в таймаут теста
 * и краснел — `bun test` перед push давал разный ответ на одном и том же коде.
 * Заодно расписание бэкоффа из молчаливой задержки стало проверяемым.
 */
let slept: number[] = [];

beforeEach(() => {
  slept = [];
  __setSleepForTests(async (ms) => void slept.push(ms));
});

afterEach(() => {
  __setAnthropicClientForTests(null);
  __setSleepForTests(null);
});

describe("ретраит ровно один слой", () => {
  test("фабрика выключает ретраи SDK", () => {
    expect(createAnthropic("sk-test").maxRetries).toBe(0);
  });

  test("умолчание SDK — действительно 2, множитель был не гипотетический", () => {
    // Пин на поведение библиотеки: если апгрейд сменит умолчание, фикс
    // останется верным, но обоснование в комментариях протухнет молча.
    expect(new Anthropic({ apiKey: "sk-test" }).maxRetries).toBe(2);
  });

  test("getAnthropic строит клиента через фабрику", () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-test";
    try {
      __setAnthropicClientForTests(null);
      expect(getAnthropic().maxRetries).toBe(0);
    } finally {
      // CLAUDE.md §3.8 п.7: env восстанавливаем всегда.
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
      __setAnthropicClientForTests(null);
    }
  });

  test("прямых `new Anthropic(` вне фабрики не осталось", () => {
    // Прод-путь (tool-loop) получает клиента из orchestrator-team, а не из
    // getAnthropic: почини только singleton — и множитель уцелеет там, где он
    // как раз и жжёт токены.
    expect(ctors("../orchestrator-team.ts")).toEqual([]);
    expect(ctors("../tools/test-handoff.ts")).toEqual([]);
    // В самом модуле конструктор ровно один — и он по-прежнему с
    // maxRetries: 0. Однострочным он был до аудита 2026-08-28, добавившего
    // явный timeout (см. audit-2026-08-28-anthropic-request-timeout).
    expect(ctors("../lib/anthropic-client.ts")).toEqual([
      "  return new Anthropic({",
    ]);
    expect(src("../lib/anthropic-client.ts")).toContain("    maxRetries: 0,");
  });
});

describe("обрывы связи ретраит теперь сам цикл", () => {
  test("переживает обрыв и возвращает ответ", async () => {
    const f = throwsInOrder([conn, conn]);
    const resp = await callAnthropic(params, f.client);
    expect(resp.content[0]).toMatchObject({ text: "ok" });
    expect(f.calls()).toBe(3);
    // Бэкофф удваивается, а не долбит с одинаковым интервалом. Джиттер держим
    // в пределах паузы, поэтому сравниваем с допуском.
    expect(slept.length).toBe(2);
    expect(slept[0]!).toBeGreaterThanOrEqual(500);
    expect(slept[1]!).toBeGreaterThanOrEqual(1000);
    expect(slept[1]!).toBeGreaterThan(slept[0]!);
  });

  test("бюджет — ровно два ретрая, дальше ошибка наверх", async () => {
    // Столько же запросов, сколько делал SDK до этого коммита. Больше нельзя:
    // на упавшей сети мы держим слот конкурентности, а их всего три.
    const f = throwsInOrder([conn, conn, conn, conn]);
    await expect(callAnthropic(params, f.client)).rejects.toThrow(/socket hung up/);
    expect(f.calls()).toBe(3);
  });

  test("таймаут соединения — тот же случай", async () => {
    const f = throwsInOrder([
      () => new APIConnectionTimeoutError({ message: "timed out" }),
    ]);
    await callAnthropic(params, f.client);
    expect(f.calls()).toBe(2);
  });

  test("408 и 409 — из того же списка, что ретраил SDK", async () => {
    const a = throwsInOrder([() => new HttpError(408)]);
    await callAnthropic(params, a.client);
    expect(a.calls()).toBe(2);

    const b = throwsInOrder([() => new HttpError(409)]);
    await callAnthropic(params, b.client);
    expect(b.calls()).toBe(2);
  });

  test("400 по-прежнему падает сразу", async () => {
    const f = throwsInOrder([() => new HttpError(400), () => new HttpError(400)]);
    await expect(callAnthropic(params, f.client)).rejects.toThrow(/http 400/);
    expect(f.calls()).toBe(1);
  });

  test("счётчик обрывов не съедает попытки у 429", async () => {
    // Два обрыва + пять 429 = семь отказов. С общим счётчиком (MAX_RETRIES = 5)
    // ход бы упал; с раздельными — доходит до успеха на восьмом запросе.
    const f = throwsInOrder([
      conn,
      conn,
      ...Array.from(
        { length: 5 },
        () => () => new HttpError(429, { "retry-after": "0" }),
      ),
    ]);
    const resp = await callAnthropic(params, f.client);
    expect(resp.content[0]).toMatchObject({ text: "ok" });
    expect(f.calls()).toBe(8);
  });
});

describe("isTransientFailure", () => {
  test("ошибки соединения — да", () => {
    expect(isTransientFailure(new APIConnectionError({ message: "x" }))).toBe(true);
    expect(
      isTransientFailure(new APIConnectionTimeoutError({ message: "x" })),
    ).toBe(true);
  });

  test("по `name` их не отличить — отсюда проверка через instanceof", () => {
    // Обе называются просто «Error»: проверка по имени молча пропустила бы их.
    expect(new APIConnectionError({ message: "x" }).name).toBe("Error");
  });

  test("408 и 409 — да, прочие 4xx — нет", () => {
    expect(isTransientFailure({ status: 408 })).toBe(true);
    expect(isTransientFailure({ status: 409 })).toBe(true);
    expect(isTransientFailure({ status: 400 })).toBe(false);
    expect(isTransientFailure({ status: 401 })).toBe(false);
    expect(isTransientFailure({ status: 429 })).toBe(false); // своя ветка
    expect(isTransientFailure({ status: 503 })).toBe(false); // своя ветка
  });

  test("голая сетевая ошибка с кодом — да (подстраховка на не-SDK слой)", () => {
    expect(isTransientFailure(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe(true);
    expect(isTransientFailure(Object.assign(new Error("x"), { code: "EAI_AGAIN" }))).toBe(true);
    expect(isTransientFailure(Object.assign(new Error("x"), { code: "ENOENT" }))).toBe(false);
  });

  test("мусор на входе не считается ретраибельным", () => {
    expect(isTransientFailure(undefined)).toBe(false);
    expect(isTransientFailure(null)).toBe(false);
    expect(isTransientFailure(new Error("boom"))).toBe(false);
    expect(isTransientFailure("ECONNRESET")).toBe(false);
  });
});
