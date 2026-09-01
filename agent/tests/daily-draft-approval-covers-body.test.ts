/**
 * Аудит 2026-08-12: владелец апрувил заголовки, а публиковался текст статьи.
 *
 * Черновик показывает `buildPreviewText`: заголовок дня, дата и по каждой
 * новости — `emoji + title` и `blurb`. Ни `summary`, ни `body` в превью нет.
 * А при апруве (реакция ✅ или «+») `approve-poll.ts::ingestArticle` шлёт на
 * сайт body целиком:
 *
 *   body: JSON.stringify({ title, date, summary, body: a.body, items, … })
 *
 * `body` — это 2–3 абзаца, написанные моделью по результатам веб-поиска
 * (daily-draft.ts: «body: 2-3 абзаца по-русски, ключевые цифры/имена выделяй
 * **жирным**»), с именами, суммами и процентами. Они уходят на публичный сайт
 * `delabs.space/digest/<id>` по одному плюсу, и владелец не видел из них ни
 * слова. Гейт апрува есть — он просто не покрывает то, что публикуется.
 *
 * Замер до правки — весь текст, который видел владелец:
 *
 *   "📰 **Aave вводит риск-фреймворк**\n🗓️ 12 августа 2026\n\nКоротко о
 *    главном — детали по ссылкам на сайте.\n\n🟣 **Aave вводит
 *    риск-фреймворк**\nОценка рисков станет обязательной. [Подробнее →
 *    (ссылка на апруве)]\n\n🟢 **Solana ETF собрал $500 млн**\n…"
 *
 * Ни одного абзаца body, ни одного summary, ни одной ссылки-источника.
 *
 * Инвариант: всё, что уйдёт в ингест, владелец видит ДО апрува.
 */
import { describe, test, expect } from "bun:test";
import {
  buildPreviewText,
  buildDraftReviewText,
  chunkForTelegram,
  TG_MESSAGE_LIMIT,
  type DraftArticle,
} from "../tools/daily-draft.ts";

const ARTICLES: DraftArticle[] = [
  {
    title: "Aave вводит риск-фреймворк",
    date: "2026-08-12",
    summary: "Кратко: Aave предлагает обязательную оценку рисков активов.",
    body:
      "После эксплойта на **$292M** Aave предлагает фреймворк.\n\n" +
      "Несоответствующие активы отключат в течение **90 дней**.",
    items: [{ text: "Источник", url: "https://example.org/aave" }],
    sourceCount: 2,
    emoji: "🟣",
    blurb: "Оценка рисков станет обязательной",
  },
  {
    title: "Solana ETF собрал $500 млн",
    date: "2026-08-12",
    summary: "Кратко: приток в первый день торгов.",
    body: "Фонд собрал **$500 млн** за первые сутки — рекорд для альткоин-ETF.",
    items: [{ text: "Источник", url: "https://example.org/sol" }],
    sourceCount: 1,
    emoji: "🟢",
    blurb: "Рекорд для альткоин-ETF",
  },
];

/** Всё, что владелец получает в Saved Messages до апрува. */
function ownerSees(articles: DraftArticle[]): string {
  return [
    buildPreviewText(articles),
    ...chunkForTelegram(buildDraftReviewText(articles)),
  ].join("\n");
}

describe("апрув покрывает то, что публикуется", () => {
  test("владелец видит body каждой статьи до апрува", () => {
    const seen = ownerSees(ARTICLES);
    for (const a of ARTICLES) {
      expect(seen).toContain(a.body);
    }
  });

  test("владелец видит summary каждой статьи до апрува", () => {
    const seen = ownerSees(ARTICLES);
    for (const a of ARTICLES) {
      expect(seen).toContain(a.summary);
    }
  });

  test("владелец видит ссылки-источники до апрува", () => {
    const seen = ownerSees(ARTICLES);
    for (const a of ARTICLES) {
      for (const it of a.items) expect(seen).toContain(it.url);
    }
  });

  test("body показывается как есть — вместе с ** разметкой", () => {
    // На сайт уезжает именно строка с `**`. Если бы мы прогнали её через
    // markdown-разбор, владелец сверял бы не тот текст, который публикуется.
    expect(buildDraftReviewText(ARTICLES)).toContain("**$292M**");
  });

  test("превью остаётся коротким — это подпись к фото (лимит 1024)", () => {
    expect(buildPreviewText(ARTICLES).length).toBeLessThanOrEqual(1024);
  });
});

describe("нарезка на сообщения", () => {
  test("ни один кусок не превышает лимит Telegram", () => {
    const long: DraftArticle[] = Array.from({ length: 4 }, (_, i) => ({
      ...ARTICLES[0]!,
      title: `Статья ${i}`,
      body: "абзац ".repeat(400).trim(),
    }));
    for (const c of chunkForTelegram(buildDraftReviewText(long))) {
      expect(c.length).toBeLessThanOrEqual(TG_MESSAGE_LIMIT);
    }
  });

  test("текст не теряется при нарезке", () => {
    const src = buildDraftReviewText(ARTICLES);
    const joined = chunkForTelegram(src, 200).join("\n");
    // Склейка по границам строк: содержимое то же, отличается лишь тем, что
    // на стыках кусков перевод строки восстанавливается как \n.
    expect(joined.replace(/\n/g, "")).toBe(src.replace(/\n/g, ""));
  });

  test("строка длиннее лимита дорезается, а не выбрасывается", () => {
    const line = "я".repeat(500);
    const chunks = chunkForTelegram(line, 100);
    expect(chunks.every((c) => c.length <= 100)).toBe(true);
    expect(chunks.join("")).toBe(line);
  });

  test("пустой вход не даёт пустого массива сообщений", () => {
    expect(chunkForTelegram("")).toEqual([""]);
  });
});
