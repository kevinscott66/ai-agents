/**
 * Аудит 2026-08-12: у новости без эмодзи в канал уходило слово «undefined».
 *
 * В типе поле необязательное (tools/daily-draft.ts, `DraftArticle`):
 *
 *   emoji?: string;
 *
 * а оба рендера подставляют его без проверки:
 *
 *   tools/daily-draft.ts:323   lines.push(`${a.emoji} **${a.title}**`);   // превью
 *   tools/approve-poll.ts:533  lines.push(`${a.emoji} **${a.title}**`);   // публикация
 *
 * Шаблонная строка не пропускает undefined молча — она печатает его текстом.
 * Замер на статье без emoji: строка получалась
 *
 *   "undefined **Заголовок**"
 *
 * Путь не гипотетический: pending.json живёт до суток, лежит на диске в
 * читаемом виде и правится владельцем руками (именно так чинят опечатку в
 * заголовке перед аппрувом), а сгенерированный ранее черновик мог не иметь
 * поля вовсе. Второй рендер — уже финальный текст публичного поста.
 *
 * Инвариант: отсутствующий эмодзи даёт маркер по умолчанию, а не слово
 * «undefined»; правило применяется в обоих рендерах — превью и публикации.
 */
import { describe, test, expect } from "bun:test";
import {
  buildPreviewText,
  itemEmoji,
  type DraftArticle,
} from "../tools/daily-draft.ts";
import { buildFinalText } from "../tools/approve-poll.ts";

function article(over: Partial<DraftArticle> = {}): DraftArticle {
  return {
    title: "Заголовок",
    date: "2026-08-12",
    summary: "Сводка.",
    body: "Тело.",
    items: [],
    sourceCount: 1,
    blurb: "Короткий блёрб.",
    ...over,
  } as DraftArticle;
}

describe("рендер новости без эмодзи", () => {
  test("превью не печатает undefined", () => {
    const t = buildPreviewText([article()]);
    expect(t).not.toInclude("undefined");
    expect(t).toInclude("**Заголовок**");
  });

  test("финальный текст публикации не печатает undefined", () => {
    const t = buildFinalText({
      createdAt: new Date().toISOString(),
      previewMsgId: 1,
      dayTitle: "Дайджест",
      articles: [article({ siteId: "abc" } as Partial<DraftArticle>)],
    } as any);
    expect(t).not.toInclude("undefined");
    expect(t).toInclude("**Заголовок**");
  });

  test("пустая строка и пробелы — тоже отсутствие эмодзи", () => {
    expect([itemEmoji(undefined), itemEmoji(""), itemEmoji("   ")]).toEqual([
      itemEmoji(undefined),
      itemEmoji(undefined),
      itemEmoji(undefined),
    ]);
    expect(itemEmoji(undefined).trim()).not.toBe("");
  });

  test("настоящий эмодзи не подменяется", () => {
    expect(itemEmoji("🔥")).toBe("🔥");
    expect(buildPreviewText([article({ emoji: "🔥" })])).toInclude("🔥 **Заголовок**");
  });
});
