import { test, expect, describe } from "bun:test";
import { buildCustomEmojiEntities, DELABS_EMOJI } from "../lib/custom-emoji-map.ts";

describe("buildCustomEmojiEntities", () => {
  test("maps a known emoji at the right UTF-16 offset", () => {
    const text = "привет 🤑 мир";
    const ents = buildCustomEmojiEntities(text);
    expect(ents.length).toBe(1);
    const e: any = ents[0];
    expect(e.offset).toBe("привет ".length);
    expect(e.length).toBe(2); // 🤑 — суррогатная пара
    expect(e.documentId.toString()).toBe(DELABS_EMOJI["🤑"]);
    // подстрока по offset/length должна совпасть с самим эмодзи
    expect(text.substring(e.offset, e.offset + e.length)).toBe("🤑");
  });

  test("multiple emoji each get an entity", () => {
    const ents = buildCustomEmojiEntities("✅ ok 🔥 hot 💬 chat");
    expect(ents.length).toBe(3);
  });

  test("unknown emoji are ignored", () => {
    expect(buildCustomEmojiEntities("обычный текст без эмодзи").length).toBe(0);
    expect(buildCustomEmojiEntities("🦄 единорога нет в словаре").length).toBe(0);
  });

  test("offsets stay correct after a surrogate-pair emoji", () => {
    const text = "🤑 и ✅";
    const ents = buildCustomEmojiEntities(text);
    expect(ents.length).toBe(2);
    for (const e of ents as any[]) {
      const sub = text.substring(e.offset, e.offset + e.length);
      expect(Object.keys(DELABS_EMOJI)).toContain(sub);
    }
  });
});
