/**
 * Аудит 2026-08-08: рендер обложки стоил ~4 секунды синхронного CPU.
 *
 * `loadSystemFonts: true` стоял безусловно, а resvg сканирует системные шрифты
 * заново на каждый инстанс. Замер на M1: 4.1с на баннер, 7.5с на
 * иллюстрированный — и всё это в том же процессе, где живут SQLite и 12 ботов,
 * ради шрифтов, которые для обычного заголовка не использовались вовсе.
 * После правки — 0.24с и 0.32с.
 *
 * Тесты сторожат условие: обычный заголовок идёт быстрым путём, а всё, чего
 * нет в бренд-TTF (эмодзи, CJK, стрелки, ©), — прежним медленным, чтобы
 * картинка не поменялась.
 */
import { describe, test, expect } from "bun:test";
import { needsSystemFonts, renderBannerPng } from "../lib/cover-banner.ts";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

describe("needsSystemFonts", () => {
  test("латиница, кириллица, цифры и типографика — быстрый путь", () => {
    for (const s of [
      "Тест баннера",
      "AI × Web3 дайджест 2026",
      "Mixed Латиница 123 — тире",
      "Заголовок: подзаголовок (уточнение)",
    ]) {
      expect(needsSystemFonts(s)).toBe(false);
    }
  });

  test("эмодзи, CJK, стрелки и © — прежний путь с системными шрифтами", () => {
    for (const s of ["🚀 Аирдроп недели", "日本語", "→ стрелка", "DeLabs © 2026"]) {
      expect(needsSystemFonts(s)).toBe(true);
    }
  });
});

describe("renderBannerPng", () => {
  test("обычный заголовок → валидный PNG", async () => {
    const buf = await renderBannerPng({ title: "Дайджест недели", date: "8 августа" });
    expect(buf.subarray(0, 4)).toEqual(PNG_MAGIC);
    expect(buf.length).toBeGreaterThan(1000);
  });

  test("заголовок с эмодзи тоже рендерится, а не падает", async () => {
    const buf = await renderBannerPng({ title: "🚀 Аирдроп недели", date: "8 августа" });
    expect(buf.subarray(0, 4)).toEqual(PNG_MAGIC);
    expect(buf.length).toBeGreaterThan(1000);
    // Запас, а не ускорение: это единственная проверка в файле, идущая МЕДЛЕННЫМ
    // путём — эмодзи в бренд-TTF нет, значит грузятся системные шрифты, а это,
    // по замеру из шапки, секунды. В дефолтные 5000 мс она под полным прогоном
    // не укладывалась: зелёная поодиночке, красная в общем.
  }, 30_000);

  test("быстрый путь даёт тот же PNG при повторном вызове (детерминизм)", async () => {
    const a = await renderBannerPng({ title: "Дайджест недели", date: "8 августа" });
    const b = await renderBannerPng({ title: "Дайджест недели", date: "8 августа" });
    expect(a.equals(b)).toBe(true);
  });
});
