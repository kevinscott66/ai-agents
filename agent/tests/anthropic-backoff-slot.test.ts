/**
 * Аудит 2026-08-13: пауза перед повтором держала слот конкурентности.
 *
 * `acquire()` стоит выше цикла ретраев, `release()` — в `finally`, значит
 * `await sleep(waitMs)` спал внутри слота. Слотов по умолчанию три на все 12
 * ролей, пауза на 429 доходит до минуты, попыток пять: три невезучих запроса
 * запирали поход в API для всей команды на время, которое сами не использовали.
 * Снаружи — «боты молчат», причём все, включая тех, кому лимит не возвращали.
 *
 * Правка: на время сна слот отпускается и берётся заново перед следующей
 * попыткой. Здесь проверяется и это, и что счётчик слотов при таком обмене не
 * уезжает — уехавший в минус счётчик тихо расширил бы лимит конкурентности,
 * а такое не видно вообще никак.
 */
import { describe, test, expect } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { callAnthropic, MAX_CONCURRENCY } from "../lib/anthropic-client.ts";

const PARAMS = {
  model: "t",
  max_tokens: 8,
  messages: [{ role: "user" as const, content: "ping" }],
} as Anthropic.MessageCreateParamsNonStreaming;

function reply(): Anthropic.Message {
  return {
    id: "m",
    type: "message",
    role: "assistant",
    model: "t",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
    content: [{ type: "text", text: "pong" }],
  } as unknown as Anthropic.Message;
}

function rateLimited(retryAfterSec: string) {
  return Object.assign(new Error("429 rate limit"), {
    status: 429,
    headers: { "retry-after": retryAfterSec },
  });
}

/** Первый вызов — 429 с явной паузой, второй — успех. */
function retriesOnce(retryAfterSec = "1"): Anthropic {
  let first = true;
  return {
    messages: {
      create: async () => {
        if (first) {
          first = false;
          throw rateLimited(retryAfterSec);
        }
        return reply();
      },
    },
  } as unknown as Anthropic;
}

function alwaysOk(onCall?: () => void): Anthropic {
  return {
    messages: {
      create: async () => {
        onCall?.();
        return reply();
      },
    },
  } as unknown as Anthropic;
}

describe("бэкофф не держит слот конкурентности", () => {
  test("пока все слоты спят в паузе, чужой запрос всё равно проходит", async () => {
    // Занимаем ВСЕ слоты запросами, которые сразу уходят в паузу на ~1с.
    const sleeping = Array.from({ length: MAX_CONCURRENCY }, () =>
      callAnthropic(PARAMS, retriesOnce("1")),
    );

    const t0 = Date.now();
    const other = await callAnthropic(PARAMS, alwaysOk());
    const waitedMs = Date.now() - t0;

    expect(other.content[0]).toMatchObject({ type: "text" });
    // До правки этот запрос ждал, пока кто-то из спящих доработает: ≥1000мс.
    expect(waitedMs).toBeLessThan(600);

    await Promise.all(sleeping);
  });

  test("спящий запрос доводит своё дело до конца, а не теряется", async () => {
    const results = await Promise.all(
      Array.from({ length: MAX_CONCURRENCY + 2 }, () =>
        callAnthropic(PARAMS, retriesOnce("0")),
      ),
    );
    expect(results.length).toBe(MAX_CONCURRENCY + 2);
    for (const r of results) expect(r.stop_reason).toBe("end_turn");
  });
});

describe("счётчик слотов остаётся сбалансированным", () => {
  /**
   * Прямого доступа к счётчику нет и заводить его ради теста незачем:
   * уехавший счётчик наблюдаем по поведению. Уехал в минус — лимит
   * конкурентности тихо вырос; уехал в плюс — слоты протекли и очередь встала.
   * Оба видно одним и тем же способом: сколько запросов реально идёт разом
   * после серии обменов слота.
   */
  test("после серии ретраев одновременно работает ровно MAX_CONCURRENCY", async () => {
    await Promise.all(
      Array.from({ length: MAX_CONCURRENCY * 2 }, () =>
        callAnthropic(PARAMS, retriesOnce("0")),
      ),
    );

    let inFlight = 0;
    let peak = 0;
    const gate = Promise.withResolvers<void>();
    const client = {
      messages: {
        create: async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await gate.promise;
          inFlight--;
          return reply();
        },
      },
    } as unknown as Anthropic;

    const many = Array.from({ length: MAX_CONCURRENCY * 3 }, () =>
      callAnthropic(PARAMS, client),
    );
    // Дать всем, кому хватило слотов, дойти до client.messages.create.
    await new Promise((r) => setTimeout(r, 20));
    const peakWhileBlocked = peak;
    gate.resolve();
    await Promise.all(many);

    expect(peakWhileBlocked).toBe(MAX_CONCURRENCY);
    expect(peak).toBe(MAX_CONCURRENCY);
    expect(inFlight).toBe(0);
  });

  test("не-ретраибельная ошибка тоже возвращает слот", async () => {
    const failing = {
      messages: {
        create: async () => {
          throw Object.assign(new Error("400 bad request"), { status: 400 });
        },
      },
    } as unknown as Anthropic;

    await Promise.all(
      Array.from({ length: MAX_CONCURRENCY }, () =>
        callAnthropic(PARAMS, failing).catch(() => null),
      ),
    );

    const t0 = Date.now();
    await callAnthropic(PARAMS, alwaysOk());
    expect(Date.now() - t0).toBeLessThan(300);
  });
});
