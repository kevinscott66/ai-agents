/**
 * Аудит 2026-08-13: PUBLISH_TO_CHANNEL молча укорачивал пост.
 *
 * Подгонка под лимит (`fitToLimit`) сообщала о себе одним `log.warn` на VPS, а
 * наружу во всех четырёх успешных выходах уходило `{ok:true}` без единого
 * признака, что в канал ушёл не тот текст, который просили опубликовать. Модель
 * по такому результату честно докладывает владельцу «опубликовано» — и это
 * ровно тот случай, когда отчёт расходится с фактом.
 *
 * Разрыв бывает большим. Подпись под баннером режется до 2048, а если Premium у
 * аккаунта кончился, повтор идёт под 1024 (см. publish-userbot-caption): от
 * поста на 4096 остаётся четверть. Сослаться на сайт нельзя — мост
 * `ingestDigestToSite` выключен по умолчанию и работает только для публичного
 * канала и только для постов с источниками.
 *
 * Правка касается ТОЛЬКО отчёта: доставка, лимиты и сами резы не тронуты — что
 * здесь и проверяется отдельным блоком.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { dispatchAction, formatGateResult } from "../lib/action-dispatch.ts";
import { registerTeamChannel } from "../lib/team-channels.ts";
import { plainTelegramLength } from "../lib/telegram-format.ts";
import { _resetRateLimits } from "../lib/rate-limits.ts";
import { _resetFloodCooldowns } from "../lib/userbot-flood.ts";
import type { UserbotHandle } from "../lib/userbot.ts";
import { db } from "../lib/db.ts";

const CH = -100781;
const STANDARD = 1024;

/** ~n символов plain-текста в одном абзаце. */
const para = (n: number) => "слово ".repeat(Math.ceil(n / 6)).trim().slice(0, n);

/** Видимый текст отрендеренного HTML — так его считает Telegram. */
const visible = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

function makeUserbot(opts: { captionLimit?: number } = {}): UserbotHandle & {
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
      if (opts.captionLimit != null && plainTelegramLength(text) > opts.captionLimit) {
        throw new Error("RPCError 400: MEDIA_CAPTION_TOO_LONG (caption is too long)");
      }
      return { message_id: 42 };
    },
  } as unknown as UserbotHandle & { calls: string[] };
}

/**
 * Bot-API путь: юзербота нет. Превью здесь обязательно — при отсутствии
 * обложки хендлер рисует авто-баннер, поэтому `sendPhoto` нужен всегда, а
 * длинный текст уходит отдельным `sendMessage` следом за баннером.
 */
function makeBotApi() {
  const sent: string[] = [];
  const captions: (string | undefined)[] = [];
  return {
    sent,
    captions,
    telegram: {
      async sendPhoto(_c: number, _p: unknown, extra: any) {
        captions.push(extra?.caption);
        if (extra?.caption) sent.push(extra.caption);
        return { message_id: 76 };
      },
      async sendMessage(_c: number, text: string) {
        sent.push(text);
        return { message_id: 77 };
      },
    } as any,
  };
}

const publish = async (
  text: string,
  over: { userbot?: UserbotHandle; telegram?: any },
) =>
  await dispatchAction(
    "PUBLISH_TO_CHANNEL",
    { channelId: CH, text } as any,
    {
      agentKey: "smm",
      chatId: -1,
      telegram:
        over.telegram ??
        ({ sendMessage: () => Promise.reject(new Error("Bot API не должен звучать")) } as any),
      userbot: over.userbot,
    } as any,
  );

/** Тело успешного результата как объект — именно его разворачивают модели. */
const body = (out: any) => out.result as Record<string, unknown>;

beforeEach(() => {
  db.prepare("DELETE FROM team_channels WHERE channel_id = ?").run(CH);
  registerTeamChannel(CH, "Team Ch", -1);
  _resetRateLimits();
  _resetFloodCooldowns();
});

describe("обрезка названа вслух", () => {
  test("юзербот без Premium: ушла четверть поста — и это видно в результате", async () => {
    const ub = makeUserbot({ captionLimit: STANDARD });
    const full = `**Итоги недели**\n\n${para(1800)}`;
    const out: any = await publish(full, { userbot: ub });

    expect(out.ok).toBe(true);
    expect(ub.calls.length).toBe(2); // первая попытка отвергнута, вторая ушла
    expect(body(out).truncated).toBe(true);
    expect(body(out).plain_sent).toBeLessThanOrEqual(STANDARD);
    expect(body(out).plain_full as number).toBeGreaterThan(STANDARD);
    // Замер идёт по реально отправленному тексту, а не по промежуточному.
    expect(body(out).plain_sent).toBe(plainTelegramLength(ub.calls[1]!));
  });

  test("Bot API: пост длиннее лимита сообщения репортится обрезанным", async () => {
    const api = makeBotApi();
    const out: any = await publish(`**Лонгрид**\n\n${para(5200)}`, {
      telegram: api.telegram,
    });

    expect(out.ok).toBe(true);
    expect(api.sent.length).toBe(1);
    expect(body(out).truncated).toBe(true);
    expect(body(out).plain_sent).toBeLessThanOrEqual(4096);
    expect(body(out).plain_full as number).toBeGreaterThan(4096);
  });

  test("id сообщения не теряется — признак добавлен К результату, а не вместо", async () => {
    const api = makeBotApi();
    const out: any = await publish(`**Лонгрид**\n\n${para(5200)}`, {
      telegram: api.telegram,
    });
    // Без этого «сообщил об обрезке» стоило бы модели ссылки на сам пост.
    expect(body(out).messageId ?? body(out).message_id).toBe(77);
  });

  test("признак доезжает до модели плоским полем в tool_result", async () => {
    const api = makeBotApi();
    const out: any = await publish(`**Лонгрид**\n\n${para(5200)}`, {
      telegram: api.telegram,
    });
    // formatGateResult разворачивает result в JSON — проверяем именно то, что
    // увидит модель, а не внутреннюю форму.
    const seen = JSON.parse(
      formatGateResult("PUBLISH_TO_CHANNEL", {
        kind: "ok",
        result: out.result,
        actionId: "a1",
      }),
    );
    expect(seen.ok).toBe(true);
    expect(seen.truncated).toBe(true);
    expect(typeof seen.note).toBe("string");
  });
});

describe("нетронутый пост не тронут", () => {
  test("юзербот: короткий пост уходит с первой попытки и без признаков обрезки", async () => {
    const ub = makeUserbot({ captionLimit: STANDARD });
    const out: any = await publish(`**Крючок.** ${para(300)}`, { userbot: ub });

    expect(out.ok).toBe(true);
    expect(ub.calls.length).toBe(1);
    // Ровно тот объект, что вернул publishPost, — ни обёртки, ни лишних полей.
    expect(out.result).toEqual({ message_id: 42 });
  });

  test("Bot API: пост в пределах лимита не получает ни truncated, ни note", async () => {
    const api = makeBotApi();
    const out: any = await publish(`**Анонс.** ${para(500)}`, {
      telegram: api.telegram,
    });

    expect(out.ok).toBe(true);
    expect(body(out).truncated).toBeUndefined();
    expect(body(out).note).toBeUndefined();
    expect(body(out).plain_sent).toBeUndefined();
  });

  test("в канал по-прежнему уходит подогнанный текст, а не полный", async () => {
    // Признак — это отчёт, а не разрешение слать длиннее лимита.
    const api = makeBotApi();
    await publish(`**Лонгрид**\n\n${para(5200)}`, { telegram: api.telegram });
    // В стаб приходит уже отрендеренный HTML, поэтому меряем видимый текст:
    // `plainTelegramLength` принимает markdown и на готовом HTML экранировала бы
    // его же теги, вернув сырую длину.
    expect(visible(api.sent[0]!).length).toBeLessThanOrEqual(4096);
  });
});
