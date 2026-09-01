/**
 * Аудит 2026-08-12 (повторный): правка «свежая секция не теряется» закрыла
 * только ветку `head.length >= limit`. Полосой ниже потеря осталась.
 *
 * Общая ветка набирает секции с конца:
 *
 *   for (let i = sections.length - 1; i >= 0; i--) {
 *     const chunk = UPDATE_SEP + sections[i]!;
 *     if (size + chunk.length > limit - 120) break;   // ← на ПЕРВОЙ итерации
 *     ...
 *   }
 *
 * Когда голова близка к лимиту, но всё ещё меньше его, цикл обрывается сразу,
 * `kept` остаётся пустым — и запись компактора уходит в никуда: `mergeAndWrite`
 * зовёт `wikiWrite`, тот отвечает успехом, ни ошибки, ни лога. Агент записал в
 * вики, в вики ничего не появилось, узнать неоткуда.
 *
 * Замер до правки (лимит 12 000, свежая секция 64 символа, голова перебиралась
 * шагом 10):
 *
 *   полоса потери: голова 11 910 … 12 000 символов
 *   шесть слияний подряд со старта 11 900:
 *     #1 len 11947 записано   #2 len 11994 записано   #3 len 11952 ПОТЕРЯНО
 *     #4 len 11999 записано   #5 len 11952 ПОТЕРЯНО   #6 len 11999 записано
 *
 * То есть страница не замерзает намертво (как показалось при первом разборе),
 * а начинает терять записи через одну — и молча. Отметка при этом врёт про
 * масштаб: «Обрезано при слиянии: 2 более ранних секций», хотя выброшена как
 * раз самая новая.
 *
 * Тестами полоса не была покрыта: compactor-trim-head.test.ts проверяет
 * `page(12_500, …)` (голова ≥ лимита) и `page(500, …)` / `page(100, …)`.
 * Между 500 и 12 500 — ничего.
 *
 * Инвариант тот же, что и у соседней ветки, и он должен действовать на всей
 * шкале: свежая секция доезжает всегда, а любая потеря — видима и посчитана
 * честно.
 */
import { describe, test, expect } from "bun:test";
import { trimMergedPage } from "../lib/compactor.ts";

const SEP = "\n\n---\n## Update ";
const LIMIT = 12_000;

function head(len: number): string {
  return ("Тело страницы. ".repeat(Math.ceil(len / 15)) as string)
    .slice(0, len)
    .trimEnd();
}

function sectionCount(s: string): number {
  return s.split(SEP).length - 1;
}

/** Ровно то, что делает mergeAndWrite: дописать секцию и обрезать. */
function merge(page: string, body: string): string {
  return trimMergedPage(page.trim() + `${SEP}${body}\n`, LIMIT);
}

describe("голова в полосе «влезает сама, но не вместе со свежей секцией»", () => {
  const FRESH = "2026-08-12\n\nРЕШЕНИЕ: переезжаем на другой хост.";

  // Границы полосы — из замера выше, шагом 10 по всей ширине.
  for (let headLen = 11_910; headLen <= 12_000; headLen += 10) {
    test(`голова ${headLen}: свежая секция доезжает`, () => {
      const out = merge(head(headLen) + `${SEP}2026-08-01\n\nстарое\n`, FRESH);
      expect(out).toContain("РЕШЕНИЕ: переезжаем на другой хост.");
      expect(out.length).toBeLessThanOrEqual(LIMIT);
    });
  }

  test("шесть слияний подряд — ни одна запись не пропадает молча", () => {
    let page = head(11_900);
    const landed: number[] = [];
    for (let i = 1; i <= 6; i++) {
      page = merge(page, `2026-08-1${i}\n\nРЕШЕНИЕ #${i}: строка.`);
      if (page.includes(`РЕШЕНИЕ #${i}:`)) landed.push(i);
      expect(page.length).toBeLessThanOrEqual(LIMIT);
    }
    // До правки: [1, 2, 4, 6] — третья и пятая записи исчезали бесследно.
    expect(landed).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("счёт выброшенного не врёт: пропадают только старые секции", () => {
    const out = merge(
      head(11_950) + `${SEP}2026-08-01\n\nстарое A\n${SEP}2026-08-02\n\nстарое B\n`,
      "2026-08-12\n\nсамое свежее",
    );
    expect(out).toContain("самое свежее");
    expect(sectionCount(out)).toBeGreaterThanOrEqual(1);
    if (!out.includes("старое A")) expect(out).toContain("Обрезано при слиянии");
  });

  test("вне полосы поведение не меняется: старые секции режутся, свежая цела", () => {
    const out = merge(
      head(8_000) +
        `${SEP}2026-08-01\n\n${"старое A ".repeat(300)}\n${SEP}2026-08-02\n\nстарое B\n`,
      "2026-08-12\n\nсамое свежее",
    );
    expect(out).toContain("самое свежее");
    expect(out).toContain("старое B");
    expect(out.length).toBeLessThanOrEqual(LIMIT);
  });
});
