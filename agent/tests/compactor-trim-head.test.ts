/**
 * Аудит 2026-08-12: на длинной странице компактор молча терял всё дописанное.
 *
 * `trimMergedPage` при переполнении сохраняет голову (исходный текст) и режет
 * самые старые секции, оставляя на их месте строку со счётом — «вырезанное не
 * замалчиваем». Но у ветки «голова не влезает одна» этого нет:
 *
 *   if (!sections.length || head.length >= limit) {
 *     return head.slice(0, limit).trimEnd();
 *   }
 *
 * То есть страница, чьё исходное тело доросло до лимита (12 000 символов),
 * навсегда перестаёт принимать записи: `mergeAndWrite` дописывает секцию,
 * `trimMergedPage` выбрасывает ЕЁ ЖЕ вместе со всеми остальными, отметки не
 * оставляет, а `wikiWrite` возвращает успех. Агент записал в вики — в вики
 * ничего не появилось, и никто об этом не узнает.
 *
 * Замер до правки (голова 12 500 символов + свежая секция «ВАЖНОЕ РЕШЕНИЕ»):
 *   вход  12 569 симв., 1 секция
 *   выход 11 999 симв., 0 секций, ни слова «ВАЖНОЕ РЕШЕНИЕ», ни отметки
 *
 * Инвариант: свежая секция доезжает всегда, а любая потеря — видима.
 */
import { describe, test, expect } from "bun:test";
import { trimMergedPage } from "../lib/compactor.ts";

const SEP = "\n\n---\n## Update ";
const LIMIT = 12_000;

/** Страница: голова заданной длины + N секций. */
function page(headLen: number, sections: string[]): string {
  const head = ("Тело страницы. ".repeat(Math.ceil(headLen / 15)) as string)
    .slice(0, headLen)
    .trimEnd();
  return head + sections.map((s) => `${SEP}${s}`).join("");
}

function sectionCount(s: string): number {
  return s.split(SEP).length - 1;
}

describe("голова длиннее лимита", () => {
  const FRESH = "2026-08-12\n\nВАЖНОЕ РЕШЕНИЕ: переезжаем на другой хост.";
  const input = page(12_500, [FRESH]);

  test("свежая секция не теряется", () => {
    const out = trimMergedPage(input, LIMIT);
    expect(out).toContain("ВАЖНОЕ РЕШЕНИЕ: переезжаем на другой хост.");
    expect(sectionCount(out)).toBe(1);
  });

  test("лимит соблюдён", () => {
    expect(trimMergedPage(input, LIMIT).length).toBeLessThanOrEqual(LIMIT);
  });

  test("усечение головы отмечено в тексте", () => {
    expect(trimMergedPage(input, LIMIT)).toContain("Обрезано при слиянии");
  });

  test("из головы остаётся начало, а не хвост", () => {
    // Голова — это то, ради чего страницу заводили: заголовок и первые абзацы
    // важнее, чем её конец.
    expect(trimMergedPage(input, LIMIT).startsWith("Тело страницы.")).toBe(true);
  });

  test("выброшенные старые секции сосчитаны", () => {
    const many = page(12_500, ["2026-01-01\n\nстарое", "2026-02-01\n\nстарее", FRESH]);
    const out = trimMergedPage(many, LIMIT);
    expect(out).toContain("ВАЖНОЕ РЕШЕНИЕ");
    expect(out).toContain("2 более ранних секций");
    expect(out).not.toContain("старое");
  });

  test("отметки не копятся прогон за прогоном", () => {
    let cur = page(12_500, [FRESH]);
    for (let i = 0; i < 5; i++) {
      cur = trimMergedPage(cur + `${SEP}2026-08-1${i}\n\nещё запись ${i}`, LIMIT);
    }
    expect(cur.match(/Обрезано при слиянии/g)?.length).toBe(1);
    expect(cur).toContain("ещё запись 4");
    expect(cur.length).toBeLessThanOrEqual(LIMIT);
  });

  test("секция сама длиннее лимита — режется, но не исчезает", () => {
    const huge = "2026-08-12\n\n" + "длинно ".repeat(3000);
    const out = trimMergedPage(page(12_500, [huge]), LIMIT);
    expect(out.length).toBeLessThanOrEqual(LIMIT);
    expect(out).toContain("длинно");
  });
});

describe("прежнее поведение сохранено", () => {
  test("страница в пределах лимита не трогается", () => {
    const p = page(100, ["2026-08-12\n\nкороткая запись"]);
    expect(trimMergedPage(p, LIMIT)).toBe(p);
  });

  test("голова влезает — режутся старые секции, свежая остаётся", () => {
    const secs = Array.from({ length: 40 }, (_, i) => `2026-01-${i}\n\n${"текст ".repeat(60)}`);
    const out = trimMergedPage(page(500, secs), LIMIT);
    expect(out.length).toBeLessThanOrEqual(LIMIT);
    expect(out).toContain("2026-01-39");
    expect(out).toContain("Обрезано при слиянии");
    expect(out.startsWith("Тело страницы.")).toBe(true);
  });

  test("нет секций и голова влезает — без изменений", () => {
    const p = "Просто страница без обновлений.";
    expect(trimMergedPage(p, LIMIT)).toBe(p);
  });

  test("нет секций, голова длиннее лимита — усечена и отмечена", () => {
    const out = trimMergedPage(page(13_000, []), LIMIT);
    expect(out.length).toBeLessThanOrEqual(LIMIT);
    expect(out).toContain("Обрезано при слиянии");
  });
});
