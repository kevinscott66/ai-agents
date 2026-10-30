/** Daily draft rendering only: no research, delivery, persistence or tool imports.
 * Legacy preview/caption rendering stays separate from the strict channel-daily-spec.
 */
import {
  ruDate,
  endSentence,
  itemEmoji,
  plainInline,
  primarySourceLink,
  TG_MESSAGE_LIMIT,
} from "./delabs-text.ts";
import { cutToCodeUnits } from "./text-cut.ts";

export interface DraftItem {
  text: string;
  url: string;
}
export interface DraftArticle {
  title: string;
  date: string; // ISO
  summary: string;
  body: string;
  items: DraftItem[];
  sourceCount: number;
  /** Эмодзи-маркер пункта в дайджесте + 1 короткая фраза (заполняется тут). */
  emoji?: string;
  blurb?: string;
  /**
   * id статьи на сайте. Проставлял approve-poll после ингеста — ради повторов:
   * ингест не идемпотентен, и без отметки следующий тик таймера создал бы
   * вторую публичную страницу той же новости.
   *
   * С 21.09.2026 (AUD-20260921-033) ингеста в approve-poll нет, и никто это
   * поле больше не пишет. Оставлено читаемым, потому что в старых pending.json
   * и в снапшотах оно есть, а падать на разборе архива не за что.
   */
  siteId?: string;
}
/** Заголовок дня — короткий, по первой статье. */
export function dayTitle(articles: DraftArticle[]): string {
  // Заголовок дня = байтовый заголовок первой новости. НЕ режем середину слова
  // (баг «обрезаются заголовки и в превью тоже»: прежний .slice(0,80) рубил по
  // 80-му символу посреди слова). Баннерный fitTitle сам ужимает длину; здесь
  // лишь страхуемся от патологически длинного заголовка — по ГРАНИЦЕ слова.
  const t = (articles[0]?.title ?? "Дайджест").trim();
  if (t.length <= 90) return t;
  const cut = t.slice(0, 90);
  const sp = cut.lastIndexOf(" ");
  return (sp > 40 ? cut.slice(0, sp) : cut).trim();
}

/**
 * Превью-текст дайджеста (этап черновика). Ссылки на сайт ещё НЕ известны
 * (slug/id вернёт ингест при апруве), поэтому в превью — заголовки без линков.
 */
export function buildPreviewText(articles: DraftArticle[]): string {
  const lines: string[] = [];
  lines.push(`📰 **${dayTitle(articles).replace(/^Дайджест:\s*/, "")}**`);
  lines.push(`🗓️ ${ruDate()}`);
  lines.push("");
  lines.push("Коротко о главном — первоисточники под новостями.");
  lines.push("");
  for (const a of articles) {
    // plainInline: заголовок и блёрб приходят из внешних источников и уходят
    // прямо в markdown. Превью обязано показывать ровно то, что опубликуется,
    // иначе апрув подтверждает не то, что увидит канал (аудит 2026-08-28).
    lines.push(`${itemEmoji(a.emoji)} **${plainInline(a.title)}**`);
    lines.push(`${endSentence(plainInline(a.summary || a.blurb || ""))} ${primarySourceLink(a.items)}`.trim());
    lines.push(""); // отступ между новостями (эталон #75)
  }
  return lines.join("\n").trimEnd();
}

/**
 * Потолок ПОДПИСИ К ФОТО в Telegram — 1024 кодовые единицы UTF-16.
 *
 * Не путать с `TG_MESSAGE_LIMIT = 4096`: у обычного сообщения потолок вчетверо
 * выше, и комментарий рядом с той константой на это прямо указывает. Превью
 * черновика уходит подписью к баннеру, то есть живёт под этим лимитом.
 */
export const TG_CAPTION_LIMIT = 1024;

/** Инструкция апрува. Без неё владелец не знает, чем одобрять черновик. */
export const DRAFT_CAPTION_FOOTER =
  '🧪 ЧЕРНОВИК на сегодня. Реакция ✅ или ответ "+" — опубликую в канал и на сайт.';

/** Ужать фразу до `max` кодовых единиц по границе слова, не разрывая суррогат. */
function shortenBlurb(s: string, max: number): string {
  const t = String(s ?? "");
  if (max <= 1) return "";
  if (t.length <= max) return t;
  const cut = safeCut(t, max - 1); // -1 под многоточие
  const head = t.slice(0, cut);
  const sp = head.lastIndexOf(" ");
  return `${(sp > max * 0.5 ? head.slice(0, sp) : head).trimEnd()}…`;
}

/**
 * Подпись к баннеру превью: текст дайджеста плюс инструкция апрува, гарантированно
 * не длиннее `limit`.
 *
 * Аудит 2026-08-20: раньше это была просто склейка `buildPreviewText` + футер, и
 * ничто не ограничивало её длину. Обе половины превью пишет модель — заголовок и
 * блёрб на каждую из четырёх (`.slice(0, 4)`) новостей, — так что на обычных, а
 * не патологических данных подпись выходила за 1024 и `sendFile` бросал. Дальше
 * `catch` зовёт `fail(..., 1)`, и день пропадал ЦЕЛИКОМ — уже после ресёрча на
 * `RESEARCH_MAX_TURNS = 20` ходов SDK, за который заплачено.
 *
 * Инвариант «превью короткое» в репозитории уже записан, но только фикстурой из
 * двух новостей с короткими блёрбами (`daily-draft-approval-covers-body.test.ts`:
 * «превью остаётся коротким — это подпись к фото (лимит 1024)»). Здесь он
 * становится свойством кода.
 *
 * Эластичная часть — только блёрбы. Заголовки владелец должен видеть все (по ним
 * он и решает, что публикуется), футер несёт саму инструкцию апрува. Полный текст
 * статей ничего не теряет: он и так уходит отдельными сообщениями через
 * `chunkForTelegram(buildDraftReviewText(articles))`.
 *
 * Считаем по исходной markdown-строке, хотя в Telegram уедет её разбор
 * (`HTMLParser.parse(mdToUserbotHtml(...))`). Разбор только СНИМАЕТ разметку —
 * `**жирный**` становится `жирный`, — поэтому оценка сверху честная, а функция
 * остаётся чистой и проверяемой без gramjs.
 */
export function buildDraftCaption(
  articles: DraftArticle[],
  limit: number = TG_CAPTION_LIMIT,
): string {
  const footer = `\n\n${DRAFT_CAPTION_FOOTER}`;
  const room = limit - footer.length;

  const full = buildPreviewText(articles);
  if (full.length <= room) return full + footer;

  // Сколько места остаётся блёрбам, если всё остальное оставить как есть.
  const blurbLen = articles.reduce((n, a) => n + (a.blurb ?? "").length, 0);
  const perBlurb = Math.floor((room - (full.length - blurbLen)) / Math.max(1, articles.length));
  const shrunk = buildPreviewText(
    articles.map((a) => ({ ...a, blurb: shortenBlurb(a.blurb ?? "", perBlurb) })),
  );
  if (shrunk.length <= room) return shrunk + footer;

  // Не влезло даже без блёрбов — значит патология в заголовках. Режем жёстко:
  // усечённое превью хуже полного, но пропущенный день хуже обоих.
  return shrunk.slice(0, safeCut(shrunk, Math.max(1, room))).trimEnd() + footer;
}

/**
 * Полный текст, который уйдёт на сайт, — для показа владельцу ДО апрува.
 *
 * Аудит 2026-08-12: превью выше показывает только `title` + `blurb`, а по
 * реакции ✅ тогдашний ингест публиковал на сайте ещё и `summary`, и `body` —
 * 2-3 абзаца, написанные моделью по веб-поиску, с именами, суммами и
 * процентами. Владелец не видел из них ни слова: гейт апрува существовал, но
 * не покрывал то, что публикуется. Здесь — все поля статьи без
 * markdown-разбора: `**жирный**` показываем как есть.
 *
 * Ингест из approve-poll убран 21.09.2026, но показ остался: содержимое
 * `summary`/`body` уезжает в корпус сайта из снапшота канала, да и одобрять
 * вслепую то, что написала модель, не стоит в любом случае.
 */
export function buildDraftReviewText(articles: DraftArticle[]): string {
  const blocks: string[] = [
    "🔎 ПОЛНЫЙ РЕДАКЦИОННЫЙ ТЕКСТ — прочти до «+»:",
  ];
  articles.forEach((a, i) => {
    const lines = [
      `${i + 1}/${articles.length} · ${a.title}`,
      a.summary,
      "",
      a.body,
    ];
    if (a.items.length) {
      lines.push("", "Источники:");
      for (const it of a.items) lines.push(`• ${it.text} — ${it.url}`);
    }
    blocks.push(lines.join("\n").trim());
  });
  return blocks.join("\n\n———\n\n");
}

/**
 * Граница жёсткой дорезки, не разрывающая суррогатную пару.
 *
 * Аудит 2026-09-11, круг 26: правило здесь было выписано в пятый раз — своими
 * `0xd800`/`0xdbff`, как в `cutBlock` (lib/telegram-format.ts), `sliceOneEnd`
 * (lib/telegram-chunking.ts) и `replyForTurnError` (orchestrator/
 * message-handler.ts). Пятая копия и есть объяснение, почему ДВА места
 * обрезки правила не знали вовсе: импортировать было нечего. Теперь оно одно,
 * в lib/text-cut.ts; здесь остаётся только перевод «строка → индекс», нужный
 * вызывающему из `chunkForTelegram`: тот режет по границе ОБЕ стороны и без
 * номера не обойдётся.
 *
 * Эмодзи вне BMP (🔥 💰 🌐 — те самые, что расставляет дайджест) занимает две
 * кодовые единицы UTF-16, и срез ровно между ними Telegram рисует как «�».
 */
function safeCut(line: string, limit: number): number {
  return cutToCodeUnits(line, limit).length;
}

/**
 * Нарезать текст на сообщения. Режем по границам строк; строку длиннее лимита
 * (один абзац body теоретически может быть таким) дорезаем жёстко — потерять
 * кусок текста, который владелец должен прочитать, хуже, чем разорвать абзац.
 */
export function chunkForTelegram(
  text: string,
  limit: number = TG_MESSAGE_LIMIT,
): string[] {
  const out: string[] = [];
  let cur = "";
  const flush = (): void => {
    if (cur) out.push(cur);
    cur = "";
  };
  for (const rawLine of text.split("\n")) {
    let line = rawLine;
    while (line.length > limit) {
      flush();
      const cut = safeCut(line, limit);
      out.push(line.slice(0, cut));
      line = line.slice(cut);
    }
    const candidate = cur ? `${cur}\n${line}` : line;
    if (candidate.length > limit) {
      flush();
      cur = line;
    } else {
      cur = candidate;
    }
  }
  flush();
  return out.length ? out : [""];
}

