/**
 * Аудит 2026-08-28: резка переписывала текст, который ей дали.
 *
 * `splitForTelegram` резала по `/\n\n+/`, а собирала жёстким `"\n\n"`: любой
 * пробел в три и более перевода строки необратимо схлопывался в два. Текст
 * короче лимита это не задевало (для него есть ранний возврат `fits(text)`),
 * поэтому все тесты ниже работают на текстах, которые реально режутся.
 *
 * Заметнее всего внутри ```-блока, где пустые строки — часть кода: PEP 8
 * отделяет функции верхнего уровня ровно двумя пустыми строками, то есть
 * тремя переводами. После отправки их оставалось две — и это молчаливая
 * правка чужого кода на пути к чату.
 */
import { describe, expect, test } from "bun:test";
import { splitForTelegram } from "../lib/telegram-chunking.ts";

const LIMIT = 80;

describe("разделители внутри части сохраняются как есть", () => {
  test("тройной перевод в первой части остаётся тройным", () => {
    const head = `${"a".repeat(20)}\n\n\n${"b".repeat(20)}`;
    const out = splitForTelegram(`${head}\n\n${"c".repeat(70)}`, LIMIT);
    expect(out).toEqual([head, "c".repeat(70)]);
  });

  test("пустые строки внутри блока кода не схлопываются", () => {
    const code = ["```python", "def a():", "    pass", "", "", "def b():", "    pass", "```"].join(
      "\n",
    );
    const out = splitForTelegram(`${code}\n\n${"x".repeat(70)}`, LIMIT);
    expect(out[0]).toBe(code);
    expect(out[1]).toBe("x".repeat(70));
  });

  test("каждый разделитель сохраняет собственную длину", () => {
    const head = `${"a".repeat(10)}\n\n${"b".repeat(10)}\n\n\n\n${"c".repeat(10)}`;
    const out = splitForTelegram(`${head}\n\n${"d".repeat(70)}`, LIMIT);
    expect(out).toEqual([head, "d".repeat(70)]);
  });
});

describe("резка по-прежнему считает разделитель", () => {
  test("части не выходят за лимит", () => {
    const text = ["a".repeat(50), "b".repeat(50), "c".repeat(50)].join("\n\n\n\n");
    const out = splitForTelegram(text, LIMIT);
    expect(out.length).toBe(3);
    for (const part of out) expect(part.length).toBeLessThanOrEqual(LIMIT);
  });

  test("длинный разделитель, из-за которого часть перестаёт влезать, переносит абзац", () => {
    // 40 + 40 = 80 влезает; те же 40 + 40 плюс шесть переводов — уже нет.
    const a = "a".repeat(40);
    const b = "b".repeat(40);
    expect(splitForTelegram(`${a}\n\n\n\n\n\n${b}`, LIMIT)).toEqual([a, b]);
  });

  test("пустых частей не появляется", () => {
    const out = splitForTelegram(`\n\n\n${"a".repeat(50)}\n\n\n\n${"b".repeat(50)}\n\n\n`, LIMIT);
    expect(out).toEqual(["a".repeat(50), "b".repeat(50)]);
  });
});
