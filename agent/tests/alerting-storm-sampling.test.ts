/**
 * Аудит 2026-08-08: проверка rate-limit шторма наблюдала 1/12 каждого часа.
 *
 * `checkRateLimitStorm` считает строки в окне (`ALERT_RATE_LIMIT_STORM_WINDOW_
 * MINUTES`, по умолчанию 5 минут), а вызывали её раз в час — общим тиком
 * `_alertingHourlyTick` в db-maint. Период опроса длиннее окна означает, что
 * между опросами есть слепая зона: шторм на десятой минуте часа к моменту тика
 * уже полностью выпал из `created_at >= now - 5м`. Пропускалась и устойчивая
 * перегрузка — 10 отказов в минуту весь час не видны, если не попали ровно в
 * последние пять минут.
 *
 * Инвариант: период опроса ≤ окна. Отсюда отдельный тик у шторма и кулдаун,
 * чтобы частый опрос не превратил длящийся шторм в поток одинаковых алертов.
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import {
  checkRateLimitStorm,
  getThresholds,
  stormTickMs,
  _resetAlertCooldowns,
} from "../lib/alerting.ts";
import { startMaintScheduler } from "../lib/db-maint.ts";
import { db } from "../lib/db.ts";

const AGENT = "stormtest";
const MIN_MS = 60_000;

function seedRejections(n: number, atMs: number): void {
  const stmt = db.prepare(
    `INSERT INTO agent_actions(id, agent_key, chat_id, action_type, payload, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'rate_limited', ?)`,
  );
  for (let i = 0; i < n; i++) {
    stmt.run(crypto.randomUUID(), AGENT, -1, "SEND_MESSAGE", "{}", atMs);
  }
}

beforeEach(() => {
  _resetAlertCooldowns();
  db.prepare(`DELETE FROM agent_actions WHERE agent_key = ?`).run(AGENT);
});

afterEach(() => {
  db.prepare(`DELETE FROM agent_actions WHERE agent_key = ?`).run(AGENT);
  db.prepare(`DELETE FROM audit_logs WHERE event_type = 'alert.rate_limit.storm'`).run();
  _resetAlertCooldowns();
});

describe("rate-limit storm: период опроса не длиннее окна", () => {
  test("период опроса не длиннее окна наблюдения", () => {
    const t = getThresholds();
    // Собственно инвариант. При часовом тике и окне в 5 минут отношение было
    // 12:1 — проверка видела 1/12 времени.
    expect(stormTickMs()).toBeLessThanOrEqual(
      t.rateLimitStormWindowMinutes * MIN_MS,
    );
    // Он держится и при другом окне из env.
    expect(stormTickMs({ rateLimitStormWindowMinutes: 15 })).toBeLessThanOrEqual(
      15 * MIN_MS,
    );
    // Но опрашивать чаще раза в минуту не станем даже при абсурдном окне.
    expect(stormTickMs({ rateLimitStormWindowMinutes: 0 })).toBe(MIN_MS);
  });

  test("у шторма свой тик в шедулере, отдельный от часового", () => {
    const handle = startMaintScheduler({ gcIntervalMs: 60 * MIN_MS });
    try {
      expect(typeof handle._alertingStormTick).toBe("function");
      seedRejections(getThresholds().rateLimitStormCount, Date.now());
      handle._alertingStormTick();
      const n = (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM audit_logs WHERE event_type = 'alert.rate_limit.storm'`,
          )
          .get() as { n: number }
      ).n;
      expect(n).toBe(1);
    } finally {
      handle.stop();
    }
  });

  test("шторм в начале часа не должен теряться к моменту опроса", () => {
    const t = getThresholds();
    const now = Date.now();
    // Отказы случились 10 минут назад — при часовом опросе это ровно тот
    // случай, что выпадал: к следующему тику им уже 70 минут.
    const stormAt = now - 10 * MIN_MS;
    seedRejections(t.rateLimitStormCount, stormAt);

    // Опрос с периодом окна: тик, который придётся на конец этого окна,
    // отказы ещё видит.
    const tickAtWindowCadence = stormAt + t.rateLimitStormWindowMinutes * MIN_MS;
    expect(checkRateLimitStorm({ now: tickAtWindowCadence })).toBe(true);

    // А часовой опрос — уже нет. Это и был баг: те же данные, тот же порог.
    _resetAlertCooldowns();
    expect(checkRateLimitStorm({ now: stormAt + 60 * MIN_MS })).toBe(false);
  });

  test("длящийся шторм не превращается в поток одинаковых алертов", () => {
    const t = getThresholds();
    const now = Date.now();
    seedRejections(t.rateLimitStormCount, now);

    expect(checkRateLimitStorm({ now })).toBe(true);
    // Тик минутой позже: те же отказы всё ещё в окне, но сигнал о них уже был —
    // повторять его каждую минуту, пока шторм идёт, незачем.
    expect(checkRateLimitStorm({ now: now + MIN_MS })).toBe(false);
    // И это именно кулдаун, а не «проверка сломалась»: без него тот же вызов
    // сигналит.
    _resetAlertCooldowns();
    expect(checkRateLimitStorm({ now: now + MIN_MS })).toBe(true);
  });

  test("кулдаун не глушит сигнал о новом шторме после паузы", () => {
    const t = getThresholds();
    const first = Date.now();
    seedRejections(t.rateLimitStormCount, first);
    expect(checkRateLimitStorm({ now: first })).toBe(true);

    // Новый шторм спустя кулдаун — обязан быть слышен.
    const later = first + (t.rateLimitStormCooldownMinutes + 1) * MIN_MS;
    seedRejections(t.rateLimitStormCount, later);
    expect(checkRateLimitStorm({ now: later })).toBe(true);
  });

  test("порог 0 по-прежнему выключает проверку целиком", () => {
    seedRejections(1000, Date.now());
    expect(
      checkRateLimitStorm({ thresholds: { rateLimitStormCount: 0 } }),
    ).toBe(false);
  });
});
