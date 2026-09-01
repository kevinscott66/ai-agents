/**
 * Аудит 2026-08-20 — геометрия текста на баннере.
 *
 * Меряем не «похоже на правду», а сам инвариант: правый край самой длинной
 * строки заголовка при той же оценке ширины (TITLE_CHAR_W), по которой её и
 * переносили, не должен выходить за холст.
 */
import { describe, test, expect } from "bun:test";
import { buildBannerSvg, buildIllustratedBannerSvg } from "../lib/cover-banner.ts";

const IW = 1536;
const W = 1920;
const PADX = 140;
const TITLE_SHIFT_X = 34;
const TITLE_CHAR_W = 0.74;

/**
 * Заголовочные строки. Отличаются от чипа тега ОТРИЦАТЕЛЬНЫМ трекингом:
 * у заголовка он -(size·0.018), у тега — жёсткое 1.5.
 */
function titleRuns(svg: string): Array<{ text: string; size: number }> {
  const out: Array<{ text: string; size: number }> = [];
  const re = /<text[^>]*font-size="(\d+)"[^>]*font-weight="800"[^>]*letter-spacing="-[^"]*"[^>]*>([^<]*)<\/text>/g;
  for (const m of svg.matchAll(re)) {
    out.push({ text: m[2]!, size: Number(m[1]) });
  }
  return out;
}

/** Правый край самой широкой строки по той же оценке, что и в переносе. */
function rightEdge(svg: string, leftPad: number): number {
  const runs = titleRuns(svg);
  expect(runs.length).toBeGreaterThan(0);
  const widest = Math.max(...runs.map((r) => r.text.length * r.size * TITLE_CHAR_W));
  return leftPad + widest;
}

const LONG = "Аирдропы недели: что забрать прямо сейчас";

describe("аудит 2026-08-20: заголовок не вылезает за холст", () => {
  test("иллюстрированный баннер — путь по умолчанию — держит заголовок внутри", () => {
    // Раньше подгонка мерила TITLE_AVAIL_W ≈ 1424 от чистого баннера 1920:
    // строка выходила ≈1373 при левом отступе 174, то есть правый край 1547.
    const svg = buildIllustratedBannerSvg({ title: LONG });
    expect(svg).not.toBeNull();
    expect(rightEdge(svg!, PADX + TITLE_SHIFT_X)).toBeLessThanOrEqual(IW);
  });

  test("та же проверка на десятке настоящих заголовков", () => {
    const titles = [
      "Итоги недели: что произошло в Web3 и на что смотреть",
      "Аирдропы недели: что забрать прямо сейчас",
      "Отработка активностей: пошаговый разбор",
      "Разблокировки токенов на этой неделе",
      "Пять тестнетов, которые стоят вашего времени",
      "Дайджест",
      "Как не потерять деньги на новых листингах",
      "Что такое points-программы и зачем они нужны",
      "Обзор экосистемы: L2 против альтернативных L1",
      "Сверхдлинноесловокотороенепереноситсянигде",
    ];
    for (const t of titles) {
      const svg = buildIllustratedBannerSvg({ title: t });
      expect(svg).not.toBeNull();
      expect(rightEdge(svg!, PADX + TITLE_SHIFT_X)).toBeLessThanOrEqual(IW);
    }
  });

  test("чистый баннер 1920 по-прежнему укладывается в свою зону", () => {
    const svg = buildBannerSvg({ title: LONG });
    // Зона до логотипа: PADX … LOGO_LEFT − TITLE_GAP.
    expect(rightEdge(svg, PADX)).toBeLessThanOrEqual(W);
  });

  test("иллюстрированный баннер не потерял заголовок целиком", () => {
    const svg = buildIllustratedBannerSvg({ title: LONG })!;
    const joined = titleRuns(svg).map((r) => r.text).join(" ");
    expect(joined.replace(/\s+/g, " ")).toBe(LONG);
  });
});

describe("аудит 2026-08-20: чип тега меряется по сырому тексту", () => {
  const chipW = (svg: string): number => {
    const m = svg.match(/<rect x="140" y="86" width="(\d+)" height="60"/);
    expect(m).not.toBeNull();
    return Number(m![1]);
  };

  test("амперсанд в теге не раздувает чип", () => {
    // esc("AT&T") = "AT&amp;T": семь символов вместо четырёх.
    const amp = buildIllustratedBannerSvg({ title: "т", tag: "AT&T" })!;
    const plain = buildIllustratedBannerSvg({ title: "т", tag: "ATxT" })!;
    expect(chipW(amp)).toBe(chipW(plain));
  });

  test("экранирование в разметке при этом осталось", () => {
    const svg = buildIllustratedBannerSvg({ title: "т", tag: "AT&T" })!;
    expect(svg).toContain(">AT&amp;T<");
    expect(svg).not.toContain(">AT&T<");
  });

  test("на чистом баннере то же самое", () => {
    const w = (svg: string) => {
      const m = svg.match(/<rect x="140" y="\d+" width="(\d+)" height="\d+" rx="\d+" fill="#6d5cff"/);
      return m ? Number(m[1]) : null;
    };
    const amp = w(buildBannerSvg({ title: "т", tag: "AT&T" }));
    const plain = w(buildBannerSvg({ title: "т", tag: "ATxT" }));
    expect(amp).not.toBeNull();
    expect(amp).toBe(plain);
  });
});

describe("аудит 2026-08-20: заголовок из пробелов", () => {
  test("не даёт баннер без заголовка", () => {
    for (const svg of [
      buildBannerSvg({ title: "   " }),
      buildIllustratedBannerSvg({ title: "   " })!,
    ]) {
      const joined = titleRuns(svg).map((r) => r.text).join("");
      expect(joined.trim()).toBe("Дайджест");
    }
  });
});
