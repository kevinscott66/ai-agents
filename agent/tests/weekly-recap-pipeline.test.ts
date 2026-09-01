/**
 * T-741. Недельный пост идёт тем же путём «черновик → апрув → канал», что и
 * дайджест, а не своим собственным.
 *
 * Задача требует и график, и того, кто проверяет выпуск. Второе уже построено:
 * `approve-poll` каждые 30 минут читает единственный `pending.json`, ищет апрув
 * владельца и публикует. Заводить рядом вторую очередь с собственным апрувом
 * значило бы получить два механизма подтверждения на один канал — и один
 * непроверенный, потому что владелец привык смотреть в первый.
 *
 * Отсюда разделитель `kind` в самом черновике:
 *
 *  • `kind: "weekly"` — публикуется УЖЕ СОБРАННЫЙ текст (`text`), а не
 *    пересобранный из статей. Недельный пост ссылается на то, что вышло за
 *    неделю, новых страниц на сайте не рождает: `articles` у него пуст, и
 *    ингесту там делать нечего.
 *  • Черновика БЕЗ `kind` быть не должно сломано: ровно такой файл лежит
 *    сейчас на VPS в `/opt/web3-puls/drafts/pending.json`, написанный
 *    сегодняшним `daily-draft`. Отсутствие поля = дайджест, как раньше.
 *
 * Отдельно проверяется, что недельный черновик не затирает дневной, ждущий
 * апрува: слот один, а `pendingAwaitingApproval` + `acquireDraftLock` уже
 * умеют его стеречь (инцидент с previewMsgId 4001→4002, daily-draft.ts).
 * Затерев дневной черновик, мы бы потеряли и апрув на него, и оплаченный ресёрч.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFinalText, headline } from "../tools/approve-poll.ts";
import { pendingAwaitingApproval, acquireDraftLock } from "../tools/daily-draft.ts";
import type { PendingDraft } from "../tools/daily-draft.ts";
import { buildWeeklyRecapText } from "../lib/delabs-post-templates.ts";
import { isChannelFooterLine } from "../lib/channel-footer.ts";

const WEEKLY_TEXT = buildWeeklyRecapText({
  activities: [
    { project: "Monad", emoji: "🔥", done: "закрыли 5 из 7 шагов", url: "https://delabs.space/activity/12" },
  ],
  news: [
    { emoji: "💰", title: "ETF на SOL одобрен", blurb: "приток $300 млн за сутки", url: "https://delabs.space/digest/88" },
  ],
  ahead: "разбираем два новых тестнета",
  weekEnd: new Date(Date.UTC(2026, 7, 12, 12)),
});

function weeklyPending(): PendingDraft {
  return {
    createdAt: "2026-08-12T18:00:00.000Z",
    previewMsgId: 7001,
    dayTitle: "Итоги недели",
    articles: [],
    kind: "weekly",
    text: WEEKLY_TEXT,
  };
}

describe("недельный черновик публикуется как есть", () => {
  const final = buildFinalText(weeklyPending());

  test("в канал уходит собранный текст, а не пересобранный дайджест", () => {
    expect(final.startsWith("🗓 **Итоги недели**")).toBe(true);
    // Шапка дайджеста сюда не подмешивается.
    expect(final).not.toContain("📰 **Итоги недели**");
    expect(final).not.toContain("Коротко о главном");
  });

  test("текст сохранён дословно, включая пустые строки между пунктами", () => {
    expect(final).toContain(WEEKLY_TEXT);
    expect(final).toContain("🔥 **Monad**");
    expect(final).toContain("💰 **ETF на SOL одобрен**");
    expect(final).toContain("⏳ **На следующей неделе:** разбираем два новых тестнета.");
  });

  test("футер приклеен ровно один раз", () => {
    const footers = final.split("\n").filter((l) => isChannelFooterLine(l));
    expect(footers.length).toBe(1);
    expect(isChannelFooterLine(final.trimEnd().split("\n").at(-1)!)).toBe(true);
  });

  test("пустой articles не превращается в пост из одной шапки", () => {
    // У дайджеста пункты берутся из articles; у недельного их нет вовсе, и
    // это норма — текст уже собран.
    expect(weeklyPending().articles.length).toBe(0);
    expect(final.split("\n").length).toBeGreaterThan(8);
  });
});

describe("черновик без kind остаётся дайджестом", () => {
  const legacy: PendingDraft = {
    createdAt: "2026-08-12T05:00:00.000Z",
    previewMsgId: 4242,
    dayTitle: "Дайджест: главное за сутки",
    articles: [
      {
        title: "Monad вышел в мейннет",
        date: "2026-08-12T05:00:00.000Z",
        summary: "s",
        body: "b",
        items: [],
        sourceCount: 2,
        emoji: "🔥",
        blurb: "сеть открыта всем",
        siteId: "2026-08-12-monad",
      },
    ],
  };

  test("шапка дайджеста на месте — ровно как до появления kind", () => {
    const t = buildFinalText(legacy);
    expect(t.startsWith("📰 **главное за сутки**")).toBe(true);
    expect(t).toContain("Коротко о главном — детали по ссылкам на сайте.");
    expect(t).toContain("🔥 **Monad вышел в мейннет**");
    expect(t).toContain("[Подробнее →](https://delabs.space/digest/2026-08-12-monad)");
  });

  test("headline по-прежнему срезает служебный префикс", () => {
    expect(headline(legacy)).toBe("главное за сутки");
  });
});

describe("недельный черновик не затирает дневной", () => {
  test("слот занят живым дневным черновиком — недельный не пишем", () => {
    const dir = mkdtempSync(join(tmpdir(), "t741-"));
    const path = join(dir, "pending.json");
    try {
      const daily: PendingDraft = {
        createdAt: new Date(Date.UTC(2026, 7, 12, 5)).toISOString(),
        previewMsgId: 4001,
        dayTitle: "Дайджест: главное за сутки",
        articles: [],
      };
      writeFileSync(path, JSON.stringify(daily));
      const now = Date.UTC(2026, 7, 12, 18); // тот же день, 13 часов спустя
      const live = pendingAwaitingApproval(path, now);
      expect(live?.previewMsgId).toBe(4001);
      // Именно на этом и должен останавливаться недельный прогон: апрув ищут по
      // previewMsgId, и перезапись потеряла бы и его, и оплаченный ресёрч.
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("замок один на оба тайминга: второй прогон уходит ни с чем", () => {
    const dir = mkdtempSync(join(tmpdir(), "t741-lock-"));
    const lock = join(dir, "pending.json.lock");
    try {
      const now = Date.UTC(2026, 7, 12, 18);
      expect(acquireDraftLock(lock, now, "daily")).not.toBeNull();
      expect(acquireDraftLock(lock, now, "weekly")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
