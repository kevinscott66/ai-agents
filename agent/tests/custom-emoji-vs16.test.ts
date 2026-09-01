/**
 * Аудит 2026-08-12: анимация эмодзи в постах канала зависела от невидимого
 * символа, а сама подсветка резала эмодзи пополам.
 *
 * `buildCustomEmojiEntities` сопоставляет текст поста со словарём DELABS_EMOJI
 * ТОЧНЫМ совпадением ключа. Но эмодзи в тексте почти всегда приходит с
 * селектором варианта U+FE0F (VS16): «❤️» — это U+2764 U+FE0F, две UTF-16
 * единицы. В словаре же одни ключи записаны с селектором («⭐️», «✍️», «🗓️»),
 * другие без («❤», «🎖»), а для «⌚»/«🗓» лежат оба варианта. Селектор в
 * редакторе не виден, так что какой именно попал в словарь — вопрос случая.
 *
 * Отсюда два дефекта, оба на пути PUBLISH_TO_CHANNEL (userbot.publishPost →
 * lib/custom-emoji-map.ts):
 *
 * 1. Ключ без селектора + текст с селектором («❤», «🎖») → entity накрывает
 *    только базовый символ, а U+FE0F остаётся ЗА его границей. Сущность
 *    custom-emoji должна покрывать эмодзи целиком — она подменяет накрытый
 *    текст анимированным стикером, и висящий следом модификатор к нему уже не
 *    относится. Замер до правки: «Итоги ❤️ недели» → offset 6, length 1,
 *    накрыто «❤», следом осиротевший U+FE0F.
 *
 * 2. Ключ с селектором + текст без него («⭐» против «⭐️») → совпадения нет
 *    вовсе, эмодзи не анимируется. Замер до правки: «Звезда ⭐ дня» → 0
 *    сущностей, «Звезда ⭐️ дня» → 1.
 *
 * Инвариант: селектор варианта не влияет на то, найдётся ли эмодзи, и всегда
 * попадает ВНУТРЬ границ сущности. Точная запись словаря при этом сильнее
 * выведенной: у «🗓️» и «🗓» разные documentId, и подмена одного другим — это
 * другая анимация в посте.
 */
import { describe, test, expect } from "bun:test";
import { buildCustomEmojiEntities, DELABS_EMOJI } from "../lib/custom-emoji-map.ts";

const VS16 = "\uFE0F";

function ents(text: string): Array<{ offset: number; length: number; id: string }> {
  return (buildCustomEmojiEntities(text) as any[]).map((e) => ({
    offset: e.offset,
    length: e.length,
    id: e.documentId.toString(),
  }));
}

describe("селектор варианта не разрывает сущность", () => {
  test("❤️ — ключ без селектора, текст с ним", () => {
    const text = "Итоги ❤️ недели";
    const [e, ...rest] = ents(text);
    expect(rest.length).toBe(0);
    expect(text.slice(e!.offset, e!.offset + e!.length)).toBe("❤️");
    expect(e!.id).toBe(DELABS_EMOJI["❤"]!);
  });

  test("🎖️ — то же на суррогатной паре", () => {
    const text = "Медаль 🎖️ выдана";
    const [e] = ents(text);
    expect(text.slice(e!.offset, e!.offset + e!.length)).toBe("🎖️");
  });

  test("ни одна сущность не оставляет селектор снаружи", () => {
    const text = Object.keys(DELABS_EMOJI)
      .map((k) => (k.endsWith(VS16) ? k : k + VS16))
      .join(" ");
    for (const e of ents(text)) {
      expect(text[e.offset + e.length]).not.toBe(VS16);
    }
  });
});

describe("селектор варианта не влияет на то, найдётся ли эмодзи", () => {
  test("⭐ без селектора анимируется так же, как ⭐️", () => {
    const withVs = ents("Звезда ⭐️ дня");
    const without = ents("Звезда ⭐ дня");
    expect(withVs.length).toBe(1);
    expect(without.length).toBe(1);
    expect(without[0]!.id).toBe(withVs[0]!.id);
    expect(without[0]!.length).toBe(1);
  });

  test("✍ без селектора тоже", () => {
    expect(ents("Пишем ✍ отчёт").length).toBe(1);
  });
});

describe("точная запись словаря сильнее выведенной", () => {
  test("🗓️ и 🗓 сохраняют свои разные documentId", () => {
    const [withVs] = ents("Дата 🗓️ тут");
    const [without] = ents("Дата 🗓 тут");
    expect(withVs!.id).toBe(DELABS_EMOJI["🗓️"]!);
    expect(without!.id).toBe(DELABS_EMOJI["🗓"]!);
    expect(withVs!.id).not.toBe(without!.id);
  });

  test("⌚ и ⌚️ — один и тот же id, обе формы находятся", () => {
    const [withVs] = ents("Время ⌚️ вышло");
    const [without] = ents("Время ⌚ вышло");
    expect(withVs!.id).toBe(DELABS_EMOJI["⌚️"]!);
    expect(without!.id).toBe(DELABS_EMOJI["⌚"]!);
  });
});
