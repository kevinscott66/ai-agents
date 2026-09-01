/**
 * Формат канального дайджеста: между каждой новостью — пустая строка (эталон
 * сообщения @delabsru #75). Регресс-защита: раньше новости шли вплотную.
 */
import { test, expect, describe } from "bun:test";
import { buildPreviewText } from "../tools/daily-draft.ts";

const ARTS = [
  { emoji: "🚫", title: "A", blurb: "первая", summary: "", body: "", items: [] },
  { emoji: "🪙", title: "B", blurb: "вторая", summary: "", body: "", items: [] },
  { emoji: "📊", title: "C", blurb: "третья", summary: "", body: "", items: [] },
] as any;

describe("digest spacing (эталон #75)", () => {
  const text = buildPreviewText(ARTS);

  test("между новостями есть пустая строка", () => {
    // блёрб первой новости + пустая строка + эмодзи-заголовок второй
    expect(text).toContain("первая. [Подробнее → (ссылка на апруве)]\n\n🪙 **B**");
    expect(text).toContain("вторая. [Подробнее → (ссылка на апруве)]\n\n📊 **C**");
  });

  test("нет хвостовой пустой строки", () => {
    expect(text.endsWith("\n")).toBe(false);
    expect(text.endsWith("третья. [Подробнее → (ссылка на апруве)]")).toBe(true);
  });

  test("шапка: заголовок, дата, intro — каждая через пустую строку", () => {
    const lines = text.split("\n");
    expect(lines[0]).toMatch(/^📰 \*\*/);
    expect(lines[1]).toMatch(/^🗓️ /);
    expect(lines[2]).toBe("");
    expect(lines[3]).toBe("Коротко о главном — детали по ссылкам на сайте.");
    expect(lines[4]).toBe("");
  });
});
