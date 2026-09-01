import { describe, expect, it } from "bun:test";
import { splitForTelegram } from "../lib/telegram-chunking.ts";

/**
 * Аудит 2026-08-27: замер куска против УСТАРЕВШЕГО `carry`.
 *
 * `splitForTelegram` подменяет `fits` замыканием над изменяемым `carry`
 * (незакрытый блок кода с прошлой части — его допишет `balanceFences`, значит
 * и мерить надо вместе с ним). Решение «влезает ли абзац» вызывающий принимал
 * ДО того, как `pushChunk` сбрасывал буфер, а сброс двигает `carry`. Абзац,
 * влезавший при закрытом блоке, после сброса ехал с дописанной открывашкой и
 * закрывашкой — до восьми символов сверх лимита.
 *
 * В проде это гасил запас (4000 против 4096), но запас — единственное, что
 * стоит между этим и 400 от Telegram, и тратить его на арифметику нельзя.
 */
describe("splitForTelegram: carry не должен утекать мимо замера", () => {
  const LIMIT = 60;
  const FENCE_OPEN = "```\n" + "a".repeat(40);

  it("абзац за незакрытым фенсом не вылезает за лимит (последняя часть)", () => {
    const parts = splitForTelegram(`${FENCE_OPEN}\n\n${"b".repeat(57)}`, LIMIT);
    expect(parts.map((p) => p.length).filter((n) => n > LIMIT)).toEqual([]);
  });

  it("абзац за незакрытым фенсом не вылезает за лимит (середина)", () => {
    const text = `${FENCE_OPEN}\n\n${"b".repeat(53)}\n\n${"c".repeat(50)}`;
    const parts = splitForTelegram(text, LIMIT);
    expect(parts.map((p) => p.length).filter((n) => n > LIMIT)).toEqual([]);
  });

  it("строка за незакрытым фенсом не вылезает за лимит", () => {
    // Резка по одиночному \n — тот же вызывающий, тот же устаревший замер.
    const text = `${FENCE_OPEN}\n\n${"b".repeat(53)}\n${"c".repeat(53)}`;
    const parts = splitForTelegram(text, LIMIT);
    expect(parts.map((p) => p.length).filter((n) => n > LIMIT)).toEqual([]);
  });

  it("текст не теряется: буквы сохраняются в исходном порядке", () => {
    const text = `${FENCE_OPEN}\n\n${"b".repeat(53)}\n\n${"c".repeat(50)}`;
    const letters = (s: string) => s.replace(/[^abc]/g, "");
    expect(letters(splitForTelegram(text, LIMIT).join("\n"))).toBe(letters(text));
  });

  it("без блоков кода поведение прежнее — абзацы склеиваются до лимита", () => {
    const text = `${"a".repeat(20)}\n\n${"b".repeat(20)}\n\n${"c".repeat(50)}`;
    expect(splitForTelegram(text, LIMIT)).toEqual([
      `${"a".repeat(20)}\n\n${"b".repeat(20)}`,
      "c".repeat(50),
    ]);
  });
});
