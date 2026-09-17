/**
 * Аудит 2026-08-28: потолок одновременных вызовов к Anthropic никто не проверял.
 *
 * `Math.max(1, Number(process.env.ANTHROPIC_MAX_CONCURRENCY ?? "3") || 3)` —
 * единственная проверка на всю настройку. Три дыры, все наблюдаемые:
 *
 *  1. **Дробное доезжает целиком.** `"2.5"` даёт 2.5, а слот выдаётся по
 *     `active < MAX_CONCURRENCY` (:121) — то есть при active=2 условие ещё
 *     истинно и в полёте оказывается ТРИ запроса при настройке «2.5».
 *     Ограничитель, который сам себя перевыполняет, — это не ограничитель.
 *  2. **Верхней границы нет вовсе.** `ANTHROPIC_MAX_CONCURRENCY=30` (лишняя
 *     цифра в 3 — ровно паттерн аудита #688 про порт) пролезает и снимает
 *     защиту от org-лимита input tokens/min, ради которой весь модуль и
 *     написан. Ролей в команде 12, больше одновременных вызовов взяться
 *     неоткуда.
 *  3. **Мусор молча становится тройкой.** `"abc"`, `" "`, `"0"` — все дают 3
 *     без единой строчки в лог. Значение читается один раз при импорте из
 *     systemd EnvironmentFile, где опечатку никто не увидит.
 *
 * Соседи по классу уже вычищены так же: `envInt` (alerting.ts),
 * `parseBudgetEnv` (token-budget.ts), `_envPort` (services.ts, аудит
 * 2026-08-28).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  MAX_CONCURRENCY,
  MAX_CONCURRENCY_CAP,
  _resolveMaxConcurrency,
} from "../lib/anthropic-client.ts";
import { CHARACTERS } from "../characters/index.ts";

const SRC = readFileSync(new URL("../lib/anthropic-client.ts", import.meta.url), "utf-8");

describe("предпосылки", () => {
  test("слот выдаётся строгим сравнением — дробный потолок округляется вверх", () => {
    // Именно поэтому дробное значение опаснее, чем кажется: при потолке 2.5
    // условие `active < 2.5` пропускает третий запрос.
    expect(SRC).toContain("if (active < MAX_CONCURRENCY) {");
    let active = 0;
    while (active < 2.5) active++;
    expect(active).toBe(3);
  });

  test("прежняя формула пропускала и дробное, и лишнюю цифру", () => {
    const old = (raw: string) => Math.max(1, Number(raw ?? "3") || 3);
    expect(old("2.5")).toBe(2.5);
    expect(old("30")).toBe(30);
    expect(old("abc")).toBe(3);
  });
});

describe("_resolveMaxConcurrency", () => {
  test("рабочие значения проходят как есть, границы включительно", () => {
    for (const [raw, want] of [
      ["1", 1],
      ["3", 3],
      ["12", 12],
      [String(MAX_CONCURRENCY_CAP), MAX_CONCURRENCY_CAP],
    ] as const) {
      expect(_resolveMaxConcurrency(raw)).toBe(want);
    }
  });

  test("пробелы по краям не мешают", () => {
    expect(_resolveMaxConcurrency("  5  ")).toBe(5);
  });

  test("дробное — дефолт, а не 2.5", () => {
    for (const bad of ["2.5", "3.0", "1e1", ".5"]) {
      expect(_resolveMaxConcurrency(bad)).toBe(3);
    }
  });

  test("выше потолка — дефолт, а не сам потолок", () => {
    // Зажать в 16 значило бы всё равно уйти в шестнадцать параллельных
    // вызовов по опечатке. Дефолт — единственное значение, про которое точно
    // известно, что оно работало.
    for (const bad of [String(MAX_CONCURRENCY_CAP + 1), "30", "100", "2147483647"]) {
      expect(_resolveMaxConcurrency(bad)).toBe(3);
    }
  });

  test("ноль, отрицательное и мусор — дефолт", () => {
    for (const bad of ["0", "-1", "-5", "abc", "3abc", "+3", "3 3", "٣"]) {
      expect(_resolveMaxConcurrency(bad)).toBe(3);
    }
  });

  test("пусто, пробелы и отсутствие — дефолт", () => {
    expect(_resolveMaxConcurrency("")).toBe(3);
    expect(_resolveMaxConcurrency("   ")).toBe(3);
    expect(_resolveMaxConcurrency(undefined)).toBe(3);
  });

  test("результат всегда целое в допустимом диапазоне", () => {
    const raws = ["", " ", "0", "1", "2.5", "12", "16", "17", "30", "abc", undefined];
    for (const raw of raws) {
      const n = _resolveMaxConcurrency(raw);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(MAX_CONCURRENCY_CAP);
    }
  });
});

describe("потолок", () => {
  test("потолок не ниже числа ролей — команде хватает по вызову на роль", () => {
    expect(MAX_CONCURRENCY_CAP).toBeGreaterThanOrEqual(CHARACTERS.length);
  });

  test("потолок ловит лишнюю цифру в дефолте", () => {
    expect(MAX_CONCURRENCY_CAP).toBeLessThan(30);
  });
});

describe("применение", () => {
  test("MAX_CONCURRENCY считается санитайзером, а не голым Number", () => {
    expect(SRC).toContain(
      "export const MAX_CONCURRENCY = _resolveMaxConcurrency(process.env.ANTHROPIC_MAX_CONCURRENCY);",
    );
    expect(SRC).not.toContain('Number(process.env.ANTHROPIC_MAX_CONCURRENCY ?? "3")');
  });

  test("боевое значение осталось рабочим", () => {
    expect(Number.isInteger(MAX_CONCURRENCY)).toBe(true);
    expect(MAX_CONCURRENCY).toBeGreaterThanOrEqual(1);
    expect(MAX_CONCURRENCY).toBeLessThanOrEqual(MAX_CONCURRENCY_CAP);
  });

  test("отвергнутое значение не проглатывается молча", () => {
    expect(SRC).toContain("[anthropic] ANTHROPIC_MAX_CONCURRENCY");
  });
});
