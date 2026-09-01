/**
 * Аудит 2026-08-29: у числа кастом-эмодзи в сообщении не было потолка.
 *
 * `buildCustomEmojiEntities` вешал сущность на КАЖДОЕ совпадение со словарём,
 * сколько бы их ни нашлось. Оба боевых вызова шлют результат склеенным с
 * разметкой (`[...fmtEntities, ...buildCustomEmojiEntities(...)]`,
 * `publishPost` в lib/userbot.ts), то есть в один и тот же серверный лимит.
 *
 * Это не теоретический перебор: недельный дайджест — два-три десятка позиций,
 * у каждой свой значок, плюс сущности разметки от HTMLParser на тех же
 * строках. Перебор сервер отклоняет целиком, а у юзербот-пути фолбэка нет:
 * `publishPost` ошибку не ловит, и на подходе к нему пост УЖЕ одобрен
 * владельцем — апрув сгорает, поста нет.
 *
 * Обрезка безопасна ровно потому, что функция не меняет текст: символ эмодзи
 * остаётся на месте, лишние позиции просто покажутся обычным эмодзи вместо
 * анимированного.
 */
import { describe, test, expect } from "bun:test";
import { Api } from "telegram";
import { buildCustomEmojiEntities } from "../lib/custom-emoji-map.ts";

/** Текст из n значков словаря через пробел. */
const many = (n: number) => Array.from({ length: n }, () => "✅").join(" ");

/** Сущности разметки, которые НЕ защищают диапазон (не pre и не code). */
const bold = (n: number): Api.TypeMessageEntity[] =>
  Array.from(
    { length: n },
    (_, i) => new Api.MessageEntityBold({ offset: i * 2, length: 1 }),
  );

describe("потолок на число сущностей", () => {
  test("сотня совпадений проходит целиком", () => {
    expect(buildCustomEmojiEntities(many(100))).toHaveLength(100);
  });

  test("сто первое совпадение уже не получает сущности", () => {
    expect(buildCustomEmojiEntities(many(101))).toHaveLength(100);
  });

  test("большой перебор режется до потолка, а не уезжает целиком", () => {
    // До фикса здесь было 400 — весь вызов к Telegram отклонялся, апрув горел.
    expect(buildCustomEmojiEntities(many(400))).toHaveLength(100);
  });

  test("разметка занимает место в том же бюджете", () => {
    // 30 сущностей разметки + 100 совпадений = 130 в сообщении. Отдать можно
    // только 70 своих: остальное место уже занято.
    const ents = buildCustomEmojiEntities(many(100), bold(30));
    expect(ents).toHaveLength(70);
  });

  test("если одной разметки больше потолка — своих сущностей ноль", () => {
    // Выбросить разметку нельзя: это смысл текста и границы pre/code.
    expect(buildCustomEmojiEntities(many(10), bold(120))).toHaveLength(0);
  });

  test("режется хвост, а начало текста сохраняет порядок и смещения", () => {
    const text = many(150);
    const ents = buildCustomEmojiEntities(text) as any[];
    expect(ents).toHaveLength(100);
    // Первые сто идут подряд, слева направо, каждая на своём значке.
    for (let i = 0; i < ents.length; i++) {
      expect(ents[i].offset).toBe(i * 2);
      expect(text.slice(ents[i].offset, ents[i].offset + ents[i].length)).toBe("✅");
    }
  });
});

describe("обычные объёмы не задеты", () => {
  test("три значка — три сущности", () => {
    expect(buildCustomEmojiEntities("✅ ok 🔥 hot 💬 chat")).toHaveLength(3);
  });

  test("текст без значков — пусто", () => {
    expect(buildCustomEmojiEntities("обычный текст без эмодзи")).toHaveLength(0);
  });
});
