/**
 * Аудит 2026-08-12: сущность расширялась только на VS16 — тон и ZWJ рвали графему.
 *
 * `matchAt` (lib/custom-emoji-map.ts) после совпадения ключа проверяет ровно
 * один соседний символ — селектор варианта. Всё остальное, что делает эмодзи
 * одной графемой, остаётся снаружи:
 *
 *   "👍🏻 Отлично"  → одна сущность offset 0 length 2, а модификатор тона
 *                    U+1F3FB (2 code units) висит ЗА границей: Telegram
 *                    подменяет накрытые 2 единицы анимированным стикером, а
 *                    осиротевший модификатор остаётся в тексте отдельным
 *                    символом-квадратом.
 *   "❤️‍🔥"          → 2764 FE0F 200D 1F525: сущность (0,2) на «❤️» и вторая
 *                    (3,2) на «🔥» — ОДНА графема разрезана на ДВА разных
 *                    анимированных стикера с ZWJ между ними.
 *
 * Правило то же, что уже записано в комментарии функции: модификатор обязан
 * попасть ВНУТРЬ границ сущности. Для тона — расширяем. Для ZWJ-составного
 * эмодзи расширять нельзя: у составного своя картинка, и накрыть «❤️‍🔥»
 * стикером «❤️» — это подмена символа, а не оживление. Такие пропускаем: живой
 * настоящий эмодзи лучше неправильного стикера.
 *
 * Путь до прода: `buildHandle().publishPost` в userbot.ts и approve-poll.ts
 * (публикация) плюс превью
 * в tools/daily-draft.ts — тот же класс, что и фикс e83206d по VS16.
 */
import { describe, test, expect } from "bun:test";
import { buildCustomEmojiEntities, DELABS_EMOJI } from "../lib/custom-emoji-map.ts";

interface Ent {
  offset: number;
  length: number;
}

function ents(text: string): Ent[] {
  return buildCustomEmojiEntities(text).map((e) => {
    const x = e as unknown as Ent;
    return { offset: x.offset, length: x.length };
  });
}

/** Ни одна сущность не оставляет за границей часть той же графемы. */
function noOrphans(text: string) {
  const SKIN = /[\u{1F3FB}-\u{1F3FF}]/u;
  for (const e of ents(text)) {
    const after = text.slice(e.offset + e.length);
    expect(after.startsWith("️")).toBe(false);
    expect(after.startsWith("‍")).toBe(false);
    expect(SKIN.test(after.slice(0, 2)) && after.length >= 2).toBe(false);
    const before = text.slice(0, e.offset);
    expect(before.endsWith("‍")).toBe(false);
  }
}

describe("границы кастом-эмодзи совпадают с графемой", () => {
  test("модификатор тона не остаётся снаружи", () => {
    const text = "👍🏻 Отлично";
    const e = ents(text);
    expect(e).toHaveLength(1);
    expect(e[0]).toEqual({ offset: 0, length: 4 });
    noOrphans(text);
  });

  test("все пять тонов ведут себя одинаково", () => {
    for (const tone of ["\u{1F3FB}", "\u{1F3FC}", "\u{1F3FD}", "\u{1F3FE}", "\u{1F3FF}"]) {
      const text = `👍${tone} ок`;
      expect(ents(text)).toEqual([{ offset: 0, length: 4 }]);
    }
  });

  test("ZWJ-составной эмодзи не разрезается на два стикера", () => {
    const text = "❤️‍🔥 огонь";
    // Ни одной сущности: у составного своя картинка, подменять её нельзя.
    expect(ents(text)).toEqual([]);
    noOrphans(text);
  });

  test("одиночный эмодзи из словаря по-прежнему оживает", () => {
    expect(ents("🔥 жарко")).toEqual([{ offset: 0, length: 2 }]);
    expect(ents("Итоги ✅")).toEqual([{ offset: 6, length: 1 }]);
  });

  test("селектор варианта по-прежнему внутри границ", () => {
    // Регрессия на фикс e83206d: «❤» в словаре без селектора, в тексте — с ним.
    const text = "❤️ спасибо";
    expect(ents(text)).toEqual([{ offset: 0, length: 2 }]);
    noOrphans(text);
  });

  test("реальный пост канала: ни одного осиротевшего модификатора", () => {
    const text = [
      "🔥 Главное за неделю 👍🏽",
      "",
      "✅ Дроп подтверждён 🤩",
      "❤️‍🔥 Рекорд по активностям",
      "👇 Подробности ниже ⭐️",
    ].join("\n");
    noOrphans(text);
    // Обычные эмодзи словаря никуда не делись.
    expect(ents(text).length).toBeGreaterThanOrEqual(5);
  });

  test("сущности не пересекаются и лежат в границах текста", () => {
    const text = "🔥👍🏻❤️‍🔥✅⭐️🤩";
    let prevEnd = 0;
    for (const e of ents(text)) {
      expect(e.offset).toBeGreaterThanOrEqual(prevEnd);
      expect(e.offset + e.length).toBeLessThanOrEqual(text.length);
      prevEnd = e.offset + e.length;
    }
    noOrphans(text);
  });

  test("словарь не потерял ключей", () => {
    expect(Object.keys(DELABS_EMOJI).length).toBeGreaterThan(25);
  });
});
