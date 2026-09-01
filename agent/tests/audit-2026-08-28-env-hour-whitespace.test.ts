/**
 * Аудит 2026-08-28: пробел в конфиге бесшумно переносил дайджест и обслуживание БД.
 *
 * `DIGEST_HOUR_UTC` и `DB_MAINT_HOUR_UTC` читались тернарником
 * `process.env.X ? Number(process.env.X) : def`. У этих двух переменных ноль —
 * законное значение (полночь UTC), поэтому санитайзеры ниже по стеку
 * (`sanitizeHourUTC` в digest.ts, `sanitizeMaintOpt` в db-maint.ts) его
 * пропускают молча. А `KEY= ` в systemd EnvironmentFile даёт `" "`: truthy для
 * тернарника и ноль для `Number`.
 *
 * Итог до правки — дайджест в 00:00 UTC вместо 06:00 и суточный archive+VACUUM
 * в 00:00 вместо 04:00, без единой строки в логе. Тот же класс, что уже
 * закрыт в lib/alerting.ts:79-95.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { _envHour } from "../orchestrator/services.ts";

const VAR = "TEST_HOUR_WHITESPACE_PROBE";
const prev = process.env[VAR];

afterEach(() => {
  // CLAUDE.md §3.8 п.7: env восстанавливаем всегда.
  if (prev === undefined) delete process.env[VAR];
  else process.env[VAR] = prev;
});

const SRC = readFileSync(new URL("../orchestrator/services.ts", import.meta.url), "utf-8");

describe("предпосылки", () => {
  test("пробельное значение truthy, а Number от него — законный час", () => {
    // Ровно эта пара свойств и делала подмену бесшумной.
    expect(Boolean(" ")).toBe(true);
    expect(Number(" ")).toBe(0);
    expect(Number("\t\n")).toBe(0);
    // Пустая строка тоже даёт ноль — поэтому trim обязан стоять ДО Number.
    expect(Number("")).toBe(0);
  });
});

describe("_envHour", () => {
  test("пробельное значение — дефолт, а не полночь", () => {
    for (const bad of [" ", "  ", "\t", "\n", " \t "]) {
      process.env[VAR] = bad;
      expect(_envHour(VAR, 6)).toBe(6);
      expect(_envHour(VAR, 4)).toBe(4);
    }
  });

  test("пусто и отсутствие — дефолт", () => {
    process.env[VAR] = "";
    expect(_envHour(VAR, 6)).toBe(6);
    delete process.env[VAR];
    expect(_envHour(VAR, 6)).toBe(6);
  });

  test("ноль, заданный явно, остаётся полночью", () => {
    // Главное, чего нельзя сломать по дороге: 0 — рабочее значение.
    process.env[VAR] = "0";
    expect(_envHour(VAR, 6)).toBe(0);
    process.env[VAR] = " 0 ";
    expect(_envHour(VAR, 6)).toBe(0);
  });

  test("границы включительно", () => {
    for (const [raw, want] of [
      ["0", 0],
      ["1", 1],
      ["6", 6],
      ["23", 23],
    ] as const) {
      process.env[VAR] = raw;
      expect(_envHour(VAR, 6)).toBe(want);
    }
  });

  test("вне диапазона, дробное и мусор — дефолт", () => {
    for (const bad of ["24", "-1", "100", "6.5", "abc", "6abc", "NaN"]) {
      process.env[VAR] = bad;
      expect(_envHour(VAR, 6)).toBe(6);
    }
  });
});

describe("применение", () => {
  test("оба часовых env читаются санитайзером, а не тернарником", () => {
    expect(SRC).toContain('_envHour("DIGEST_HOUR_UTC", 6)');
    expect(SRC).toContain('_envHour("DB_MAINT_HOUR_UTC", 4)');
    // Исполняемых строк со старым тернарником не осталось (в докстринге он
    // процитирован — source-guard на собственном тексте ломается от правки).
    const hits = SRC.split("\n").filter((l) => {
      const t = l.trimStart();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return false;
      return l.includes("process.env.DIGEST_HOUR_UTC") || l.includes("process.env.DB_MAINT_HOUR_UTC");
    });
    expect(hits).toEqual([]);
  });
});
