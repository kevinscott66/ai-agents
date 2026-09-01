/**
 * approve-poll.ts — поллер апрува черновика DeLabs (этап 2 из 2: publish).
 *
 * Читает /opt/web3-puls/drafts/pending.json (его пишет daily-draft.ts). Если на
 * превью-сообщении в Saved Messages стоит реакция ✅ ИЛИ владелец ответил на него
 * текстом с «+», «✅» или «опубликов» — считаем ЧЕРНОВИК одобренным:
 *   1) ингест каждой статьи на сайт (POST $SITE_INGEST_URL, Bearer $SITE_INGEST_TOKEN)
 *      → получаем id → ссылка https://delabs.space/digest/<id>;
 *   2) собираем финальный текст дайджеста + ensureChannelFooter, рендерим баннер,
 *      публикуем в канал (sendFile, formatting + custom-emoji entities);
 *   3) удаляем pending.
 * Pending старше MAX_AGE_MS (20ч, не 24 — инцидент 2026-08-14) → expire
 *   (удаляем, выходим). Иначе — выходим тихо (ждём след. поллинга).
 *
 * Запуск (каждые ~30 мин): bun tools/approve-poll.ts   (из /opt/agent-team).
 * Нужны env: USERBOT_SESSION_PATH/KEY, TELEGRAM_API_ID/HASH, SITE_INGEST_URL, SITE_INGEST_TOKEN.
 */
import {
  readFileSync,
  rmSync,
  existsSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { HOUR_MS } from "../lib/time-constants.ts";
import { HTMLParser } from "telegram/extensions/html";
import { CustomFile } from "telegram/client/uploads";
import { decryptEncryptedSession } from "./userbot-login.ts";
import { renderBannerPng } from "../lib/cover-banner.ts";
import { mdToUserbotHtml, plainTelegramLength } from "../lib/telegram-format.ts";
import { splitForTelegram } from "../lib/telegram-chunking.ts";
import {
  TELEGRAM_CAPTION_LIMIT,
  isCaptionTooLong,
} from "../lib/telegram-actions.ts";
import { buildCustomEmojiEntities } from "../lib/custom-emoji-map.ts";
import { CHANNEL_FOOTER, ensureChannelFooter } from "../lib/channel-footer.ts";
import { extractMessageId } from "../lib/userbot.ts";
import { delabsChannelId, delabsSiteBase } from "../lib/delabs-env.ts";
import { PENDING_PATH, ruDate, endSentence, itemEmoji, plainInline } from "./daily-draft.ts";
import type { PendingDraft, DraftArticle } from "./daily-draft.ts";

const CHANNEL_ID = delabsChannelId();
const SITE_BASE = delabsSiteBase();
// 20ч, а не 24: см. PENDING_MAX_AGE_MS в daily-draft.ts (инцидент 2026-08-14).
export const MAX_AGE_MS = 20 * HOUR_MS;
// Аудит 2026-08-28: здесь лежала своя копия футера — байт в байт та же
// строка, что CHANNEL_FOOTER, из модуля, который этот файл и так импортирует
// строкой выше. Публикация в канал идёт отсюда, поэтому правка канонического
// футера (ссылка на чат, год копирайта) молча разошлась бы с тем, что реально
// уходит в @delabsru. Одно определение на проект.
const FOOTER = CHANNEL_FOOTER;

/**
 * Запись pending: tmp + rename. Таймеры daily-draft и approve-poll независимы,
 * а прогресс ингеста теперь сохраняется по ходу дела — читатель не должен
 * увидеть полфайла.
 */
function writePendingAtomic(p: PendingDraft): void {
  const tmp = `${PENDING_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(p, null, 2));
  renameSync(tmp, PENDING_PATH);
}

function buildClient(): TelegramClient {
  const sp = process.env.USERBOT_SESSION_PATH?.trim() || "data/userbot.session";
  const blob = readFileSync(sp, "utf8").trim();
  const ss = decryptEncryptedSession(blob, process.env.USERBOT_SESSION_KEY);
  return new TelegramClient(
    new StringSession(ss),
    Number(process.env.TELEGRAM_API_ID),
    process.env.TELEGRAM_API_HASH!,
    { connectionRetries: 2 },
  );
}

/**
 * Короткие однозначные формы согласия. Сверяем ответ ЦЕЛИКОМ, а не по вхождению.
 *
 * Аудит 2026-08-12: тут стояло
 *   `s.includes("+") || s.includes("✅") || s.includes("опубликов")`.
 * Это поиск подстроки, а не разбор ответа: «переделай второй пункт + добавь
 * источник» и «это не публикуем, +1 к правкам» считались апрувом, а
 * `includes("опубликов")` матчил и само отрицание — «не опубликовывай».
 * Механизма отказа не было вовсе: не публиковать можно было только молчанием до
 * MAX_AGE_MS, то есть единственный способ ответить текстом был опасен — почти
 * любая правка содержит либо плюс, либо слово «опубликов».
 *
 * Цена ошибки необратима: следующий тик таймера ингестит статьи на delabs.space
 * (страницы + RSS) и постит дайджест подписчикам через юзербот.
 *
 * Отсюда правило: апрув — это ответ, в котором НЕТ ничего, кроме согласия.
 * Есть содержательный текст — значит это правка, а путь по умолчанию —
 * не публиковать. Реакция ✅ на превью остаётся вторым каналом апрува
 * (см. isApproved) и через эту функцию не проходит.
 */
const APPROVAL_WORDS = new Set([
  "да",
  "ок",
  "ok",
  "го",
  "публикуем",
  "публиковать",
  "опубликовать",
  "опубликуй",
  "апрув",
  "yes",
]);

/** Текст-ответ считается апрувом? */
export function isApprovalText(t: string): boolean {
  const s = (t ?? "")
    .toLowerCase()
    .replace(/[.!…\s]+$/u, "")
    .trim();
  if (!s) return false;
  // Ответ состоит только из плюсов и/или ✅ — «+», «++», «+✅», «✅».
  if (/^[+✅]+$/u.test(s)) return true;
  return APPROVAL_WORDS.has(s);
}

export interface ApprovalSignals {
  /** Есть ли ✅ среди реакций на превью. */
  reaction: boolean;
  /** Тексты ответов владельца на превью. null — прочитать не удалось. */
  replies: string[] | null;
}

export interface ApprovalDecision {
  approved: boolean;
  reason: "reaction" | "reply" | "veto" | "replies_unreadable" | "no_signal";
  /** Текст, из-за которого решили не публиковать (для лога). */
  vetoText?: string;
}

/**
 * Решение об апруве по собранным сигналам.
 *
 * Аудит 2026-08-12: раньше реакция проверялась ПЕРВОЙ и возвращала true сразу,
 * до чтения ответов. Владелец, поставивший ✅ и следом написавший «стоп, не
 * публикуй», получал публикацию — необратимую, с рассылкой подписчикам.
 * Правило файла («есть содержательный текст — значит это правка, по умолчанию
 * не публикуем») на реакцию не распространялось вовсе.
 *
 * Теперь вето сильнее любого апрува, а нечитаемые ответы — это НЕ «ответов
 * нет»: публиковать вслепую нельзя, поллер вернётся через полчаса.
 */
export function decideApproval(s: ApprovalSignals): ApprovalDecision {
  if (s.replies === null) {
    return { approved: false, reason: "replies_unreadable" };
  }
  const texts = s.replies.map((t) => (t ?? "").trim()).filter(Boolean);
  const veto = texts.find((t) => !isApprovalText(t));
  if (veto) return { approved: false, reason: "veto", vetoText: veto };
  if (texts.length) return { approved: true, reason: "reply" };
  return s.reaction
    ? { approved: true, reason: "reaction" }
    : { approved: false, reason: "no_signal" };
}

/**
 * Стоит ли на превью реакция ✅ — включая премиальную кастомную.
 *
 * У ReactionCustomEmoji вместо `emoticon` лежит `documentId`, поэтому проверка
 * по одному emoticon премиум-✅ не видела: владелец ставил галочку, а поллер
 * молча ждал дальше, пока черновик не протухнет через сутки. Alt кастомного
 * эмодзи (базовый символ) достаём одним запросом и только если такие реакции
 * вообще есть.
 */
async function hasApprovalReaction(
  client: TelegramClient,
  me: unknown,
  previewMsgId: number,
): Promise<boolean> {
  try {
    const msgs: any[] = await client.getMessages(me as any, { ids: [previewMsgId] });
    const results: any[] = msgs?.[0]?.reactions?.results ?? [];
    const customIds: unknown[] = [];
    for (const r of results) {
      const emoticon = r?.reaction?.emoticon;
      if (typeof emoticon === "string" && emoticon.includes("✅")) return true;
      const docId = r?.reaction?.documentId;
      if (docId !== undefined && docId !== null) customIds.push(docId);
    }
    if (!customIds.length) return false;
    const docs: any[] = await (client as any).invoke(
      new Api.messages.GetCustomEmojiDocuments({ documentId: customIds as any }),
    );
    for (const d of docs ?? []) {
      for (const attr of d?.attributes ?? []) {
        if (typeof attr?.alt === "string" && attr.alt.includes("✅")) return true;
      }
    }
  } catch (e) {
    console.warn("[approve-poll] reaction read failed:", (e as Error).message);
  }
  return false;
}

/** Тексты ответов владельца на превью. null — прочитать не удалось совсем. */
async function readPreviewReplies(
  client: TelegramClient,
  me: unknown,
  previewMsgId: number,
): Promise<string[] | null> {
  const pick = (rows: any[]): string[] =>
    rows
      .filter((r) => Number(r?.replyTo?.replyToMsgId) === previewMsgId)
      .map((r) => String(r?.message ?? ""));
  try {
    return pick(
      await client.getMessages(me as any, { limit: 30, replyTo: previewMsgId }),
    );
  } catch {
    // Fallback: просканировать последние сообщения вручную на reply к превью.
    try {
      return pick(await client.getMessages(me as any, { limit: 40 }));
    } catch (e2) {
      console.warn("[approve-poll] reply read failed:", (e2 as Error).message);
      return null;
    }
  }
}

/**
 * Проверить, одобрено ли превью: реакция ✅ на сообщении ИЛИ reply владельца
 * с «+»/«✅»/«публикуем» — и НИ ОДНОГО содержательного ответа поверх этого.
 * «me»-чат — Saved Messages, все реакции/ответы там наши.
 */
export async function isApproved(
  client: TelegramClient,
  previewMsgId: number,
): Promise<boolean> {
  const me = await client.getInputEntity("me");
  const reaction = await hasApprovalReaction(client, me, previewMsgId);
  const replies = await readPreviewReplies(client, me, previewMsgId);
  const d = decideApproval({ reaction, replies });

  // Молчаливый отказ владельцу не объяснить — пишем причину.
  if (d.reason === "veto") {
    console.log(
      `[approve-poll] ответ на превью не считается апрувом (нужен «+», «✅» или «публикуем» целиком): ${String(d.vetoText).slice(0, 120)}`,
    );
  } else if (d.reason === "replies_unreadable") {
    console.error(
      "[approve-poll] ответы на превью прочитать не удалось — публиковать вслепую не будем, повторим на следующем тике",
    );
  }
  return d.approved;
}

const INGEST_TIMEOUT_DEFAULT_MS = 15_000;

/** Бюджет одного POST на сайт. Пустая строка из EnvironmentFile = «не задано». */
export function _resolveIngestTimeoutMs(
  raw: string | undefined = process.env.SITE_INGEST_TIMEOUT_MS,
): number {
  const v = Number(raw?.trim() || "");
  return Number.isFinite(v) && v > 0 ? v : INGEST_TIMEOUT_DEFAULT_MS;
}

/** Ингест одной статьи на сайт → вернуть id (slug). null при ошибке. */
export async function ingestArticle(
  a: DraftArticle,
  opts: { _timeoutMs?: number } = {},
): Promise<string | null> {
  const url = process.env.SITE_INGEST_URL;
  const token = process.env.SITE_INGEST_TOKEN;
  if (!url || !token) {
    console.error("[approve-poll] SITE_INGEST_URL/TOKEN not set — cannot ingest");
    return null;
  }
  // Аудит 2026-08-29: тут стоял голый `await fetch(url, …)` без сигнала.
  // Зависший сайт (не отдаёт ни ответа, ни RST) держал этот await столько,
  // сколько позволит ядро, то есть съедал весь TimeoutStartSec юнита. Дальше
  // прилетал SIGTERM — и если он заставал шаг 3 уже ПОСЛЕ
  // `pending.publishStartedAt`, выпуск умирал: каждый следующий тик отвечал
  // `publish_already_attempted`, а через 20 часов TTL стирал одобренный
  // черновик. Ограничиваем каждый POST явно, как давно сделано в
  // `lib/site-ingest.ts`.
  const timeoutMs = opts._timeoutMs ?? _resolveIngestTimeoutMs();
  const controller = new AbortController();
  /** Оборвали ли МЫ запрос: таймаут и «сайт закрыл соединение» — разные аварии. */
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        title: a.title,
        date: a.date,
        summary: a.summary,
        body: a.body,
        items: a.items,
        sourceCount: a.sourceCount,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error("[approve-poll] ingest non-ok", res.status, "for", a.title);
      return null;
    }
    const j: any = await res.json();
    return typeof j?.id === "string" ? j.id : null;
  } catch (e) {
    if (timedOut) {
      console.error(
        `[approve-poll] ingest таймаут ${timeoutMs}ms для «${a.title}» — сайт не ответил, публикацию отменяем и повторим на следующем тике`,
      );
    } else {
      console.error("[approve-poll] ingest failed:", (e as Error).message);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Одобренный черновик: ингест статей на сайт → публикация в канал.
 *
 * Вынесено из main() и работает на инжектируемых зависимостях, потому что
 * шаги здесь НЕОБРАТИМЫ (публичные страницы + рассылка подписчикам), а вся
 * логика «что можно повторить после сбоя» до этого была не покрыта ничем:
 * тестов на publish-путь не существовало, а живой прогон стоит публикации.
 */
export interface PublishDeps {
  ingest: (a: DraftArticle) => Promise<string | null>;
  /**
   * Всё, что готовится ДО отправки и потому свободно повторяется: рендер
   * баннера. Держим отдельно от send именно поэтому — сбой рендера не должен
   * блокировать дайджест навсегда.
   */
  renderBanner: (head: string) => Promise<Uint8Array>;
  /**
   * Второе, что готовится ДО отправки и потому свободно повторяется: резолв
   * пира канала и разметка текста. Аудит 2026-08-28: комментарий у шага 3
   * обещал, что `getInputEntity` падает ДО отметки, а фактически он стоял
   * первой строкой внутри `send` — то есть уже ПОСЛЕ. Пир не в кэше сессии
   * или FLOOD_WAIT → `publish_failed` с отметкой на диске → каждый следующий
   * тик отвечает `publish_already_attempted`, дайджест не уходит никогда, а
   * через 20 часов TTL стирает pending со словами «пост мог уйти в канал»,
   * хотя не ушло ничего. Опционален: юнит-харнессы обходятся без него.
   */
  prepareSend?: (finalText: string) => Promise<void>;
  /** Отправка в канал. Возвращает id сообщения и счётчик частей хвоста. */
  send: (
    finalText: string,
    head: string,
    banner: Uint8Array,
  ) => Promise<DigestSendResult>;
  /** Сохранить pending обратно (прогресс ингеста, отметка попытки). */
  savePending: (p: PendingDraft) => void;
  clearPending: () => void;
  log?: (msg: string) => void;
}

export interface PublishOutcome {
  published: boolean;
  msgId?: number;
  /** Машиночитаемая причина отказа — она же ключ в логах. */
  reason?:
    | "ingest_failed"
    | "banner_failed"
    | "prepare_failed"
    | "publish_failed"
    | "publish_already_attempted"
    | "progress_unsaved";
  /** Пост в канале, но не все части хвоста доставлены. published при этом
   *  остаётся true: медиа с подписью ушло, повторять публикацию нельзя. */
  tailIncomplete?: { sent: number; total: number };
}

export async function runApprovedPublish(
  pending: PendingDraft,
  deps: PublishDeps,
): Promise<PublishOutcome> {
  const say = deps.log ?? ((m: string) => console.log(m));

  // 1) Ингест статей. Уже проингесченные (с siteId) пропускаем — не потому,
  // что повтор опасен (сайт дедуплицирует по заголовку, см. разбор в catch
  // ниже), а потому что это лишний сетевой вызов на каждом тике.
  for (const a of pending.articles) {
    if (a.siteId) continue;
    const id = await deps.ingest(a);
    say(`[approve-poll] ingested ${a.title} → id ${id}`);
    if (id) {
      a.siteId = id;
      // Пишем прогресс сразу: если следующая статья или публикация упадёт,
      // следующий тик не должен ингестить эту заново.
      try {
        deps.savePending(pending);
      } catch (e) {
        // Статья уже на сайте, а siteId на диск не лёг (ENOSPC на data/,
        // EACCES, отвалившийся том). Через 30 минут апрув всё ещё стоит и
        // `if (a.siteId) continue` не сработает — та же статья уедет на сайт
        // повторно.
        //
        // Аудит 2026-08-28: ровно этого раньше и боялись — ветка звала
        // `clearPending()` и писала «выпуск за этот день потерян», исходя из
        // того, что «ингест не идемпотентен, ключа дедупликации в POST нет».
        // Посылка неверна. Дедупликация на сайте идёт по ЗАГОЛОВКУ:
        // `site/server/index.ts` определяет занятость как
        // `existing !== null && existing.title !== title`, то есть «занято» =
        // «под этим id лежит ДРУГОЙ материал». Повтор того же title+date
        // возвращает ТОТ ЖЕ id двумя путями — `reusableDigestId`
        // (`findLatestDigestByTitle`, окно 12 ч, а `a.date` в pending
        // зафиксирован) и `freeSlug(slugFromTitle(title, dateIso), taken)`.
        // Запинено на стороне сайта: `site/server/ingest-slug.test.ts` —
        // «повторная отправка той же статьи обновляет её, а не плодит копии».
        //
        // Значит цена повтора — обновление страницы на месте, а цена
        // `clearPending()` — уничтоженный выпуск, одобренный владельцем, и
        // сгоревший ресёрч. Ведём себя как ветка отметки публикации ниже:
        // логируем и выходим, pending НЕ трогаем. Обычный тик через 30 минут
        // доведёт дело до конца, как только диск починится.
        say(
          `[approve-poll] прогресс ингеста не сохранён (${(e as Error).message}) — статья «${a.title}» уже на сайте. Pending оставляем: повторный ингест обновит ту же страницу (дедуп по заголовку), а не создаст дубль. Чините диск, следующий тик доведёт публикацию.`,
        );
        return { published: false, reason: "progress_unsaved" };
      }
    }
  }

  // 2) Провал ингеста — НЕ публикуем.
  //
  // Раньше отсутствующий id молча превращался в ссылку на главную: дайджест
  // уходил подписчикам, обещая «детали по ссылкам на сайте», каждое «Подробнее
  // →» вело на главную, статей на сайте не было, а pending стирался. Владелец
  // одобрил не то, что опубликовалось, и откатить это уже нечем.
  const missing = pending.articles.filter((a) => !a.siteId);
  if (missing.length) {
    say(
      `[approve-poll] ингест не прошёл для ${missing.length} из ${pending.articles.length} статей — публикация отменена, повторим на следующем тике`,
    );
    return { published: false, reason: "ingest_failed" };
  }

  // 3) Публикация. Отметку ставим ДО отправки: сбой sendFile неотличим от
  // «доставлено, но ответ потерян», а таймер запускается каждые 30 минут — то
  // есть автоповтор мог положить подписчикам второй экземпляр поста. Всё, что
  // падает до этой точки (рендер баннера, резолв пира и разметка в
  // prepareSend), повторяется свободно: отметки ещё нет. Инвариант держится
  // только пока сетевая подготовка живёт в prepareSend, а не внутри send.
  if (pending.publishStartedAt) {
    say(
      `[approve-poll] публикация уже начиналась ${pending.publishStartedAt} — автоповтор запрещён (пост мог уйти в канал). Проверьте канал; чтобы отправить заново, удалите publishStartedAt из pending.json`,
    );
    return { published: false, reason: "publish_already_attempted" };
  }

  const finalText = buildFinalText(pending);
  const head = headline(pending);

  let banner: Uint8Array;
  try {
    banner = await deps.renderBanner(head);
  } catch (e) {
    say(`[approve-poll] banner render failed: ${(e as Error).message}`);
    return { published: false, reason: "banner_failed" };
  }

  // Резолв пира и разметка — последнее, что ещё можно повторить бесплатно.
  // Держим их здесь, рядом с баннером, а не внутри send: всё, что стоит после
  // строки ниже, повторить уже нельзя.
  if (deps.prepareSend) {
    try {
      await deps.prepareSend(finalText);
    } catch (e) {
      say(
        `[approve-poll] подготовка отправки не удалась (${(e as Error).message}) — отметку не ставим, pending цел, следующий тик повторит`,
      );
      return { published: false, reason: "prepare_failed" };
    }
  }

  pending.publishStartedAt = new Date().toISOString();
  try {
    deps.savePending(pending);
  } catch (e) {
    // Отметка — единственное, что защищает подписчиков от второго экземпляра
    // поста. Не легла на диск → отправлять нельзя. Pending НЕ трогаем: в канал
    // ничего не ушло, ингест уже сохранён, следующий тик повторит публикацию
    // штатно и без дубля.
    say(
      `[approve-poll] отметку публикации не удалось сохранить (${(e as Error).message}) — не отправляем: без неё следующий тик положил бы в канал второй экземпляр`,
    );
    return { published: false, reason: "publish_failed" };
  }

  let sent: DigestSendResult;
  try {
    sent = await deps.send(finalText, head, banner);
  } catch (e) {
    say(`[approve-poll] publish failed: ${(e as Error).message}`);
    return { published: false, reason: "publish_failed" };
  }

  deps.clearPending();
  // Хвост доставлен не весь — это НЕ повод повторять публикацию (медиа уже в
  // канале), но и не полный успех: в канале висит пост без последних новостей
  // и без футера. Отдаём счётчик наверх, там он станет ненулевым кодом выхода.
  return sent.tailSent < sent.tailTotal
    ? {
        published: true,
        msgId: sent.msgId,
        tailIncomplete: { sent: sent.tailSent, total: sent.tailTotal },
      }
    : { published: true, msgId: sent.msgId };
}

/** Лимит подписи к фото (тот же, что у остальных отправок медиа). */
export const CAPTION_PLAIN_LIMIT = TELEGRAM_CAPTION_LIMIT;

/**
 * Разложить готовый пост на подпись к баннеру и хвост отдельными сообщениями.
 *
 * Аудит 2026-08-12: подпись уходила в client.sendFile как есть. Замер на
 * реальной форме дайджеста: 4 статьи с blurb по 180 символов → 1209 знаков
 * plain, по 220 → 1369, при лимите 1024 без Premium. То есть обычный день из
 * четырёх новостей получал MEDIA_CAPTION_TOO_LONG, runApprovedPublish
 * записывал publish_failed — а publishStartedAt к тому моменту уже стоял, и
 * автоповтор запрещён. Дайджест не уходил вообще, пока владелец руками не
 * поправит pending.json.
 *
 * Меряем PLAIN-длину: Telegram считает подпись после разбора сущностей, и
 * `[Подробнее →](https://…)` весит только видимый текст. По сырой длине мы бы
 * рвали посты, которые обязаны остаться одним сообщением.
 */
export function splitForCaption(
  text: string,
  limit = CAPTION_PLAIN_LIMIT,
): string[] {
  if (plainTelegramLength(text) <= limit) return [text];
  const out: string[] = [];
  let buf = "";
  const flush = () => {
    if (buf.trim()) out.push(buf.trimEnd());
    buf = "";
  };
  for (const para of text.split(/\n\n+/)) {
    if (plainTelegramLength(para) > limit) {
      // Абзац не влезает сам по себе — режем его по сырой длине, она всегда
      // не меньше plain, так что результат гарантированно в лимите.
      flush();
      out.push(...splitForTelegram(para, limit));
      continue;
    }
    const candidate = buf ? `${buf}\n\n${para}` : para;
    if (plainTelegramLength(candidate) > limit) {
      flush();
      buf = para;
    } else {
      buf = candidate;
    }
  }
  flush();
  return out.length ? out : [text];
}

export interface DigestSendIo {
  /** Отправить баннер с подписью. Возвращает id сообщения. */
  sendPhoto: (caption: string, banner: Uint8Array) => Promise<number>;
  /** Отправить добивку отдельным сообщением. */
  sendMessage: (text: string) => Promise<void>;
}

/**
 * Опубликовать дайджест: баннер с подписью в лимите + хвост следом.
 * Возвращает id сообщения с баннером — на него ссылаются логи и закрепы.
 */
/** Итог отправки дайджеста. Счётчик хвоста нужен наверху: пост из медиа с
 *  подписью — уже успех (повторять нельзя), но пост без последних новостей и
 *  без футера успехом называть тоже нельзя. */
export interface DigestSendResult {
  msgId: number;
  /** Сколько частей хвоста доставлено. */
  tailSent: number;
  /** Сколько их было. 0 — пост уместился в подпись целиком. */
  tailTotal: number;
}

export async function sendDigest(
  finalText: string,
  banner: Uint8Array,
  io: DigestSendIo,
  limit = CAPTION_PLAIN_LIMIT,
): Promise<DigestSendResult> {
  let parts = splitForCaption(finalText, limit);
  let msgId: number;
  try {
    msgId = await io.sendPhoto(parts[0]!, banner);
  } catch (e) {
    // Настоящий лимит зависит от Premium и считается по своим правилам —
    // отказ детерминированный и приходит ДО создания сообщения, поэтому один
    // повтор с запасом безопасен. Всё остальное (flood, сеть) — наверх.
    if (!isCaptionTooLong(e)) throw e;
    console.warn(
      "[approve-poll] подпись всё ещё длинна для Telegram — пересобираем с запасом",
    );
    parts = splitForCaption(finalText, Math.floor(limit * 0.6));
    msgId = await io.sendPhoto(parts[0]!, banner);
  }
  // Аудит 2026-08-12: этот цикл не был защищён, и падение на нём объявляло всю
  // публикацию неудачной — при том, что баннер с подписью УЖЕ в публичном
  // канале. Дальше по коду runApprovedPublish это тупик: publishStartedAt
  // проставляется до deps.send, поэтому следующий тик поллера отбивается
  // гардом publish_already_attempted, а clearPending при throw не зовётся. В
  // канале висит обрезанный пост — без последней новости и без футера, — и
  // штатно доделать его нечем, только правкой pending.json руками.
  //
  // Разрыв на части — обычный путь, а не край: дайджест из 4 статей с блёрбами
  // по ~180 символов даёт 1191 «плоский» символ при лимите подписи 1000.
  //
  // То же правило, что в lib/telegram-actions.ts (sendCaptionTail): медиа уже
  // в чате, объявлять отправку неудачной нельзя — но и молчать нельзя.
  let tailSent = 0;
  const tail = parts.slice(1);
  for (const part of tail) {
    try {
      await io.sendMessage(part);
      tailSent++;
    } catch (e) {
      console.warn(
        `[approve-poll] хвост поста не доставлен: отправлено ${tailSent} из ${tail.length} частей, msgId=${msgId}: ${(e as Error).message}`,
      );
      break;
    }
  }
  return { msgId, tailSent, tailTotal: tail.length };
}

/**
 * Дата, о которой дайджест. Берём из черновика: апрув приходит утром, а
 * новости в нём вчерашние — пост с завтрашним числом над вчерашними статьями
 * читается как ошибка. Битый createdAt (не должен случаться) — на «сейчас».
 */
function draftDate(p: PendingDraft): Date {
  const t = Date.parse(p.createdAt);
  return Number.isFinite(t) ? new Date(t) : new Date();
}

/** Заголовок дня без служебного префикса. */
export function headline(pending: PendingDraft): string {
  return pending.dayTitle.replace(/^Дайджест:\s*/, "");
}

/** Финальный текст канального дайджеста с реальными ссылками на сайт + футер. */
export function buildFinalText(pending: PendingDraft): string {
  // T-741. Недельный пост собран целиком ещё в черновике — тем самым текстом,
  // который владелец видел в превью и одобрил. Пересобирать его здесь нечем:
  // `articles` у него пуст, и ветка ниже дала бы шапку дайджеста без единого
  // пункта. Отсутствие `kind` — дайджест, как было до T-741.
  if (pending.kind === "weekly") {
    const text = (pending.text ?? "").trimEnd();
    // Пустой текст — не пост. Пусть лучше упадёт публикация (и владелец увидит
    // причину в логе), чем в канал уйдёт один футер.
    if (!text) throw new Error("weekly pending без text — публиковать нечего");
    return ensureChannelFooter(`${text}\n\n${FOOTER}`);
  }

  const lines: string[] = [];
  lines.push(`📰 **${headline(pending)}**`);
  lines.push(`🗓️ ${ruDate(draftDate(pending))}`);
  lines.push("");
  lines.push("Коротко о главном — детали по ссылкам на сайте.");
  lines.push("");
  pending.articles.forEach((a) => {
    // siteId проставлен ингестом; сюда мы доходим только когда он есть у всех
    // (см. runApprovedPublish) — ветка с ссылкой на главную убрана намеренно.
    const link = `${SITE_BASE}/digest/${a.siteId}`;
    // plainInline: единственный шаг между внешним текстом и разметкой поста.
    // Без него `title` вида «Дроп [жми сюда](https://evil.tld)» публиковался
    // настоящей ссылкой на чужой домен, а в превью на апруве была видна только
    // подпись «жми сюда» — владелец одобрял, не видя куда (аудит 2026-08-28).
    lines.push(`${itemEmoji(a.emoji)} **${plainInline(a.title)}**`);
    lines.push(`${endSentence(plainInline(a.blurb ?? ""))} [Подробнее →](${link})`);
    lines.push(""); // отступ между новостями (эталон #75) + перед футером
  });
  lines.push(FOOTER);
  return ensureChannelFooter(lines.join("\n"));
}

/**
 * Разметка и custom-emoji считаются для КАЖДОЙ части отдельно: entity адресуют
 * смещения внутри своего сообщения.
 *
 * mdToUserbotHtml и передача fmtEntities — аудит 2026-08-13: у gramjs свой тег
 * спойлера, а кастом-эмодзи нельзя вешать внутрь pre/code (обоснования в
 * telegram-format.ts и custom-emoji-map.ts). Путь тот же, что у publishPost, и
 * ошибки у него те же.
 *
 * Вынесено из замыкания send (аудит 2026-08-28), чтобы prepareSend мог прогнать
 * ровно этот код до отметки публикации: бросок HTMLParser после отметки навсегда
 * запирает выпуск в publish_already_attempted.
 */
function renderForUserbot(md: string): { plain: string; entities: any[] } {
  const [plain, fmtEntities] = HTMLParser.parse(mdToUserbotHtml(md));
  return {
    plain,
    entities: [...fmtEntities, ...buildCustomEmojiEntities(plain, fmtEntities)],
  };
}

async function main(): Promise<void> {
  if (!existsSync(PENDING_PATH)) {
    console.log("[approve-poll] no pending draft — exit");
    process.exit(0);
    return;
  }

  let pending: PendingDraft;
  try {
    pending = JSON.parse(readFileSync(PENDING_PATH, "utf8"));
  } catch (e) {
    console.error("[approve-poll] pending unreadable:", (e as Error).message);
    process.exit(0);
    return;
  }

  // Expire по MAX_AGE_MS — 20ч, не 24: ровно сутки означали бы период таймера
  // в период таймера, и черновик мог протухнуть за миг до своего же поллинга
  // (инцидент 2026-08-14, обоснование при константе).
  const age = Date.now() - Date.parse(pending.createdAt);
  if (!Number.isFinite(age) || age > MAX_AGE_MS) {
    const started = pending.publishStartedAt;
    try { rmSync(PENDING_PATH); } catch {}
    if (started) {
      // Публикация начиналась — значит апрув владельца был, ресёрч потрачен, а
      // гард publish_already_attempted запер автоповтор. Стирать такой pending
      // строкой console.log в общем потоке значит терять выпуск бесшумно.
      console.error(
        `[approve-poll] ОДОБРЕННЫЙ выпуск удалён по TTL: публикация начиналась ${started} и не завершилась. Проверьте канал — пост мог уйти. Черновик утрачен, повторить нечем.`,
      );
      process.exit(1);
      return;
    }
    console.log("[approve-poll] pending expired (>20h) — removed");
    process.exit(0);
    return;
  }

  const client = buildClient();
  let approved = false;
  try {
    await client.connect();
    approved = await isApproved(client, pending.previewMsgId);
  } catch (e) {
    console.error("[approve-poll] approval check failed:", (e as Error).message);
    try { await client.disconnect(); } catch {}
    process.exit(0);
    return;
  }

  if (!approved) {
    console.log("[approve-poll] not approved yet — waiting");
    try { await client.disconnect(); } catch {}
    process.exit(0);
    return;
  }

  console.log("[approve-poll] APPROVED — ingesting + publishing");

  // Пир резолвится в prepareSend и переиспользуется в send — так сетевой
  // вызов остаётся ДО отметки публикации.
  let channelPeer: Awaited<ReturnType<typeof client.getInputEntity>> | null = null;

  const outcome = await runApprovedPublish(pending, {
    ingest: ingestArticle,
    renderBanner: (head) =>
      renderBannerPng({
        title: head,
        subtitle: pending.kind === "weekly" ? "Что было за неделю" : "Свежее в крипте и AI",
        date: ruDate(draftDate(pending)),
        tag: "AI × Web3",
      }),
    prepareSend: async (finalText) => {
      // Резолв пира — сетевой вызов (может ответить FLOOD_WAIT или не найти
      // канал в кэше сессии), поэтому он здесь, до отметки публикации.
      channelPeer = await client.getInputEntity(CHANNEL_ID);
      // Разметку прогоняем вхолостую тем же кодом, что и отправка: HTMLParser
      // бросает на битой разметке, и лучше узнать это сейчас, а не после того
      // как автоповтор уже запрещён.
      renderForUserbot(finalText);
    },
    send: async (finalText, _head, banner) => {
      // prepareSend отработал выше — иначе сюда не дошли бы.
      const peer = channelPeer ?? (await client.getInputEntity(CHANNEL_ID));
      const buf = Buffer.isBuffer(banner) ? banner : Buffer.from(banner);
      const render = renderForUserbot;
      return sendDigest(finalText, buf, {
        sendPhoto: async (caption) => {
          const { plain, entities } = render(caption);
          const file = new CustomFile("banner.png", buf.length, "", buf);
          const sent: any = await client.sendFile(peer, {
            file,
            caption: plain,
            formattingEntities: entities,
          });
          return extractMessageId(sent);
        },
        sendMessage: async (text) => {
          const { plain, entities } = render(text);
          await client.sendMessage(peer, {
            message: plain,
            formattingEntities: entities,
          });
        },
      });
    },
    savePending: writePendingAtomic,
    clearPending: () => {
      try { rmSync(PENDING_PATH); } catch {}
    },
  });

  try { await client.disconnect(); } catch {}

  if (!outcome.published) {
    console.error(`[approve-poll] не опубликовано: ${outcome.reason}`);
    process.exit(1);
    return;
  }
  if (outcome.tailIncomplete) {
    // Публикация состоялась и повторять её нельзя (медиа в канале, pending
    // очищен) — но в канале висит обрезанный пост. До 2026-08-20 этот случай
    // печатал «published» и выходил нулём: юнит зелёный, пост без последних
    // новостей и без футера, ноль сигналов владельцу. Код выхода — тот
    // единственный канал наружу, который у standalone-скрипта есть.
    const { sent, total } = outcome.tailIncomplete;
    console.error(
      `[approve-poll] пост ${outcome.msgId} опубликован ЧАСТИЧНО: доставлено ${sent} из ${total} частей хвоста. В канале нет последних новостей и футера — допишите вручную, повторная публикация продублирует медиа.`,
    );
    process.exit(1);
    return;
  }
  console.log("[approve-poll] published msg", outcome.msgId, "to", CHANNEL_ID, "— pending cleared");
  process.exit(0);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("[approve-poll] fatal:", e);
    process.exit(1);
  });
}
