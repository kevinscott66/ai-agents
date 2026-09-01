// unlocks.ts — real token-unlock data from DefiLlama (free, no key).
//
// Source: https://defillama-datasets.llama.fi/emissionsIndex
// (the documented api.llama.fi/emissions is now behind the paid plan, so we use
//  the public datasets host that powers https://defillama.com/unlocks).
//
// Response shape (defensively parsed — any missing field => skip):
//   { data: Array<{
//       name: string,                 // project name, e.g. "Aave"
//       token: string,                // e.g. "coingecko:aave"
//       gecko_id?: string,            // e.g. "aave"
//       maxSupply?: number,
//       circSupply?: number,
//       tokenPrice?: number | { ... },// current price in USD (shape varies)
//       mcap?: number,                // circulating market cap USD
//       events: Array<{
//         timestamp: number,          // unix SECONDS
//         noOfTokens: number[],       // tokens unlocked in this event
//         category?: string,
//         unlockType?: string,
//       }>
//     }> }
//
// We keep, per project, the single nearest FUTURE unlock event.

import {
  countUnlocks,
  countUpcomingUnlocks,
  getMeta,
  replaceUpcomingUnlocks,
  setMeta,
} from "./db.ts";
import type { Unlock } from "./types.ts";

export const EMISSIONS_URL =
  "https://defillama-datasets.llama.fi/emissionsIndex";

const CACHE_KEY = "unlocks_fetched_at";
/**
 * Сколько снимок фида считается свежим.
 *
 * Экспортируется, потому что этот срок — часть договора с расписанием в
 * index.ts: период тика обязан быть меньше TTL, иначе обновление не попадает в
 * окно свежести ни разу. Пока значение было приватной константой, проверить
 * это соотношение было нечем.
 */
export const UNLOCKS_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const TTL_MS = UNLOCKS_TTL_MS;
/**
 * Потолок тела ответа апстрима (anti-OOM).
 *
 * Аудит 2026-08-28: стоял на 25 МБ — ровно наблюдаемый размер фида
 * (index.ts: «Фид — 25 МБ JSON»). Запаса ноль: один байт роста апстрима, и
 * каждая из четырёх попыток fetchEmissions качает 25 МБ и бросает на последних
 * байтах. ~2.4 ГБ трафика в сутки при часовом цикле и календарь, замерший
 * навсегда, — а снаружи только console.warn. Кратный запас: фид растёт вместе
 * с числом проектов, то есть на проценты в месяц, а не в разы.
 */
export const MAX_BODY_BYTES = 64 * 1024 * 1024;

/**
 * Порог «мы приближаемся к потолку».
 *
 * Без него отказ наступает молча-постепенно: сегодня тело проходит, завтра нет,
 * и ничто заранее не говорит, что запас кончается. Предупреждение даёт время
 * поднять потолок до того, как он станет отказом.
 */
export const BODY_WARN_BYTES = Math.round(MAX_BODY_BYTES * 0.75);

/**
 * Доля от текущего календаря, ниже которой снимок считается деградировавшим.
 *
 * Аудит 2026-08-28: разбор, вернувший хоть одну строку, проходил дальше, а
 * `replaceUpcomingUnlocks` сносит ВСЕ будущие строки. Усечённый ответ апстрима
 * или переименованное поле, которое режет проекты на проверке `maxSupply`, —
 * и публичный календарь схлопывается с четырёхсот строк до трёх. Настоящий фид
 * так не сжимается: он отдаёт по одному ближайшему событию на проект, и число
 * проектов между сутками меняется на проценты, а не в разы.
 */
export const MIN_SNAPSHOT_RATIO = 0.5;

/**
 * Сколько охрана выше вправе держать старый календарь.
 *
 * Без срока она превращается в собственную поломку: если фид сжался
 * по-настоящему, календарь замёрз бы навсегда. Данные старше этого срока хуже
 * маленького, но свежего снимка, поэтому после него снимок принимается любым.
 */
export const COLLAPSE_OVERRIDE_MS = 3 * UNLOCKS_TTL_MS;

type RawEvent = {
  timestamp?: unknown;
  noOfTokens?: unknown;
  category?: unknown;
  unlockType?: unknown;
};

type RawProject = {
  name?: unknown;
  token?: unknown;
  gecko_id?: unknown;
  symbol?: unknown;
  maxSupply?: unknown;
  circSupply?: unknown;
  tokenPrice?: unknown;
  mcap?: unknown;
  events?: unknown;
};

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** True for hex contract addresses like "0xabc123…" — never a real ticker. */
function looksLikeHexAddress(s: string): boolean {
  return /^0x[0-9a-f]+$/i.test(s) || /^0X[0-9A-F]{6,}$/.test(s);
}

/**
 * Build a ticker from a human name: initials for multi-word, else the word.
 *
 * Аудит 2026-08-29: и `w[0]`, и `slice(0, 10)` считали единицы UTF-16. Имя,
 * начинающееся с не-BMP символа (эмодзи в названии проекта фид приносит
 * регулярно), давало в инициалах одинокий суррогат — а он не кодируется в
 * UTF-8 и доезжает до читателя как U+FFFD. Считаем кодовые точки: `Array.from`
 * режет строку по ним, поэтому и первый символ, и потолок в десять берутся
 * целыми.
 */
function symbolFromName(name: string): string {
  const base = name.replace(/[_]/g, " ").trim();
  if (!base) return "?";
  const words = base.split(/\s+/);
  const sym =
    words.length === 1
      ? words[0].replace(/[-.]/g, "")
      : words.map((w) => Array.from(w)[0] ?? "").join("");
  return (Array.from(sym || "?").slice(0, 10).join("")).toUpperCase();
}

/** Clean a raw candidate into a ticker; "" if it's hex/garbage. */
function cleanTicker(raw: string): string {
  const c = raw.trim();
  if (!c || looksLikeHexAddress(c)) return "";
  const sym = c.replace(/[-_\s.]/g, "");
  if (!sym || looksLikeHexAddress(sym)) return "";
  const out = sym.slice(0, 10).toUpperCase();
  // Аудит 2026-08-28: обе проверки выше требуют, чтобы hex была ВСЯ строка, а
  // обрезка идёт после них — и восстанавливает чистый префикс адреса из
  // кандидата с не-hex хвостом ("0xabc1234567890def_v2" -> "0XABC12345").
  // Путь через symbolFromName проверяет уже обрезанное; здесь делаем так же.
  return looksLikeHexAddress(out) ? "" : out;
}

/**
 * Derive a ticker symbol. Tries explicit symbol, gecko_id, the part after ":"
 * in token (e.g. "coingecko:based-one" → BASEDONE), and ALWAYS falls back to a
 * name-derived ticker. Guarantees the result is NEVER a hex contract address
 * (those leak into the feed for many tokens and must not be shown as tickers).
 */
function deriveSymbol(p: RawProject): string {
  const candidates: string[] = [];
  if (typeof p.symbol === "string") candidates.push(p.symbol);
  if (typeof p.gecko_id === "string") candidates.push(p.gecko_id);
  if (typeof p.token === "string" && p.token.includes(":")) {
    candidates.push(p.token.split(":")[1] ?? "");
  }
  for (const raw of candidates) {
    const t = cleanTicker(raw);
    if (t) return t;
  }
  // Last resort: build a ticker from the human project name.
  if (typeof p.name === "string" && p.name.trim()) {
    const s = symbolFromName(p.name);
    if (s && !looksLikeHexAddress(s)) return s;
  }
  return "?";
}

/**
 * Границы правдоподобной цены токена в долларах.
 *
 * Снизу — мем-монеты с триллионным предложением (десятые доли пикодоллара),
 * сверху — с запасом выше биткойна. Всё за пределами — не цена: это поле,
 * которое мы приняли за цену по ошибке.
 */
const MIN_UNIT_PRICE = 1e-12;
const MAX_UNIT_PRICE = 1e7;

/**
 * Ключи, под которыми в объекте `tokenPrice` лежит именно цена.
 *
 * Набор расширен и приведён к нормализованной форме при разборе дубля #580
 * (2026-08-21). Список из пяти строк сравнивался ПО РЕГИСТРУ, и замер показал,
 * что это не «промах мимо цены», а неверное число: на `{decimals: 18,
 * priceusd: 0.42}` имя не совпадало, срабатывал позиционный перебор и в выдачу
 * уходило 18 — ровно те 43×, против которых написан весь этот файл. Так же
 * ломались `PriceUSD`, `usdPrice`, `currentPrice` и `current-price`.
 */
const PRICE_KEYS = new Set([
  "price",
  "usd",
  "priceusd",
  "usdprice",
  "currentprice",
  "current_price",
  "value",
]);

/** Регистр, пробелы и дефисы в имени ключа фида ничего не значат. */
function normalizePriceKey(k: string): string {
  return k.toLowerCase().replace(/[\s-]/g, "");
}

function plausiblePrice(n: number | null): number | null {
  if (n === null || !Number.isFinite(n)) return null;
  if (n < MIN_UNIT_PRICE || n > MAX_UNIT_PRICE) return null;
  return n;
}

/**
 * Достаёт цену в долларах из того вида, в котором пришли tokenPrice/mcap.
 *
 * Аудит 2026-08-20: объектная ветка брала ПЕРВОЕ положительное число из
 * `Object.values(tokenPrice)`, то есть цену определял порядок ключей в JSON.
 * Проверено на `{decimals: 18, symbol: "AAVE", price: 0.42, …}` с
 * `noOfTokens: [160000]`: в выдачу уходило `amountUsd: 2 880 000` вместо
 * `67 200` — сумма завышена в 43 раза и печаталась на главной как факт. С
 * `timestamp` первым получалось ~2.8e14.
 *
 * Теперь цена читается ПО ИМЕНИ ключа, без оглядки на регистр. Позиционный
 * перебор остался запасным путём — форма поля в фиде официально «varies», и
 * молча терять цену хуже, чем перебрать, — но только для объекта из ОДНОГО
 * поля. Проверка на правдоподобность тут не спасает и никогда не спасала:
 * 18 (decimals) её проходит, это и есть те самые 43×; отсекаются лишь
 * 1.7e9 (timestamp) и 1e18 (mcap 1e9 / circSupply 1e-6).
 */
function deriveUnitPrice(p: RawProject): number | null {
  // Preferred: explicit tokenPrice (sometimes a number, sometimes an object).
  const tp = p.tokenPrice;
  if (typeof tp === "number") {
    const direct = plausiblePrice(tp);
    if (direct !== null) return direct;
  }
  if (tp && typeof tp === "object") {
    const obj = tp as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj)) {
      if (!PRICE_KEYS.has(normalizePriceKey(k))) continue;
      const byName = plausiblePrice(num(v));
      if (byName !== null) return byName;
    }
    // Позиционный путь сузился до объекта из ОДНОГО поля: там угадывать нечего,
    // единственное значение и есть цена. У объекта с несколькими незнакомыми
    // полями первое число — это лотерея, и `{decimals: 18, symbol: "ACME"}`
    // выигрывал её восемнадцатью долларами.
    const keys = Object.keys(obj);
    if (keys.length === 1) {
      const only = plausiblePrice(num(obj[keys[0]!]));
      if (only !== null) return only;
    }
  }
  // Fallback: mcap / circSupply.
  const mcap = num(p.mcap);
  const circ = num(p.circSupply);
  if (mcap && circ && circ > 0) return plausiblePrice(mcap / circ);
  return null;
}

/**
 * Pure parser. Takes the raw emissions JSON and returns one Unlock per project
 * (the nearest future event). `nowMs` is injectable for deterministic tests.
 */
export function parseEmissions(
  raw: unknown,
  nowMs: number = Date.now(),
): Unlock[] {
  const data =
    raw && typeof raw === "object" && Array.isArray((raw as any).data)
      ? ((raw as any).data as RawProject[])
      : Array.isArray(raw)
        ? (raw as RawProject[])
        : [];

  const nowSec = nowMs / 1000;
  // Верхняя граница правдоподобной отметки: двадцать лет вперёд. Отсекает и
  // микро-, и миллисекундные значения, пролезающие в фид под видом секунд.
  //
  // Аудит 2026-08-28: рядом жила и нижняя (`nowSec - 365 * 24 * 3600`), но
  // сработать она не могла ни разу: отбор ниже берёт только строго будущие
  // события (`ts <= nowSec` — continue), а год назад меньше, чем сейчас. Ниже
  // по времени отсекает именно та проверка; держать вторую границу, которая
  // читается как защита, но ничего не защищает, — хуже, чем не держать.
  const MAX_EVENT_TS = nowSec + 20 * 365 * 24 * 3600;
  const out: Unlock[] = [];

  for (const p of data) {
    if (!p || typeof p !== "object") continue;
    const project = typeof p.name === "string" ? p.name.trim() : "";
    if (!project) continue;

    const events = Array.isArray(p.events) ? (p.events as RawEvent[]) : [];
    const maxSupply = num(p.maxSupply);
    const unitPrice = deriveUnitPrice(p);

    // Find nearest strictly-future event with a positive token amount.
    let best: { ts: number; tokens: number } | null = null;
    for (const e of events) {
      if (!e || typeof e !== "object") continue;
      const ts = num(e.timestamp);
      if (ts === null || ts <= nowSec) continue;
      // Аудит 2026-08-20: единственная строка с мусорным временем убивала весь
      // прогон. `new Date(ts * 1000).toISOString()` ниже бросает RangeError при
      // ts*1000 > 8.64e15 (микросекундная отметка, например 1.786e15), а
      // per-project try/catch тут нет — исключение вылетало из parseEmissions в
      // catch у refreshUnlocks, тот писал «refresh failed» и возвращал 0.
      // Хорошие проекты выбрасывались вместе с плохим, маркер кэша не
      // сдвигался, и часовой цикл повторял ту же ошибку вечно — ровно та тихая
      // 50-дневная протухшесть, о которой комментарии в этом файле и написаны.
      // Миллисекундная отметка (1.786e12) не бросала вовсе: получалась дата
      // «+058566-…», а всё сравнение дат в SQL лексикографическое и "+" < "2",
      // так что строка становилась невидимой для listUpcomingUnlocks и
      // неудаляемой для `DELETE … WHERE date >= ?` — вечный призрак в счётчике.
      if (ts > MAX_EVENT_TS) continue;
      const arr = Array.isArray(e.noOfTokens) ? e.noOfTokens : [];
      let tokens = 0;
      for (const t of arr) {
        const n = num(t);
        if (n) tokens += n;
      }
      if (tokens <= 0) continue;
      if (!best || ts < best.ts) best = { ts, tokens };
      // Аудит 2026-08-20: совпадение по времени — не дубль. Разблокировка одной
      // даты нормально приходит несколькими событиями по категориям (team,
      // insiders, investors). Строгое `<` оставляло только первое, и заголовок
      // «% предложения» занижался во столько раз, сколько категорий отрезали.
      else if (ts === best.ts) best.tokens += tokens;
    }
    if (!best) continue;

    // % of supply needs a max supply to be meaningful.
    if (!maxSupply || maxSupply <= 0) continue;
    const pctOfSupply = (best.tokens / maxSupply) * 100;
    if (!Number.isFinite(pctOfSupply) || pctOfSupply <= 0) continue;

    const amountUsd =
      unitPrice && unitPrice > 0
        ? Math.round(best.tokens * unitPrice)
        : null;

    out.push({
      project,
      symbol: deriveSymbol(p),
      date: new Date(best.ts * 1000).toISOString(),
      // Аудит 2026-08-20: округление до сотых обнуляло мелкие разблокировки —
      // 1000 токенов из миллиарда давали строку «0% предложения» рядом с живой
      // суммой в долларах. Отсечка `pctOfSupply <= 0` выше стоит ДО округления,
      // поэтому строка доходила до сайта. Четыре знака: 0.0001% ≈ то, что ещё
      // осмысленно показать.
      pctOfSupply: Math.round(pctOfSupply * 10000) / 10000,
      amountUsd,
    });
  }

  // Soonest first.
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

async function fetchOnce(timeoutMs: number): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(EMISSIONS_URL, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "web3-puls/1.0 (+https://agents.example.com)",
        Accept: "application/json",
        // The datasets host streams large gzip; request compression explicitly.
        "Accept-Encoding": "gzip, deflate, br",
      },
    });
    if (!res.ok) throw new Error(`emissions HTTP ${res.status}`);
    // Anti-OOM: reject obviously-oversized bodies up front, then stream with a
    // running byte cap (Content-Length may be absent on chunked responses).
    // Заголовок несёт СЖАТЫЙ размер (fetch распаковывает тело прозрачно), а
    // потолок меряет распакованные байты. Проверка односторонняя: сработать
    // может не всегда, ложно отвергнуть — не может. Настоящий предел ставит
    // readCapped ниже.
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      throw new Error(`emissions body too large: ${declared} bytes`);
    }
    return JSON.parse(await readCapped(res, MAX_BODY_BYTES));
  } finally {
    clearTimeout(t);
  }
}

/** Read a response body as text, aborting if it exceeds `maxBytes`. */
export async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const body = res.body;
  if (!body) return await res.text();
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let out = "";
  const warnAt = Math.round(maxBytes * 0.75);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`emissions body exceeded ${maxBytes} bytes`);
      }
      out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
    if (total > warnAt) {
      console.warn(
        `[unlocks] тело фида ${total} байт — выше порога ${warnAt} при потолке ${maxBytes}; ` +
          `пора поднимать MAX_BODY_BYTES, пока это предупреждение, а не отказ`,
      );
    }
    return out;
  } finally {
    reader.cancel().catch(() => {});
  }
}

/**
 * Fetch raw emissions JSON with a few retries — the public datasets host
 * (defillama-datasets.llama.fi) sometimes resets the connection mid-stream.
 * Throws if all attempts fail.
 */
async function fetchEmissions(): Promise<unknown> {
  const attempts = 4;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchOnce(45_000);
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Экспортирована ради теста: сетевой путь refreshUnlocks в тестах не трогаем. */
export function cacheFresh(): boolean {
  const at = getMeta(CACHE_KEY);
  if (!at) return false;
  const ms = Number(at);
  if (!Number.isFinite(ms)) return false;
  // Аудит 2026-08-20: без нижней границы маркер из БУДУЩЕГО тоже «свежий».
  // Скакнули часы на VPS (плохой NTP, ручная установка) — метка, записанная в
  // тот момент, держит кэш свежим, пока настоящее время её не догонит, то есть
  // календарь замирает на дни, а часовой цикл выходит нулём сразу.
  const age = Date.now() - ms;
  return age >= 0 && age < TTL_MS;
}

/**
 * Похож ли новый снимок на живой фид, а не на деградировавший разбор.
 *
 * Сравниваем ровно с тем, что `replaceUpcomingUnlocks` собирается удалить, —
 * с будущими строками. Пустой календарь принимает что угодно: терять нечего.
 */
function snapshotIsPlausible(incoming: number): boolean {
  const existing = countUpcomingUnlocks();
  if (existing === 0 || incoming >= existing * MIN_SNAPSHOT_RATIO) return true;

  const at = Number(getMeta(CACHE_KEY));
  const age = Number.isFinite(at) ? Date.now() - at : Infinity;
  if (age >= COLLAPSE_OVERRIDE_MS) {
    console.warn(
      `[unlocks] snapshot still small (${incoming} of ${existing}) but stored calendar ` +
        `is older than ${COLLAPSE_OVERRIDE_MS}ms — accepting it`,
    );
    return true;
  }
  console.warn(
    `[unlocks] snapshot collapsed: ${incoming} events vs ${existing} upcoming rows ` +
      `— keeping existing rows, will retry next tick`,
  );
  return false;
}

/**
 * Refresh the unlocks cache from DefiLlama if stale (or forced).
 * Never throws — logs and leaves existing rows intact on failure.
 * Returns the number of rows written (0 if skipped/failed/rejected).
 *
 * «Failure» здесь — это и деградировавший разбор, а не только сеть: снимок,
 * схлопнувшийся относительно текущего календаря, отвергается (см.
 * `snapshotIsPlausible`). `force` эту проверку обходит.
 */
export async function refreshUnlocks(force = false): Promise<number> {
  if (!force && cacheFresh() && countUnlocks() > 0) return 0;
  try {
    const raw = await fetchEmissions();
    const parsed = parseEmissions(raw);
    if (parsed.length === 0) {
      console.warn("[unlocks] parser returned 0 events; keeping existing rows");
      return 0;
    }
    if (!force && !snapshotIsPlausible(parsed.length)) {
      // Маркер свежести НЕ выставляем: иначе cacheFresh() сутки отвечал бы
      // «свежо» и часовой цикл не пытался бы починить — ровно то, что делало
      // схлопывание необратимым до следующего окна.
      return 0;
    }
    // Снимок целиком заменяет предыдущий: перенесённые и отменённые события
    // иначе оставались бы в календаре навсегда (db.ts, replaceUpcomingUnlocks).
    replaceUpcomingUnlocks(parsed);
    setMeta(CACHE_KEY, String(Date.now()));
    console.log(`[unlocks] refreshed ${parsed.length} upcoming unlocks`);
    return parsed.length;
  } catch (err) {
    console.warn(
      `[unlocks] refresh failed (network/parse): ${
        err instanceof Error ? err.message : String(err)
      } — keeping existing rows`,
    );
    return 0;
  }
}

/** Called once on startup: fetch only if table is empty or cache is stale. */
export async function ensureUnlocks(): Promise<void> {
  if (countUnlocks() === 0) {
    await refreshUnlocks(true);
  } else if (!cacheFresh()) {
    await refreshUnlocks(false);
  }
}

/**
 * Когда фид приезжал в последний раз, или null — если не приезжал никогда.
 *
 * Аудит 2026-08-12: при отсутствии отметки возвращалось `new Date()`, то есть
 * «обновлено прямо сейчас» ровно в том случае, когда обновления не было ни
 * одного. На главной это выглядело как «отслеживаем 0 разблокировок ·
 * обновлено 12 августа 2026 г.» — свежесть, выданная за пустые данные.
 * Отсутствие даты — это отсутствие даты; фронт просто не пишет строку.
 *
 * Аудит 2026-08-28: границ было мало. Метку из БУДУЩЕГО `cacheFresh()` явно
 * отвергает с 2026-08-20 (скачок часов на VPS), а здесь она публиковалась —
 * «обновлено 3 января 2027 г.» в /api/stats и /api/unlocks. Две функции над
 * одним значением расходились в том, что считают правдоподобным.
 *
 * И `Number.isFinite` — не тот фильтр: `1e300` конечен, но
 * `new Date(1e300).toISOString()` бросает RangeError (диапазон Date ±8.64e15),
 * а бросок отсюда — это 500 сразу на обоих эндпоинтах.
 */
const MAX_DATE_MS = 8.64e15;

export function lastUnlocksRefreshIso(): string | null {
  const at = getMeta(CACHE_KEY);
  const ms = at ? Number(at) : NaN;
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_DATE_MS) return null;
  // Та же нижняя граница, что и у cacheFresh: возраст не бывает отрицательным.
  if (Date.now() - ms < 0) return null;
  return new Date(ms).toISOString();
}
