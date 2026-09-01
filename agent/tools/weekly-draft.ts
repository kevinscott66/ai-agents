/**
 * weekly-draft.ts — черновик поста «Итоги недели» (T-741).
 *
 * Собирает то, что уже вышло за неделю (дайджесты сайта + активности), строит
 * текст шаблоном `buildWeeklyRecapText` и кладёт его в ТУ ЖЕ очередь
 * `pending.json`, что и дневной дайджест, с пометкой `kind: "weekly"`.
 *
 * Проверяет выпуск существующий `approve-poll` (таймер раз в 30 минут): он
 * ищет апрув владельца на превью в Saved Messages и публикует. Своего апрува
 * здесь нет намеренно — два механизма подтверждения на один канал означали бы,
 * что один из них владелец не смотрит.
 *
 * Ничего не публикует сам: максимум, что делает, — шлёт превью себе же.
 *
 * Слот выпуска один. Если дневной черновик ещё ждёт апрува — недельный прогон
 * уходит ни с чем, а не затирает его: апрув ищут по `previewMsgId`, и
 * перезапись потеряла бы и одобрение, и оплаченный ресёрч (тот же инцидент,
 * из-за которого появился `acquireDraftLock`).
 */
import { existsSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DAY_MS } from "../lib/time-constants.ts";

import { CustomFile } from "telegram/client/uploads";
import { HTMLParser } from "telegram/extensions/html";

import { mdToUserbotHtml } from "../lib/telegram-format.ts";
import { buildCustomEmojiEntities } from "../lib/custom-emoji-map.ts";
import { extractMessageId } from "../lib/userbot.ts";
import { renderBannerPng } from "../lib/cover-banner.ts";
import {
  PENDING_PATH,
  DRAFT_LOCK_PATH,
  acquireDraftLock,
  releaseDraftLock,
  pendingAwaitingApproval,
  commitPending,
  buildClient,
} from "./daily-draft.ts";
import type { PendingDraft } from "./daily-draft.ts";
import {
  buildWeeklyRecapText,
} from "../lib/delabs-post-templates.ts";
import type { RecapNews, RecapActivity } from "../lib/delabs-post-templates.ts";
import { weekStart, tzDayStart, ruDateRange, ITEM_EMOJI, oneLine } from "../lib/delabs-text.ts";
import { plainTelegramLength } from "../lib/telegram-format.ts";
import { delabsSiteBase } from "../lib/delabs-env.ts";
import { TELEGRAM_CAPTION_LIMIT } from "../lib/telegram-actions.ts";

const SITE_BASE = delabsSiteBase();
/** Сколько пунктов берём в каждый блок: пост должен читаться, а не листаться. */
const MAX_NEWS = 6;
const MAX_ACTIVITIES = 4;

/** Запись сайта в том виде, в каком её отдаёт публичный API. */
export interface SiteDigestRow {
  id: string;
  title: string;
  date: string;
  summary?: string;
}
export interface SiteActivityRow {
  id: string;
  project: string;
  title: string;
  emoji?: string;
  date: string;
  rewardType?: string;
  status?: string;
}

/**
 * Границы недели: [понедельник 00:00, следующий понедельник 00:00).
 *
 * Интервал полуоткрытый намеренно. С закрытым справа запись, попавшая ровно в
 * полночь воскресенья, вошла бы и в эту неделю, и в следующую — читатель увидел
 * бы один и тот же пункт в двух постах подряд.
 */
export function weekBounds(now = new Date()): { from: Date; to: Date } {
  // weekStart отдаёт полдень понедельника (см. её док); границей окна берём
  // начало тех же суток по поясу канала.
  const from = tzDayStart(weekStart(now));
  const to = new Date(from.getTime() + 7 * DAY_MS);
  return { from, to };
}

/**
 * Насколько «свежий» старт недели считаем догоном за прошлую.
 *
 * Таймер стоит на воскресенье 18:00 UTC — это ещё та неделя, которую и
 * подводим. Но `Persistent=true` догоняет пропущенный запуск при старте VPS, и
 * догон приходится уже на понедельник-вторник, когда неделя сменилась.
 * Трёх суток хватает на любой такой догон и заведомо мало, чтобы задеть
 * штатный воскресный прогон (у него разница ~6 суток).
 */
const CATCHUP_WINDOW_MS = 3 * DAY_MS;

/**
 * Границы недели, которую подводим, и её понедельник.
 *
 * Аудит 2026-08-20: `main` брала `weekBounds()` от «сейчас». В воскресенье это
 * верно, а вот догон после простоя VPS приходил в понедельник — и подводил
 * итоги недели, начавшейся полдня назад. Пунктов в ней нет, прогон выходил по
 * ветке «публиковать нечего» с кодом 0, и закрытая неделя пропадала совсем:
 * следующий запуск таймера — только через семь дней.
 *
 * Тот же сдвиг нужен, чтобы понедельничный повтор (см. .timer) подводил ту
 * неделю, которую не удалось подвести в воскресенье, а не начавшуюся.
 */
export function recapBounds(now = new Date()): {
  from: Date;
  to: Date;
  monday: Date;
} {
  let monday = weekStart(now);
  let from = tzDayStart(monday);
  if (now.getTime() - from.getTime() < CATCHUP_WINDOW_MS) {
    monday = weekStart(new Date(monday.getTime() - 7 * DAY_MS));
    from = tzDayStart(monday);
  }
  const to = new Date(from.getTime() + 7 * DAY_MS);
  return { from, to, monday };
}

/** Каталог очереди черновиков — маркер живёт рядом с pending.json. */
function draftsDir(): string {
  return dirname(PENDING_PATH);
}

/**
 * Метка «за эту неделю черновик уже собран».
 *
 * Ключ — понедельник недели, а не дата запуска: воскресный прогон и
 * понедельничный повтор подводят ОДНУ неделю и обязаны попасть в один файл.
 * `weekStart` отдаёт полдень UTC понедельника, поэтому срез ISO-строки не
 * поедет от пояса.
 */
export function weeklyMarkerPath(monday: Date, dir = draftsDir()): string {
  return join(dir, `weekly-${monday.toISOString().slice(0, 10)}.done`);
}

export function weeklyAlreadyDrafted(monday: Date, dir = draftsDir()): boolean {
  return existsSync(weeklyMarkerPath(monday, dir));
}

/** Сколько маркеров держим: одна неделя — один файл, остальное мусор. */
const MARKER_KEEP_MS = 60 * DAY_MS;

/**
 * Поставить метку и подмести старые.
 *
 * Пишется ПОСЛЕ `commitPending`: пока черновик не лёг в очередь, неделя не
 * закрыта, и повтор обязан её подхватить.
 */
export function markWeeklyDrafted(monday: Date, dir = draftsDir()): void {
  writeFileSync(weeklyMarkerPath(monday, dir), new Date().toISOString(), "utf8");
  try {
    for (const name of readdirSync(dir)) {
      const m = /^weekly-(\d{4}-\d{2}-\d{2})\.done$/.exec(name);
      if (!m) continue;
      const t = Date.parse(`${m[1]}T12:00:00Z`);
      if (Number.isFinite(t) && Date.now() - t > MARKER_KEEP_MS) {
        unlinkSync(join(dir, name));
      }
    }
  } catch {
    // Уборка — не повод ронять прогон: метка уже стоит.
  }
}

function within(iso: string, from: Date, to: Date): boolean {
  const t = Date.parse(iso);
  return Number.isFinite(t) && t >= from.getTime() && t < to.getTime();
}

/** Первая фраза описания — в пост идёт она, а не весь абзац. */
function firstSentence(s: string): string {
  const t = oneLine(s ?? "", 400);
  const cut = t.split(/(?<=[.!?])\s/)[0] ?? t;
  return oneLine(cut, 200);
}

/**
 * Новости недели из дайджестов сайта.
 *
 * Эмодзи у дайджеста в БД нет (колонки такой нет вовсе), поэтому маркер берём
 * по кругу из ITEM_EMOJI: иначе весь блок вышел бы одним и тем же значком.
 */
export function selectWeekNews(
  rows: SiteDigestRow[],
  from: Date,
  to: Date,
  limit = MAX_NEWS,
): RecapNews[] {
  return rows
    .filter((r) => within(r.date, from, to))
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
    .slice(0, limit)
    .map((r, i) => ({
      emoji: ITEM_EMOJI[i % ITEM_EMOJI.length],
      title: r.title,
      blurb: firstSentence(r.summary ?? ""),
      url: `${SITE_BASE}/digest/${r.id}`,
    }));
}

/** Активности, которые за неделю вышли на сайт. */
export function selectWeekActivities(
  rows: SiteActivityRow[],
  from: Date,
  to: Date,
  limit = MAX_ACTIVITIES,
): RecapActivity[] {
  return rows
    .filter((r) => within(r.date, from, to))
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
    .slice(0, limit)
    .map((r) => ({
      emoji: r.emoji,
      project: r.project,
      done: [r.rewardType, r.status].filter(Boolean).join(" · ") || "разобрали гайд",
      url: `${SITE_BASE}/activity/${r.id}`,
    }));
}

/** Инструкция апрува под превью. Она уезжает той же подписью, значит и место занимает. */
export const WEEKLY_DRAFT_FOOTER =
  '🧪 ЧЕРНОВИК «Итоги недели». Реакция ✅ или ответ "+" — опубликую в канал.';

/**
 * Влезает ли недельный пост в ПОДПИСЬ К ФОТО вместе с инструкцией апрува.
 *
 * Аудит 2026-08-21: здесь звался `fitsOneMessage`, то есть мерка обычного
 * сообщения — `TG_MESSAGE_LIMIT = 4096`. А пост уходит подписью к баннеру
 * (`client.sendFile(peer, { file, caption })` ниже), где потолок Telegram —
 * 1024 (`TELEGRAM_CAPTION_HARD_LIMIT`). Порог 3776 недостижим при
 * `MAX_NEWS = 6` / `MAX_ACTIVITIES = 4`, поэтому цикл-ужиматель не срабатывал
 * НИ РАЗУ, а подпись выходила за лимит на обычных данных: шесть новостей и
 * четыре активности с реалистичными текстами дают 1506 «плоских» знаков.
 * Telegram отвечает `MEDIA_CAPTION_TOO_LONG`, `catch` ниже зовёт
 * `fail("preview send failed", 1)` — и недельный пост не выходит вообще, а
 * замок снимается, то есть следующая попытка будет только через неделю.
 *
 * Мерка — «плоская» длина (`plainTelegramLength`), как её считает Telegram
 * после разбора сущностей: пост состоит из ссылок `[Подробнее →](…)`, у
 * которых виден только текст. По сырой длине те же данные дают 1940 против
 * 1506 — то есть сырая мерка выбрасывала бы лишние пункты.
 *
 * Лимит — мягкий `TELEGRAM_CAPTION_LIMIT = 1000`, тот же, которым режет
 * подпись публикатор (`lib/telegram-actions.ts`, `approve-poll.ts`), а не
 * жёсткий 1024: запас на случай, если разбор посчитает чуть иначе.
 */
export function fitsWeeklyCaption(
  text: string,
  limit: number = TELEGRAM_CAPTION_LIMIT,
): boolean {
  return plainTelegramLength([text, "", WEEKLY_DRAFT_FOOTER].join("\n")) <= limit;
}

/**
 * Ужать пост до одной подписи к баннеру.
 *
 * Публикатор режет длинный текст по границам строк, и «хвост» уходит вторым
 * сообщением уже без баннера — недельный пост из полутора десятков пунктов
 * выглядел бы обрывком. Дешевле выкинуть самые старые пункты здесь.
 *
 * Аудит 2026-08-28: прежнее доказательство терминальной ветки («одна новость и
 * одна активность при полностью забитых полях дают максимум 1002 знака, до
 * 1024 запас есть всегда — измерено») считало только капы `oneLine`: заголовок
 * 90, блёрб 200, проект 80, сделано 200, планы 200. Двух слагаемых в нём нет:
 *
 *   маркер пункта   — `itemEmoji` пропускал `emoji` как есть, а сайт отдаёт
 *                     шестнадцать любых символов (`readScalar("emoji", …, 16)`);
 *   диапазон дат    — `ruDateRange` переменной ширины: «6 — 12 июля 2026» это
 *                     16 знаков, «28 декабря 2026 — 3 января 2027» уже 31.
 *
 * Измерено на коде до правки маркера: тот же минимальный пост с шестнадцатью
 * символами в `emoji` даёт 1026 знаков в ОБЫЧНУЮ неделю и 1041 на стыке годов.
 * Это больше жёсткого потолка, то есть `sendFile` отвечает
 * `MEDIA_CAPTION_TOO_LONG`, `catch` зовёт `fail("preview send failed", 1)`,
 * замок отпускается, а маркер недели не пишется — выпуск не выходит вовсе, и
 * повтор упирается в то же самое.
 *
 * Маркер закрыт отдельно (`itemEmoji` теперь принимает один эмодзи, ≤4 единиц
 * UTF-16), и худший случай стал 1017 — под потолком, но с запасом в семь
 * знаков, который держится на арифметике, уже дважды оказавшейся неполной.
 * Поэтому здесь добавлена настоящая ступень: планы. Без них тот же худший
 * случай — 791 (обе цифры измерены `plainTelegramLength` вместе с футером).
 * Ужиматель перестал зависеть от доказательства и стал зависеть от проверки.
 */
export function buildWeeklyTextFitting(args: {
  news: RecapNews[];
  activities: RecapActivity[];
  ahead?: string;
  weekEnd: Date;
}): string {
  let news = [...args.news];
  let activities = [...args.activities];
  let ahead = args.ahead;
  for (;;) {
    const text = buildWeeklyRecapText({ news, activities, ahead, weekEnd: args.weekEnd });
    if (!text || fitsWeeklyCaption(text)) return text;
    // Режем длинный блок, начиная с конца — там самое старое.
    if (news.length >= activities.length && news.length > 1) news = news.slice(0, -1);
    else if (activities.length > 1) activities = activities.slice(0, -1);
    // Последняя ступень — планы. Блок необязательный и ни на что не ссылается,
    // поэтому его потеря дешевле, чем потеря всего выпуска (см. ниже).
    else if (ahead) ahead = undefined;
    // Одна новость, одна активность, планов нет — ужимать больше нечего.
    else return text;
  }
}

/** Черновик недельного поста по ответу Telegram. null — id превью не получен. */
export function buildWeeklyPending(
  sent: unknown,
  text: string,
  createdAt = new Date().toISOString(),
): PendingDraft | null {
  const previewMsgId = extractMessageId(sent);
  // Апрув ищут ровно по этому id: без него одобрять нечего, и черновик молча
  // протух бы через сутки (та же причина, что в daily-draft::buildPending).
  if (!previewMsgId) return null;
  if (!text.trim()) return null;
  return {
    createdAt,
    previewMsgId,
    dayTitle: "Итоги недели",
    articles: [],
    kind: "weekly",
    text,
  };
}

async function fetchJson<T>(url: string): Promise<T[]> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  const body = (await res.json()) as { items?: T[] } | T[];
  return Array.isArray(body) ? body : (body.items ?? []);
}

function fail(msg: string, code: number): void {
  console.error(msg);
  process.exit(code);
}

async function main(): Promise<void> {
  console.log("[weekly-draft] start", new Date().toISOString());

  const lock = acquireDraftLock();
  if (!lock) {
    fail("[weekly-draft] слот занят другим прогоном — выходим", 0);
    return;
  }

  const waiting = pendingAwaitingApproval();
  if (waiting) {
    releaseDraftLock(DRAFT_LOCK_PATH, lock);
    fail(
      `[weekly-draft] черновик от ${waiting.createdAt} ещё ждёт апрува — недельный не шлём`,
      0,
    );
    return;
  }

  const { from, to, monday } = recapBounds();
  if (weeklyAlreadyDrafted(monday)) {
    releaseDraftLock(DRAFT_LOCK_PATH, lock);
    fail(
      `[weekly-draft] итоги недели с ${monday.toISOString().slice(0, 10)} уже собраны — повтор не нужен`,
      0,
    );
    return;
  }
  const weekEnd = new Date(to.getTime() - DAY_MS);
  let news: RecapNews[] = [];
  let activities: RecapActivity[] = [];
  try {
    const [digestRows, activityRows] = await Promise.all([
      fetchJson<SiteDigestRow>(`${SITE_BASE}/api/digests?limit=100`),
      fetchJson<SiteActivityRow>(`${SITE_BASE}/api/activities?limit=100`),
    ]);
    news = selectWeekNews(digestRows, from, to);
    activities = selectWeekActivities(activityRows, from, to);
  } catch (e) {
    releaseDraftLock(DRAFT_LOCK_PATH, lock);
    fail(`[weekly-draft] сайт недоступен: ${(e as Error).message}`, 1);
    return;
  }

  const text = buildWeeklyTextFitting({
    news,
    activities,
    ahead: process.env.WEEKLY_AHEAD?.trim() || undefined,
    weekEnd,
  });
  if (!text) {
    releaseDraftLock(DRAFT_LOCK_PATH, lock);
    // Неделя без единого пункта — не повод выпускать шапку. Это не ошибка.
    fail(`[weekly-draft] за ${ruDateRange(from, weekEnd)} публиковать нечего`, 0);
    return;
  }
  console.log(
    `[weekly-draft] ${ruDateRange(from, weekEnd)}: новостей ${news.length}, активностей ${activities.length}, ${text.length} символов`,
  );

  let banner: Buffer;
  try {
    banner = await renderBannerPng({
      title: "Итоги недели",
      subtitle: "Что было за неделю",
      date: ruDateRange(from, weekEnd),
      tag: "AI × Web3",
    });
  } catch (e) {
    releaseDraftLock(DRAFT_LOCK_PATH, lock);
    fail(`[weekly-draft] banner render failed: ${(e as Error).message}`, 1);
    return;
  }

  // Ровно та склейка, длину которой считает fitsWeeklyCaption. Литерал был
  // копией константы: разъехались бы — и мерка снова перестала бы совпадать
  // с тем, что реально уходит в подпись.
  const caption = [text, "", WEEKLY_DRAFT_FOOTER].join("\n");

  const client = buildClient();
  let pending: PendingDraft | null = null;
  try {
    await client.connect();
    // Юзербот-путь: свой тег спойлера у gramjs, и кастом-эмодзи не заходят
    // в pre/code (аудит 2026-08-13 — см. lib/telegram-format.ts и
    // lib/custom-emoji-map.ts).
    const [plain, fmtEntities] = HTMLParser.parse(mdToUserbotHtml(caption));
    const peer = await client.getInputEntity("me");
    const file = new CustomFile("weekly-banner.png", banner.length, "", banner);
    const sent: any = await client.sendFile(peer, {
      file,
      caption: plain,
      formattingEntities: [...fmtEntities, ...buildCustomEmojiEntities(plain, fmtEntities)],
    });
    pending = buildWeeklyPending(sent, text);
    if (!pending) {
      try { await client.disconnect(); } catch {}
      releaseDraftLock(DRAFT_LOCK_PATH, lock);
      fail("[weekly-draft] Telegram не вернул id превью — pending не пишем", 1);
      return;
    }
  } catch (e) {
    try { await client.disconnect(); } catch {}
    releaseDraftLock(DRAFT_LOCK_PATH, lock);
    fail(`[weekly-draft] preview send failed: ${(e as Error).message}`, 1);
    return;
  }
  try { await client.disconnect(); } catch {}

  if (!commitPending(pending)) {
    releaseDraftLock(DRAFT_LOCK_PATH, lock);
    fail("[weekly-draft] чужой черновик уже ждёт апрува — свой pending не пишем", 1);
    return;
  }
  console.log("[weekly-draft] pending written →", PENDING_PATH, "msgId", pending.previewMsgId);
  // Метка только теперь: до записи в очередь неделя не закрыта.
  try {
    markWeeklyDrafted(monday);
  } catch (e) {
    // Хуже дубля на повторе только потерянный черновик, поэтому не падаем.
    console.error(`[weekly-draft] не удалось поставить метку недели: ${(e as Error).message}`);
  }

  releaseDraftLock(DRAFT_LOCK_PATH, lock);
  console.log("[weekly-draft] done. Awaiting owner approval in Saved Messages.");
  process.exit(0);
}

// Импорт модуля НЕ должен коннектиться к Telegram — только явный запуск.
if (import.meta.main) {
  main().catch((e) => {
    console.error("[weekly-draft] fatal:", e);
    process.exit(1);
  });
}
