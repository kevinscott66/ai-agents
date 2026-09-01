/**
 * Аудит 2026-08-29 — зависшее ТЕЛО ответа держало слот конкурентности вечно.
 *
 * `createAnthropic` задаёт `timeout`, и докблок модуля обещал, что «непрерывное
 * удержание слота ограничено сверху одним таймаутом». В SDK 0.98.1 это неправда:
 * `fetchWithTimeout` (client.js:562-593) снимает таймер в `finally` сразу, как
 * только `fetch` вернул Response, — то есть таймаут покрывает ОДНИ заголовки.
 * Тело читается позже, и сокет, отдавший 200 и замолчавший, не даёт ни
 * таймаута, ни ретрая, ни строчки в логе. Три таких сокета при дефолтных трёх
 * слотах — очередь не двигается больше никогда.
 *
 * Чинится парой: пер-запросный `AbortSignal.timeout` рвёт чтение тела, а
 * `isTransientFailure` учится узнавать то, чем этот обрыв прилетает — иначе
 * вечный висяк просто меняется на фатальную ошибку без единого ретрая.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import {
  callAnthropic,
  isTransientFailure,
  _requestTimeoutMs,
  __setSleepForTests,
  MAX_CONCURRENCY,
} from "../lib/anthropic-client.ts";

const PARAMS = {
  model: "claude-haiku-4-5-20251001",
  max_tokens: 16,
  messages: [{ role: "user" as const, content: "ping" }],
};

/** DOMException, которым браузерный fetch отвечает на abort. */
function abortError(): Error {
  return Object.assign(new Error("The operation was aborted."), {
    name: "AbortError",
  });
}

/**
 * Клиент, который отдал заголовки и замолчал на теле.
 *
 * Без пер-запросного signal промис не резолвится НИКОГДА — ровно то, что
 * делал прод до правки. С signal — отклоняется голым AbortError.
 */
function stallingClient() {
  let calls = 0;
  const seenSignals: Array<AbortSignal | undefined> = [];
  const client = {
    messages: {
      create(_p: unknown, opts?: { signal?: AbortSignal }) {
        calls++;
        seenSignals.push(opts?.signal);
        return new Promise((_resolve, reject) => {
          const s = opts?.signal;
          if (!s) return;
          if (s.aborted) return reject(abortError());
          s.addEventListener("abort", () => reject(abortError()), {
            once: true,
          });
        });
      },
    },
  } as unknown as Anthropic;
  return { client, calls: () => calls, signals: () => seenSignals };
}

function okClient() {
  const resp = {
    id: "msg_ok",
    content: [{ type: "text", text: "ok" }],
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  return {
    messages: { create: async () => resp },
  } as unknown as Anthropic;
}

/** Промис-часовой: отличает «зависли» от «отклонились». */
function withSentinel<T>(p: Promise<T>, ms: number): Promise<T | "STALLED"> {
  let timer: ReturnType<typeof setTimeout>;
  const sentinel = new Promise<"STALLED">((r) => {
    timer = setTimeout(() => r("STALLED"), ms);
  });
  return Promise.race([p, sentinel]).finally(() => clearTimeout(timer));
}

const SENTINEL_MS = 15_000;
const SLOW = 40_000;
const slowTest = (name: string, fn: () => Promise<unknown>) =>
  test(name, fn, SLOW);

describe("аудит 2026-08-29: дедлайн на чтение тела", () => {
  let savedTimeout: string | undefined;

  beforeAll(() => {
    savedTimeout = process.env.ANTHROPIC_REQUEST_TIMEOUT_MS;
    // Минимум, который принимает _resolveRequestTimeout.
    process.env.ANTHROPIC_REQUEST_TIMEOUT_MS = "1000";
    // Бэкоффы мгновенные: тест меряет висяк, а не арифметику пауз.
    __setSleepForTests(async () => {});
  });

  afterAll(() => {
    __setSleepForTests(null);
    if (savedTimeout === undefined) {
      delete process.env.ANTHROPIC_REQUEST_TIMEOUT_MS;
    } else {
      process.env.ANTHROPIC_REQUEST_TIMEOUT_MS = savedTimeout;
    }
    // Сбрасываем мемоизацию обратно на восстановленное значение.
    _requestTimeoutMs();
  });

  slowTest("запрос с замолчавшим телом не висит вечно, а падает", async () => {
    const { client, calls } = stallingClient();
    const res = await withSentinel(
      callAnthropic(PARAMS, client).then(
        () => "RESOLVED" as const,
        (e) => e as Error,
      ),
      SENTINEL_MS,
    );
    expect(res).not.toBe("STALLED");
    expect(res).not.toBe("RESOLVED");
    expect((res as Error).name).toBe("AbortError");
    // Один заход плюс два ретрая: обрыв на теле получает ровно ту же лестницу,
    // что и обрыв до заголовков (TRANSIENT_MAX_RETRIES = 2).
    expect(calls()).toBe(3);
  });

  slowTest("каждой попытке достаётся живой пер-запросный signal", async () => {
    const { client, signals } = stallingClient();
    await callAnthropic(PARAMS, client).catch(() => {});
    expect(signals().length).toBe(3);
    for (const s of signals()) {
      expect(s).toBeInstanceOf(AbortSignal);
      // Сигнал одноразовый: у каждой попытки свой дедлайн, а не общий на всё.
      expect(s!.aborted).toBe(true);
    }
    expect(new Set(signals()).size).toBe(3);
  });

  slowTest("зависшие тела не запирают очередь для всей команды", async () => {
    // Занимаем ВСЕ слоты зависшими запросами — ровно та ситуация, в которой
    // прод замолкал целиком до `systemctl restart agent-team`.
    const stalls = Array.from({ length: MAX_CONCURRENCY }, () => {
      const { client } = stallingClient();
      return callAnthropic(PARAMS, client).catch(() => "failed");
    });
    const bystander = withSentinel(
      callAnthropic(PARAMS, okClient()).then(() => "RESOLVED" as const),
      SENTINEL_MS,
    );
    expect(await bystander).toBe("RESOLVED");
    await Promise.all(stalls);
  });
});

describe("аудит 2026-08-29: классификация обрыва на теле", () => {
  test("bun: ConnectionClosed", () => {
    expect(
      isTransientFailure(
        Object.assign(new Error("The socket connection was closed"), {
          code: "ConnectionClosed",
        }),
      ),
    ).toBe(true);
  });

  test("undici: код спрятан в cause", () => {
    // Снаружи это `TypeError: terminated` вообще без своего `code` — до правки
    // код в `cause` никто не смотрел, и обрыв считался фатальным.
    const err = Object.assign(new TypeError("terminated"), {
      cause: Object.assign(new Error("other side closed"), {
        code: "UND_ERR_SOCKET",
      }),
    });
    expect((err as { code?: unknown }).code).toBeUndefined();
    expect(isTransientFailure(err)).toBe(true);
  });

  test("node-стрим: ERR_STREAM_PREMATURE_CLOSE", () => {
    expect(isTransientFailure({ code: "ERR_STREAM_PREMATURE_CLOSE" })).toBe(
      true,
    );
  });

  test("abort по дедлайну: AbortError и TimeoutError", () => {
    expect(isTransientFailure(abortError())).toBe(true);
    expect(
      isTransientFailure(
        Object.assign(new Error("timed out"), { name: "TimeoutError" }),
      ),
    ).toBe(true);
  });

  test("прежнее поведение не расширено дальше нужного", () => {
    expect(isTransientFailure(new Error("boom"))).toBe(false);
    expect(isTransientFailure({ code: "EACCES" })).toBe(false);
    expect(isTransientFailure({ status: 400 })).toBe(false);
    expect(isTransientFailure(null)).toBe(false);
    expect(isTransientFailure("ECONNRESET")).toBe(false);
    // Прежние коды и статусы на месте.
    expect(isTransientFailure({ code: "ECONNRESET" })).toBe(true);
    expect(isTransientFailure({ status: 408 })).toBe(true);
    expect(isTransientFailure({ status: 409 })).toBe(true);
  });

  test("самоссылающийся cause не вешает обход", () => {
    const err: { cause?: unknown } = {};
    err.cause = err;
    expect(isTransientFailure(err)).toBe(false);
  });
});

describe("аудит 2026-08-29: _requestTimeoutMs", () => {
  test("мемоизирует и пересчитывает при смене переменной", () => {
    const saved = process.env.ANTHROPIC_REQUEST_TIMEOUT_MS;
    try {
      process.env.ANTHROPIC_REQUEST_TIMEOUT_MS = "5000";
      expect(_requestTimeoutMs()).toBe(5000);
      expect(_requestTimeoutMs()).toBe(5000);
      process.env.ANTHROPIC_REQUEST_TIMEOUT_MS = "7000";
      expect(_requestTimeoutMs()).toBe(7000);
      delete process.env.ANTHROPIC_REQUEST_TIMEOUT_MS;
      expect(_requestTimeoutMs()).toBe(120_000);
    } finally {
      if (saved === undefined) {
        delete process.env.ANTHROPIC_REQUEST_TIMEOUT_MS;
      } else {
        process.env.ANTHROPIC_REQUEST_TIMEOUT_MS = saved;
      }
      _requestTimeoutMs();
    }
  });
});
