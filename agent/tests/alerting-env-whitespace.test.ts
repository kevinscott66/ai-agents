/**
 * Аудит 2026-08-20: `envInt` в alerting.ts не тримил значение.
 *
 * `Number("  ")` === 0, а ноль в этом модуле по контракту (шапка «Thresholds»)
 * означает «алерт выключен». То есть `ALERT_X=` (пусто) читалось как «дефолт»,
 * а `ALERT_X= ` — лишний пробел после знака равенства, самая обычная опечатка
 * при правке .env руками — навсегда глушило алерт, без единой строчки в логе.
 *
 * Для окна шторма это ещё хуже: window=0 делает выборку пустой при любом числе
 * отказов (winStart === now), при этом stormTickMs клэмпит период снизу до
 * минуты — тик продолжает исправно тикать, а проверка внутри мертва.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { getThresholds, stormTickMs } from "../lib/alerting.ts";

const KEYS = [
  "ALERT_APPROVAL_BACKLOG_MIN",
  "ALERT_APPROVAL_BACKLOG_AGE_MINUTES",
  "ALERT_APPROVAL_BACKLOG_COOLDOWN_MINUTES",
  "ALERT_RATE_LIMIT_STORM_COUNT",
  "ALERT_RATE_LIMIT_STORM_WINDOW_MINUTES",
  "ALERT_RATE_LIMIT_STORM_COOLDOWN_MINUTES",
] as const;

describe("alerting: пробельные env не выключают алерты", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    for (const k of KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });

  test("дефолты без env", () => {
    const t = getThresholds();
    expect(t.rateLimitStormCount).toBe(50);
    expect(t.rateLimitStormWindowMinutes).toBe(5);
    expect(t.approvalBacklogMin).toBe(10);
  });

  test("значение из одного пробела читается как «не задано»", () => {
    process.env.ALERT_RATE_LIMIT_STORM_COUNT = " ";
    expect(getThresholds().rateLimitStormCount).toBe(50);
  });

  test("таб и перевод строки — тоже «не задано»", () => {
    process.env.ALERT_APPROVAL_BACKLOG_MIN = "\t";
    process.env.ALERT_APPROVAL_BACKLOG_AGE_MINUTES = "\n";
    const t = getThresholds();
    expect(t.approvalBacklogMin).toBe(10);
    expect(t.approvalBacklogAgeMinutes).toBe(60);
  });

  test("пробел в окне шторма не обнуляет окно", () => {
    // Именно этот случай делал детектор шторма мёртвым при живом шедулере.
    process.env.ALERT_RATE_LIMIT_STORM_WINDOW_MINUTES = "  ";
    expect(getThresholds().rateLimitStormWindowMinutes).toBe(5);
    expect(stormTickMs()).toBe(5 * 60_000);
  });

  test("число с пробелами по краям читается как число", () => {
    process.env.ALERT_RATE_LIMIT_STORM_COUNT = " 25 ";
    expect(getThresholds().rateLimitStormCount).toBe(25);
  });

  test("явный ноль по-прежнему выключает алерт", () => {
    // Осознанное «выключить» ломать нельзя — это документированный контракт.
    process.env.ALERT_RATE_LIMIT_STORM_COUNT = "0";
    expect(getThresholds().rateLimitStormCount).toBe(0);
  });

  test("мусор по-прежнему падает на дефолт", () => {
    process.env.ALERT_APPROVAL_BACKLOG_MIN = "много";
    process.env.ALERT_RATE_LIMIT_STORM_COUNT = "-5";
    const t = getThresholds();
    expect(t.approvalBacklogMin).toBe(10);
    expect(t.rateLimitStormCount).toBe(50);
  });
});
