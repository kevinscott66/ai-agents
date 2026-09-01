/**
 * Бэкофф на 429 стал экспоненциальным (аудит 2026-08-04).
 *
 * Без заголовка `retry-after` пауза была фиксированной секундой: пять попыток
 * укладывались в ~5 секунд и все пять упирались в тот же перегруженный лимит,
 * после чего исключение уходило наверх — а там его глотал `catch` хода, и бот
 * в чате молчал. Для 5xx удвоение с потолком 30с было с самого начала; 429
 * просто забыли.
 *
 * Заголовок сервера по-прежнему главнее собственной догадки: когда он есть,
 * ждём ровно столько и ничего не удваиваем.
 *
 * Аудит 2026-08-20 — фикстура здесь сменилась с `retry-after: 0` на `1`, а
 * секундомер — на подменяемый сон. Ноль был удобен тем, что живой прогон
 * проходил мгновенно, но он же и оказался дырой: `parseRetryAfterMs` отдавал
 * 0 мс, и в 429-ветке это разом убирало и паузу, и рост `backoff429`
 * (`ra !== undefined`). Теперь ноль трактуется как «заголовка нет»
 * (tests/anthropic-retry-after-cap.test.ts), значит наименьшее осмысленное
 * значение фикстуры — секунда, и живой прогон стоил бы 5 секунд гейта на тест.
 * `__setSleepForTests` (тот же сеттер, что чинил флаки в
 * anthropic-retry-multiplier.test.ts) возвращает скорость и заодно делает
 * проверку сильнее: видно сами длительности пауз, а не суммарное время.
 */
import { describe, test, expect } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { callAnthropic, __setSleepForTests } from "../lib/anthropic-client.ts";

const SRC = readFileSync(
  new URL("../lib/anthropic-client.ts", import.meta.url),
  "utf8",
);

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

function failThen(n: number, err: () => Error) {
  let calls = 0;
  return {
    client: {
      messages: {
        create: async () => {
          if (calls++ < n) throw err();
          return {
            id: "m",
            type: "message",
            role: "assistant",
            model: "t",
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
            content: [{ type: "text", text: "ok" }],
          } as unknown as Anthropic.Message;
        },
      },
    } as unknown as Anthropic,
    calls: () => calls,
  };
}

/** Записывает запрошенные паузы и не спит. */
function fakeSleep(): { waits: number[]; restore: () => void } {
  const waits: number[] = [];
  __setSleepForTests(async (ms) => {
    waits.push(ms);
  });
  return { waits, restore: () => __setSleepForTests(null) };
}

describe("429: retry-after главнее собственной оценки", () => {
  test("заголовок соблюдается и не раздувается удвоением", async () => {
    const s = fakeSleep();
    try {
      const f = failThen(5, () => new HttpError(429, { "retry-after": "1" }));
      const resp = await callAnthropic(params, f.client);
      expect(resp.content[0]).toMatchObject({ type: "text", text: "ok" });
      expect(f.calls()).toBe(6);
      // Пять пауз, и каждая — секунда из заголовка плюс jitter (<200мс).
      // Удвоение дало бы 1, 2, 4, 8, 16 секунд.
      expect(s.waits).toHaveLength(5);
      for (const w of s.waits) {
        expect(w).toBeGreaterThanOrEqual(1000);
        expect(w).toBeLessThan(1200);
      }
    } finally {
      s.restore();
    }
  });

  test("без заголовка собственная догадка удваивается", async () => {
    const s = fakeSleep();
    try {
      const f = failThen(99, () => new HttpError(429));
      await expect(callAnthropic(params, f.client)).rejects.toThrow(/http 429/);
      // Шесть попыток: первая плюс MAX_RETRIES повторов.
      expect(f.calls()).toBe(6);
      expect(s.waits.map((w) => w - (w % 1000))).toEqual([1000, 2000, 4000, 8000, 16_000]);
    } finally {
      s.restore();
    }
  });

  test("после MAX_RETRIES ошибка уходит наверх", async () => {
    const s = fakeSleep();
    try {
      const f = failThen(99, () => new HttpError(429, { "retry-after": "1" }));
      await expect(callAnthropic(params, f.client)).rejects.toThrow(/http 429/);
      expect(f.calls()).toBe(6);
    } finally {
      s.restore();
    }
  });
});

describe("429 без заголовка: удвоение с потолком", () => {
  // Живой прогон здесь стоил бы 1+2+4+8+16 секунд, поэтому проверяем структуру.
  function branch429(): string {
    const start = SRC.indexOf("if (status === 429)");
    expect(start).toBeGreaterThan(-1);
    return SRC.slice(start, SRC.indexOf("if (typeof status === \"number\"", start));
  }

  test("у 429 собственный счётчик бэкоффа", () => {
    expect(SRC).toMatch(/let backoff429 = 1000;/);
    expect(branch429()).toMatch(/\?\? backoff429/);
  });

  test("удвоение с тем же потолком, что у 5xx", () => {
    expect(branch429()).toMatch(/backoff429 \* 2, 30_000/);
  });

  test("удваивается только собственная догадка", () => {
    // Сервер назвал точное время — наращивать его поверх нечего.
    expect(branch429()).toMatch(/if \(ra === undefined\) backoff429 =/);
  });

  test("фиксированная секунда из кода ушла", () => {
    // Мутационная проверка: со старым `?? 1000` предыдущие пины бы уцелели.
    expect(branch429()).not.toMatch(/\?\? 1000/);
  });
});
