/**
 * Аудит 2026-08-28: у публикующего скрипта была своя копия футера канала.
 *
 * `agent/tools/approve-poll.ts` держал `const FOOTER = "💬 [ЧАТ]…"` — байт в
 * байт ту же строку, что `CHANNEL_FOOTER` в lib/channel-footer.ts, из модуля,
 * который этот же файл импортирует строкой выше ради `ensureChannelFooter`.
 *
 * Публикация в @delabsru идёт именно отсюда (`buildFinalText`), поэтому правка
 * канонического футера — новая ссылка на чат, следующий год копирайта —
 * доехала бы куда угодно, только не в канал, и молча: `ensureChannelFooter`
 * видит блок футера на месте и ничего не меняет.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CHANNEL_FOOTER } from "../lib/channel-footer.ts";
import { buildFinalText } from "../tools/approve-poll.ts";
import type { PendingDraft } from "../tools/daily-draft.ts";

const SRC = readFileSync(new URL("../tools/approve-poll.ts", import.meta.url), "utf-8");

describe("одно определение футера на проект", () => {
  test("в публикующем скрипте нет своей копии строки", () => {
    expect(SRC).not.toContain("💬 [ЧАТ](https://t.me/");
    expect(SRC).toContain("const FOOTER = CHANNEL_FOOTER;");
  });

  test("канонический футер импортируется оттуда же, откуда ensureChannelFooter", () => {
    expect(SRC).toContain(
      'import { CHANNEL_FOOTER, ensureChannelFooter } from "../lib/channel-footer.ts";',
    );
  });
});

describe("текст поста не поехал", () => {
  const base = {
    dayTitle: "Дайджест: тестовый день",
    date: "2026-08-28T09:00:00.000Z",
  } as unknown as PendingDraft;

  test("дайджест заканчивается каноническим футером", () => {
    const pending = {
      ...base,
      articles: [
        {
          title: "Заголовок",
          blurb: "Короткая фраза",
          emoji: "🟣",
          siteId: "2026-08-28-zagolovok",
        },
      ],
    } as unknown as PendingDraft;
    const out = buildFinalText(pending);
    expect(out.endsWith(CHANNEL_FOOTER)).toBe(true);
    // Ровно один — ensureChannelFooter не должен доклеивать второй.
    expect(out.split(CHANNEL_FOOTER).length - 1).toBe(1);
  });

  test("недельный пост — тоже", () => {
    const pending = {
      ...base,
      kind: "weekly",
      text: "Итоги недели",
      articles: [],
    } as unknown as PendingDraft;
    const out = buildFinalText(pending);
    expect(out.endsWith(CHANNEL_FOOTER)).toBe(true);
    expect(out.split(CHANNEL_FOOTER).length - 1).toBe(1);
  });
});
