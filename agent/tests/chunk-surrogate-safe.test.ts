/**
 * Аудит 2026-08-12: жёсткая дорезка длинной строки рвала эмодзи пополам.
 *
 * tools/daily-draft.ts, chunkForTelegram:
 *
 *   while (line.length > limit) {
 *     flush();
 *     out.push(line.slice(0, limit));
 *     line = line.slice(limit);
 *   }
 *
 * `String.length` считает кодовые единицы UTF-16, и эмодзи вне BMP («🔥», «💰»,
 * «🌐» — ровно те, что расставляет сам дайджест) занимает две. Если граница
 * приходится между ними, получаются два одиноких суррогата: хвост первого
 * сообщения и голова второго. Замер на строке из 🔥 при limit = 5:
 *
 *   часть 1 = "🔥🔥\uD83D"   (последний код 0xD83D, isWellFormed() === false)
 *   часть 2 = "\uDD25🔥…"    (начинается с 0xDD25)
 *
 * Такой текст Telegram отдаёт как «�» — в публичном канале это видно, а на
 * стороне Bot API невалидный UTF-8 в теле запроса может кончиться и отказом.
 * Путь рабочий: chunkForTelegram режет черновик на аппрув, а лимит подписи при
 * повторе по caption_too_long падает до 600 — окно только шире.
 *
 * Инвариант: ни одна часть не начинается и не заканчивается половиной пары —
 * каждая часть остаётся корректной строкой (isWellFormed), склейка частей
 * равна исходному тексту, и ни одна часть не превышает лимит.
 */
import { describe, test, expect } from "bun:test";
import { chunkForTelegram } from "../tools/daily-draft.ts";

const FIRE = "🔥"; // U+1F525 — две кодовые единицы

describe("chunkForTelegram: дорезка не рвёт суррогатные пары", () => {
  test("нечётная граница по эмодзи не даёт одиноких суррогатов", () => {
    const parts = chunkForTelegram(FIRE.repeat(20), 5);
    for (const p of parts) expect(p.isWellFormed()).toBe(true);
  });

  test("текст не теряется и не дублируется", () => {
    const src = FIRE.repeat(20);
    expect(chunkForTelegram(src, 5).join("")).toBe(src);
  });

  test("лимит соблюдён при любой нечётной границе", () => {
    for (const limit of [3, 5, 7, 9, 11]) {
      const parts = chunkForTelegram(FIRE.repeat(30), limit);
      for (const p of parts) {
        expect(p.length).toBeLessThanOrEqual(limit);
        expect(p.isWellFormed()).toBe(true);
      }
      expect(parts.join("")).toBe(FIRE.repeat(30));
    }
  });

  test("смешанный текст: латиница + эмодзи + кириллица", () => {
    const src = `${"ab🔥вг💰".repeat(40)}`;
    const parts = chunkForTelegram(src, 17);
    expect(parts.join("")).toBe(src);
    for (const p of parts) expect(p.isWellFormed()).toBe(true);
  });

  test("обычный текст режется как раньше — по строкам", () => {
    const parts = chunkForTelegram("aaa\nbbb\nccc", 7);
    expect(parts).toEqual(["aaa\nbbb", "ccc"]);
  });

  test("эмодзи ровно на границе не сдвигает её без нужды", () => {
    // limit = 6 — три пары ровно, резать посередине не нужно.
    expect(chunkForTelegram(FIRE.repeat(6), 6)).toEqual([
      FIRE.repeat(3),
      FIRE.repeat(3),
    ]);
  });
});
