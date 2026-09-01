/**
 * T-717: Figma клиент — parseFigmaKey + summarizeFigmaFile (чистые, без сети).
 */
import { describe, test, expect } from "bun:test";
import { parseFigmaKey, summarizeFigmaFile } from "../lib/figma.ts";

describe("parseFigmaKey", () => {
  test("из ссылки /file/", () => {
    expect(parseFigmaKey("https://www.figma.com/file/abc123XYZ/My-Design?node=1")).toBe(
      "abc123XYZ",
    );
  });
  test("из ссылки /design/", () => {
    expect(parseFigmaKey("https://figma.com/design/KEY9876543/Proj")).toBe("KEY9876543");
  });
  test("голый key", () => {
    expect(parseFigmaKey("abcdef123456")).toBe("abcdef123456");
  });
  test("мусор → null", () => {
    expect(parseFigmaKey("not a key")).toBeNull();
    expect(parseFigmaKey("")).toBeNull();
  });
});

describe("summarizeFigmaFile", () => {
  const doc = {
    name: "Design System",
    lastModified: "2026-06-10T00:00:00Z",
    styles: { s1: {}, s2: {} },
    components: { c1: {} },
    document: {
      type: "DOCUMENT",
      children: [
        {
          type: "CANVAS",
          name: "Page 1",
          children: [
            { type: "FRAME", name: "Home" },
            { type: "FRAME", name: "Profile" },
            { type: "COMPONENT", name: "Button" },
            { type: "TEXT", name: "ignore-me" },
          ],
        },
        { type: "CANVAS", name: "Page 2", children: [] },
      ],
    },
  };

  test("компактная сводка: страницы/фреймы/компоненты/счётчики", () => {
    const s = summarizeFigmaFile(doc);
    expect(s.name).toBe("Design System");
    expect(s.pageCount).toBe(2);
    expect(s.styleCount).toBe(2);
    expect(s.componentCount).toBe(1);
    expect(s.pages[0].frames).toEqual(["Home", "Profile"]);
    expect(s.pages[0].components).toEqual(["Button"]);
    // TEXT-нода не попала ни во frames, ни в components
    expect(s.pages[0].frames).not.toContain("ignore-me");
  });

  test("пустой документ не падает", () => {
    const s = summarizeFigmaFile({ name: "x" });
    expect(s.pageCount).toBe(0);
    expect(s.pages).toEqual([]);
  });
});
