/**
 * Аудит 2026-08-20: внешние строки из Figma/TGStat уезжали в контекст модели
 * без потолка. `maxPerList` в summarizeFigmaFile резал только список фреймов
 * внутри страницы; число страниц и длина каждого имени не ограничивались
 * ничем, поэтому «компактная сводка» на большом файле выходила в мегабайты.
 */
import { describe, it, expect } from "bun:test";
import { summarizeFigmaFile } from "../lib/figma.ts";
import { shapeChannelStats } from "../lib/tgstat.ts";

const LONG = "A".repeat(400);

function bigDoc(pageCount: number, framesPerPage = 25, name = LONG) {
  return {
    name,
    document: {
      children: Array.from({ length: pageCount }, () => ({
        type: "CANVAS",
        name,
        children: Array.from({ length: framesPerPage }, () => ({
          type: "FRAME",
          name,
        })),
      })),
    },
  };
}

describe("summarizeFigmaFile: потолки на внешний текст", () => {
  it("сводка большого файла остаётся в разумных байтах", () => {
    const bytes = JSON.stringify(summarizeFigmaFile(bigDoc(400))).length;
    // Без капов здесь было ~4.2 MB — один tool_result ≈ 1 млн токенов.
    expect(bytes).toBeLessThan(200_000);
  });

  it("список страниц усечён до 40, но pageCount честный", () => {
    const s = summarizeFigmaFile(bigDoc(400));
    expect(s.pages).toHaveLength(40);
    expect(s.pageCount).toBe(400);
  });

  it("усечение списка страниц видно модели через pagesTruncated", () => {
    expect(summarizeFigmaFile(bigDoc(41)).pagesTruncated).toBe(true);
  });

  it("на файле без усечения флага нет", () => {
    const s = summarizeFigmaFile(bigDoc(40));
    expect(s.pages).toHaveLength(40);
    expect(s.pagesTruncated).toBeUndefined();
  });

  it("имя файла обрезано до 120 символов", () => {
    expect(summarizeFigmaFile(bigDoc(1)).name).toHaveLength(120);
  });

  it("имя страницы обрезано до 120 символов", () => {
    expect(summarizeFigmaFile(bigDoc(1)).pages[0]!.name).toHaveLength(120);
  });

  it("имя каждого фрейма обрезано до 120 символов", () => {
    const frames = summarizeFigmaFile(bigDoc(1)).pages[0]!.frames;
    expect(frames.length).toBeGreaterThan(0);
    for (const f of frames) expect(f.length).toBeLessThanOrEqual(120);
  });

  it("имя компонента обрезано до 120 символов", () => {
    const doc = {
      document: {
        children: [
          {
            type: "CANVAS",
            name: "p",
            children: [{ type: "COMPONENT_SET", name: LONG }],
          },
        ],
      },
    };
    expect(summarizeFigmaFile(doc).pages[0]!.components[0]).toHaveLength(120);
  });

  it("короткие имена не трогаются", () => {
    const s = summarizeFigmaFile(bigDoc(2, 1, "Главная"));
    expect(s.name).toBe("Главная");
    expect(s.pages[0]!.name).toBe("Главная");
    expect(s.pages[0]!.frames[0]).toBe("Главная");
  });

  it("maxPerList продолжает резать фреймы внутри страницы", () => {
    const s = summarizeFigmaFile(bigDoc(1, 100, "f"), 3);
    expect(s.pages[0]!.frames).toHaveLength(3);
  });

  it("счётчики стилей и компонентов не зависят от капа страниц", () => {
    const doc = {
      ...bigDoc(100),
      styles: Object.fromEntries(
        Array.from({ length: 7 }, (_, i) => [`s${i}`, {}]),
      ),
      components: Object.fromEntries(
        Array.from({ length: 9 }, (_, i) => [`c${i}`, {}]),
      ),
    };
    const s = summarizeFigmaFile(doc);
    expect(s.styleCount).toBe(7);
    expect(s.componentCount).toBe(9);
  });

  it("пустой документ не падает", () => {
    const s = summarizeFigmaFile({});
    expect(s.pageCount).toBe(0);
    expect(s.pages).toEqual([]);
    expect(s.pagesTruncated).toBeUndefined();
  });
});

describe("shapeChannelStats: потолок на title/username", () => {
  it("длинный title обрезан до 120", () => {
    expect(shapeChannelStats({ title: LONG }).title).toHaveLength(120);
  });

  it("длинный username обрезан до 120", () => {
    expect(shapeChannelStats({ username: LONG }).username).toHaveLength(120);
  });

  it("короткие строки не трогаются, нестроки дают undefined", () => {
    const s = shapeChannelStats({ title: "DeLabs", username: 42 });
    expect(s.title).toBe("DeLabs");
    expect(s.username).toBeUndefined();
  });

  it("числовые поля не задеты", () => {
    const s = shapeChannelStats({ title: LONG, participants_count: 1234 });
    expect(s.participants).toBe(1234);
  });
});
