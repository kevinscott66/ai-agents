// site-ingest.ts — bridge "published channel digest -> Web3 Пульс site DB".
//
// After a digest post is published to the Telegram channel we best-effort parse
// the post markdown into a Digest shape and POST it to the site's internal
// ingest endpoint. This is strictly fire-and-forget: it MUST never throw and
// MUST never block publication.
//
// The bridge is OFF by default: it does nothing unless BOTH SITE_INGEST_URL and
// SITE_INGEST_TOKEN are configured in the environment.

import { log } from "./log.ts";
import { getErrorMessage } from "./errors.ts";
import { HOUR_MS } from "./time-constants.ts";
import { isChannelFooterLine } from "./channel-footer.ts";
import { isTestRun } from "./test-run-marker.ts";
import { DEFAULT_DELABS_CHANNEL_ID } from "./delabs-env.ts";

const REQUEST_TIMEOUT_MS = 5000;

/**
 * Тестовый прогон наружу не ходит.
 *
 * T-743: на delabs.space лежат восемь публичных страниц «Крючок.» с датами
 * 2026-08-02…08-12 — это фикстура наших же publish-тестов. `bun test` на VPS
 * проходил по настоящему PUBLISH_TO_CHANNEL, а мост брал боевые
 * SITE_INGEST_URL/TOKEN из окружения процесса и публиковал страницу с записью
 * в RSS. Снять её обратно нельзя.
 *
 * Фильтры по каналу и по числу источников — про СОДЕРЖИМОЕ поста; они бы этот
 * текст сегодня отсекли, но не отсекут первый же тест с нормальным дайджестом
 * в публичный канал. Нужен фильтр по ОТПРАВИТЕЛЮ, и он здесь.
 *
 * Строгое сравнение с "1", а не «похоже на да»: включает мост только тот, кто
 * знает точное значение, то есть тесты самого моста, где fetch подменён.
 *
 * Аудит 2026-08-20: сам признак «мы под тестами» больше не берётся из
 * NODE_ENV. Настоящая экспортированная переменная бьёт дефолт bun'а —
 * `NODE_ENV=production bun test` давал NODE_ENV === "production", и гейт
 * снимался целиком. А ставить NODE_ENV=production на сервере предписывает
 * `.env.example:83`, и держат оба unit-файла; `set -a; . /opt/agent-team/.env`
 * экспортирует его вместе с боевыми SITE_INGEST_URL/TOKEN. Это ровно условия
 * T-743, восстановленные одной переменной. Признак теперь ставит preload
 * тест-раннера — см. test-run-marker.ts.
 */
function ingestBlockedByTestRun(): boolean {
  if (!isTestRun()) return false;
  return process.env.SITE_INGEST_ALLOW_IN_TESTS !== "1";
}

/**
 * Публичный канал DeLabs — единственный, чьи посты становятся страницами сайта.
 *
 * Цепочка: свой SITE_INGEST_CHANNEL_ID, затем общий DELABS_CHANNEL_ID, затем
 * известный id. Фолбэк именно на конкретный канал, а не на «разрешить всё»:
 * незаданная или битая переменная не должна открывать мост остальным каналам
 * команды.
 *
 * Аудит 2026-08-28: тот же id был захардкожен ещё и дефолтом в
 * tools/daily-draft.ts и tools/approve-poll.ts — причём в виде
 * `Number(DELABS_CHANNEL_ID ?? "-1004471352065")`, который для пустой строки из
 * systemd давал чат 0. Теперь константа одна, а читатели зовут
 * lib/delabs-env.ts.
 */
export const DEFAULT_SITE_CHANNEL_ID = DEFAULT_DELABS_CHANNEL_ID;

export function siteIngestChannelId(): number {
  const raw =
    process.env.SITE_INGEST_CHANNEL_ID?.trim() ||
    process.env.DELABS_CHANNEL_ID?.trim() ||
    "";
  if (!raw) return DEFAULT_SITE_CHANNEL_ID;
  const n = Number(raw);
  return Number.isFinite(n) && n !== 0 ? n : DEFAULT_SITE_CHANNEL_ID;
}

type ParsedItem = { text: string; url?: string };
type ParsedDigest = {
  title: string;
  summary: string;
  items: ParsedItem[];
  sourceCount: number;
};

/** Markdown emphasis/heading/quote punctuation we strip from displayed text. */
const MD_PUNCT_RE = /[#*_`>|~]/g;

/**
 * Markdown-ссылка `[текст](url)` — тот же вид, что мы разбираем в items.
 *
 * Аудит 2026-08-28: адрес читался как `[^)\s]+`, то есть обрывался на первой
 * же скобке ВНУТРИ адреса. `[Про DAO](https://ru.wikipedia.org/wiki/DAO_(организация))`
 * давал item со ссылкой `…/DAO_(организация` — и она проходила `safeStoredUrl`
 * на сайте (схема-то https), так что битая ссылка уезжала на публичную
 * страницу и в RSS, а закрывающая скобка оставалась в тексте. Скобки в URL —
 * не экзотика: так устроены статьи Википедии, а на них ссылаются объяснялки.
 * Разрешаем один уровень вложенных скобок; альтернативы различаются первым
 * символом, так что перебора с возвратами тут нет.
 */
const MD_LINK_RE = /\[([^\]]+)\]\((https?:\/\/(?:[^()\s]|\([^()\s]*\))*)\)/g;

/**
 * `[Zora](https://zora.co)` → `Zora`.
 *
 * Аудит 2026-08-21: MD_PUNCT_RE не знает про `[`, `]`, `(`, `)`, и заголовок
 * уезжал на сайт куском сырой разметки. `**[Zora Drop](https://zora.co/drop)**`
 * — обычная шапка поста — давала title `Zora Drop](https://zora.co/drop)`:
 * `**` снимались, скобки оставались, а `^[^\p{L}\p{N}]+` срезал только ведущую
 * `[`. Пост совсем без прозы (одни ссылки) давал `a](https://x/1)`.
 * Уходит это в публичный delabs.space и в RSS, обратного хода нет.
 */
function unwrapMdLinks(s: string): string {
  return s.replace(MD_LINK_RE, "$1");
}

/**
 * A line is footer-ish if it carries the channel footer / copyright block.
 *
 * Аудит 2026-08-11: здесь жила своя копия правила, и она матчила `delabs` без
 * якоря — то есть любую строку с названием бренда. Канал ровно про DeLabs, так
 * что с сайта молча пропадали и пункты дайджеста, и вступление поста (тогда
 * summary откатывался на title — карточка с заголовком вместо описания).
 * Правило теперь одно, в channel-footer.ts, общее с тем, что ставит футер.
 */
const isFooterLine = isChannelFooterLine;

/**
 * Шаблонная «обвязка» поста (приветствие/шапка/дата DeLabs-стиля) — её НЕ нужно
 * тащить в summary: 📰 = заголовок (он уже в title), 🗓️ = строка даты, приветствие
 * с 🤑 или словами «отличного дня/привет/доброе утро…».
 */
function isScaffoldLine(line: string): boolean {
  const l = line.trim();
  if (!l) return false;
  if (/^📰/.test(l)) return true; // шапка-заголовок (дублирует title)
  if (/^🗓/.test(l)) return true; // строка даты
  if (/🤑/.test(l) && l.length < 40) return true; // приветствие
  if (/^(отличного дня|привет|доброе утро|добрый (день|вечер)|здравствуй|всем привет)/iu.test(l))
    return true;
  return false;
}

/**
 * Derive the digest title: first **bold** or first meaningful line.
 *
 * Аудит 2026-08-20: bold искался по всему тексту, и футер из фильтра выпадал —
 * `!isFooterLine(l)` стоял только в фолбэке. Футер у нас программный:
 * `ensureChannelFooter` приклеивает `CHANNEL_FOOTER`, который заканчивается на
 * `**© Copyright 2023-2026 [DeLabs](…)**`. Футер подставляется, когда агент
 * написал свой (`if (!removed) return text` — пост совсем без футера функция не
 * трогает), то есть на любом посте в обычном стиле канала. И такой пост, где
 * агент ничего не выделил сам, уезжал на delabs.space с заголовком
 * «Copyright 2023-2026 [DeLabs](…)» — вместе с записью в RSS и без обратного
 * хода. Обе ветки теперь смотрят на один и тот же набор строк.
 *
 * Аудит 2026-09-11: у поста два заголовка, и второй жил своей копией этой
 * функции — `deriveBannerTitle` в dispatch/publish.ts, с телом ДО правки
 * 2026-08-20 и без снятия ссылок (2026-08-28). Тот же футер уезжал уже не в
 * запись на сайте, а в PNG-обложку публичного поста — и вот там обратного
 * хода нет совсем, картинку не переингестишь. Копию убрали, длину вынесли в
 * параметр: баннеру 70, записи на сайте 120.
 */
export function deriveTitle(text: string, maxLen = 120): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => !isFooterLine(l));
  // `.` не матчит перевод строки, так что bold и раньше искался внутри строки —
  // меняется только набор строк, по которым идём.
  let t = "";
  for (const l of lines) {
    const bold = l.match(/\*\*(.+?)\*\*/);
    if (bold) {
      t = unwrapMdLinks(bold[1]!);
      break;
    }
  }
  if (!t) {
    // Считаем «осмысленность» уже по видимому тексту: в `[a](https://x/1)` шесть
    // букв набирал сам URL, и строка-ссылка проходила порог как заголовок.
    const line = lines
      .map((l) => unwrapMdLinks(l))
      .find((l) => l.replace(/[^\p{L}\p{N}]/gu, "").length >= 6);
    t = line ?? "Дайджест";
  }
  t = t
    .replace(MD_PUNCT_RE, "")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .trim();
  return (t || "Дайджест").slice(0, maxLen);
}

/**
 * Ключ, по которому строка сравнивается с заголовком.
 *
 * Аудит 2026-08-28: сравнение шло `l.replace(MD_PUNCT_RE, "").trim() !== title`,
 * то есть строку нормализовали НЕ так, как сам заголовок: `deriveTitle`
 * дополнительно снимает markdown-ссылки, срезает ведущую не-букву и режет по
 * 120 символам. Из-за этого строка заголовка почти никогда не совпадала сама с
 * собой и уезжала в summary второй раз. Спасал только `isScaffoldLine`, а он
 * знает ровно 📰 и 🗓 — тогда как tools-schema.ts:322 выдаёт модели всю палитру
 * (🤑📰🗓️✅🤩🙌😮❌💰🔥👉👇⭐️😎) и просит выбирать по смыслу. Пост,
 * начинающийся с `🔥 **Web3 Пульс за 27 августа**`, давал на delabs.space
 * карточку, описание которой начинается с её же заголовка. Уходит это в
 * публичный сайт и в RSS, обратного хода нет.
 *
 * Нормализация здесь — ровно хвост deriveTitle; `**` снимает MD_PUNCT_RE.
 */
function titleKey(line: string): string {
  return unwrapMdLinks(line)
    .replace(MD_PUNCT_RE, "")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .trim()
    .slice(0, 120);
}

/**
 * Строка, с которой НАЧИНАЕТСЯ пункт: вся строка — один bold-заголовок,
 * возможно с эмодзи и пунктуацией по краям (`🔥 **Monad**`, `📌 **Активности**`).
 * Проза с выделением внутри (`⏳ **На следующей неделе:** смотрим…`) сюда не
 * попадает — после закрывающих `**` есть буквы.
 *
 * Строка самого заголовка поста исключена: она такой же формы, но пункта не
 * начинает (и из summary её убирает отдельный фильтр).
 */
const ITEM_HEAD_RE = /^[^\p{L}\p{N}]*\*\*[^*]+\*\*[^\p{L}\p{N}]*$/u;

function isItemHeadLine(line: string, title: string): boolean {
  const l = line.trim();
  return ITEM_HEAD_RE.test(l) && titleKey(l) !== title;
}

/**
 * Parse the post markdown into a digest best-effort.
 * - title: first bold/heading line.
 * - items: lines containing a markdown link [text](url) -> {text, url}.
 * - summary: intro paragraph before the first item, trimmed to ~300 chars.
 * - sourceCount: number of links found.
 * Footer lines (copyright/community-chat) are excluded from items and summary.
 */
export function parseDigestPost(postText: string): ParsedDigest {
  const text = postText ?? "";
  const title = deriveTitle(text);

  const lines = text.split("\n");

  const items: ParsedItem[] = [];
  let firstItemIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isFooterLine(line)) continue;
    const matches = [...line.matchAll(MD_LINK_RE)];
    if (matches.length === 0) continue;
    if (firstItemIdx === -1) firstItemIdx = i;
    // One item per link found on the line.
    for (const m of matches) {
      // Аудит 2026-09-11: тут стоял свой набор знаков — без `>` и `|`, то
      // есть текст пункта нормализовался НЕ так, как заголовок и описание
      // того же поста. Маркер цитаты и палка из таблицы уезжали на
      // delabs.space и в RSS. Набор ровно один, он и назван (`MD_PUNCT_RE`);
      // делить `.replace` с глобальным флагом безопасно — он сам сбрасывает
      // `lastIndex`, в отличие от `.test`.
      const itText = (m[1] ?? "").replace(MD_PUNCT_RE, "").trim();
      const url = m[2];
      items.push(itText ? { text: itText, url } : { text: url, url });
    }
  }

  // Summary: вступление до первого пункта, минус строка заголовка и футер,
  // собранное в один абзац.
  //
  // Аудит 2026-08-28: границей была первая строка СО ССЫЛКОЙ, а в домашнем
  // формате пункт начинается заголовком на своей строке, и ссылка приходит
  // строкой-двумя ниже (tools-schema.ts:332 просит 2-3 строки описания под
  // каждым заголовком). В итоге заголовки пунктов уезжали в описание карточки:
  // buildActivityRunText давал summary «Что стоит сделать прямо сейчас — по
  // шагам и без воды. 🔥 Monad», а buildWeeklyRecapText — «…Что произошло и что
  // мы отработали. 📌 Активности 🔥 Monad 🔥 Zora дроп». Уходит это на публичный
  // delabs.space и в RSS, обратного хода нет. Режем по первому НАЧАЛУ пункта:
  // это заголовок пункта, если он есть до первой ссылки, иначе — сама ссылка.
  let introEnd = firstItemIdx === -1 ? lines.length : firstItemIdx;
  for (let i = 0; i < introEnd; i++) {
    if (isItemHeadLine(lines[i]!, title)) {
      introEnd = i;
      break;
    }
  }
  const intro = lines
    .slice(0, introEnd)
    .map((l) => l.trim())
    .filter((l) => l && !isFooterLine(l) && !isScaffoldLine(l))
    // Drop the title line itself if it appears verbatim.
    .filter((l) => titleKey(l) !== title)
    .join(" ")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(MD_PUNCT_RE, "")
    .replace(/\s+/g, " ")
    .trim();

  let summary = intro;
  if (!summary) {
    // Fallback: use the title as a minimal summary so the site row is valid.
    summary = title;
  }
  if (summary.length > 300) summary = `${summary.slice(0, 297).trimEnd()}…`;

  return { title, summary, items, sourceCount: items.length };
}

/**
 * Уже отправленные посты: хэш текста → момент отправки.
 *
 * Аудит 2026-08-11: идемпотентности не было вообще. Один и тот же пост,
 * опубликованный дважды (повтор после потерянного ответа Telegram — сценарий,
 * ради которого мы как раз НЕ ретраим автоматически), давал на сайте две
 * одинаковые карточки. Память процессная и этого достаточно: дубль рождается в
 * пределах одной сессии публикации, а не через сутки.
 */
const sentAt = new Map<string, number>();
const DEDUP_TTL_MS = 6 * HOUR_MS;
const DEDUP_MAX = 500;

/**
 * Ключи, запрос по которым прямо сейчас в полёте.
 *
 * Аудит 2026-08-14: `sentAt` закрывает только повтор ПОСЛЕ доставки, а
 * помечаем мы доставленным по факту `res.ok` — то есть между проверкой
 * `alreadySent` и записью `rememberSent` лежит `await fetch`. Функция
 * fire-and-forget: её зовут без await из обработчика PUBLISH_POST, и два
 * одинаковых поста подряд (ретрай публикации, два агента с одним дайджестом)
 * успевают оба пройти проверку до того, как первый запишет результат. На сайте
 * — две одинаковые карточки и две записи в RSS, снять которые обратно нельзя.
 *
 * Резервируем ключ до запроса и освобождаем после. Свойство, ради которого
 * `rememberSent` стоит под `res.ok`, при этом сохраняется: при сетевом сбое
 * ключ уходит из `inFlight` и дайджест сможет уехать следующей попыткой.
 */
const inFlight = new Set<string>();

/** Устойчивый к мелким различиям ключ текста поста. */
function ingestKey(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function alreadySent(key: string, now: number): boolean {
  const at = sentAt.get(key);
  return at !== undefined && now - at < DEDUP_TTL_MS;
}

function rememberSent(key: string, now: number): void {
  sentAt.set(key, now);
  if (sentAt.size <= DEDUP_MAX) return;
  for (const [k, at] of sentAt) {
    if (now - at >= DEDUP_TTL_MS) sentAt.delete(k);
  }
  // Всё ещё много — выкидываем самые старые (Map хранит порядок вставки).
  for (const k of sentAt.keys()) {
    if (sentAt.size <= DEDUP_MAX) break;
    sentAt.delete(k);
  }
}

/** Тест-хук: забыть, что уже отправляли. */
export function _resetIngestDedup(): void {
  sentAt.clear();
  inFlight.clear();
}

/**
 * Best-effort push of a published digest post to the site DB. Fire-and-forget:
 * call WITHOUT await. Never throws; never blocks publication. No-op unless both
 * SITE_INGEST_URL and SITE_INGEST_TOKEN are set.
 *
 * `channelId` обязателен: см. siteIngestChannelId — мост открыт ровно одному
 * каналу, и без id мы не публикуем.
 */
export async function ingestDigestToSite(
  postText: string,
  channelId: number,
  /**
   * Только для тестов: во сколько мс обрывать запрос. По умолчанию
   * REQUEST_TIMEOUT_MS. Ветку таймаута иначе можно проверить, только честно
   * проспав пять секунд на каждый тест — в общем прогоне это заметно, а
   * проверяется здесь поведение, а не длительность (стиль `_sleep`/`_now` из
   * userbot-flood.ts).
   */
  opts: { _timeoutMs?: number } = {},
): Promise<void> {
  // Раньше всего остального: под тестами мост закрыт (см. ingestBlockedByTestRun).
  if (ingestBlockedByTestRun()) return;

  const url = process.env.SITE_INGEST_URL;
  const token = process.env.SITE_INGEST_TOKEN;
  // Bridge OFF by default.
  if (!url || !token) return;

  // Аудит 2026-08-12: канала в сигнатуре не было вовсе, а публиковать
  // PUBLISH_TO_CHANNEL разрешает в ЛЮБОЙ канал из реестра team_channels —
  // значит карточку на публичном сайте рождал и пост во внутренний рабочий
  // канал. Апрув владельца был про Telegram-канал, а не про delabs.space, и
  // снять страницу обратно нельзя: RSS уже разошёлся.
  const allowed = siteIngestChannelId();
  if (!Number.isFinite(channelId) || Number(channelId) !== allowed) {
    log.info("[site-ingest] пропуск: пост не в публичный канал", {
      channelId,
      allowed,
    });
    return;
  }

  try {
    const parsed = parseDigestPost(postText);
    if (!parsed.title || !parsed.summary) return; // nothing meaningful to send

    // Аудит 2026-08-11: мост висит на КАЖДОМ выходе PUBLISH_POST, то есть
    // карточку на сайте рождал любой пост в канале — анонс в одну строку, мем,
    // «тест 1». Дайджестом там и не пахнет: источников нет, summary
    // откатывается на title, и на сайте появляется карточка «заголовок =
    // описание, 0 источников». Ссылки из футера источниками не считаются — их
    // parseDigestPost и так отбрасывает. Нет источников — нет дайджеста.
    if (parsed.items.length === 0) return;

    const key = ingestKey(postText);
    const now = Date.now();
    if (alreadySent(key, now)) {
      log.info("[site-ingest] пропуск: этот пост уже уходил на сайт", {
        title: parsed.title,
      });
      return;
    }
    // Между этой проверкой и rememberSent лежит await — резервируем ключ здесь,
    // иначе дубль-в-полёте проходит дедуп целиком (см. комментарий к inFlight).
    if (inFlight.has(key)) {
      log.info("[site-ingest] пропуск: этот пост уже уходит на сайт", {
        title: parsed.title,
      });
      return;
    }
    inFlight.add(key);

    const controller = new AbortController();
    /**
     * Оборвали ли МЫ запрос по таймауту. Отличать это от «соединение не
     * состоялось» обязательно: см. ветку catch ниже.
     */
    let timedOut = false;
    const timeoutMs = opts._timeoutMs ?? REQUEST_TIMEOUT_MS;
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
          title: parsed.title,
          summary: parsed.summary,
          items: parsed.items,
          sourceCount: parsed.sourceCount,
        }),
        signal: controller.signal,
      });
      if (res.ok) {
        // Помечаем доставленным только по факту: иначе первый же сетевой сбой
        // навсегда закрыл бы этому дайджесту дорогу на сайт.
        rememberSent(key, now);
      } else {
        log.warn("[site-ingest] ingest non-ok response", {
          status: res.status,
        });
      }
    } catch (e) {
      // Аудит 2026-08-20: таймаут — это НЕ «не доставлено».
      //
      // AbortController обрывает запрос на нашей стороне на 5-й секунде.
      // Сервер к этому моменту мог принять POST и уже создать страницу: сайт
      // пишет её и отдаёт в RSS, ответ просто не успел вернуться. Пометка
      // `rememberSent` стоит под `res.ok`, а `inFlight.delete` — в `finally`,
      // так что после таймаута от запроса не остаётся ни следа, и следующая
      // публикация того же дайджеста уезжает заново. На сайте — ВТОРАЯ
      // публичная страница и вторая запись в RSS.
      //
      // Это ровно класс инцидента T-743: снять такую страницу обратно нельзя,
      // разгребали руками, восемь штук. Цена ошибок здесь несимметрична —
      // пропущенная карточка не видна никому и добавляется повторной
      // публикацией, лишняя публичная страница необратима. Поэтому по
      // таймауту закрываемся: считаем ключ отправленным.
      //
      // Только по таймауту. Отказ соединения, DNS, оборванный сокет до
      // отправки — запрос сервера не достиг, и прежнее поведение (ключ
      // свободен, дайджест уедет следующей попыткой) остаётся в силе.
      if (timedOut) {
        rememberSent(key, now);
        log.warn(
          "[site-ingest] таймаут ответа — считаем отправленным, повтор запрещён",
          { title: parsed.title, timeoutMs },
        );
      } else {
        throw e;
      }
    } finally {
      clearTimeout(timer);
      inFlight.delete(key);
    }
  } catch (e) {
    // Never propagate — publication must not be affected.
    log.warn("[site-ingest] ingest failed", { error: getErrorMessage(e) });
  }
}
