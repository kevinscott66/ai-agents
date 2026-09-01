/**
 * Аудит 2026-08-11: токены ботов утекали в Mini App через health-снапшот.
 *
 * Цепочка целиком:
 *  1. `telegram.getMe()` у telegraf 4.16 ходит через node-fetch@2, а тот на
 *     сетевой ошибке бросает `request to ${url} failed, reason: ...` —
 *     где url это `https://api.telegram.org/bot<ТОКЕН>/getMe`.
 *  2. `lib/health.ts` клал `e.message` в `lastError` как есть (200 симв. —
 *     токен влезает с запасом).
 *  3. `orchestrator/services.ts` отдавал СЫРОЙ снапшот в SSE-шину, а
 *     `miniapp-server.ts` рассылает payload всем подключённым по allowlist —
 *     без admin-проверки.
 *
 * То есть любая сетевая недоступность Telegram (ECONNREFUSED, DNS, таймаут —
 * ровно то, ради чего health-монитор и существует) раздавала 12 токенов всем
 * пользователям Mini App. Токен = полный контроль над ботом.
 *
 * Почему это дожило: REST-путь был безопасен. `buildAgentsList` проецирует
 * снапшот на {alive,lastOkAt,consecutiveFailures} и `lastError` выбрасывает —
 * так что /api/agents и /api/dashboard не текли. Утечка была только во второй
 * двери к тем же данным, где на провод уходил внутренний тип целиком.
 *
 * Инвариант: секрет не должен попадать в снапшот вообще (источник), и наружу
 * уходит проекция, а не внутренний тип (граница).
 */
import { describe, test, expect, spyOn } from "bun:test";
import { startHealthMonitor, publicHealth } from "../lib/health.ts";
import type { RunningBot } from "../lib/types.ts";
import { log } from "../lib/log.ts";

/** Формат токена настоящий, значение — из примеров документации Telegram. */
const FAKE_TOKEN = "7123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";
/** Дословный текст ошибки node-fetch@2 (lib/index.js: `request to ... failed`). */
const NODE_FETCH_ERROR =
  `request to https://api.telegram.org/bot${FAKE_TOKEN}/getMe failed, ` +
  `reason: connect ECONNREFUSED 149.154.167.220:443`;

function makeBot(key: string, getMe: () => Promise<any>): RunningBot {
  return {
    def: { key, name: key } as any,
    bot: { telegram: { getMe } } as any,
    username: `${key}_bot`,
    id: 1,
  };
}

async function snapshotAfterError(message: string) {
  const b = makeBot("orchestrator", async () => {
    throw new Error(message);
  });
  const h = startHealthMonitor({ bots: [b], intervalMs: 60_000 });
  try {
    await h._tick();
    return h.snapshot();
  } finally {
    h.stop();
  }
}

describe("токен не попадает в health-снапшот", () => {
  test("сетевая ошибка node-fetch не тащит токен в lastError", async () => {
    const snap = await snapshotAfterError(NODE_FETCH_ERROR);

    expect(snap[0].alive).toBe(false);
    expect(snap[0].lastError).toBeDefined();
    expect(snap[0].lastError).not.toContain(FAKE_TOKEN);
  });

  test("причина сбоя при этом сохраняется — иначе монитор бесполезен", async () => {
    const snap = await snapshotAfterError(NODE_FETCH_ERROR);

    expect(snap[0].lastError).toContain("ECONNREFUSED");
    expect(snap[0].lastError).toContain("api.telegram.org");
  });

  test("обычная ошибка API не портится", async () => {
    const snap = await snapshotAfterError("401: Unauthorized");

    expect(snap[0].lastError).toBe("401: Unauthorized");
  });
});

describe("наружу уходит проекция, а не внутренний тип", () => {
  test("publicHealth не отдаёт lastError ни в каком виде", async () => {
    const snap = await snapshotAfterError(NODE_FETCH_ERROR);
    const pub = publicHealth(snap);

    expect(JSON.stringify(pub)).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(pub)).not.toContain("ECONNREFUSED");
    expect(pub[0]).not.toHaveProperty("lastError");
  });

  test("поля ровно те же, что /api/agents отдаёт в health", async () => {
    // buildAgentsList (miniapp-server.ts) проецирует на alive/lastOkAt/
    // consecutiveFailures. SSE обязан отдавать не больше — обе двери ведут к
    // одним данным, и расхождение между ними и было дырой.
    const snap = await snapshotAfterError(NODE_FETCH_ERROR);

    expect(Object.keys(publicHealth(snap)[0]).sort()).toEqual(
      ["agentKey", "alive", "consecutiveFailures", "lastOkAt"],
    );
  });

  test("живой бот проходит проекцию без потерь", async () => {
    const b = makeBot("pm", async () => ({ id: 1, username: "pm_bot" }));
    const h = startHealthMonitor({ bots: [b], intervalMs: 60_000 });
    try {
      await h._tick();
      const pub = publicHealth(h.snapshot());
      expect(pub[0].agentKey).toBe("pm");
      expect(pub[0].alive).toBe(true);
      expect(pub[0].lastOkAt).toBeGreaterThan(0);
      expect(pub[0].consecutiveFailures).toBe(0);
    } finally {
      h.stop();
    }
  });
});

describe("скруббер логов знает токен в пути URL, а не только в query", () => {
  function captureLog(fn: () => void): string {
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      fn();
      return spy.mock.calls.map((c) => c.join(" ")).join("\n");
    } finally {
      spy.mockRestore();
    }
  }

  test("токен в https://api.telegram.org/bot<T>/ вычищается", () => {
    // SENSITIVE_KEY ловит ключ `token`, INLINE_QS_SECRET — `?token=`, BEARER —
    // заголовок. Форма `/bot<T>/` не попадала ни под один, а node-fetch пишет
    // ошибки именно так. Скруббер объявлен ALWAYS on, значит дыра в нём — дыра
    // в постоянно включённой защите.
    const out = captureLog(() => log.error(NODE_FETCH_ERROR));

    expect(out).not.toContain(FAKE_TOKEN);
    expect(out).toContain("ECONNREFUSED");
  });

  test("токен внутри вложенных данных тоже", () => {
    const out = captureLog(() =>
      log.error("health tick failed", { reason: NODE_FETCH_ERROR }),
    );

    expect(out).not.toContain(FAKE_TOKEN);
  });
});
