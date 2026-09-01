/**
 * Аудит 2026-08-28: период тика шторма не имел верхней границы.
 *
 * `stormTickMs` = `Math.max(MIN_MS, окно * MIN_MS)` — клэмп только снизу, а
 * `envInt` в alerting.ts принимает любое конечное неотрицательное число.
 * `ALERT_RATE_LIMIT_STORM_WINDOW_MINUTES=300000` (путаница «минуты vs
 * миллисекунды» — соседние ручки `WATCHDOG_INTERVAL_MS`, `HEALTH_INTERVAL_MS`
 * как раз в мс) даёт 1.8e10 мс, что не влезает в знаковый 32-битный int.
 *
 * setInterval на такую задержку печатает одну строку TimeoutOverflowWarning в
 * stderr и ставит период в 1 мс: `_alertingStormTick` начинает крутиться
 * тысячу раз в секунду, каждый раз выполняя COUNT(*) по общей ручке bun:sqlite,
 * которая обслуживает все 12 ботов и HTTP Mini App. Кулдаун гасит только сам
 * алерт, не запрос, так что в логах и аудите тихо — снаружи виден лишь
 * голодающий event loop без причины.
 *
 * Класс уже чинили: #688 (`e3375a76`) добавил потолок в `_envPositiveInt`
 * (orchestrator/services.ts) для watchdog/health/self-diag. Путь alerting его
 * не проходит: services.ts:320-327 передаёт в шедулер только dailyHourUTC и
 * archiveDays, а окно шторма читается из env внутри alerting.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { getThresholds, stormTickMs } from "../lib/alerting.ts";
import { MAX_TIMER_MS } from "../lib/constants.ts";

const VAR = "ALERT_RATE_LIMIT_STORM_WINDOW_MINUTES";
const prev = process.env[VAR];
const MIN_MS = 60_000;

afterEach(() => {
  // Без восстановления env течёт в соседние файлы (CLAUDE.md §3.8 п.7).
  if (prev === undefined) delete process.env[VAR];
  else process.env[VAR] = prev;
});

describe("предпосылка", () => {
  test("setInterval схлопывает задержку больше 2^31-1 в 1 мс", async () => {
    let ticks = 0;
    const t = setInterval(() => {
      ticks += 1;
    }, MAX_TIMER_MS + 1);
    await new Promise((r) => setTimeout(r, 40));
    clearInterval(t);
    // Смысл всей правки: отказа, по которому видно причину, здесь нет —
    // таймер просто начинает молотить.
    expect(ticks).toBeGreaterThan(5);
  });
});

describe("верхняя граница периода", () => {
  test("абсурдное окно из env не переполняет таймер", () => {
    process.env[VAR] = "300000";
    expect(getThresholds().rateLimitStormWindowMinutes).toBe(300000);
    expect(stormTickMs()).toBeLessThanOrEqual(MAX_TIMER_MS);
  });

  test("окно, переданное аргументом, тоже зажато", () => {
    for (const minutes of [35792, 100000, 1e9]) {
      expect(
        stormTickMs({ rateLimitStormWindowMinutes: minutes }),
      ).toBeLessThanOrEqual(MAX_TIMER_MS);
    }
  });

  test("последнее влезающее окно проходит как есть", () => {
    // 35791 мин = 2 147 460 000 мс — ещё помещается в знаковый 32-битный int.
    expect(stormTickMs({ rateLimitStormWindowMinutes: 35791 })).toBe(
      35791 * MIN_MS,
    );
  });
});

describe("прежние инварианты держатся", () => {
  test("период опроса не длиннее окна наблюдения", () => {
    for (const minutes of [1, 5, 15, 60, 35791]) {
      expect(
        stormTickMs({ rateLimitStormWindowMinutes: minutes }),
      ).toBeLessThanOrEqual(minutes * MIN_MS);
    }
  });

  test("нижняя граница в минуту на месте", () => {
    expect(stormTickMs({ rateLimitStormWindowMinutes: 0 })).toBe(MIN_MS);
  });

  test("зажатый период всё ещё не длиннее окна", () => {
    const minutes = 300000;
    expect(stormTickMs({ rateLimitStormWindowMinutes: minutes })).toBeLessThanOrEqual(
      minutes * MIN_MS,
    );
  });
});
