/**
 * daily-draft.ts — ежедневный ЧЕРНОВИК контента DeLabs (этап 1 из 2: draft).
 *
 * Через Claude Agent SDK (подписка, WebSearch/WebFetch) ресёрчит свежие новости
 * крипты+AI за ~24-48ч и собирает 3-4 мини-статьи. Рендерит бренд-баннер, шлёт
 * ПРЕВЬЮ дайджеста в Saved Messages юзербота («me») с пометкой ЧЕРНОВИК и
 * сохраняет pending JSON в /opt/web3-puls/drafts/pending.json. НЕ постит в канал.
 *
 * Публикация (после апрува владельца) — отдельный шаг approve-poll.ts.
 *
 * Запуск: bun tools/daily-draft.ts   (из /opt/agent-team, чтобы ../lib резолвился)
 * Нужны env: CLAUDE_BIN, USERBOT_SESSION_PATH/KEY, TELEGRAM_API_ID/HASH.
 */
import { readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { HOUR_MS, MINUTE_MS } from "../lib/time-constants.ts";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { HTMLParser } from "telegram/extensions/html";
import { CustomFile } from "telegram/client/uploads";
import { decryptEncryptedSession } from "./userbot-login.ts";
import { buildSubscriptionEnv } from "../lib/subscription-env.ts";
import { renderBannerPng } from "../lib/cover-banner.ts";
import { mdToUserbotHtml } from "../lib/telegram-format.ts";
import { buildCustomEmojiEntities } from "../lib/custom-emoji-map.ts";
import { extractMessageId } from "../lib/userbot.ts";
import { cutToCodeUnits } from "../lib/text-cut.ts";
import { delabsChannelId, delabsSiteBase, delabsPendingPath } from "../lib/delabs-env.ts";
// Текстовые примитивы поста живут отдельным чистым модулем: их делят три
// шаблона (дайджест, отработка активностей, итоги недели), а этот файл тянет
// gramjs и Agent SDK. Реэкспорт — чтобы прежние импорты продолжали работать.
import {
  ruDate,
  endSentence,
  itemEmoji,
  plainInline,
  ITEM_EMOJI,
  TG_MESSAGE_LIMIT,
} from "../lib/delabs-text.ts";
export { ruDate, endSentence, itemEmoji, plainInline, TG_MESSAGE_LIMIT };

export const PENDING_PATH = delabsPendingPath();

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
   * id статьи на сайте — проставляет approve-poll после успешного ингеста.
   * Существует ради повторов: ингест не идемпотентен (в POST не уходит ни
   * одного ключа), и без отметки следующий тик таймера создал бы вторую
   * публичную страницу той же новости.
   */
  siteId?: string;
}
export interface PendingDraft {
  createdAt: string; // ISO
  previewMsgId: number;
  dayTitle: string;
  articles: DraftArticle[];
  /**
   * Что за пост в очереди. Отсутствует = дайджест: ровно такой файл лежит на
   * VPS прямо сейчас, и ломать его нельзя.
   *
   * T-741: недельный пост едет через ту же очередь и тот же approve-poll, а не
   * через собственную. Два механизма апрува на один канал означали бы, что один
   * из них владелец не смотрит.
   */
  kind?: "digest" | "weekly";
  /**
   * Уже собранный текст поста — только для `kind: "weekly"`. Недельный пост
   * ссылается на то, что вышло за неделю, и новых страниц на сайте не рождает:
   * пересобирать его из `articles` (там пусто) нечем и незачем.
   */
  text?: string;
  /**
   * Момент, когда началась отправка поста в канал. Сбой sendFile неотличим от
   * «доставлено, но ответ потерян», поэтому автоповтор после этой отметки
   * запрещён — иначе подписчики получают второй экземпляр поста.
   */
  publishStartedAt?: string;
}

const CHANNEL_ID = delabsChannelId();
const SITE_BASE = delabsSiteBase();
/** Нормализация заголовка для дедупа: lowercase, только буквы/цифры/пробел. */
function normTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Заголовки уже опубликованных дайджестов (с сайта) — чтобы НЕ повторять одну и
 * ту же громкую новость снова и снова (баг «постовик зациклился на EF-увольнениях»).
 * Терпимо к ошибке сети: вернёт [].
 */
async function recentPublishedTitles(): Promise<string[]> {
  try {
    const res = await fetch(`${SITE_BASE}/api/digests?limit=40`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const j: any = await res.json();
    const items: any[] = Array.isArray(j?.items) ? j.items : [];
    return items
      .map((d) => (typeof d?.title === "string" ? d.title : ""))
      // defense-in-depth: заголовки идут в промпт ресёрча — убираем переносы/
      // управляющие символы и режем длину, чтобы контент не «ломал» инструкцию.
      .map((t) => t.replace(/\s+/g, " ").trim().slice(0, 140))
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Частые крипто-филлеры: НЕ считаем их «отличительными» при дедупе, иначе две
// РАЗНЫЕ новости с общими словами («запускает стейкинг…») ложно слипаются в дубль.
const STOPWORDS = new Set([
  "запускает", "запустил", "запуск", "биржа", "бирже", "биржу", "токен", "токена",
  "против", "рынок", "рынка", "стейкинг", "листинг", "криптовалют", "криптовалюты",
  "блокчейн", "протокол", "сеть", "сети", "компания", "млрд", "может", "после",
  "новый", "новая", "первый", "будет", "более", "через", "около",
]);

/** Отличительные слова заголовка (>4 символов, не стоп-слова) для дедупа. */
function keyWords(s: string): Set<string> {
  return new Set(
    normTitle(s)
      .split(" ")
      .filter((w) => w.length > 4 && !STOPWORDS.has(w)),
  );
}

/** Near-дубль: нормализованное вхождение ИЛИ ≥2 общих значимых слова. */
export function isDuplicate(title: string, published: string[]): boolean {
  const nt = normTitle(title);
  if (!nt) return false;
  const kw = keyWords(title);
  for (const p of published) {
    const np = normTitle(p);
    if (np && (np.includes(nt) || nt.includes(np))) return true;
    let overlap = 0;
    const pk = keyWords(p);
    for (const w of kw) if (pk.has(w)) overlap++;
    if (overlap >= 2) return true;
  }
  return false;
}

/**
 * Бюджет ходов на ресёрч.
 *
 * Было 12, и юнит падал: `research failed: Reached maximum number of turns (12)`
 * (прод, 2026-08-12 08:04). Промпт просит 3-4 статьи, в каждой 2-4 источника —
 * это 15-20 вызовов инструментов минимум, то есть задача была структурно
 * невыполнима в выданном бюджете, и падало не иногда, а всегда, когда хватало
 * лимита подписки.
 *
 * Потолок сверху — `TimeoutStartSec=600` в юните. Упавший прогон дал 4м25с на
 * 12 ходов, то есть ~22с на ход; после ресёрча идут ещё рендер баннера и две
 * ходки в Telegram. 20 ходов ≈ 7.5 минуты и оставляют запас до таймаута.
 * Одновременно промпт получил сам это число, чтобы модель тратила ходы на
 * широкие поиски, а не на открытие каждой ссылки подряд.
 */
export const RESEARCH_MAX_TURNS = 20;

const RESEARCH_SYSTEM = [
  "Ты — Drop Hunter, контент-редактор DeLabs (Telegram-канал @delabsru про крипту, airdrop, AI×Web3).",
  "Пишешь по-русски, живо, без ИИ-клише («в эпоху цифровизации», «давайте разберёмся», «не секрет, что», «стоит отметить»).",
  "Заголовки — байтовые, конкретные, без воды и без точки в конце.",
  "Каждый факт подкреплён РЕАЛЬНЫМ источником (URL, найденным через WebSearch/WebFetch). Не выдумывай ссылки.",
].join(" ");

export function researchPrompt(exclude: string[]): string {
  const today = new Date().toISOString().slice(0, 10);
  const excludeBlock = exclude.length
    ? [
        "",
        "❗ЭТИ ТЕМЫ УЖЕ ОПУБЛИКОВАНЫ на сайте — НЕ повторяй их и близкие по смыслу:",
        ...exclude.slice(0, 40).map((t) => `- ${t}`),
        "Если самая громкая новость дня уже в этом списке — НЕ бери её, выбирай ДРУГИЕ, ещё не освещённые свежие события.",
        "",
      ]
    : [];
  return [
    `Сегодня ${today}. Через WebSearch/WebFetch найди самые важные СВЕЖИЕ новости криптовалют и AI`,
    "СТРОГО за последние ~24-48 часов (запуски, листинги, airdrop, регуляторика, крупные апдейты протоколов, модели ИИ).",
    "Не бери старые новости недельной/месячной давности, даже если они кажутся важными.",
    ...excludeBlock,
    "Собери 3-4 мини-статьи. Для КАЖДОЙ:",
    "- title: байтовый русский заголовок (без точки, без ИИ-клише),",
    "- date: ISO-дата новости (YYYY-MM-DD),",
    "- summary: 1-2 предложения сути,",
    "- body: 2-3 абзаца по-русски, ключевые цифры/имена выделяй **жирным** (Markdown),",
    "- items: массив {text,url} с РЕАЛЬНЫМИ источниками (2-4 ссылки).",
    "",
    `У тебя ${RESEARCH_MAX_TURNS} ходов на всё — планируй бюджет:`,
    "начни с 2-3 широких поисков сразу по нескольким темам, а WebFetch трать",
    "только там, где выдача поиска не даёт цифр или деталей. Ссылки из",
    "результатов поиска — тоже настоящие источники, открывать каждую не нужно.",
    "Лучше 3 статьи с готовым JSON, чем 4 недособранных и оборванный ход.",
    "",
    "Верни СТРОГО ОДИН JSON-объект и НИЧЕГО кроме него:",
    `{"articles":[{"title":"...","date":"${today}","summary":"...","body":"...","items":[{"text":"...","url":"https://..."}]}]}`,
  ].join("\n");
}

/** Вытащить первый сбалансированный {...} из текста модели и распарсить. */
function extractJson(raw: string): { articles: DraftArticle[] } {
  const start = raw.indexOf("{");
  if (start < 0) throw new Error("no JSON object in model output");
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const slice = raw.slice(start, i + 1);
        const obj = JSON.parse(slice);
        if (!obj || !Array.isArray(obj.articles)) throw new Error("JSON has no articles[]");
        return obj;
      }
    }
  }
  throw new Error("unbalanced JSON braces");
}

/**
 * Ответ модели → статьи черновика. Отдельно от `research`, потому что
 * `research` ходит в сеть, а разбор — чистый и проверяемый.
 */
export function articlesFromResearch(parsed: { articles: DraftArticle[] }): DraftArticle[] {
  return parsed.articles
    .filter((a) => a && a.title && a.body)
    .slice(0, 4)
    .map((a, i) => {
      // Ссылки, которые реально доедут до сайта: всё, что не http(s), сюда не
      // попадает (модель присылает и «TBD», и относительные пути).
      const items = Array.isArray(a.items)
        ? a.items
            .filter((it) => it && typeof it.url === "string" && /^https?:\/\//.test(it.url))
            .map((it) => ({ text: String(it.text ?? "Источник").trim(), url: it.url }))
        : [];
      return {
        title: String(a.title).trim(),
        date: typeof a.date === "string" && a.date ? a.date : new Date().toISOString().slice(0, 10),
        summary: String(a.summary ?? "").trim(),
        body: String(a.body ?? "").trim(),
        items,
        // Аудит 2026-08-21: счётчик брался из ответа модели, а фолбэк считал
        // `a.items.length` — длину СЫРОГО списка, включая ссылки, которые
        // фильтр выше только что выбросил. На сайте это бейдж «N источников»
        // ровно над списком ссылок (`DigestPage`, `HomeDigests`): модель
        // объявляла 5, доезжало 3, и страница сама себе противоречила.
        // Считаем по тому, что доехало, — как это и делает второй путь
        // ингеста, `lib/site-ingest.ts` (`sourceCount: items.length`).
        sourceCount: items.length,
        emoji: ITEM_EMOJI[i % ITEM_EMOJI.length],
        blurb: String(a.summary ?? "").trim().split(/(?<=[.!?])\s/)[0] || a.title,
      };
    });
}

/** Запустить ресёрч через подписку и вернуть статьи. */
async function research(): Promise<DraftArticle[]> {
  const published = await recentPublishedTitles();
  let result = "";
  for await (const m of query({
    prompt: researchPrompt(published),
    options: {
      systemPrompt: RESEARCH_SYSTEM,
      allowedTools: ["WebSearch", "WebFetch"],
      maxTurns: RESEARCH_MAX_TURNS,
      permissionMode: "default",
      pathToClaudeCodeExecutable: process.env.CLAUDE_BIN,
      env: buildSubscriptionEnv(),
    } as any,
  })) {
    if ((m as any).type === "result") result = (m as any).result ?? "";
  }
  const arts = articlesFromResearch(extractJson(result));
  // Пост-фильтр: выкинуть near-дубли уже опубликованного (страховка на случай,
  // если модель проигнорировала список исключений в промпте). НЕ откатываемся на
  // дубли — иначе постовик снова зациклится на той же новости.
  const fresh = arts
    .filter((a) => !isDuplicate(a.title, published))
    .map((a, i) => ({ ...a, emoji: ITEM_EMOJI[i % ITEM_EMOJI.length] }));
  if (fresh.length < arts.length) {
    console.warn(
      `[daily-draft] отфильтровано ${arts.length - fresh.length} дубль(ей) уже опубликованного`,
    );
  }
  if (!fresh.length) {
    throw new Error(
      "all researched articles duplicate already-published topics — skipping draft",
    );
  }
  return fresh;
}

/** Заголовок дня — короткий, по первой статье. */
function dayTitle(articles: DraftArticle[]): string {
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
  lines.push("Коротко о главном — детали по ссылкам на сайте.");
  lines.push("");
  for (const a of articles) {
    // plainInline: заголовок и блёрб приходят из внешних источников и уходят
    // прямо в markdown. Превью обязано показывать ровно то, что опубликуется,
    // иначе апрув подтверждает не то, что увидит канал (аудит 2026-08-28).
    lines.push(`${itemEmoji(a.emoji)} **${plainInline(a.title)}**`);
    lines.push(`${endSentence(plainInline(a.blurb ?? ""))} [Подробнее → (ссылка на апруве)]`);
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
 * реакции ✅ `approve-poll.ts::ingestArticle` публикует на delabs.space ещё и
 * `summary`, и `body` — 2-3 абзаца, написанные моделью по веб-поиску, с
 * именами, суммами и процентами. Владелец не видел из них ни слова: гейт
 * апрува существовал, но не покрывал то, что публикуется. Здесь — ровно те
 * поля, что уходят в ингест, без markdown-разбора: `**жирный**` показываем
 * как есть, потому что именно эти символы и поедут на сайт.
 */
export function buildDraftReviewText(articles: DraftArticle[]): string {
  const blocks: string[] = [
    "🔎 ПОЛНЫЙ ТЕКСТ НА САЙТ — прочти до «+»:",
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

/**
 * Столько живёт неодобренный черновик — тот же срок, что у approve-poll.
 *
 * Инцидент 2026-08-14: было ровно 24ч, то есть РОВНО период таймера. Черновик
 * от 08-13 08:05 на прогоне 08-14 08:00 был «жив» ещё пять минут, и день
 * пропустили — один неодобренный черновик стоил не одного дня выпуска, а двух.
 * Порог должен быть строго меньше периода таймера с запасом на дрейф старта
 * (systemd стартует не секунда в секунду) — отсюда 20ч.
 *
 * Менять только вместе с MAX_AGE_MS в approve-poll.ts: если poll держит апрув
 * дольше, чем draft считает слот занятым, новый черновик затрёт pending, на
 * который владелец вот-вот поставит ✅, и апрув уйдёт в никуда.
 */
export const PENDING_MAX_AGE_MS = 20 * HOUR_MS;

/**
 * Черновик, который уже ждёт апрува. null — путь свободен, можно слать новый.
 *
 * Аудит 2026-08-12: pending.json перезаписывался без проверки. Второй запуск
 * (таймер дёрнулся дважды, ручной прогон поверх ночного) затирал черновик,
 * который владелец в этот момент читал: апрув относился к превью со старым
 * msgId, а в pending лежал уже новый — одобрение просто пропадало, и дневной
 * ресёрч через SDK оплачивался второй раз.
 *
 * Протухший (старше PENDING_MAX_AGE_MS, то есть 20ч) и битый файл живыми не
 * считаем: их удалит approve-poll на
 * своём тике, а блокировать из-за них выпуск навсегда нельзя.
 */
export function pendingAwaitingApproval(
  path = PENDING_PATH,
  now = Date.now(),
): PendingDraft | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null; // файла нет — обычный случай
  }
  try {
    const p = JSON.parse(raw) as PendingDraft;
    const age = now - Date.parse(p?.createdAt);
    if (!Number.isFinite(age) || age > PENDING_MAX_AGE_MS) return null;
    return p;
  } catch {
    return null;
  }
}

/** Замок на время прогона: рядом с pending, чтобы жить на том же томе. */
export const DRAFT_LOCK_PATH = PENDING_PATH + ".lock";
/**
 * Дольше этого замок считаем брошенным. systemd рубит юнит по
 * TimeoutStartSec=600, ручной прогон может идти дольше — 30 минут с запасом.
 */
export const DRAFT_LOCK_MAX_AGE_MS = 30 * MINUTE_MS;

/**
 * Занять слот выпуска. Возвращает токен замка или null — кто-то уже работает.
 *
 * Аудит 2026-08-12: между проверкой `pendingAwaitingApproval()` и записью
 * pending лежит `research()` (SDK, `RESEARCH_MAX_TURNS` ходов) плюс рендер баннера и две
 * ходки в Telegram — минуты. Оба прогона, начавшиеся внутри этого окна,
 * проходят проверку: замер на реальных функциях дал `gate A: null | gate B:
 * null`, после чего pending с previewMsgId 4001 превращался в 4002. Апрув
 * ищут ТОЛЬКО по `pending.previewMsgId` (approve-poll.ts:570), поэтому ✅ на
 * превью, которое владелец читал, не совпадает ни с чем, а ✅ на втором
 * публикует статьи, которых он не открывал. Плюс ресёрч оплачивается дважды.
 *
 * Замок берём ДО ресёрча, эксклюзивным созданием файла (`wx`) — это атомарно.
 * Брошенный замок (прогон убили таймаутом) перехватываем по возрасту, но
 * подтверждаем перечитыванием: два перехватчика одновременно допустимы, выжить
 * должен ровно тот, чей токен остался в файле.
 */
export function acquireDraftLock(
  path = DRAFT_LOCK_PATH,
  now = Date.now(),
  token = String(process.pid),
): string | null {
  // В файле `<время старта>:<токен>`: возраст нужен, чтобы отличить работающий
  // прогон от убитого, а токен — чтобы не снять чужой замок.
  const stamp = `${now}:${token}`;
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {}
  try {
    writeFileSync(path, stamp, { flag: "wx" });
    return stamp;
  } catch {
    // Файл уже есть.
  }
  let started = NaN;
  try {
    started = Number(readFileSync(path, "utf8").trim().split(":")[0]);
  } catch {}
  // Живой замок — отступаем. Битый (NaN) считаем брошенным: иначе один мусорный
  // файл заблокировал бы выпуск навсегда.
  if (Number.isFinite(started) && now - started < DRAFT_LOCK_MAX_AGE_MS) return null;
  try {
    writeFileSync(path, stamp, "utf8");
    return readFileSync(path, "utf8") === stamp ? stamp : null;
  } catch {
    return null;
  }
}

/** Снять свой замок. Чужой не трогаем — его владелец ещё работает. */
export function releaseDraftLock(path = DRAFT_LOCK_PATH, token?: string | null): void {
  if (!token) return;
  try {
    if (readFileSync(path, "utf8") !== token) return;
  } catch {
    return;
  }
  try {
    rmSync(path);
  } catch {}
}

/**
 * Записать pending, если слот всё ещё свободен. false — отказ, чужой черновик
 * уже ждёт апрува и затирать его нельзя.
 *
 * Перепроверка нужна даже с замком: замок перехватывается по возрасту, и
 * прогон, который сочли брошенным, мог успеть дописать pending. Запись
 * pending — точка, после которой апрув владельца становится публикацией, так
 * что здесь отказ дешевле гонки.
 */
export function commitPending(
  pending: PendingDraft,
  path = PENDING_PATH,
  now = Date.now(),
): boolean {
  if (pendingAwaitingApproval(path, now)) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(pending, null, 2), "utf8");
  return true;
}

/**
 * Собрать pending по ответу Telegram. null — id превью определить не удалось.
 *
 * `Number(sent?.id ?? 0)` врал на ответе-Updates (см. extractMessageId): id
 * лежит внутри updates[], а не в корне. previewMsgId=0 означает, что
 * approve-poll будет искать реакции и ответы на несуществующем сообщении —
 * апрув не совпадёт ни с чем никогда, а черновик молча протухнет через сутки.
 * Поэтому нулевой id — отказ на месте.
 */
export function buildPending(
  sent: unknown,
  dayTitle: string,
  articles: DraftArticle[],
  createdAt = new Date().toISOString(),
): PendingDraft | null {
  const previewMsgId = extractMessageId(sent);
  if (!previewMsgId) return null;
  return { createdAt, previewMsgId, dayTitle, articles };
}

/**
 * Построить userbot-клиент из env-сессии (как в probe-*).
 *
 * Экспортируется, потому что недельный черновик (T-741) шлёт превью в тот же
 * «me» и той же сессией: вторая копия этих десяти строк означала бы, что смена
 * формата ключа сессии чинится в одном месте и ломается в другом.
 */
export function buildClient(): TelegramClient {
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

async function main(): Promise<void> {
  console.log("[daily-draft] start", new Date().toISOString(), "channel", CHANNEL_ID);

  // Проверяем ДО ресёрча: он идёт через SDK и стоит денег, а если предыдущий
  // черновик ещё ждёт апрува, слать поверх него всё равно нечего.
  const waiting = pendingAwaitingApproval();
  if (waiting) {
    console.log(
      `[daily-draft] черновик от ${waiting.createdAt} ещё ждёт апрува (msg ${waiting.previewMsgId}) — второй не шлём`,
    );
    process.exit(0);
    return;
  }

  // Замок ДО ресёрча: он идёт через SDK и стоит денег. Без замка второй прогон,
  // начавшийся внутри окна «проверка … запись», платил за ресёрч второй раз и в
  // конце затирал чужой pending (см. acquireDraftLock).
  const lock = acquireDraftLock();
  if (!lock) {
    console.log("[daily-draft] другой прогон уже в работе — ресёрч не запускаем");
    process.exit(0);
    return;
  }
  const fail = (msg: string, code: number): never => {
    if (code) console.error(msg);
    else console.log(msg);
    releaseDraftLock(DRAFT_LOCK_PATH, lock);
    process.exit(code);
  };

  let articles: DraftArticle[];
  try {
    articles = await research();
  } catch (e) {
    fail(`[daily-draft] research failed: ${(e as Error).message}`, 1);
    return;
  }
  console.log(`[daily-draft] got ${articles.length} articles`);

  const title = dayTitle(articles);
  let banner: Buffer;
  try {
    banner = await renderBannerPng({
      title: title.replace(/^Дайджест:\s*/, ""),
      subtitle: "Свежее в крипте и AI",
      date: ruDate(),
      tag: "AI × Web3",
    });
  } catch (e) {
    fail(`[daily-draft] banner render failed: ${(e as Error).message}`, 1);
    return;
  }

  // Последняя проверка перед отправкой: замок можно перехватить по возрасту, и
  // «брошенный» прогон мог успеть дописать pending, пока мы ресёрчили. Слать
  // превью поверх чужого черновика незачем — владелец получил бы два и не знал
  // бы, какой из них живой.
  const appeared = pendingAwaitingApproval();
  if (appeared) {
    fail(
      `[daily-draft] пока шёл ресёрч, появился черновик от ${appeared.createdAt} — превью не шлём`,
      0,
    );
    return;
  }

  const caption = buildDraftCaption(articles);

  const client = buildClient();
  let pending: PendingDraft | null = null;
  try {
    await client.connect();
    // Юзербот-путь: свой тег спойлера у gramjs, и кастом-эмодзи не заходят
    // в pre/code (аудит 2026-08-13 — см. lib/telegram-format.ts и
    // lib/custom-emoji-map.ts).
    const [plain, fmtEntities] = HTMLParser.parse(mdToUserbotHtml(caption));
    const ceEntities = buildCustomEmojiEntities(plain, fmtEntities);
    const peer = await client.getInputEntity("me");
    const file = new CustomFile("draft-banner.png", banner.length, "", banner);
    const sent: any = await client.sendFile(peer, {
      file,
      caption: plain,
      formattingEntities: [...fmtEntities, ...ceEntities],
    });
    pending = buildPending(sent, title, articles);
    if (!pending) {
      // Апрув ищут по этому id — без него одобрять нечего. Лучше пропущенный
      // день с явной ошибкой, чем pending, который никогда не совпадёт.
      try { await client.disconnect(); } catch {}
      fail(
        "[daily-draft] Telegram не вернул id превью — pending не пишем, апрув был бы невозможен",
        1,
      );
      return;
    }
    console.log(
      "[daily-draft] preview sent to Saved Messages, msgId",
      pending.previewMsgId,
    );

    // Полный текст статей — отдельными сообщениями следом. В подпись к фото он
    // не влезает (1024 символа), а апрув без него — апрув вслепую.
    //
    // Отправляем НЕ реплаем на превью: `approve-poll.ts::isApproved` сканирует
    // именно реплаи и на каждый неодобряющий пишет строку «ответ не считается
    // апрувом» — своими же сообщениями засоряли бы этот лог.
    for (const chunk of chunkForTelegram(buildDraftReviewText(articles))) {
      await client.sendMessage(peer, { message: chunk });
    }
  } catch (e) {
    // Сюда же попадает падение отправки полного текста — и это осознанно:
    // pending пишется ниже, так что без него approve-poll выйдет на «no
    // pending draft» и не опубликует ничего. Отказ закрытый: лучше пропущенный
    // день, чем апрув того, чего владелец не видел.
    try { await client.disconnect(); } catch {}
    fail(`[daily-draft] preview send failed: ${(e as Error).message}`, 1);
    return;
  }
  try { await client.disconnect(); } catch {}

  try {
    if (!commitPending(pending)) {
      fail(
        "[daily-draft] чужой черновик уже ждёт апрува — свой pending не пишем, чтобы не сорвать одобрение",
        1,
      );
      return;
    }
    console.log("[daily-draft] pending written →", PENDING_PATH);
  } catch (e) {
    fail(`[daily-draft] failed to write pending: ${(e as Error).message}`, 1);
    return;
  }

  releaseDraftLock(DRAFT_LOCK_PATH, lock);
  console.log("[daily-draft] done. Awaiting owner approval in Saved Messages.");
  process.exit(0);
}

// Импорт модуля НЕ должен коннектиться к Telegram — только явный запуск.
if (import.meta.main) {
  main().catch((e) => {
    console.error("[daily-draft] fatal:", e);
    process.exit(1);
  });
}
