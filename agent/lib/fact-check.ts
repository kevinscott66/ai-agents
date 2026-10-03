/**
 * fact-check.ts — сверка написанного с первоисточниками ПЕРЕД публикацией.
 *
 * Зачем. С 23.09.2026 контент уходит в канал и на сайт без апрува владельца
 * (DELABS_AUTO_PUBLISH=1): черновик пишет `daily-draft`, публикует
 * `approve-poll` сразу же, ExecStartPost'ом. Единственное, что стояло между
 * выдумкой модели и читателем, — просьбы в промпте («ни одной цифры, которой
 * нет в источнике») и проверки длины в `checkEntry`. Про них там честно
 * написано: «выдумку модели этим не поймаешь».
 *
 * Ручной аудит 23.09.2026 показал, чего это стоит. Из 71 выпуска, написанного
 * ботом, примерно треть несла ошибки, которые проверки длины пропускают все до
 * одной:
 *   - выдуманная прямая речь: заявление Robinhood по делу об инсайде сочинено
 *     целиком, цитата Брокмана «Welcome to the AGI era» есть только в
 *     пересказах СМИ, у Армстронга «цитата» оказалась пересказом;
 *   - перевёрнутое направление: «Ledger дал денег Zcash» вместо «Zcash Labs
 *     заплатила Ledger $80 000»; «десятинедельная пауза Strategy» — компания
 *     эти десять недель продавала биткоин;
 *   - подменённая величина: $279 млрд у Nvidia — обязательства ПЕРЕД
 *     поставщиками, а не предзаказы клиентов; 26% у Anthropic — доля задач, а
 *     не доля кода;
 *   - приписанное источнику: «Standard Chartered выделяет Solana как
 *     инфраструктуру для стейблкоинов» — в релизе нет ни Solana, ни
 *     стейблкоинов;
 *   - не та ссылка: у CFTC подставлен мартовский пресс-релиз вместо
 *     сентябрьского, и утверждение в нём не подтверждается;
 *   - дата заметки вместо даты события (ФРС, CoinEx, Nvidia);
 *   - умолчание, которое стоит читателю денег: принудительный выкуп CET по
 *     0,005 USDT, порог ликвидации 82,5% у Hyperliquid, «ARC публично не
 *     торгуется» (любая «продажа ARC» — скам).
 *
 * Отсюда устройство модуля. Проверяет НЕ тот агент, который писал: у автора
 * контекст полон собственных формулировок, и он подтверждает себя. Проверяющий
 * получает только готовый текст и ссылки, ходит в сеть сам и отвечает списком
 * претензий. Автор потом переписывает по этому списку — один раз; если и после
 * этого утверждение не подтверждается, материал не публикуется вовсе.
 *
 * Молчание проверяющего само по себе ничего не значит: агент, не открывший ни
 * одного источника, тоже вернёт «проблем нет». Поэтому вердикт без единого
 * открытого источника считается несостоявшейся проверкой (см. `verdictFrom`).
 *
 * Здесь нет ничего специфичного для дайджеста или для активности: модуль
 * делят `tools/daily-draft.ts` (канал + сайт) и `tools/site-editorial.ts`
 * (редактура сайта).
 */
import { editorialResearch } from "./codex-editorial.ts";

export type Severity = "block" | "warn";

export interface FactProblem {
  /** Утверждение из текста — дословно, чтобы его можно было найти глазами. */
  claim: string;
  /** Что с ним не так и что говорит источник. */
  issue: string;
  severity: Severity;
  /** Где в материале: title | summary | body | items. */
  where?: string;
  /** Чем проверяли (url первоисточника). */
  source?: string;
}

export interface FactVerdict {
  problems: FactProblem[];
  /** Сколько источников проверяющий реально открыл. 0 — проверки не было. */
  opened: number;
  at: string;
}

/** Всё, что мы умеем проверять: текст плюс ссылки под ним. */
export interface Checkable {
  title: string;
  date?: string;
  summary?: string;
  /** Тело выпуска или интро активности — что из них есть. */
  body?: string;
  intro?: string;
  items?: { text: string; url: string }[];
}

/**
 * Бюджет ходов проверяющего.
 *
 * Считался от работы: 2-4 ссылки материала открыть, на спорное утверждение —
 * один поиск, и двенадцати ходов на это «должно хватать». Ручной прогон
 * 23.09.2026 показал, что не хватает: из четырёх статей дня две проверки
 * упёрлись в лимит и вернули не вердикт, а ошибку SDK. Считается это как
 * несостоявшаяся проверка, то есть блокирующая претензия, — и статья уходит на
 * переписывание из-за бюджета, а не из-за фактов. Хуже того, второй такой же
 * обрыв снял бы её совсем.
 *
 * Дело в том, что живая проверка — это не «открыть ссылку», а «открыть,
 * увидеть, что цифры в ней нет, и пойти искать, откуда она взялась»: у выпуска
 * с четырьмя источниками таких заходов набирается полтора десятка. 20 ходов
 * покрывают их с запасом и всё равно дешевле авторских 20-24 на написание.
 */
export const FACT_CHECK_MAX_TURNS = 20;

/**
 * Таймаут одной проверки ссылки на живость. Ссылок в материале 2-5, ходим по
 * ним последовательно и до выхода в SDK, так что общий вклад — секунды.
 */
export const LINK_TIMEOUT_MS = 12_000;

/** Браузерный UA: без него половина изданий отвечает 403 и роняет проверку в шум. */
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

export const FACT_CHECK_SYSTEM = [
  "Ты — фактчекер. Тебе дают уже написанный материал и список источников под ним.",
  "Твоя работа — не улучшать текст и не хвалить его, а найти в нём то, что не подтверждается первоисточником.",
  "Ты открываешь источники сам и опираешься только на то, что в них прочитал.",
  "Отсутствие подтверждения — это претензия, а не мелочь: «не нашёл» и «неправда» для публикации без редактора равны.",
  "Ты не выдумываешь претензии ради отчёта: нечего сказать — возвращай пустой список.",
].join(" ");

/**
 * Прямая речь в тексте. Выдёргиваем ёлочки и кавычки-лапки отдельно от модели:
 * цитату проверяющий обязан сверить дословно, а перечисленная в промпте она не
 * потеряется (три из четырёх выдуманных цитат аудита стояли именно в ёлочках).
 */
export function quotedFragments(text: string): string[] {
  const out: string[] = [];
  for (const m of String(text ?? "").matchAll(/[«"]([^«»"]{12,300})[»"]/g)) {
    const q = m[1].trim();
    // Не цитата, а разметка или кавычки названия: без пробелов это «ARC», а не
    // чьи-то слова.
    if (/\s/.test(q)) out.push(q);
  }
  return [...new Set(out)];
}

/**
 * Обороты «по данным X», «X заявил/сообщил/подтвердил». Каждый из них —
 * обещание читателю, что X это действительно сказал. Ровно так в аудите Solana
 * попала в пресс-релиз Standard Chartered, где её нет, и «по данным Reuters»
 * оказалось приписано агентству без основания.
 */
export function attributions(text: string): string[] {
  const s = String(text ?? "");
  const out: string[] = [];
  for (const m of s.matchAll(/по (?:данным|информации|словам)\s+[^,.;:()]{2,60}/gi)) out.push(m[0].trim());
  for (const m of s.matchAll(
    /[A-ZА-ЯЁ][\p{L}&.\- ]{2,40}?\s(?:заяви[лан]+|сообщи[лан]+|подтверди[лан]+|объявил[аи]?|пише[тм]|утвержда[ею]т)/gu,
  ))
    out.push(m[0].trim());
  return [...new Set(out)].slice(0, 12);
}

/** Весь текст материала одной строкой — то, что увидит читатель. */
export function fullText(c: Checkable): string {
  return [c.title, c.summary, c.body ?? c.intro].filter(Boolean).join("\n\n");
}

export interface LinkStatus {
  url: string;
  status: number;
  /** null — не ответил вовсе (DNS, таймаут, обрыв). */
  ok: boolean;
}

/**
 * Запись в X как первоисточник: ссылка на конкретный пост, а не на профиль.
 *
 * Имя автора из url ненадёжно (ретвит, смена ника), поэтому дальше ходим по
 * числовому id — он у записи один навсегда.
 */
export function tweetRef(url: string): { user: string; id: string } | null {
  const m = String(url ?? "").match(
    /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter|fxtwitter|vxtwitter|fixupx)\.com\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{5,25})/i,
  );
  return m ? { user: m[1], id: m[2] } : null;
}

/**
 * Читаемый текст записи в X.
 *
 * Зачем вообще. 25.09.2026 из дня пропала новость Hotstuff об остановке
 * perp-торговли — с дедлайном вывода средств, то есть ровно та, где молчание
 * стоит читателю денег. Первоисточником был единственный пост проекта в X;
 * x.com отдаёт фронтенду 402 Payment Required, фактчекер его не открыл и
 * честно написал «не подтверждено ни одним источником». Материал сняли не
 * потому, что он ложный, а потому, что до правды не дотянулись руки.
 *
 * При этом сам текст записи отдаётся без ключей и без авторизации — двумя
 * служебными маршрутами, которыми живут превью в мессенджерах:
 *   * `api.fxtwitter.com` — JSON с полным text, датой и автором;
 *   * `cdn.syndication.twimg.com/tweet-result` — тот же текст, запасной путь.
 * Оба возвращают ТУ ЖЕ запись по её id, поэтому это не «источник со слов
 * третьей стороны», а способ прочитать первоисточник. Не работают (проверено
 * 25.09.2026): x.com напрямую — 402, api.vxtwitter.com — 403, r.jina.ai — 451,
 * publish.twitter.com/oembed — 301.
 *
 * null — прочитать не вышло; тогда всё остаётся как было, и фактчекер решает
 * сам.
 */
export async function readTweet(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const ref = tweetRef(url);
  if (!ref) return null;
  const get = async (u: string): Promise<any | null> => {
    try {
      const res = await fetchImpl(u, {
        headers: { "user-agent": UA, accept: "application/json" },
        signal: AbortSignal.timeout(LINK_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  };

  const fx = await get(`https://api.fxtwitter.com/${ref.user}/status/${ref.id}`);
  const t = fx?.tweet;
  if (t?.text) return formatTweet(t.author?.screen_name ?? ref.user, t.created_at, t.text);

  const syn = await get(`https://cdn.syndication.twimg.com/tweet-result?id=${ref.id}&token=a`);
  if (syn?.text) return formatTweet(syn.user?.screen_name ?? ref.user, syn.created_at, syn.text);

  return null;
}

const formatTweet = (user: string, at: unknown, text: string): string =>
  `Запись @${user}${at ? ` от ${String(at)}` : ""}:\n${String(text).trim()}`;

/** Первоисточник, который редакция прочитала сама и кладёт фактчекеру на стол. */
export interface ReadSource {
  url: string;
  text: string;
}

/**
 * Прочитать те источники, до которых фактчекер своим WebFetch не дотянется.
 *
 * Пока это только записи в X: больше ни у одного первоисточника нет открытого
 * маршрута в обход блокировки фронтенда, а выдавать фактчекеру пересказ из
 * агрегатора вместо первоисточника нельзя — на этом и построен весь модуль.
 */
export async function readSources(
  items: { url: string }[] = [],
  fetchImpl: typeof fetch = fetch,
): Promise<ReadSource[]> {
  const out: ReadSource[] = [];
  for (const it of items) {
    const url = String(it?.url ?? "");
    if (!tweetRef(url)) continue;
    const text = await readTweet(url, fetchImpl);
    if (text) out.push({ url, text });
  }
  return out;
}

/**
 * Живость ссылок — до обращения к модели и без неё.
 *
 * В аудите нашлись 404 (coinreporter.io) и 403 (Forbes, Bloomberg): ссылка
 * стоит под утверждением, читатель по ней идёт и не попадает никуда. Это
 * проверяется точно и стоит один запрос, спрашивать об этом модель незачем.
 */
export async function checkLinks(
  items: { url: string }[] = [],
  fetchImpl: typeof fetch = fetch,
): Promise<LinkStatus[]> {
  const out: LinkStatus[] = [];
  for (const it of items) {
    const url = String(it?.url ?? "");
    if (!/^https?:\/\//.test(url)) continue;
    try {
      const res = await fetchImpl(url, {
        method: "GET",
        redirect: "follow",
        headers: { "user-agent": UA, accept: "text/html,*/*" },
        signal: AbortSignal.timeout(LINK_TIMEOUT_MS),
      });
      try {
        await res.body?.cancel();
      } catch {}
      out.push({ url, status: res.status, ok: res.status < 400 });
    } catch {
      out.push({ url, status: 0, ok: false });
    }
  }
  return out;
}

/**
 * Статусы ссылок → претензии.
 *
 * 404/410 — блокирующая: страницы нет, и утверждение под ней ничем не
 * прикрыто. 401/403/451 и обрывы — предупреждение: так отвечают и x.com, и
 * платные издания живым читателям через раз, и выбрасывать из-за этого выпуск
 * значит остаться без первоисточников вовсе. Решение по ним принимает автор
 * при переписывании.
 */
export function linkProblems(statuses: LinkStatus[], read: ReadSource[] = []): FactProblem[] {
  const out: FactProblem[] = [];
  const readable = new Set(read.map((r) => r.url));
  for (const s of statuses) {
    if (s.ok) continue;
    // Текст этой записи редакция прочитала служебным маршрутом и положила
    // фактчекеру в промпт. Утверждение под ссылкой прикрыто, и замечание
    // «читателю, скорее всего, не откроется» здесь только шум.
    if (readable.has(s.url)) continue;
    const dead = s.status === 404 || s.status === 410;
    out.push({
      claim: s.url,
      issue: dead
        ? `источник отвечает ${s.status} — страницы нет, замени ссылку на живой первоисточник`
        : s.status
          ? `источник отвечает ${s.status} — читателю он, скорее всего, тоже не откроется`
          : "источник не ответил вовсе (таймаут или неизвестный домен)",
      severity: dead ? "block" : "warn",
      where: "items",
      source: s.url,
    });
  }
  return out;
}

export function factCheckPrompt(c: Checkable, read: ReadSource[] = []): string {
  const text = fullText(c);
  const links = (c.items ?? []).map((it) => `- ${it.text}: ${it.url}`).join("\n") || "- (ссылок нет)";
  const quotes = quotedFragments(text);
  const attrs = attributions(text);
  return [
    "Проверь материал перед публикацией. Он уйдёт в канал и на сайт без редактора.",
    "",
    `Дата материала: ${String(c.date ?? "").slice(0, 10) || "не указана"}`,
    "Текст:",
    text,
    "",
    "Источники под текстом:",
    links,
    "",
    // Блок появился 25.09.2026: без него фактчекер писал «не подтверждается ни
    // одним источником» про запись в X, которую x.com просто не отдаёт
    // браузеру, и материал снимался как выдуманный.
    read.length
      ? [
          "Первоисточники, прочитанные редакцией дословно (страница в браузере может не открываться,",
          "текст получен служебным маршрутом той же платформы и равен содержимому записи):",
          ...read.map((r) => `--- ${r.url} ---\n${r.text}`),
          "",
          "Эти источники считай ОТКРЫТЫМИ и сверяй материал по ним. Перечисли их в sources_opened.",
          "Претензию «источник недоступен» или «утверждение не подтверждено» им не выноси —",
          "выноси её только тому, чего в приведённом тексте действительно нет.",
        ].join("\n")
      : "",
    "",
    quotes.length ? `Прямая речь в тексте (каждую сверь ДОСЛОВНО с первоисточником):\n${quotes.map((q) => `- «${q}»`).join("\n")}` : "",
    attrs.length ? `Ссылки на чужие слова (проверь, что это действительно сказано там, куда приписано):\n${attrs.map((a) => `- ${a}`).join("\n")}` : "",
    "",
    "Открой источники и сверь по каждому пункту:",
    "1. ЦИФРЫ. Величина верна и измеряет то, что сказано в тексте. Обязательства компании — не предзаказы клиентов,",
    "   доля задач — не доля кода, накопленный оборот — не объём под защитой, run rate — не выручка.",
    "2. НАПРАВЛЕНИЕ. Кто кому заплатил, кто что купил или продал, кто на кого подал в суд.",
    "   Перевёрнутое направление — самая частая ошибка и самая незаметная.",
    "3. ЦИТАТЫ. Прямая речь совпадает с первоисточником дословно и принадлежит тому, кому приписана.",
    "   Фраза, которая есть только в пересказах СМИ, цитатой не является.",
    "4. ДАТЫ. В тексте стоит дата СОБЫТИЯ, а не дата заметки о нём.",
    "5. ССЫЛКИ. Каждый источник действительно содержит то утверждение, рядом с которым стоит.",
    "   Пресс-релиз того же ведомства, но о другом — это не источник.",
    "6. АТРИБУЦИЯ. «По данным X» и «X заявил» — только если это есть у самого X.",
    "7. БЕЗ ИСТОЧНИКА. Утверждение, которого нет ни в одном открытом тобой источнике, — претензия,",
    "   даже если оно правдоподобно.",
    "8. РИСК ЧИТАТЕЛЯ. Если по материалу можно потерять деньги, а условие не названо — это претензия:",
    "   принудительный выкуп токена, порог ликвидации, дедлайн вывода, токен не торгуется публично,",
    "   реферальная ссылка или код в тексте, обещание награды, которого проект не давал.",
    "",
    "severity:",
    '- "block" — факт неверен, перевёрнут, не подтверждается ни одним источником, цитата не дословна,',
    "  ссылка не о том, или читателю не назван риск. Такой материал публиковать нельзя.",
    '- "warn" — уточнение, от которого текст не становится ложным.',
    "",
    `У тебя ${FACT_CHECK_MAX_TURNS} ходов. Сначала открой источники материала, поиск — только на спорное.`,
    "Следи за бюджетом: ответ должен уместиться в него. Осталось два хода — заканчивай и возвращай то,",
    "что уже нашёл; оборванная на середине проверка считается несостоявшейся, и материал не выйдет вовсе.",
    "В sources_opened перечисли url, которые ты реально открыл: пустой список означает, что проверки не было.",
    "",
    "Верни СТРОГО ОДИН JSON-объект и НИЧЕГО кроме него:",
    '{"problems":[{"claim":"...","issue":"...","severity":"block","where":"body","source":"https://..."}],"sources_opened":["https://..."]}',
  ]
    .filter((s) => s !== "")
    .join("\n");
}

/** Первый сбалансированный {...} из ответа модели. */
export function extractJson(raw: string): Record<string, unknown> {
  const start = String(raw ?? "").indexOf("{");
  if (start < 0) throw new Error("в ответе фактчекера нет JSON-объекта");
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
      if (depth === 0) return JSON.parse(raw.slice(start, i + 1));
    }
  }
  throw new Error("незакрытые скобки JSON");
}

/**
 * Разбор ответа проверяющего.
 *
 * Незнакомая severity трактуется как блокирующая намеренно: «critical»,
 * «high», «важно» — всё это модель пишет, когда претензия серьёзная, а
 * неизвестное слово в режиме публикации без человека должно останавливать, а
 * не пропускать.
 */
export function parseProblems(parsed: Record<string, unknown>): FactProblem[] {
  const raw = Array.isArray((parsed as any).problems) ? ((parsed as any).problems as any[]) : [];
  return raw
    .filter((p) => p && (p.claim || p.issue))
    .map((p) => {
      const s = String(p.severity ?? "").toLowerCase();
      const warn = s === "warn" || s === "warning" || s === "low" || s === "minor" || s === "note";
      return {
        claim: String(p.claim ?? "").trim(),
        issue: String(p.issue ?? "").trim(),
        severity: (warn ? "warn" : "block") as Severity,
        where: p.where ? String(p.where).trim() : undefined,
        source: typeof p.source === "string" && /^https?:\/\//.test(p.source) ? p.source : undefined,
      };
    });
}

export function openedUrls(parsed: Record<string, unknown>): string[] {
  const raw = (parsed as any).sources_opened;
  return Array.isArray(raw) ? raw.filter((u) => typeof u === "string" && /^https?:\/\//.test(u)) : [];
}

export function openedCount(parsed: Record<string, unknown>): number {
  return openedUrls(parsed).length;
}

/**
 * Собрать вердикт из ответа модели и статусов ссылок.
 *
 * Отдельная функция, потому что здесь живёт правило, ради которого всё
 * затевалось: «проблем нет» от агента, не открывшего ни одной страницы, — это
 * не «всё в порядке», а «проверка не состоялась», и публиковать по нему нельзя.
 * Материал без единой ссылки — тот же случай: проверять нечем.
 */
export function verdictFrom(
  parsed: Record<string, unknown>,
  links: LinkStatus[],
  c: Checkable,
  read: ReadSource[] = [],
): FactVerdict {
  const problems = [...parseProblems(parsed), ...linkProblems(links, read)];
  // Источник, текст которого лежал в промпте, прочитан независимо от того,
  // вспомнил ли фактчекер перечислить его в sources_opened.
  const opened = new Set([...openedUrls(parsed), ...read.map((r) => r.url)]).size;
  if (!(c.items ?? []).length) {
    problems.unshift({
      claim: c.title,
      issue: "под материалом нет ни одного источника — проверить его нечем",
      severity: "block",
      where: "items",
    });
  } else if (!opened) {
    problems.unshift({
      claim: c.title,
      issue: "фактчекер не открыл ни одного источника — проверки не было, публиковать вслепую нельзя",
      severity: "block",
      where: "items",
    });
  }
  return { problems, opened, at: new Date().toISOString() };
}

export const blocking = (p: FactProblem[]): FactProblem[] => p.filter((x) => x.severity === "block");
export const passed = (v: FactVerdict): boolean => !blocking(v.problems).length;

/** Строка для журнала юнита и для превью владельцу. */
export function verdictLine(v: FactVerdict): string {
  const b = blocking(v.problems).length;
  const w = v.problems.length - b;
  if (!v.problems.length) return `сверено по ${v.opened} источник(ам), претензий нет`;
  return `сверено по ${v.opened} источник(ам): блокирующих ${b}, замечаний ${w}`;
}

/** Приписка автору: что именно переписать. Уходит в промпт второй попытки. */
export function fixNote(problems: FactProblem[]): string {
  if (!problems.length) return "";
  return [
    "",
    "Проверка фактов вернула претензии — исправь ИМЕННО ИХ:",
    ...problems.map(
      (p) =>
        `- ${p.severity === "block" ? "[блок] " : ""}«${p.claim}» — ${p.issue}` +
        (p.source ? ` (источник: ${p.source})` : ""),
    ),
    "Утверждение, которое не подтвердилось, — убери из текста целиком, а не смягчай формулировку.",
    "Если после удаления не подтверждённого от новости ничего не остаётся — так и скажи, материал не выйдет.",
  ].join("\n");
}

/** Один заход проверяющего в SDK. Отдельная функция — чтобы тесты её подменяли. */
export async function askFactChecker(prompt: string): Promise<string> {
  return editorialResearch(FACT_CHECK_SYSTEM,prompt);
}

export interface FactCheckDeps {
  ask?: (prompt: string) => Promise<string>;
  fetchImpl?: typeof fetch;
}

/**
 * Проверить материал. Не бросает: сорвавшаяся проверка — это блокирующая
 * претензия, а не повод пропустить материал мимо неё. В режиме публикации без
 * апрува «фактчекер упал» и «фактчекер промолчал» обязаны значить одно и то же.
 */
export async function factCheck(c: Checkable, deps: FactCheckDeps = {}): Promise<FactVerdict> {
  const ask = deps.ask ?? askFactChecker;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const links = await checkLinks(c.items ?? [], fetchImpl);
  const read = await readSources(c.items ?? [], fetchImpl);
  try {
    const parsed = extractJson(await ask(factCheckPrompt(c, read)));
    return verdictFrom(parsed, links, c, read);
  } catch (err) {
    return {
      problems: [
        {
          claim: c.title,
          issue: `проверка фактов не состоялась: ${(err as Error).message}`,
          severity: "block",
        },
        ...linkProblems(links, read),
      ],
      opened: 0,
      at: new Date().toISOString(),
    };
  }
}
