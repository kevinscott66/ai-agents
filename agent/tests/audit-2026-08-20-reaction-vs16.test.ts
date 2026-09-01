/**
 * Аудит 2026-08-20: whitelist реакций отвергал ту самую форму эмодзи, которую
 * даёт клавиатура.
 *
 * ALLOWED_REACTIONS записан СТРОГО в базовой форме — во всём telegram-actions.ts
 * ноль символов U+FE0F (Variation Selector-16). Сравнение шло точным
 * `Set.has`. Между тем «❤️», «🕊️», «✍️», «⚡️», «☃️», «🤷‍♂️», «❤️‍🔥» в любом
 * человеческом вводе и в большинстве LLM-выводов идут С селектором.
 *
 * Селектор невидим, поэтому дефект выглядел издевательски:
 *   - роль просит «❤️» → ошибка `REACTION_NOT_ALLOWED: ❤️. Allowed: 👍👎❤🔥…»,
 *     где предложенное неотличимо от отвергнутого. Модель шлёт то же самое;
 *   - у оркестратора промах по whitelist'у уводит в фолбэк через userbot, то
 *     есть реакция ставится от аккаунта ВЛАДЕЛЬЦА — из-за невидимого символа.
 *
 * Ровно этот урок аудит 2026-08-12 уже вывел для словаря кастомных эмодзи
 * (BASE_EMOJI в custom-emoji-map.ts); здесь он не был применён.
 */
import { test, expect, describe } from "bun:test";
import {
  ALLOWED_REACTIONS,
  isAllowedReaction,
  normalizeReaction,
} from "../lib/telegram-actions.ts";

const VS16 = "️";

describe("формы с Variation Selector-16", () => {
  const cases = [
    ["❤️", "❤"],
    ["🕊️", "🕊"],
    ["✍️", "✍"],
    ["⚡️", "⚡"],
    ["☃️", "☃"],
    ["🤷‍♂️", "🤷‍♂"],
    ["❤️‍🔥", "❤‍🔥"],
  ] as const;

  for (const [typed, canonical] of cases) {
    test(`«${typed}» принимается и приводится к канонической форме`, () => {
      expect(typed).toContain(VS16);
      expect(isAllowedReaction(typed)).toBe(true);
      expect(normalizeReaction(typed)).toBe(canonical);
    });
  }
});

describe("инварианты whitelist'а", () => {
  test("список хранится без селекторов — это и есть источник расхождения", () => {
    expect(ALLOWED_REACTIONS.some((e) => e.includes(VS16))).toBe(false);
  });

  test("каждая запись списка принимается и как есть, и с селектором", () => {
    for (const canonical of ALLOWED_REACTIONS) {
      expect(normalizeReaction(canonical)).toBe(canonical);
      expect(normalizeReaction(canonical + VS16)).toBe(canonical);
    }
  });

  test("нормализация идемпотентна", () => {
    const once = normalizeReaction("❤️");
    expect(once).not.toBeNull();
    expect(normalizeReaction(once as string)).toBe(once as string);
  });
});

describe("whitelist остаётся whitelist'ом", () => {
  test("эмодзи вне списка по-прежнему отвергается", () => {
    expect(isAllowedReaction("🍕")).toBe(false);
    expect(normalizeReaction("🍕")).toBeNull();
  });

  test("селектор не открывает лазейку для чужого эмодзи", () => {
    expect(isAllowedReaction("🍕" + VS16)).toBe(false);
  });

  test("пустая строка и мусор отвергаются", () => {
    expect(isAllowedReaction("")).toBe(false);
    expect(isAllowedReaction(VS16)).toBe(false);
    expect(isAllowedReaction("не эмодзи вовсе")).toBe(false);
  });

  test("окружающие пробелы не мешают, но и не делают мусор валидным", () => {
    expect(normalizeReaction("  👍  ")).toBe("👍");
    expect(normalizeReaction("  🍕  ")).toBeNull();
  });
});
