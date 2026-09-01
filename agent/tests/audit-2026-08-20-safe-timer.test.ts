/**
 * Аудит 2026-08-20, пара к фиксу uncaughtException.
 *
 * Пока глобальный обработчик глушил всё подряд, исключение из колбэка
 * setInterval стоило строки в логе, и следующий тик приходил как ни в чём не
 * бывало. Как только необработанное исключение начинает валить процесс,
 * каждая голая граница таймера превращается в рестарт сервиса от рядового
 * SQLITE_BUSY. Для планировщика упавший тик — ожидаемое событие, а не
 * неизвестное состояние: работа инкрементальная, следующий тик догонит.
 *
 * Проверяем ровно это: исключение остаётся внутри границы, а таймер живёт.
 */
import { describe, test, expect } from "bun:test";
import { safeTick } from "../lib/safe-timer.ts";

describe("safeTick", () => {
  test("синхронный throw не выходит за границу", () => {
    const wrapped = safeTick("t", () => {
      throw new Error("SQLITE_BUSY");
    });
    expect(() => wrapped()).not.toThrow();
  });

  test("следующий тик всё равно случается", () => {
    let n = 0;
    const wrapped = safeTick("t", () => {
      n++;
      if (n === 1) throw new Error("первый упал");
    });
    wrapped();
    wrapped();
    // Второй вызов не был отменён падением первого — это и есть «догонит».
    expect(n).toBe(2);
  });

  test("reject асинхронного колбэка тоже не улетает наружу", async () => {
    let settled = false;
    const wrapped = safeTick("t", async () => {
      settled = true;
      throw new Error("async упал");
    });
    wrapped();
    // Даём микрозадачам провернуться: без catch внутри это был бы
    // unhandledRejection — анонимная строка без имени таймера.
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(true);
  });

  test("успешный колбэк проходит без изменений, значение не требуется", () => {
    const seen: number[] = [];
    const wrapped = safeTick("t", () => void seen.push(1));
    wrapped();
    wrapped();
    expect(seen).toEqual([1, 1]);
  });

  test("не-Error бросок тоже удерживается", () => {
    const wrapped = safeTick("t", () => {
      // eslint-disable-next-line no-throw-literal
      throw "строка вместо Error";
    });
    expect(() => wrapped()).not.toThrow();
  });
});
