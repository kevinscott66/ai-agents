/**
 * Формат канального дайджеста: между каждой новостью — пустая строка (эталон
 * сообщения @delabsru #75). Регресс-защита: раньше новости шли вплотную.
 */
import { test, expect, describe } from "bun:test";
import { buildPreviewText, type DraftArticle } from "../tools/daily-draft.ts";

const ARTS: DraftArticle[] = [
  { emoji: "🚫", title: "A", blurb: "первая", summary: "", body: "", items: [], date: "2026-10-30", sourceCount: 0 },
  { emoji: "🪙", title: "B", blurb: "вторая", summary: "", body: "", items: [], date: "2026-10-30", sourceCount: 0 },
  { emoji: "📊", title: "C", blurb: "третья", summary: "", body: "", items: [], date: "2026-10-30", sourceCount: 0 },
];

describe("digest spacing (эталон #75)", () => {
  const text = buildPreviewText(ARTS);

  test("между новостями есть пустая строка", () => {
    // блёрб первой новости + пустая строка + эмодзи-заголовок второй
    expect(text).toContain("первая.\n\n🪙 **B**");
    expect(text).toContain("вторая.\n\n📊 **C**");
  });

  test("нет хвостовой пустой строки", () => {
    expect(text.endsWith("\n")).toBe(false);
    expect(text.endsWith("третья.")).toBe(true);
    expect(text).not.toContain("ссылка на апруве");
  });

  test("шапка: заголовок, дата, intro — каждая через пустую строку", () => {
    const lines = text.split("\n");
    expect(lines[0]).toMatch(/^📰 \*\*/);
    expect(lines[1]).toMatch(/^🗓️ /);
    expect(lines[2]).toBe("");
    expect(lines[3]).toBe("Коротко о главном — первоисточники под новостями.");
    expect(lines[4]).toBe("");
  });

  test("первоисточник остаётся у своей новости и не съедает отступ", () => {
    const sourced = ARTS.map((article, i) => ({ ...article,
      items: [{ text: "Анонс", url: `https://example.com/story-${i}` }], sourceCount: 1 }));
    const preview = buildPreviewText(sourced);
    expect(preview).toContain("первая. [Первоисточник](https://example.com/story-0)\n\n🪙 **B**");
    expect(preview).toContain("вторая. [Первоисточник](https://example.com/story-1)\n\n📊 **C**");
    expect(preview.endsWith("третья. [Первоисточник](https://example.com/story-2)")).toBe(true);
  });
});
