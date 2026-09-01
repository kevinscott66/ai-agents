/**
 * Аудит 2026-08-12: зависший getMe оставлял бота «живым» навсегда.
 *
 * `tickOne` делает `await b.bot.telegram.getMe()` без потолка. Telegraf ходит
 * в api.telegram.org обычным fetch'ем, и зависший сокет — это не ошибка, а
 * отсутствие события: catch не сработает никогда. Последствия:
 *
 *  1. Снапшот остаётся тем, что был: `alive: true`, `lastOkAt` часовой
 *     давности, `consecutiveFailures: 0`. Активная проверка, которая заведена
 *     ровно чтобы отличать «молчит» от «мёртв», рапортует «жив» про бота,
 *     до которого не достучаться.
 *  2. `pickAvailableAgent` (lib/role-skills.ts) верит `alive` и продолжает
 *     слать делегирования именно туда.
 *  3. `setInterval` не ждёт предыдущий тик: каждые 60 секунд стартует новый,
 *     и повисшие getMe копятся вместе с их промисами.
 *
 * Замер до правки (bun, зонд на живом lib/health.ts): у бота, чей getMe не
 * резолвится никогда, `_tick()` не завершился за 1200 мс, а снапшот остался
 * ровно таким, каким был до тика — то есть после одного успешного пинга это
 * `alive: true, consecutiveFailures: 0` навсегда.
 *
 * Инвариант: тик всегда завершается, зависание считается отказом, и
 * следующий тик не стартует поверх незавершённого.
 */
import { describe, test, expect } from "bun:test";
import { startHealthMonitor, HEALTH_GETME_TIMEOUT_MS } from "../lib/health.ts";
import type { RunningBot } from "../lib/types.ts";

function makeBot(key: string, getMe: () => Promise<any>): RunningBot {
  return {
    def: { key, name: key } as any,
    bot: { telegram: { getMe } } as any,
    username: `${key}_bot`,
    id: 1,
  };
}

const never = () => new Promise<any>(() => {});

describe("зависший getMe", () => {
  test("тик завершается, а не висит", async () => {
    const h = startHealthMonitor({
      bots: [makeBot("hung", never)],
      intervalMs: 60_000,
      getMeTimeoutMs: 30,
    });
    try {
      await h._tick();
    } finally {
      h.stop();
    }
  }, 1500);

  test("зависание — это отказ, а не «жив»", async () => {
    const pending: Array<(v: any) => void> = [];
    let first = true;
    const b = makeBot("flaky", () => {
      if (first) {
        first = false;
        return Promise.resolve({ id: 1 });
      }
      return new Promise<any>((res) => {
        pending.push(res);
      });
    });
    const h = startHealthMonitor({
      bots: [b],
      intervalMs: 60_000,
      getMeTimeoutMs: 30,
    });
    try {
      await h._tick(); // успешный: alive=true
      expect(h.snapshot()[0]!.alive).toBe(true);
      const okAt = h.snapshot()[0]!.lastOkAt;

      await h._tick(); // зависший
      const s = h.snapshot()[0]!;
      expect(s.alive).toBe(false);
      expect(s.consecutiveFailures).toBe(1);
      expect(s.lastError).toContain("timeout");
      // Прошлый успех не затирается — по нему видно, когда бот был жив.
      expect(s.lastOkAt).toBe(okAt);
    } finally {
      for (const res of pending) res(null);
      h.stop();
    }
  }, 1500);

  test("новый тик не стартует поверх незавершённого", async () => {
    let calls = 0;
    const h = startHealthMonitor({
      bots: [
        makeBot("slow", () => {
          calls++;
          return never();
        }),
      ],
      intervalMs: 60_000,
      getMeTimeoutMs: 120,
    });
    try {
      const a = h._tick();
      const b = h._tick(); // пока первый в полёте
      await Promise.all([a, b]);
      expect(calls).toBe(1);
    } finally {
      h.stop();
    }
  }, 1500);

  test("после завершения тика следующий проходит нормально", async () => {
    let calls = 0;
    const h = startHealthMonitor({
      bots: [
        makeBot("ok", async () => {
          calls++;
          return { id: 1 };
        }),
      ],
      intervalMs: 60_000,
      getMeTimeoutMs: 100,
    });
    try {
      await h._tick();
      await h._tick();
      expect(calls).toBe(2);
      expect(h.snapshot()[0]!.alive).toBe(true);
    } finally {
      h.stop();
    }
  }, 1500);

  test("потолок по умолчанию конечен и меньше минимального интервала", () => {
    // Иначе зависший тик перекрывал бы следующий и защита от наложения
    // превращалась бы в «проверок больше нет».
    expect(Number.isFinite(HEALTH_GETME_TIMEOUT_MS)).toBe(true);
    expect(HEALTH_GETME_TIMEOUT_MS).toBeGreaterThan(0);
    expect(HEALTH_GETME_TIMEOUT_MS).toBeLessThan(60_000);
  });

  test("один зависший бот не мешает проверить остальных", async () => {
    const h = startHealthMonitor({
      bots: [makeBot("hung", never), makeBot("fine", async () => ({ id: 2 }))],
      intervalMs: 60_000,
      getMeTimeoutMs: 40,
    });
    try {
      await h._tick();
      const byKey = Object.fromEntries(
        h.snapshot().map((s) => [s.agentKey, s]),
      );
      expect(byKey.hung!.alive).toBe(false);
      expect(byKey.fine!.alive).toBe(true);
    } finally {
      h.stop();
    }
  }, 1500);
});
