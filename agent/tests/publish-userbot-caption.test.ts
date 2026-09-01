/**
 * Аудит 2026-08-11: лимит подписи 2048 — это допущение о ЧУЖОЙ подписке.
 *
 * PUBLISH_TO_CHANNEL подгоняет подпись под `PREMIUM_CAPTION_LIMIT = 2048`,
 * потому что у Telegram Premium лимит вдвое больше обычного. Проверить статус
 * подписки код не может и не проверяет. Пока Premium активен — всё верно; в
 * день, когда он кончится (не продлили, оплата не прошла), Telegram начинает
 * отвечать MEDIA_CAPTION_TOO_LONG на КАЖДЫЙ пост с баннером, а баннер у нас
 * ставится автоматически ко всем постам. То есть публикация в канал отказывает
 * целиком, и по логу это выглядит как загадочная ошибка юзербота.
 *
 * Отказ детерминированный и приходит до создания сообщения — значит повтор с
 * подписью под обычный лимит безопасен и дублей не даёт. Пост с более короткой
 * подписью хуже полного, но несравнимо лучше отсутствия поста.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { dispatchAction } from "../lib/action-dispatch.ts";
import { registerTeamChannel } from "../lib/team-channels.ts";
import { plainTelegramLength } from "../lib/telegram-format.ts";
import { _resetRateLimits } from "../lib/rate-limits.ts";
import { _resetFloodCooldowns } from "../lib/userbot-flood.ts";
import type { UserbotHandle } from "../lib/userbot.ts";
import { db } from "../lib/db.ts";

const CH = -100780;
/** Обычный (не-Premium) лимит подписи к медиа. */
const STANDARD = 1024;

function makeUserbot(opts: { rejectWith?: Error; captionLimit?: number }): UserbotHandle & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    isNoop: false,
    calls,
    async setReaction() {},
    async deleteMessage() {},
    async sendMessage() {
      return { message_id: 1 };
    },
    async publishPost(_channelId: number, text: string) {
      calls.push(text);
      if (opts.rejectWith) throw opts.rejectWith;
      if (opts.captionLimit != null && plainTelegramLength(text) > opts.captionLimit) {
        // Форма ошибки gramjs: RPCError с MTProto-кодом в message.
        throw new Error("RPCError 400: MEDIA_CAPTION_TOO_LONG (caption is too long)");
      }
      return { message_id: 42 };
    },
  } as unknown as UserbotHandle & { calls: string[] };
}

const publish = async (text: string, ub: UserbotHandle) =>
  await dispatchAction(
    "PUBLISH_TO_CHANNEL",
    { channelId: CH, text } as any,
    {
      agentKey: "smm",
      chatId: -1,
      telegram: { sendMessage: () => Promise.reject(new Error("Bot API не должен звучать")) } as any,
      userbot: ub,
    } as any,
  );

/** ~n символов plain-текста в одном абзаце. */
const para = (n: number) => "слово ".repeat(Math.ceil(n / 6)).trim().slice(0, n);

/**
 * Запас по таймауту, а не ускорение.
 *
 * Каждый `publish()` здесь проходит НАСТОЯЩИЙ путь публикации, включая рендер
 * обложки: `renderCoverBanner` → resvg → PNG 1536×1024 (~330 КБ). Замер на
 * этой машине вхолостую — 400-900 мс на баннер, а тест с повтором рисует его
 * дважды. Дефолтные 5 с бун покрывают это только на незагруженной машине: в
 * полном прогоне на 392 файла те же тела упирались в 4.7-6.6 с и краснели
 * «timed out» — то есть результат зависел от того, что ещё крутится на
 * машине, а не от кода.
 *
 * Рендер здесь не мокается намеренно: повтор при MEDIA_CAPTION_TOO_LONG
 * обязан отдать в канал ту же картинку и укоротить только подпись, а с
 * заглушкой вместо баннера это утверждение стало бы пустым.
 */
const SLOW = 30_000;

describe("PUBLISH_TO_CHANNEL: аккаунт без Premium", () => {
  beforeEach(() => {
    db.prepare("DELETE FROM team_channels WHERE channel_id = ?").run(CH);
    registerTeamChannel(CH, "Team Ch", -1);
    _resetRateLimits();
    _resetFloodCooldowns();
  });

  test("MEDIA_CAPTION_TOO_LONG → повтор с подписью под обычный лимит", async () => {
    const ub = makeUserbot({ captionLimit: STANDARD });
    const out = await publish(`**Итоги недели**\n\n${para(1800)}`, ub);
    expect(out.ok).toBe(true);
    expect(ub.calls.length).toBe(2);
    // Первая попытка — по премиальному лимиту, вторая уже влезает в обычный.
    expect(plainTelegramLength(ub.calls[0])).toBeGreaterThan(STANDARD);
    expect(plainTelegramLength(ub.calls[1])).toBeLessThanOrEqual(STANDARD);
    expect(ub.calls[1]).toContain("Итоги недели");
  }, SLOW);

  test("короткий пост уходит с первой попытки", async () => {
    const ub = makeUserbot({ captionLimit: STANDARD });
    const out = await publish(`**Крючок.** ${para(300)}`, ub);
    expect(out.ok).toBe(true);
    expect(ub.calls.length).toBe(1);
  }, SLOW);

  test("другая ошибка юзербота не переотправляется", async () => {
    // CHAT_WRITE_FORBIDDEN коротким текстом не лечится, а повтор на сетевой
    // ошибке дал бы в канале второй экземпляр поста.
    const ub = makeUserbot({ rejectWith: new Error("RPCError 403: CHAT_WRITE_FORBIDDEN") });
    const out = await publish(`**Крючок.** ${para(1800)}`, ub);
    expect(out.ok).toBe(false);
    expect(ub.calls.length).toBe(1);
  }, SLOW);
});
