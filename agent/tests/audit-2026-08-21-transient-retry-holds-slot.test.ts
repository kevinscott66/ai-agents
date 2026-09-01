/**
 * Аудит 2026-08-21: пауза после ОБРЫВА СВЯЗИ держала слот конкурентности.
 *
 * Ровно тот дефект, который аудит 2026-08-13 закрыл для 429 и 5xx
 * (`anthropic-backoff-slot.test.ts`), но в третьей ветке того же цикла. Ветки
 * 429 и 5xx зовут `backoffWithoutSlot(waitMs)` — она отпускает слот на время
 * сна и берёт заново. Ветка `isTransientFailure` (ECONNRESET/408/409) звала
 * голый `sleep(waitMs)`, то есть спала ВНУТРИ слота.
 *
 * Инвариант сформулирован в докблоке `backoffWithoutSlot` прямым текстом:
 * «Спящий запрос API не занимает». Слотов по умолчанию три на все 12 ролей —
 * три невезучих запроса запирали поход в API для всей команды.
 *
 * Замер до фикса (все слоты заняты запросами, спящими в паузе; сон подменён
 * воротами, поэтому проверка не зависит от таймингов):
 *
 *   PROBE ECONNRESET: чужой запрос прошёл, пока слоты спят = false
 *   PROBE 429 (эталон): чужой запрос прошёл, пока слоты спят = true
 *
 * Глубина ямы ограничена (TRANSIENT_MAX_RETRIES = 2, пауза 500→1000мс), но
 * «ненадолго» здесь означает всю команду разом, а не один запрос.
 */
import { describe, test, expect, afterEach } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import {
  callAnthropic,
  MAX_CONCURRENCY,
  __setSleepForTests,
} from "../lib/anthropic-client.ts";

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

/** Обрыв связи в том виде, в каком его отдаёт кастомный fetch: голый код. */
function connReset(): Error {
  return Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
}

function rateLimited(): Error {
  return Object.assign(new Error("429"), {
    status: 429,
    headers: { "retry-after": "1" },
  });
}

/** Первый вызов падает, второй — успех. */
function failsOnce(mk: () => Error): Anthropic {
  let first = true;
  return {
    messages: {
      create: async () => {
        if (first) {
          first = false;
          throw mk();
        }
        return reply();
      },
    },
  } as unknown as Anthropic;
}

function alwaysOk(): Anthropic {
  return {
    messages: { create: async () => reply() },
  } as unknown as Anthropic;
}

const tick = () => new Promise((r) => setTimeout(r, 20));

afterEach(() => __setSleepForTests(null));

/**
 * Занимает ВСЕ слоты запросами, которые уходят в паузу, и проверяет, успеет ли
 * посторонний запрос пройти, пока те спят. Сон подменён воротами: тест не
 * меряет время, он смотрит, дошло ли дело до ответа при закрытых воротах.
 */
async function foreignRequestPasses(mk: () => Error): Promise<boolean> {
  const gate = Promise.withResolvers<void>();
  __setSleepForTests(() => gate.promise);
  const sleeping = Array.from({ length: MAX_CONCURRENCY }, () =>
    callAnthropic(PARAMS, failsOnce(mk)),
  );
  await tick(); // дать всем дойти до паузы
  let passed = false;
  const other = callAnthropic(PARAMS, alwaysOk()).then((r) => {
    passed = true;
    return r;
  });
  await tick();
  const seen = passed;
  gate.resolve();
  await Promise.all([...sleeping, other]);
  return seen;
}

describe("пауза после обрыва связи не держит слот", () => {
  test("пока все слоты спят после ECONNRESET, чужой запрос проходит", async () => {
    expect(await foreignRequestPasses(connReset)).toBe(true);
  });

  test("эталон: на 429 это работало и раньше", async () => {
    // Позитивный контроль. Если сломается ОН, дело не в этой правке, а в самом
    // стенде (подменённый sleep, счётчик слотов), и первый тест — ложный.
    expect(await foreignRequestPasses(rateLimited)).toBe(true);
  });

  test("после обмена слотами их по-прежнему ровно MAX_CONCURRENCY", async () => {
    // Уехавший в минус счётчик тихо расширил бы лимит конкурентности, уехавший
    // в плюс — запер очередь. И то и другое видно только по поведению.
    __setSleepForTests(() => Promise.resolve());
    await Promise.all(
      Array.from({ length: MAX_CONCURRENCY * 2 }, () =>
        callAnthropic(PARAMS, failsOnce(connReset)),
      ),
    );
    __setSleepForTests(null);

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
    await tick();
    const peakWhileBlocked = peak;
    gate.resolve();
    await Promise.all(many);

    expect(peakWhileBlocked).toBe(MAX_CONCURRENCY);
  });
});
