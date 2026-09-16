/**
 * PUBLISH_TO_CHANNEL side-effect handler.
 *
 * Keeps channel ownership checks, content policy, cover fallbacks, Telegram
 * delivery and rollback in one boundary. The dispatcher supplies the userbot
 * resolver so routing and legacy test seams remain outside this module.
 */
import type { Telegram } from "telegraf";
import { getErrorMessage } from "../errors.ts";
import { HOUR_MS } from "../time-constants.ts";
import { generateCoverPng } from "./media.ts";
import { renderBannerPng, renderIllustratedBannerPng, hasBannerPool } from "../cover-banner.ts";
import { plainTelegramLength, cutBlock } from "../telegram-format.ts";
import {
  tgSendMessage,
  tgSendPhoto,
  tgDeleteMessage,
  isPhotoRejected,
  isCaptionTooLong,
} from "../telegram-actions.ts";
import { guardedUserbotCall } from "../userbot-flood.ts";
import type { UserbotHandle } from "../userbot.ts";
import { ingestDigestToSite, deriveTitle } from "../site-ingest.ts";
import { isTeamChannel } from "../team-channels.ts";
import { ensureChannelFooter, isChannelFooterLine } from "../channel-footer.ts";
import type { PayloadByType } from "../action-payload.ts";
import { log } from "../log.ts";

export interface PublishHandlerContext {
  agentKey: string;
  chatId: number;
  telegram: Telegram;
  resolveUserbot: () => Promise<UserbotHandle | null>;
}

export type PublishDispatchResult =
  | { ok: true; result: unknown }
  // `sideEffect` — «провал, но что-то уже видно снаружи»; см. HandlerResult в
  // dispatch/helpers.ts. `gateOrDispatch` (action-dispatch.ts) читает именно
  // его и по нему НЕ возвращает слоты rate-limit. Номера строк тут стояли и
  // оба уехали — ссылаемся на символы, как в action-dispatch.ts рядом с
  // ActionResult.
  | { ok: false; error: string; sideEffect?: boolean };

const RU_MONTHS = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];

/** Дата в формате «13 июня 2026» по московскому времени (для баннера). */
function formatRuDate(d: Date = new Date()): string {
  const msk = new Date(d.getTime() + 3 * HOUR_MS);
  return `${msk.getUTCDate()} ${RU_MONTHS[msk.getUTCMonth()]} ${msk.getUTCFullYear()}`;
}

/**
 * Подогнать текст под лимит Telegram, измеряя plain-текст и сохраняя короткий
 * канонический footer последним блоком.
 *
 * «Канонический» — по единственному определению проекта (`channel-footer.ts`),
 * а не по длине. Аудит 2026-08-29: признаком футера была одна лишь длина
 * последнего блока, поэтому у поста без футера к обрезанному телу
 * приклеивался его же последний абзац — вывод вставал сразу за многоточием, и
 * обрезанный пост выглядел завершённым.
 *
 * Порядок вызовов это позволяет: `ensureChannelFooter` отрабатывает строкой
 * выше `fitToLimit`, то есть футер, если он в посте есть, уже канонический.
 */
const FOOTER_MAX_PLAIN = 300;

export function fitToLimit(text: string, limit: number, agentKey: string): string {
  if (plainTelegramLength(text) <= limit) return text;
  const blocks = text.split(/\n{2,}/);
  const last = blocks[blocks.length - 1] ?? "";
  const hasFooter =
    blocks.length > 1 &&
    plainTelegramLength(last) <= FOOTER_MAX_PLAIN &&
    last.split("\n").some(isChannelFooterLine);
  const footer = hasFooter ? last : "";
  const body = hasFooter ? blocks.slice(0, -1) : [...blocks];
  const assemble = (b: string[]) => {
    const parts = footer ? [...b, footer] : b;
    return parts.filter((x) => x !== "").join("\n\n");
  };

  const kept: string[] = [];
  for (const block of body) {
    if (plainTelegramLength(assemble([...kept, block])) <= limit) {
      kept.push(block);
      continue;
    }
    const piece = cutBlock(block, (c) => plainTelegramLength(assemble([...kept, c])) <= limit);
    if (plainTelegramLength(piece) >= 40) kept.push(piece);
    break;
  }

  let out = assemble(kept);
  if (plainTelegramLength(out) > limit) {
    out = cutBlock(out, (c) => plainTelegramLength(c) <= limit);
  }
  log.warn(
    `[publish] текст ${plainTelegramLength(text)}>${limit} (plain) — обрезал до ${plainTelegramLength(out)} (роль ${agentKey})`,
  );
  return out;
}

/**
 * Зависимости рендера обложки. Вынесены параметром, чтобы сборку опций можно
 * было проверить без Resvg и пула фонов: реальный путь тянет ~2 с синхронного
 * рендера с загрузкой системных шрифтов на общем процессе 12 ботов.
 */
export interface CoverBannerDeps {
  illustrated: typeof renderIllustratedBannerPng;
  clean: typeof renderBannerPng;
  poolAvailable: typeof hasBannerPool;
}

const REAL_COVER_DEPS: CoverBannerDeps = {
  illustrated: renderIllustratedBannerPng,
  clean: renderBannerPng,
  poolAvailable: hasBannerPool,
};

export async function renderCoverBanner(
  opts: { title: string; subtitle?: string; date?: string; seed?: string },
  style: string | undefined,
  deps: CoverBannerDeps = REAL_COVER_DEPS,
): Promise<Buffer> {
  if (style !== "clean" && deps.poolAvailable()) {
    try {
      const illu = await deps.illustrated({
        title: opts.title,
        // Аудит 2026-08-28: поля перечислялись вручную и subtitle сюда не
        // попадал. Рисовать его buildIllustratedBannerSvg научили 2026-08-20,
        // но иллюстрированный баннер — путь по умолчанию, так что та правка
        // работала только на style="clean", то есть почти никогда.
        subtitle: opts.subtitle,
        date: opts.date,
        seed: opts.seed ?? opts.title,
      });
      if (illu) return illu;
    } catch (e) {
      log.warn("[publish] иллюстрированный баннер упал — фолбэк на clean", {
        error: getErrorMessage(e),
      });
    }
  }
  return deps.clean(opts);
}

/**
 * Заголовок авто-баннера — тем же кодом, что и заголовок записи на сайте.
 *
 * Аудит 2026-09-11: здесь стояла своя копия `deriveTitle`, застывшая до двух
 * правок. Без `!isFooterLine` пост, где агент написал футер сам и ничего не
 * выделил жирным, получал на обложку «Copyright 2023-2026 [DeLabs](…)» — ту
 * самую строку, которую на сайте убрал аудит 2026-08-20. Без `unwrapMdLinks`
 * жирная ссылка `**[Zora Drop](https://…)**` рисовалась на картинке вместе с
 * адресом, а строка-ссылка проходила порог «шесть букв» за счёт самого URL
 * (аудит 2026-08-28). Разница между двумя заголовками ровно одна — длина.
 */
const BANNER_TITLE_MAX = 70;

export async function handlePublishToChannel(
  p: PayloadByType["PUBLISH_TO_CHANNEL"],
  ctx: PublishHandlerContext,
): Promise<PublishDispatchResult> {
  // anti-exfil: post only to channels created by the team from this chat.
  if (!isTeamChannel(p.channelId, ctx.chatId)) {
    return {
      ok: false,
      error: isTeamChannel(p.channelId)
        ? "канал заведён из другого чата — постить можно только в каналы своего чата"
        : "channelId не в реестре team-каналов — постить можно только в созданные командой каналы",
    };
  }

  try {
    const TG_CAPTION_LIMIT = 1024;
    const TG_MESSAGE_LIMIT = 4096;
    const fullText = ensureChannelFooter(p.text);
    const text = fitToLimit(fullText, TG_MESSAGE_LIMIT, ctx.agentKey);
    // Аудит 2026-08-27: Telegram отвергает обложку (WEBPAGE_MEDIA_EMPTY,
    // IMAGE_PROCESS_FAILED, PHOTO_INVALID_DIMENSIONS) — пост уходит голым
    // текстом, а действие возвращало ровно тот же `ok:true`, что и полная
    // публикация с картинкой. В логе VPS запись есть, у модели — нет: она
    // отчитывалась «пост с обложкой опубликован», обложку никто не чинил, и
    // следующий пост падал так же. Ровно как `truncated` ниже и
    // `fallback_from`/`fallback_reason` в media.ts — расхождение
    // «просили / получилось» обязано доехать до вызывающего.
    let coverDropped: string | undefined;
    // Аудит 2026-08-28: цепочка обложки ниже смотрела на `photoUrl` только в
    // последней ветке, поэтому `photoUrl` + `coverPrompt` списывал слот
    // GENERATE_IMAGE (6/час на роль), ходил в gpt-image-1 и терял буфер на
    // `if (p.photoUrl)` при выборе фото. С `coverTitle` терялось ~2 секунды
    // синхронного Resvg в общем процессе на 12 ботов. Ни build-payload.ts, ни
    // tools-schema.ts такую пару не запрещают, а ответ был неотличим от
    // публикации, где обложку взяли. Работу теперь не делаем вовсе, а
    // проигнорированные поля называем — тем же `extra`, что `truncated`.
    const COVER_FIELDS = [
      "coverTitle",
      "coverSubtitle",
      "coverPrompt",
      "coverStyle",
      "photoBase64",
    ] as const;
    // Аудит 2026-08-28 (повторный проход): счёт стоял под `p.photoUrl ? ... : []`,
    // то есть молчание чинилось только для одной из двух развилок. Цепочка ниже
    // — `coverTitle → photoBase64 → coverPrompt → авто-баннер` — точно так же
    // выбирает ОДИН источник и роняет остальные, и самая дорогая пара тут
    // `coverTitle` + `photoBase64`: агент сходил в GENERATE_IMAGE (6/час на
    // роль), получил картинку, приложил — и она выбрасывается ради локального
    // баннера по заголовку, а ответ неотличим от публикации, где её взяли.
    //
    // Порядок предпочтения не трогаем: это то, что реально уходит в живой
    // канал. Считаем набор по победившему источнику — какие поля он
    // действительно израсходовал, остальные присутствующие называем.
    const presentCover = COVER_FIELDS.filter((k) => p[k] !== undefined && p[k] !== "");
    let coverIgnored: (typeof COVER_FIELDS)[number][] = [];
    let coverIgnoredNote = "";
    const usedCover = (source: string, used: readonly string[]) => {
      coverIgnored = presentCover.filter((k) => !used.includes(k));
      coverIgnoredNote =
        `обложка взята из ${source} — ${coverIgnored.join(", ")} не использовались, ` +
        "обложка по ним не строилась; выбирай один источник обложки";
    };
    if (p.photoUrl) {
      coverIgnored = presentCover;
      coverIgnoredNote =
        `photoUrl задан — ${coverIgnored.join(", ")} не использовались, ` +
        "обложка по ним не строилась; выбирай одно: либо готовый photoUrl, " +
        "либо поля обложки";
    }
    const published = (r: unknown, sentText: string): PublishDispatchResult => {
      const plainFull = plainTelegramLength(fullText);
      const plainSent = plainTelegramLength(sentText);
      const extra: Record<string, unknown> = {};
      if (plainSent < plainFull) {
        extra.truncated = true;
        extra.plain_sent = plainSent;
        extra.plain_full = plainFull;
        extra.note =
          "в канал ушла сокращённая версия — скажи об этом человеку, " +
          "не выдавай пост за опубликованный целиком";
      }
      if (coverIgnored.length > 0) {
        extra.cover_ignored = coverIgnored;
        extra.cover_ignored_note = coverIgnoredNote;
      }
      if (coverDropped !== undefined) {
        extra.cover_dropped = true;
        extra.cover_error = coverDropped;
        extra.cover_note =
          "Telegram отверг обложку — пост ушёл без картинки; " +
          "скажи человеку, не выдавай за публикацию с обложкой";
      }
      if (Object.keys(extra).length === 0) return { ok: true, result: r };
      return {
        ok: true,
        result: {
          ...(r !== null && typeof r === "object" ? r : { sent: r }),
          ...extra,
        },
      };
    };

    let coverBuf: Buffer | undefined;
    if (!p.photoUrl) {
      try {
        if (p.coverTitle) {
          usedCover("coverTitle", ["coverTitle", "coverSubtitle", "coverStyle"]);
          coverBuf = await renderCoverBanner(
            {
              title: p.coverTitle,
              subtitle: p.coverSubtitle,
              date: formatRuDate(),
            },
            p.coverStyle,
          );
        } else if (p.photoBase64) {
          usedCover("photoBase64", ["photoBase64"]);
          coverBuf = Buffer.from(p.photoBase64, "base64");
        } else if (p.coverPrompt) {
          usedCover("coverPrompt", ["coverPrompt"]);
          coverBuf = await generateCoverPng(p.coverPrompt, ctx.agentKey);
        } else {
          usedCover("авто-баннера по тексту поста", ["coverStyle"]);
          coverBuf = await renderCoverBanner(
            {
              title: deriveTitle(p.text, BANNER_TITLE_MAX),
              date: formatRuDate(),
              seed: p.text.slice(0, 80),
            },
            p.coverStyle,
          );
        }
      } catch (e) {
        log.warn(
          `[publish] обложка не получилась — пробуем локальный баннер (роль ${ctx.agentKey})`,
          { channelId: p.channelId, error: getErrorMessage(e) },
        );
        coverBuf = undefined;
        // Аудит 2026-08-20: ветка «превью обязательно, рисуем авто-баннер» стояла
        // только на пути «агент не дал обложку вовсе». Агент, который обложку ДАЛ,
        // но её не удалось получить, проваливался мимо неё в пост без превью —
        // хотя рендер баннера локальный: ни OpenAI, ни Claude, ни ролевого
        // инструмента. То есть пост наказывался за то, что автор передал БОЛЬШЕ
        // данных. Сюда же приходит роль, которой не выдана генерация обложек
        // (см. гейт в dispatch/media.ts): гейт закрыт, а пост с превью.
        try {
          coverBuf = await renderCoverBanner(
            {
              title: p.coverTitle || deriveTitle(p.text, BANNER_TITLE_MAX),
              subtitle: p.coverSubtitle,
              date: formatRuDate(),
              seed: p.text.slice(0, 80),
            },
            p.coverStyle,
          );
        } catch (e2) {
          // Локальный рендер тоже упал — публикуем текстом, как раньше.
          log.warn(
            `[publish] и локальный баннер не получился — публикуем текстом (роль ${ctx.agentKey})`,
            { channelId: p.channelId, error: getErrorMessage(e2) },
          );
          coverBuf = undefined;
        }
      }

    }
    const PREMIUM_CAPTION_LIMIT = 2048;
    const STANDARD_CAPTION_LIMIT = 1024;
    const ub = await ctx.resolveUserbot();
    if (ub && !ub.isNoop && !p.photoUrl) {
      const caption = coverBuf
        ? fitToLimit(text, PREMIUM_CAPTION_LIMIT, ctx.agentKey)
        : text;
      const send = (t: string) =>
        guardedUserbotCall(ctx.agentKey, p.channelId, () =>
          ub.publishPost(p.channelId, t, { photo: coverBuf }),
        );
      let r;
      let sentText = caption;
      try {
        r = await send(caption);
      } catch (e) {
        if (!isCaptionTooLong(e)) throw e;
        log.warn(
          `[publish] подпись длиннее лимита аккаунта (Premium неактивен?) — повтор под ${STANDARD_CAPTION_LIMIT} (роль ${ctx.agentKey})`,
          { channelId: p.channelId, error: getErrorMessage(e) },
        );
        sentText = fitToLimit(text, STANDARD_CAPTION_LIMIT, ctx.agentKey);
        r = await send(sentText);
      }
      void ingestDigestToSite(fullText, p.channelId);
      return published(r, sentText);
    }

    let photo:
      | { url: string }
      | { buffer: Buffer; filename: string }
      | undefined;
    if (p.photoUrl) photo = { url: p.photoUrl };
    else if (coverBuf) photo = { buffer: coverBuf, filename: "cover.png" };

    if (photo) {
      try {
        if (text && plainTelegramLength(text) > TG_CAPTION_LIMIT) {
          const cover = await tgSendPhoto(ctx.telegram, {
            chatId: p.channelId,
            photo,
          });
          let r;
          try {
            r = await tgSendMessage(ctx.telegram, {
              chatId: p.channelId,
              text,
            });
          } catch (e) {
            const sendErr = getErrorMessage(e);
            try {
              await tgDeleteMessage(ctx.telegram, {
                chatId: p.channelId,
                messageId: cover.messageId,
              });
              return {
                ok: false,
                error: `публикация отменена: текст не ушёл (${sendErr}); баннер удалён, канал чист`,
              };
            } catch (delErr) {
              log.error("[publish] осиротевший баннер не удалён", {
                channelId: p.channelId,
                messageId: cover.messageId,
                sendError: sendErr,
                deleteError: getErrorMessage(delErr),
              });
              return {
                ok: false,
                // Аудит 2026-08-27: без этого флага `gateOrDispatch` делал
                // рефанд — снимал `agent-all:<role>` (60/мин), `chat:<id>`
                // (30/мин) и `bot:*:chat:*`. Ход, положивший картинку в
                // ПУБЛИЧНЫЙ канал, лимитом не считался вообще: модель
                // повторяет, каждый повтор кладёт ещё один осиротевший
                // баннер, потолок не наступает никогда. Соседняя ветка (где
                // удаление УДАЛОСЬ) флага не ставит и не должна — канал чист.
                sideEffect: true,
                error:
                  `текст не ушёл (${sendErr}); в канале остался баннер ` +
                  `message_id=${cover.messageId}, удалить не удалось ` +
                  `(${getErrorMessage(delErr)}) — снести вручную перед повтором`,
              };
            }
          }
          void ingestDigestToSite(fullText, p.channelId);
          return published(r, text);
        }
        const r = await tgSendPhoto(ctx.telegram, {
          chatId: p.channelId,
          photo,
          caption: text || undefined,
        });
        void ingestDigestToSite(fullText, p.channelId);
        return published(r, text);
      } catch (e) {
        if (!isPhotoRejected(e)) throw e;
        coverDropped = getErrorMessage(e);
        log.warn(
          `[publish] Telegram отверг картинку — публикуем текстом (роль ${ctx.agentKey})`,
          { channelId: p.channelId, error: coverDropped },
        );
      }
    }

    const r = await tgSendMessage(ctx.telegram, {
      chatId: p.channelId,
      text,
    });
    void ingestDigestToSite(fullText, p.channelId);
    return published(r, text);
  } catch (e) {
    return { ok: false, error: getErrorMessage(e) };
  }
}
