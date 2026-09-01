/**
 * Аудит 2026-08-08: parseIntOr возвращал дробь и ронял запрос в 500.
 *
 * Имя обещало Int, реализация — нет: Number("1.5") конечен и > 0, Math.min
 * дробь сохраняет. Все четыре вызова (miniapp-server: /api/tasks, /api/actions,
 * /api/messages, /api/audit) биндят результат в `LIMIT ?`, где bun:sqlite
 * отвечает `datatype mismatch`. Ошибку подбирал общий catch → 500 без причины.
 */
import { describe, test, expect } from "bun:test";
import { parseIntOr } from "../lib/http-utils.ts";
import { db } from "../lib/db.ts";

describe("parseIntOr", () => {
  test("дробное значение округляется вниз, а не проезжает насквозь", () => {
    expect(parseIntOr("1.5", 20)).toBe(1);
    expect(parseIntOr("99.9", 20, 500)).toBe(99);
    expect(Number.isInteger(parseIntOr("7.7", 20, 500))).toBe(true);
  });

  test("дробь ниже единицы — это не «ноль элементов», а дефолт", () => {
    // Math.floor(0.5) === 0, а LIMIT 0 вернул бы пустой список — молча пустой
    // экран вместо данных. Такое значение бессмысленно, поэтому дефолт.
    expect(parseIntOr("0.5", 20)).toBe(20);
  });

  test("результат годится для bun:sqlite LIMIT — драйвер дробь не принимает", () => {
    const limit = parseIntOr("2.9", 20, 500);
    const run = () => db.prepare(`SELECT 1 AS x LIMIT ?`).all(limit);
    expect(run).not.toThrow();
    // Контроль: именно дробь драйвер и отвергал.
    expect(() => db.prepare(`SELECT 1 AS x LIMIT ?`).all(2.9)).toThrow();
  });

  test("обычные случаи не изменились", () => {
    expect(parseIntOr(null, 20)).toBe(20);
    expect(parseIntOr("", 20)).toBe(20);
    expect(parseIntOr("abc", 20)).toBe(20);
    expect(parseIntOr("0", 20)).toBe(20);
    expect(parseIntOr("-5", 20)).toBe(20);
    expect(parseIntOr("50", 20)).toBe(50);
    expect(parseIntOr("9000", 20, 500)).toBe(500);
  });
});
