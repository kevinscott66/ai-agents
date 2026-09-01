/**
 * Аудит 2026-08-11: lib/telegram-chunking.ts до сих пор не имел ни одного теста,
 * хотя через него проходит каждый длинный ответ агента и каждая длинная подпись
 * к фото/документу — то есть всё, что уходит в чат и в канал.
 *
 * Найдено два дефекта.
 *
 * 1. Жёсткая резка длинной строки (`line.slice(i, i + limit)`) режет по UTF-16
 *    code units и разваливает суррогатную пару: часть заканчивается «половиной»
 *    эмодзи. Строка становится невалидной UTF-16 (isWellFormed() === false).
 *    Telegram такую не принимает — сообщение не уходит целиком, а не «уходит с
 *    кракозяброй». Ветка достижима на обычном тексте: абзац без переносов
 *    длиннее лимита (для подписи лимит всего 1000), а эмодзи в постах канала —
 *    норма, не редкость.
 *
 * 2. Части выходили длиннее заданного лимита. `pushChunk` решал, сбрасывать ли
 *    буфер, по длине ВМЕСТЕ с разделителем, а после сброса всё равно дописывал
 *    разделитель в начало пустого буфера: +2 символа к каждой части и +1 при
 *    резке по одиночному \n. Сейчас это гасится запасом (4000 при лимите
 *    Telegram 4096, 1000 при лимите подписи 1024) — то есть в проде пока не
 *    рвётся. Но контракт функции нарушен, а запас — единственное, что стоит
 *    между этим и 400 от Telegram: следующий вызов с limit = настоящему лимиту
 *    сломается молча.
 *
 * Инварианты: ни одна часть не длиннее лимита, ни одна не битая, ничего не
 * потеряно.
 */
import { describe, test, expect } from "bun:test";
import { splitForTelegram } from "../lib/telegram-chunking.ts";

/** Непробельные символы — по ним сверяем, что текст не потерялся. */
function dense(s: string): string {
  return s.replace(/\s/g, "");
}

function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe("splitForTelegram: части не длиннее лимита", () => {
  const L = 100;
  const CASES: { name: string; text: string }[] = [
    { name: "абзац ровно в лимит после текста", text: "x".repeat(50) + "\n\n" + "y".repeat(L) },
    { name: "подряд абзацы по лимиту", text: Array.from({ length: 5 }, () => "z".repeat(L)).join("\n\n") },
    { name: "строка ровно в лимит после текста", text: "x".repeat(50) + "\n" + "y".repeat(L) },
    { name: "длинная строка без переносов", text: "q".repeat(L * 3 + 7) },
    {
      name: "смешанный текст",
      text: "a".repeat(30) + "\n\n" + "b".repeat(L) + "\n" + "c".repeat(L) + "\n\n" + "d".repeat(5),
    },
    { name: "много коротких абзацев", text: Array.from({ length: 40 }, (_, i) => `абзац ${i} ` + "м".repeat(20)).join("\n\n") },
  ];

  for (const { name, text } of CASES) {
    test(name, () => {
      const parts = splitForTelegram(text, L);
      for (const p of parts) expect(p.length).toBeLessThanOrEqual(L);
      expect(dense(parts.join(""))).toBe(dense(text));
    });
  }

  test("подпись к фото: лимит 1000 держится", () => {
    const caption = "п".repeat(999) + "\n\n" + "х".repeat(1000);
    const parts = splitForTelegram(caption, 1000);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(1000);
    expect(dense(parts.join(""))).toBe(dense(caption));
  });

  test("текст короче лимита возвращается одной частью как есть", () => {
    expect(splitForTelegram("коротко", 100)).toEqual(["коротко"]);
  });
});

describe("splitForTelegram: эмодзи не разваливаются пополам", () => {
  test("жёсткая резка не оставляет половину суррогатной пары", () => {
    // Нечётный лимит гарантированно попадает в середину пары.
    const line = "🚀".repeat(60);
    for (const limit of [11, 51, 99]) {
      const parts = splitForTelegram(line, limit);
      for (const p of parts) {
        expect(hasLoneSurrogate(p)).toBe(false);
        expect(p.length).toBeLessThanOrEqual(limit);
      }
      expect(parts.join("")).toBe(line);
    }
  });

  test("эмодзи вперемешку с текстом переживают резку", () => {
    const line = Array.from({ length: 200 }, (_, i) => `${i}🎯мы🚀`).join("");
    const parts = splitForTelegram(line, 137);
    for (const p of parts) {
      expect(hasLoneSurrogate(p)).toBe(false);
      expect(p.length).toBeLessThanOrEqual(137);
    }
    expect(parts.join("")).toBe(line);
  });

  test("абзац из эмодзи режется по границам символов", () => {
    const text = "заголовок\n\n" + "😀".repeat(200) + "\n\nхвост";
    const parts = splitForTelegram(text, 90);
    for (const p of parts) {
      expect(hasLoneSurrogate(p)).toBe(false);
      expect(p.length).toBeLessThanOrEqual(90);
    }
    expect(dense(parts.join(""))).toBe(dense(text));
  });
});
