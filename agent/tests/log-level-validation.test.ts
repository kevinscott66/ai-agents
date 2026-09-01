/**
 * Аудит 2026-08-12: опечатка в LOG_LEVEL тихо включала debug-логи в проде.
 *
 * Было:
 *   const envLevel = process.env.LOG_LEVEL as LogLevel;
 *   this.level = envLevel || (this.isProduction ? 'info' : 'debug');
 *   ...
 *   return levels.indexOf(level) >= levels.indexOf(this.level);
 *
 * Значение не проверялось. Любая строка вне набора — `verbose`, `INFO` в
 * верхнем регистре, `warning`, лишний пробел — даёт `indexOf(this.level) === -1`,
 * и условие становится истинным ДЛЯ ВСЕХ уровней, включая debug. То есть
 * «не тот регистр» выглядит рабочей настройкой, а фактически открывает
 * debug-поток целиком.
 *
 * Направление отказа — «логировать больше, чем просили»: в journalctl уезжает
 * то, что в проде видеть не собирались. Достаточно одной строки в
 * /opt/agent-team/.env, и никакого сигнала об ошибке нет.
 *
 * Инвариант: уровень логирования — только из известного набора. Незнакомое
 * значение не понижает порог молча: берём дефолт и говорим об этом вслух.
 */
import { describe, test, expect } from "bun:test";
import { resolveLogLevel } from "../lib/log.ts";

describe("resolveLogLevel: известные значения", () => {
  test("валидный уровень принимается как есть", () => {
    for (const l of ["debug", "info", "warn", "error"] as const) {
      expect(resolveLogLevel(l, true)).toBe(l);
    }
  });

  test("регистр и пробелы нормализуются, а не отбрасываются", () => {
    expect(resolveLogLevel("INFO", true)).toBe("info");
    expect(resolveLogLevel("  Warn  ", true)).toBe("warn");
  });
});

describe("resolveLogLevel: незнакомое значение не открывает debug", () => {
  test("мусор в проде даёт info, а не debug", () => {
    for (const junk of ["verbose", "warning", "trace", "1", "true", "-"]) {
      expect(resolveLogLevel(junk, true)).toBe("info");
    }
  });

  test("мусор локально даёт локальный дефолт", () => {
    expect(resolveLogLevel("verbose", false)).toBe("debug");
  });

  test("пусто/undefined — обычный дефолт по окружению", () => {
    expect(resolveLogLevel(undefined, true)).toBe("info");
    expect(resolveLogLevel("", true)).toBe("info");
    expect(resolveLogLevel("   ", true)).toBe("info");
    expect(resolveLogLevel(undefined, false)).toBe("debug");
  });
});
