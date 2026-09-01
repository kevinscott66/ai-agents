/**
 * Аудит 2026-08-12: двойная точка в каждой строке опубликованного поста.
 *
 * `blurb` — это первое предложение summary:
 *   String(a.summary).trim().split(/(?<=[.!?])\s/)[0]
 * Lookbehind оставляет саму точку в первой части, а шаблон дописывает свою:
 *   `${a.blurb}. [Подробнее →](${link})`
 *
 * Замер (зонд на реальных формах summary):
 *   "Биржа объявила листинг за сутки до старта.. [Подробнее →](…)"
 *   "Проект привлёк $30 млн!. [Подробнее →](…)"
 *   "Что дальше с ETF?. [Подробнее →](…)"
 *   "Короткое резюме без точки. [Подробнее →](…)"   ← а тут точка нужна
 *
 * Видно в каждом посте публичного канала и на превью владельцу. Существующий
 * регресс-тест tests/digest-spacing.test.ts поймать это не мог: его блёрбы —
 * «первая», «вторая», «третья», то есть без пунктуации вовсе.
 */
import { describe, test, expect } from "bun:test";
import { buildPreviewText, endSentence } from "../tools/daily-draft.ts";
import { buildFinalText } from "../tools/approve-poll.ts";
import type { PendingDraft } from "../tools/daily-draft.ts";

const CASES: Array<[string, string]> = [
  ["Биржа объявила листинг за сутки до старта.", "Биржа объявила листинг за сутки до старта."],
  ["Проект привлёк $30 млн!", "Проект привлёк $30 млн!"],
  ["Что дальше с ETF?", "Что дальше с ETF?"],
  ["Короткое резюме без точки", "Короткое резюме без точки."],
  ["Многоточие в конце…", "Многоточие в конце…"],
  ["Многоточие тремя точками...", "Многоточие тремя точками..."],
];

describe("блёрб дайджеста: ровно один знак конца предложения", () => {
  for (const [input, expected] of CASES) {
    test(`«${input}» → «${expected}»`, () => {
      expect(endSentence(input)).toBe(expected);
    });
  }

  test("превью владельцу не удваивает точку", () => {
    const arts = [
      {
        emoji: "🔥",
        title: "A",
        blurb: "Биржа объявила листинг.",
        summary: "",
        body: "",
        items: [],
        sourceCount: 0,
      },
      {
        emoji: "💰",
        title: "B",
        blurb: "Раунд вёл a16z!",
        summary: "",
        body: "",
        items: [],
        sourceCount: 0,
      },
    ] as any;
    const text = buildPreviewText(arts);
    expect(text).toContain("Биржа объявила листинг. [Подробнее");
    expect(text).toContain("Раунд вёл a16z! [Подробнее");
    expect(text).not.toContain("..");
    expect(text).not.toContain("!.");
    // Отступы (эталон #75) на месте — правка касается только пунктуации.
    expect(text).toContain("\n\n💰 **B**");
  });

  test("итоговый пост в канал не удваивает точку", () => {
    const pending: PendingDraft = {
      createdAt: new Date().toISOString(),
      previewMsgId: 1,
      dayTitle: "Дайджест: тест",
      articles: [
        {
          title: "A",
          date: "2026-08-12",
          summary: "",
          body: "",
          items: [],
          sourceCount: 0,
          emoji: "🔥",
          blurb: "Биржа объявила листинг.",
          siteId: "aaa111",
        },
        {
          title: "B",
          date: "2026-08-12",
          summary: "",
          body: "",
          items: [],
          sourceCount: 0,
          emoji: "💰",
          blurb: "Без точки",
          siteId: "bbb222",
        },
      ],
    };
    const text = buildFinalText(pending);
    expect(text).toContain("Биржа объявила листинг. [Подробнее →](");
    expect(text).toContain("Без точки. [Подробнее →](");
    expect(text).not.toContain("..");
  });
});
