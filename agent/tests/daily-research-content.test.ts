import { describe, expect, test } from "bun:test";
import { articlesFromResponse, articlesFromResearch } from "../lib/daily-research-content.ts";
import { articlesFromResearch as legacyArticlesFromResearch } from "../tools/daily-draft.ts";

const entry = (title = "Заголовок") => ({ title, body: "Текст {события}", summary: "Суть. Детали.", date: "2026-10-30" });

describe("daily model response contract", () => {
  test("tool compatibility and prose-wrapped responses preserve the complete normalized article", () => {
    const input = { ...entry(), items: [{ url: "https://example.com/announcement" }], sourceCount: 999 };
    const decoded = articlesFromResponse(`Ответ:\n\`\`\`json\n${JSON.stringify({ articles: [input] })}\n\`\`\``);
    expect(legacyArticlesFromResearch).toBe(articlesFromResearch);
    expect(decoded).toEqual(articlesFromResearch({ articles: [input] }));
    expect(decoded[0]).toMatchObject({ ...entry(), blurb: "Суть.", sourceCount: 1 });
  });

  test("bad envelopes are errors, while an explicitly empty edition is readable", () => {
    for (const value of [null, false, 3, "text", [], {}, { articles: null }, { articles: {} }])
      expect(() => articlesFromResearch(value)).toThrow("JSON has no articles[]");
    expect(articlesFromResponse('{"articles":[]}')).toEqual([]);
  });

  test("mixed garbage cannot turn into an article or consume the four-article limit", () => {
    const values = [null, false, 1, "text", {}, { title: "No body" }, ...Array.from({ length: 6 }, (_, i) => entry(String(i)))];
    expect(articlesFromResponse(JSON.stringify({ articles: values })).map(a => a.title)).toEqual(["0", "1", "2", "3"]);
  });

  test("missing and invalid dates are never generated, fixed or replaced with today", () => {
    for (const date of [undefined, null, false, 0, "", "2026-02-31", "2026-12-31"]) {
      const [article] = articlesFromResearch({ articles: [{ ...entry(), date }] });
      expect(article.date).toBe(typeof date === "string" ? date : "");
    }
  });

  test("source count describes retained links and decoding never mutates input", () => {
    const input = { articles: [{ ...entry(), sourceCount: 100, items: [null, { url: "javascript:alert(1)" }, { url: "/relative" }, ...Array.from({ length: 6 }, (_, i) => ({ url: `https://example.com/${i}` }))] }] };
    const before = structuredClone(input);
    const [article] = articlesFromResearch(input);
    expect(article.items).toHaveLength(4);
    expect(article.sourceCount).toBe(4);
    expect(input).toEqual(before);
  });
});
