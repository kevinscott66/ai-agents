/**
 * Аудит 2026-08-20: `oneLine` рвал составные символы и молча терял текст.
 *
 * Функция готовит КАЖДУЮ строку постов DeLabs: заголовки пунктов (`max` 80/90),
 * блёрбы и действия (200), мета (40). Дефектов было три:
 *
 *  1) `.slice(0, max)` режет по кодовым единицам UTF-16. Если на границе стоит
 *     эмодзи, в хвосте остаётся одинокий верхний суррогат — в UTF-8 это «�» в
 *     опубликованном посте. Блёрбы с эмодзи — норма, а не редкость.
 *  2) `\p{Cf}` включает U+200D (ZWJ) — тот самый символ, который склеивает
 *     эмодзи в один глиф. «Команда 👨‍💻» превращалась в «Команда 👨 💻».
 *  3) Обрезка была молчаливой. Заголовки новостей приходят из API сайта с
 *     потолком 120 символов (`deriveTitle`), а печатаются с `max = 90`: до 30
 *     символов исчезали посреди слова, и отличить это от исходного текста
 *     читателю нечем.
 *
 * Инвариант: результат не длиннее `max`, не содержит разорванных графем, а
 * факт обрезки виден.
 */
import { describe, test, expect } from "bun:test";
import { oneLine } from "../lib/delabs-text.ts";

/** Есть ли в строке непарный суррогат — то, что станет «�» в UTF-8. */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

const ZWJ = "‍";

describe("обрезка не рвёт символы", () => {
  test("эмодзи на границе не оставляет половину суррогатной пары", () => {
    const out = oneLine("а".repeat(199) + "🔥ещё", 200);
    expect(hasLoneSurrogate(out)).toBe(false);
    expect(out.length).toBeLessThanOrEqual(200);
  });

  test("граница ровно по эмодзи — оно целиком либо отсутствует", () => {
    for (let max = 3; max <= 12; max++) {
      const out = oneLine("аб🔥вг🎯де", max);
      expect(hasLoneSurrogate(out)).toBe(false);
      expect(out.length).toBeLessThanOrEqual(max);
    }
  });

  test("ZWJ-эмодзи не распадается на два глифа", () => {
    expect(oneLine(`Команда 👨${ZWJ}💻 работает`)).toBe(`Команда 👨${ZWJ}💻 работает`);
  });

  test("ZWJ-последовательность не режется посередине", () => {
    const out = oneLine(`аб👨${ZWJ}💻вг`, 6);
    expect(out).not.toContain(ZWJ.concat(""));
    expect(hasLoneSurrogate(out)).toBe(false);
  });
});

describe("остальные управляющие символы по-прежнему убираются", () => {
  test("перенос строки и таб схлопываются в пробел", () => {
    expect(oneLine("а\nб\tв")).toBe("а б в");
  });

  test("невидимый форматирующий символ убирается", () => {
    expect(oneLine("а​б")).toBe("а б");
  });
});

describe("обрезка видна", () => {
  test("длинная строка получает многоточие", () => {
    expect(oneLine("абвгдеёжз", 5)).toBe("абвг…");
  });

  test("результат не длиннее max", () => {
    for (const max of [1, 2, 3, 40, 90, 200]) {
      expect(oneLine("я".repeat(500), max).length).toBeLessThanOrEqual(max);
    }
  });

  test("заголовок сайта на 120 символов при max=90 обрезается с маркером", () => {
    const out = oneLine("т".repeat(120), 90);
    expect(out.length).toBe(90);
    expect(out.endsWith("…")).toBe(true);
  });

  test("строка ровно по лимиту не трогается", () => {
    const exact = "т".repeat(90);
    expect(oneLine(exact, 90)).toBe(exact);
  });

  test("короткая строка не получает многоточия", () => {
    expect(oneLine("короткая строка", 200)).toBe("короткая строка");
  });

  test("пустой вход остаётся пустым", () => {
    expect(oneLine("", 10)).toBe("");
    expect(oneLine("   ", 10)).toBe("");
  });

  test("хвостовой пробел не остаётся перед многоточием", () => {
    expect(oneLine("аб вгдеёж", 4)).toBe("аб…");
  });
});
