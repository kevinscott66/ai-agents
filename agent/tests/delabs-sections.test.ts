/**
 * AUD-20260921-033. Разделы сайта в канальном посте — копия навигации сайта,
 * и это единственное место, где расхождение можно заметить.
 *
 * Репозитории разные, импорта между ними нет, а ссылка в посте к подписчикам
 * уходит навсегда. Поэтому список закрыт дословно: переименовали раздел на
 * сайте — красный тест здесь, а не тихие 404 в канале.
 *
 * Адреса сверены с живым сайтом 21.09.2026 (все шесть — 200). Обновляя этот
 * список, сверяйте так же: `/partners` и `/airdrop` выглядят разумно, но дают
 * 404 — раздачи живут на `/drops`, а списка партнёров на сайте нет вовсе.
 */
import { describe, test, expect } from "bun:test";
import { DELABS_SECTIONS, sectionsLine } from "../lib/delabs-sections.ts";

describe("delabs: разделы для канального поста", () => {
  test("список дословно совпадает с навигацией сайта", () => {
    expect(DELABS_SECTIONS.map((s) => [s.href, s.label])).toEqual([
      ["/digest", "Дайджест"],
      ["/drops", "Дропы"],
      ["/activities", "Активности"],
      ["/unlocks", "Анлоки"],
      ["/projects", "Проекты"],
      ["/ai", "AI"],
    ]);
  });

  test("адреса — списки разделов, а не страницы отдельных материалов", () => {
    // Страницу выпуска (`/digest/<slug>`) сайт собирает из корпуса уже ПОСЛЕ
    // поста, так что в момент публикации её адрес не существует. Любой второй
    // сегмент здесь — возврат к той же дыре.
    for (const s of DELABS_SECTIONS) {
      expect(s.href).toMatch(/^\/[a-z-]+$/);
      expect(s.label.trim()).toBe(s.label);
    }
    expect(new Set(DELABS_SECTIONS.map((s) => s.href)).size).toBe(
      DELABS_SECTIONS.length,
    );
  });

  test("строка поста клеится из базы без хвостового слэша", () => {
    const line = sectionsLine("https://example.test");
    expect(line).toBe(
      "Разделы: [Дайджест](https://example.test/digest) · " +
        "[Дропы](https://example.test/drops) · " +
        "[Активности](https://example.test/activities) · " +
        "[Анлоки](https://example.test/unlocks) · " +
        "[Проекты](https://example.test/projects) · " +
        "[AI](https://example.test/ai)",
    );
    // Одна строка: перенос внутри неё разорвал бы markdown-ссылку.
    expect(line).not.toContain("\n");
  });
});
