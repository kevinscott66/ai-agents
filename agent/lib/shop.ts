/**
 * Покупки в Яндекс Лавке, Яндекс Еде и Яндекс Маркете через браузер на Mac
 * владельца — шаги 10a, 10b и 10c плана.
 *
 * Модуль без побочек: его импортируют и сервер (разбор ввода модели, карточка,
 * разбор ответа Mac), и демон (строгий повторный разбор кадра, разбор цены со
 * страницы). Один источник на сервисы, коды отказов и форму ответов.
 *
 * Деньги уходят только так: SHOP_QUOTE → ORDER_FOOD или MARKET_PURCHASE (карточка в чате) →
 * подпись на телефоне (lib/signed-actions.ts) → claim → prepare на Mac
 * (корзина собирается из подписанных позиций) → checkFinal по итогу со
 * страницы → confirm на Mac (одно нажатие «Оплатить») → complete. Капчу агент
 * не решает, в Яндекс не входит, адрес и карту не вводит.
 *
 * Блюда Еды с выбором (размер, тесто, соус, состав): расчёт читает группы опций
 * из карточки блюда, модель называет выбор владельца, сервер сверяет его с
 * расчётом (обязательные группы, лимиты, доплаты) и подписывает вместе с
 * позицией; исполнитель отмечает ровно эти опции и сверяет корзину по ним.
 */

import { createHash } from "node:crypto";

export const SHOP_SERVICES = {
  lavka: "Яндекс Лавка",
  eda: "Яндекс Еда",
  market: "Яндекс Маркет",
} as const;
export type ShopService = keyof typeof SHOP_SERVICES;
export const SHOP_SERVICE_KEYS = Object.keys(SHOP_SERVICES) as ShopService[];
/** Имя сервиса в подписанном payload (то, что видит телефон). */
export const SHOP_GATE_SERVICE: Record<ShopService, string> = { lavka: "yandex_lavka", eda: "yandex_eda", market: "yandex_market" };
/** В Еде заказ — из одного ресторана: его надо найти до блюд. */
export const shopNeedsPlace = (service: ShopService) => service === "eda";
export const SHOP_GATE_ACTION = "order_food";
export const MARKET_GATE_ACTION = "market_purchase";
/** Действие в подписанном payload: еда и продукты — order_food, Маркет — market_purchase. */
export const shopGateAction = (service: ShopService) => (service === "market" ? MARKET_GATE_ACTION : SHOP_GATE_ACTION);
/** Тип заявки в чате: Маркет — MARKET_PURCHASE, Лавка и Еда — ORDER_FOOD. */
export const shopOrderType = (service: ShopService) => (service === "market" ? "MARKET_PURCHASE" : "ORDER_FOOD");
/**
 * Маркет показывает доставку только на оформлении. В MARKET_PURCHASE
 * delivery_rub — сколько владелец готов заплатить за доставку; итог со
 * страницы всё равно сверяется с подписанным потолком.
 */
export const MARKET_DELIVERY_MAX = 1_000;

export const SHOP_QUERY_MAX = 80;
export const SHOP_ITEMS_MAX = 10;
export const SHOP_QTY_MAX = 20;
export const SHOP_CANDIDATES_MAX = 3;
export const SHOP_NAME_MAX = 120;
export const SHOP_ADDRESS_MAX = 200;
/** prepare собирает до десяти позиций: сессии нужен запас до confirm. */
export const SHOP_SESSION_TTL_MS = 5 * 60_000;
/** Сколько живёт расчёт, по которому можно заказать. */
export const SHOP_QUOTE_TTL_MS = 15 * 60_000;
/** Сколько ресторанов отдаёт SHOP_PLACES. */
export const SHOP_PLACES_MAX = 10;
/** Предел времени доставки, который может задать владелец, минут. */
export const SHOP_MAX_ETA_MIN = 10;
export const SHOP_MAX_ETA_MAX = 180;
/** Потолок обещания на карточке ресторана: больше — ошибка разбора, а не доставка. */
export const SHOP_PLACE_ETA_MAX = 240;
/** Скриншот в кадре моста: base64 должен уместиться в хвост потока (64 КБ). */
export const SHOP_SCREENSHOT_B64_MAX = 56_000;

const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const SESSION = /^[A-Za-z0-9_-]{16,64}$/;
/** Идентификатор товара — slug из ссылки `/good/<slug>`. */
export const SHOP_PRODUCT_ID = /^[a-z0-9][a-z0-9-]{0,159}$/;
/** Ресторан Еды: `<бренд>:<placeSlug>` из ссылки `/r/<бренд>?placeSlug=<placeSlug>`. */
export const SHOP_PLACE_REF = /^[a-z0-9][a-z0-9_-]{0,79}:[a-z0-9][a-z0-9_-]{0,79}$/;
/** Товар Маркета: номер карточки из ссылки `/card/<slug>/<номер>`. Подмножество SHOP_PRODUCT_ID. */
export const MARKET_PRODUCT_ID = /^[1-9]\d{0,19}$/;

/**
 * У блюд Еды нет своих страниц: блюдо — это название в меню ресторана. id
 * выводится из ресторана и названия, так что другое блюдо или другой ресторан
 * дают другой id, а сверка на Mac идёт по названию.
 */
export function edaDishId(placeRef: string, name: string): string {
  return `d${createHash("sha256").update(`${placeRef}\n${name}`).digest("hex").slice(0, 24)}`;
}

/**
 * Вариант блюда в корзине: блюдо и отмеченные опции. Корзина Еды показывает у
 * позиции только названия опций (без групп и в своём порядке), поэтому ключ —
 * отсортированные названия. Без опций — id самого блюда.
 */
export function edaVariantId(placeRef: string, name: string, choices: ReadonlyArray<string>): string {
  if (!choices.length) return edaDishId(placeRef, name);
  return edaDishId(placeRef, `${name}\n${[...choices].sort().join("\n")}`);
}

export const SHOP_OPTION_NAME_MAX = 60;
export const SHOP_OPTION_GROUPS_MAX = 12;
export const SHOP_OPTION_CHOICES_MAX = 40;
/** Сколько опций можно отметить у одной позиции. */
export const SHOP_OPTION_PICKS_MAX = 12;
/** Всего вариантов опций в одном расчёте: ответ Mac должен уместиться в хвост потока. */
export const SHOP_QUOTE_CHOICES_MAX = 240;
/** Строка позиции в подписанных params — не длиннее, чем принимает гейт. */
export const SHOP_LINE_TEXT_MAX = 300;

/** Вариант в группе опций: название и доплата к цене блюда. */
export interface ShopOptionChoice {
  name: string;
  price_rub: number;
}

/** Группа опций блюда: сколько вариантов можно (max) и нужно (min) отметить. */
export interface ShopOptionGroup {
  name: string;
  min: number;
  max: number;
  choices: ShopOptionChoice[];
}

/** Выбранная опция: группа и вариант ровно как в расчёте. */
export interface ShopOptionPick {
  group: string;
  name: string;
}

/** Отказы, после которых кнопка оплаты точно не нажималась. */
export const SHOP_PRE_ORDER_CODES = [
  "shop_disabled",
  "profile_missing",
  "profile_insecure",
  "browser_unavailable",
  "login_required",
  "address_required",
  "captcha",
  "unexpected_page",
  "place_not_found",
  "place_too_slow",
  "product_not_found",
  "product_mismatch",
  "out_of_stock",
  "options_required",
  "options_mismatch",
  "cart_not_empty",
  "cart_mismatch",
  "price_unreadable",
  "price_changed",
  "checkout_unavailable",
  "payment_needs_owner",
  "pay_button_missing",
  "session_unknown",
  "shop_busy",
] as const;
export type ShopFailCode = (typeof SHOP_PRE_ORDER_CODES)[number] | "shop_paying";
/**
 * shop_paying — ответ на reset: браузер занят оформлением с «Оплатить», его не
 * рвут. Не входит в SHOP_PRE_ORDER_CODES: кнопка там, возможно, уже нажата.
 */
const FAIL_CODES: readonly string[] = [...SHOP_PRE_ORDER_CODES, "shop_paying"];

/** Потолок обещанного времени: дальше это уже не доставка, а ошибка разбора. */
export const SHOP_ETA_MAX = 600;

export const SHOP_ORDER_STATES = [
  "none",
  "payment_pending",
  "accepted",
  "assembling",
  "delivering",
  // Маркет: посылка доехала до пункта выдачи и ждёт владельца. У Лавки и Еды
  // такой стадии нет — курьер везёт до двери, там `delivering` → `delivered`.
  "pickup_ready",
  "delivered",
  "cancelled",
  "unknown",
] as const;
export type ShopOrderState = (typeof SHOP_ORDER_STATES)[number];
/** Состояния, в которых заказ точно оформлен и оплачен. */
export const SHOP_PLACED_STATES: readonly ShopOrderState[] = ["accepted", "assembling", "delivering", "pickup_ready", "delivered"];

export interface ShopLine {
  id: string;
  name: string;
  qty: number;
  /** Только Еда: отмеченные опции в порядке групп расчёта. */
  options?: ShopOptionPick[];
}

/** Обещание ресторана на карточке: «20 – 25 мин» → {from_min: 20, to_min: 25}. */
export interface ShopPlaceEta {
  from_min: number;
  to_min: number;
}

export interface ShopPlace {
  ref: string;
  name: string;
  /** Нет — карточка время не пишет (ресторан закрыт или предзаказ). */
  eta?: ShopPlaceEta;
}

/**
 * Время доставки с карточки ресторана: «4.8 (1800+) · 20 – 25 мин» или
 * «35 – 45 мин». Одно число («25 мин») — это и начало, и конец. Часов на
 * карточках нет; нет минут — null.
 */
export function parseShopPlaceEta(text: unknown): ShopPlaceEta | null {
  if (typeof text !== "string") return null;
  const s = text.replace(/[\u00a0\u202f\u2009]/g, " ");
  const range = s.match(/(?:^|[^\d])(\d{1,3})\s*[–—-]\s*(\d{1,3})\s*мин/);
  const one = range ? null : s.match(/(?:^|[^\d])(\d{1,3})\s*мин/);
  const from = Number(range ? range[1] : one?.[1]);
  const to = Number(range ? range[2] : one?.[1]);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || from > to || to > SHOP_PLACE_ETA_MAX) return null;
  return { from_min: from, to_min: to };
}

export const shopPlaceEtaText = (eta: ShopPlaceEta) =>
  eta.from_min === eta.to_min ? `${eta.to_min} мин` : `${eta.from_min}–${eta.to_min} мин`;

/** Предел времени от модели: целые минуты в [SHOP_MAX_ETA_MIN, SHOP_MAX_ETA_MAX]. */
export const isShopMaxEta = (v: unknown): v is number =>
  Number.isSafeInteger(v) && (v as number) >= SHOP_MAX_ETA_MIN && (v as number) <= SHOP_MAX_ETA_MAX;

/** Успевает ли ресторан: конец обещанного интервала не позже предела. Без времени — нет. */
export const shopPlaceFits = (p: ShopPlace, maxEtaMin: number) => p.eta !== undefined && p.eta.to_min <= maxEtaMin;

const foldPlace = (s: string) => s.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * Ресторан по названию: точные совпадения, иначе названия, содержащие запрос.
 * Первый попавшийся по другому названию не берём — владелец просил конкретный.
 * У одной сети бывает несколько точек с одним названием и разным временем:
 * с пределом берём самую быструю из успевающих, а если не успевает ни одна —
 * too_slow (ресторан есть, но везёт дольше). Без предела — первая, как в выдаче.
 */
export function pickShopPlace(
  query: string,
  places: ReadonlyArray<ShopPlace>,
  maxEtaMin?: number,
): { place: ShopPlace } | { too_slow: ShopPlace } | null {
  const q = foldPlace(query);
  if (!q) return null;
  const same = places.filter((p) => foldPlace(p.name) === q);
  const pool = same.length ? same : places.filter((p) => foldPlace(p.name).includes(q));
  if (!pool.length) return null;
  if (maxEtaMin === undefined) return { place: pool[0]! };
  const fast = pool.filter((p) => shopPlaceFits(p, maxEtaMin)).sort((a, b) => a.eta!.to_min - b.eta!.to_min);
  return fast.length ? { place: fast[0]! } : { too_slow: pool[0]! };
}

/**
 * Рестораны для SHOP_PLACES: без повторов, с пределом — только успевающие,
 * быстрые первыми (без времени — в конце), не больше SHOP_PLACES_MAX.
 */
export function rankShopPlaces(places: ReadonlyArray<ShopPlace>, maxEtaMin?: number): ShopPlace[] {
  const seen = new Set<string>();
  const unique = places.filter((p) => !seen.has(p.ref) && seen.add(p.ref));
  const kept = maxEtaMin === undefined ? unique : unique.filter((p) => shopPlaceFits(p, maxEtaMin));
  const key = (p: ShopPlace) => p.eta?.to_min ?? Number.POSITIVE_INFINITY;
  return kept.map((p, i) => ({ p, i })).sort((a, b) => key(a.p) - key(b.p) || a.i - b.i).map(({ p }) => p).slice(0, SHOP_PLACES_MAX);
}

/**
 * `place` есть ровно у сервисов, где shopNeedsPlace: в quote — название для поиска, в prepare — ref.
 * `max_eta_min` — только у Еды: ресторан должен успеть за столько минут.
 * `places` — только Еда: какие рестораны находятся по запросу («шаверма»).
 */
export type ShopRequest =
  | { op: "quote"; service: ShopService; place?: string; max_eta_min?: number; queries: string[] }
  | { op: "places"; service: ShopService; query: string; max_eta_min?: number }
  | { op: "prepare"; session: string; service: ShopService; place?: string; lines: ShopLine[] }
  | { op: "confirm"; session: string; maxRub: number }
  | { op: "abandon"; session: string }
  | { op: "status"; service: ShopService }
  | { op: "set_address"; service: ShopService; address: string }
  /**
   * Сбросить браузер, занятый брошенным запуском. Сервер шлёт запросы по одному,
   * поэтому занятость, которую он видит, держит запрос, которого он уже не ждёт.
   */
  | { op: "reset" };

/** Сколько сохранённых адресов читаем из окна выбора. */
export const SHOP_ADDRESSES_MAX = 20;

/** Адрес меняем только между сохранёнными: у Маркета адрес — пункт выдачи, его не трогаем. */
export const shopCanSetAddress = (service: ShopService) => service === "lavka" || service === "eda";

/**
 * Адрес в слова для сравнения: строчные, «ё» → «е», сокращения («ул.», «д.»,
 * «корп.») и знаки убраны, номера домов («12/1к2») разбиты на части.
 */
export function shopAddressTokens(v: string): string[] {
  return v
    .toLowerCase().replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/gi, " ")
    .split(" ")
    .flatMap((w) => (/^\d/.test(w) ? w.split(/(?<=\d)(?=[а-я])|(?<=[а-я])(?=\d)/) : [w]))
    .filter((w) => (w.length > 1 || /\d/.test(w)) && !SHOP_ADDRESS_STOP.has(w));
}

/** Сокращения, предлоги и слова-связки: в сравнении не участвуют. */
const SHOP_ADDRESS_STOP = new Set([
  "ул", "улица", "дом", "кв", "квартира", "корп", "корпус", "стр", "строение", "под", "подъезд", "этаж",
  "пр", "проспект", "мкр", "микрорайон", "им", "имени", "г", "город",
  "на", "во", "по", "до", "из", "со", "адрес", "адресу",
]);

/** Все слова запроса есть в подписи адреса. */
export const shopAddressHas = (label: string, query: string): boolean => {
  const tokens = shopAddressTokens(label);
  const want = shopAddressTokens(query);
  return want.length > 0 && want.every((w) => tokens.includes(w));
};

/**
 * Какой из сохранённых адресов имел в виду владелец. Ровно одно совпадение —
 * его номер; ни одного или несколько — null: сами не выбираем и новых не заводим.
 */
export function matchSavedAddress(query: string, saved: ReadonlyArray<string>): number | null {
  const hits = saved.flatMap((label, i) => (shopAddressHas(label, query) ? [i] : []));
  return hits.length === 1 ? hits[0]! : null;
}

export interface ShopCandidate {
  id: string;
  name: string;
  /** Цена без доплат за опции. */
  price_rub: number;
  /** Только Еда: группы опций блюда, если они есть. */
  options?: ShopOptionGroup[];
}

export interface ShopQuoteResult {
  query: string;
  candidates: ShopCandidate[];
}

export interface ShopPreparedLine {
  /** id варианта в корзине (у блюда с опциями — edaVariantId). */
  id: string;
  qty: number;
  price_rub: number;
}

export type ShopOutcome =
  | { ok: true; op: "quote"; address: string; place?: ShopPlace; delivery_rub: number | null; results: ShopQuoteResult[] }
  | { ok: true; op: "places"; address: string; places: ShopPlace[] }
  | { ok: true; op: "prepare"; address: string; lines: ShopPreparedLine[]; total_rub: number }
  | { ok: true; op: "confirm"; state: ShopOrderState }
  | { ok: true; op: "abandon" }
  | { ok: true; op: "status"; state: ShopOrderState; eta_min: number | null }
  /** Адрес после попытки: matched — нашёлся ровно один сохранённый и он выбран. */
  | { ok: true; op: "set_address"; matched: boolean; address: string | null; saved_count: number }
  /** reset: true — браузер был занят и закрыт; false — занят не был. */
  | { ok: true; op: "reset"; reset: boolean }
  /** busy_op/busy_ms — у shop_busy: чем занят браузер и сколько уже. */
  | { ok: false; code: ShopFailCode; price_rub?: number; screenshot?: string; busy_op?: ShopRequest["op"]; busy_ms?: number };

const isService = (v: unknown): v is ShopService => typeof v === "string" && Object.hasOwn(SHOP_SERVICES, v);
const keysOf = (m: Record<string, unknown>) => Object.keys(m).sort().join(",");
const isRub = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0 && (v as number) <= 1_000_000;
const isFee = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 10_000;
/** Обещанное время в минутах: как у такси и Доставки, 0..600 или «не знаем». */
const isEta = (v: unknown): v is number | null => v === null || (Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= SHOP_ETA_MAX);
const isQty = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 1 && (v as number) <= SHOP_QTY_MAX;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Название товара со страницы → одна видимая строка. Лавка расставляет мягкие
 * переносы (U+00AD) внутри слов: они вырезаются, прочие невидимые — отказ.
 */
export function normalizeShopName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/\u00ad/g, "").replace(/[\u00a0\u202f\u2009]/g, " ").replace(/\s+/g, " ").trim();
  if (!s || s.length > SHOP_NAME_MAX || HIDDEN.test(s)) return null;
  return s;
}

/** Запрос поиска: одна видимая строка. */
export function normalizeShopQuery(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  if (s.length < 2 || s.length > SHOP_QUERY_MAX || HIDDEN.test(s)) return null;
  return s;
}

/** Адрес из шапки сайта: одна видимая строка. */
export function normalizeShopAddress(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u00a0\u202f\u2009]/g, " ").replace(/\s+/g, " ").trim();
  if (s.length < 3 || s.length > SHOP_ADDRESS_MAX || HIDDEN.test(s)) return null;
  return s;
}

export function normalizeShopService(v: unknown): ShopService | null {
  if (v === undefined) return "lavka";
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  if (isService(s)) return s;
  if (s === "лавка" || s === "яндекс лавка") return "lavka";
  if (s === "маркет" || s === "яндекс маркет" || s === "яндекс.маркет") return "market";
  return s === "еда" || s === "яндекс еда" || s === "яндекс.еда" ? "eda" : null;
}

/** Название ресторана: как название товара, та же одна видимая строка. */
export const normalizeShopPlaceName = (v: unknown) => normalizeShopName(v);

const exact = <T>(norm: (v: unknown) => T | null, v: unknown) => norm(v) !== null && norm(v) === v;

/** Название группы или варианта опции: одна видимая строка, до 60 символов. */
export function normalizeShopOptionName(v: unknown): string | null {
  const s = normalizeShopName(v);
  return s && s.length <= SHOP_OPTION_NAME_MAX ? s : null;
}

const isDelta = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 100_000;

/** Группы опций из ответа Mac: строго, без лишних полей, без повторов названий. */
export function parseShopOptionGroups(raw: unknown): ShopOptionGroup[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > SHOP_OPTION_GROUPS_MAX) return null;
  const groups: ShopOptionGroup[] = [];
  for (const g of raw) {
    if (!isObject(g) || keysOf(g) !== "choices,max,min,name" || !exact(normalizeShopOptionName, g.name)) return null;
    if (!Array.isArray(g.choices) || g.choices.length < 1 || g.choices.length > SHOP_OPTION_CHOICES_MAX) return null;
    const choices: ShopOptionChoice[] = [];
    for (const c of g.choices) {
      if (!isObject(c) || keysOf(c) !== "name,price_rub" || !exact(normalizeShopOptionName, c.name) || !isDelta(c.price_rub)) return null;
      choices.push({ name: c.name as string, price_rub: c.price_rub });
    }
    const { min, max } = g;
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || (min as number) < 0 || (max as number) < 1 || (min as number) > (max as number) || (max as number) > choices.length) return null;
    if (new Set(choices.map((c) => c.name)).size !== choices.length) return null;
    groups.push({ name: g.name as string, min: min as number, max: max as number, choices });
  }
  return new Set(groups.map((g) => g.name)).size === groups.length ? groups : null;
}

/** Выбор из модели или кадра: [{group, name}], 1..12, без повторов. */
export function parseShopOptionPicks(raw: unknown, normalize = false): ShopOptionPick[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > SHOP_OPTION_PICKS_MAX) return null;
  const picks: ShopOptionPick[] = [];
  for (const p of raw) {
    if (!isObject(p) || keysOf(p) !== "group,name") return null;
    const group = normalizeShopOptionName(p.group);
    const name = normalizeShopOptionName(p.name);
    if (!group || !name || (!normalize && (group !== p.group || name !== p.name))) return null;
    picks.push({ group, name });
  }
  return new Set(picks.map((p) => `${p.group}\n${p.name}`)).size === picks.length ? picks : null;
}

/**
 * Выбор владельца против групп расчёта: каждая опция есть в своей группе, в
 * каждой группе отмечено от min до max. Ответ — выбор в порядке расчёта и
 * сумма доплат; иначе — текст ошибки для модели.
 */
export function resolveShopOptions(
  groups: ReadonlyArray<ShopOptionGroup> | undefined,
  picks: ReadonlyArray<ShopOptionPick> | undefined,
): { ok: true; picks: ShopOptionPick[]; extra_rub: number } | { ok: false; error: string } {
  const chosen = picks ?? [];
  if (!groups?.length) return chosen.length ? { ok: false, error: "у этого блюда нет опций" } : { ok: true, picks: [], extra_rub: 0 };
  for (const p of chosen) {
    const g = groups.find((x) => x.name === p.group);
    if (!g) return { ok: false, error: `нет группы опций «${p.group}»; есть: ${groups.map((x) => x.name).join(", ")}` };
    if (!g.choices.some((c) => c.name === p.name)) {
      return { ok: false, error: `в группе «${g.name}» нет «${p.name}»; есть: ${g.choices.map((c) => c.name).join(", ")}` };
    }
  }
  const ordered: ShopOptionPick[] = [];
  let extra = 0;
  for (const g of groups) {
    const inGroup = g.choices.filter((c) => chosen.some((p) => p.group === g.name && p.name === c.name));
    if (inGroup.length < g.min || inGroup.length > g.max) {
      const need = g.min === g.max ? `ровно ${g.min}` : `от ${g.min} до ${g.max}`;
      return { ok: false, error: `в группе «${g.name}» надо выбрать ${need}; варианты: ${g.choices.map((c) => c.name).join(", ")}` };
    }
    for (const c of inGroup) {
      ordered.push({ group: g.name, name: c.name });
      extra += c.price_rub;
    }
  }
  return { ok: true, picks: ordered, extra_rub: extra };
}

/** Ключ позиции для проверки повторов: товар и его опции. */
const lineKey = (l: { id: string; options?: ReadonlyArray<ShopOptionPick> }) =>
  `${l.id}\n${(l.options ?? []).map((p) => p.name).sort().join("\n")}`;

const idFits = (service: ShopService, id: string) => SHOP_PRODUCT_ID.test(id) && (service !== "market" || MARKET_PRODUCT_ID.test(id));

function parseLines(raw: unknown, service: ShopService): ShopLine[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > SHOP_ITEMS_MAX) return null;
  const lines: ShopLine[] = [];
  for (const l of raw) {
    const withOptions = shopNeedsPlace(service) && isObject(l) && l.options !== undefined;
    if (!isObject(l) || keysOf(l) !== (withOptions ? "id,name,options,qty" : "id,name,qty")) return null;
    if (typeof l.id !== "string" || !idFits(service, l.id) || !exact(normalizeShopName, l.name) || !isQty(l.qty)) return null;
    const options = withOptions ? parseShopOptionPicks(l.options) : undefined;
    if (withOptions && !options) return null;
    lines.push({ id: l.id, name: l.name as string, qty: l.qty, ...(options ? { options } : {}) });
  }
  return new Set(lines.map(lineKey)).size === lines.length ? lines : null;
}

const SHOP_OPS = ["quote", "places", "prepare", "confirm", "abandon", "status", "set_address", "reset"] as const satisfies readonly ShopRequest["op"][];

/** Строгий разбор кадра: лишние поля и ненормализованные строки — отказ. */
export function parseShopRequest(raw: unknown): ShopRequest | null {
  if (!isObject(raw)) return null;
  const m = raw;
  const keys = keysOf(m);
  const session = (v: unknown) => typeof v === "string" && SESSION.test(v);
  switch (m.op) {
    case "quote": {
      if (!isService(m.service) || !Array.isArray(m.queries)) return null;
      const place = shopNeedsPlace(m.service);
      const eta = place && m.max_eta_min !== undefined;
      if (keys !== (place ? (eta ? "max_eta_min,op,place,queries,service" : "op,place,queries,service") : "op,queries,service")) return null;
      if (place && !exact(normalizeShopQuery, m.place)) return null;
      if (eta && !isShopMaxEta(m.max_eta_min)) return null;
      if (m.queries.length < 1 || m.queries.length > SHOP_ITEMS_MAX || !m.queries.every((q) => exact(normalizeShopQuery, q))) return null;
      return {
        op: "quote", service: m.service, ...(place ? { place: m.place as string } : {}),
        ...(eta ? { max_eta_min: m.max_eta_min as number } : {}), queries: [...(m.queries as string[])],
      };
    }
    case "places": {
      if (!isService(m.service) || !shopNeedsPlace(m.service)) return null;
      const eta = m.max_eta_min !== undefined;
      if (keys !== (eta ? "max_eta_min,op,query,service" : "op,query,service")) return null;
      if (!exact(normalizeShopQuery, m.query) || (eta && !isShopMaxEta(m.max_eta_min))) return null;
      return { op: "places", service: m.service, query: m.query as string, ...(eta ? { max_eta_min: m.max_eta_min as number } : {}) };
    }
    case "prepare": {
      if (!session(m.session) || !isService(m.service)) return null;
      const place = shopNeedsPlace(m.service);
      if (keys !== (place ? "lines,op,place,service,session" : "lines,op,service,session")) return null;
      if (place && (typeof m.place !== "string" || !SHOP_PLACE_REF.test(m.place))) return null;
      const lines = parseLines(m.lines, m.service);
      return lines ? { op: "prepare", session: m.session as string, service: m.service, ...(place ? { place: m.place as string } : {}), lines } : null;
    }
    case "confirm":
      return keys === "maxRub,op,session" && session(m.session) && isRub(m.maxRub)
        ? { op: "confirm", session: m.session as string, maxRub: m.maxRub } : null;
    case "abandon":
      return keys === "op,session" && session(m.session) ? { op: "abandon", session: m.session as string } : null;
    case "status":
      return keys === "op,service" && isService(m.service) ? { op: "status", service: m.service } : null;
    case "set_address": {
      if (keys !== "address,op,service" || !isService(m.service) || !shopCanSetAddress(m.service)) return null;
      const address = normalizeShopAddress(m.address);
      return address && address === m.address && address.length >= 3 ? { op: "set_address", service: m.service, address } : null;
    }
    case "reset":
      return keys === "op" ? { op: "reset" } : null;
    default:
      return null;
  }
}

/**
 * Цена одного товара или итога → целые рубли, копейки вверх. «99 ₽»,
 * «1 234 ₽», «89,90 ₽». Одна цена и знак рубля обязательны: «99 ₽ вместо
 * 109 ₽» — не цена, а подпись скидки, её разбирать нельзя.
 */
export function parseShopRubles(text: unknown): number | null {
  if (typeof text !== "string" || text.length > 40) return null;
  const s = text.replace(/[\u00a0\u202f\u2009]/g, " ").replace(/\s+/g, " ").trim();
  const m = s.match(/^(?:Итого:?\s*)?(\d{1,3}(?: \d{3})+|\d+)(?:[,.](\d{1,2}))?\s?(?:₽|руб\.?)$/i);
  if (!m) return null;
  const value = Number(m[1].replace(/ /g, "")) + (m[2] && Number(m[2]) > 0 ? 1 : 0);
  return isRub(value) ? value : null;
}

/**
 * «5–10 мин, 0 ₽» или «Доставка 149 ₽» → стоимость доставки; иначе null.
 * Диапазон «0–59 ₽» (цена зависит от суммы корзины) → верхняя граница.
 */
export function parseDeliveryRubles(text: unknown): number | null {
  if (typeof text !== "string" || text.length > 80) return null;
  const m = text.replace(/[\u00a0\u202f\u2009]/g, " ").match(/(?:^|[\s,])(?:\d{1,5}\s?[–-]\s?)?(\d{1,5})\s?₽\s*$/);
  if (!m) return null;
  const value = Number(m[1]);
  return isFee(value) ? value : null;
}

const b64 = (v: unknown) => typeof v === "string" && v.length <= SHOP_SCREENSHOT_B64_MAX && /^[A-Za-z0-9+/=]+$/.test(v);

/**
 * Сколько ещё ждать, по тексту страницы заказа: «Осталось 15 мин», «Доставим
 * через 30–40 мин», «Курьер приедет через 1 ч 10 мин».
 *
 * Два правила, оба ради честности перед владельцем. Первое: числу должно
 * предшествовать слово про ожидание — иначе на странице заказов поймаешь «30–40
 * мин» из чужой карточки. Второе: у диапазона берём верхнюю границу — обещать
 * лучше пессимистично. Ничего не нашли — `null`, то есть «не знаем», а не ноль.
 */
export function parseShopEtaMinutes(text: unknown): number | null {
  if (typeof text !== "string" || !text || text.length > 20_000) return null;
  const s = text.replace(/[\u00a0\u202f\u2009]/g, " ").replace(/\s+/g, " ");
  const cue = "(?:остал|через|прибу|доставим|достав[ия]т|приедет|подача|будет у вас|ожидан)[^.;!?]{0,40}?";
  const h = s.match(new RegExp(cue + "(\\d{1,2})\\s*ч(?:ас[а-я]*)?(?:\\s*(\\d{1,2})\\s*мин)?", "iu"));
  const m = s.match(new RegExp(cue + "(\\d{1,3})(?:\\s*[–—-]\\s*(\\d{1,3}))?\\s*мин", "iu"));
  // Что встретилось раньше, то и про этот заказ.
  const first = h && m ? (h.index! <= m.index! ? h : m) : (h ?? m);
  if (!first) return null;
  const value = first === h ? Number(h![1]) * 60 + Number(h![2] ?? 0) : Number(m![2] ?? m![1]);
  return isEta(value) ? value : null;
}

/** Ресторан в ответе Mac: ref, название и, если карточка его пишет, время. Демон до выката времени шлёт без eta. */
function parsePlace(p: unknown): ShopPlace | null {
  if (!isObject(p) || typeof p.ref !== "string" || !SHOP_PLACE_REF.test(p.ref) || !exact(normalizeShopPlaceName, p.name)) return null;
  if (p.eta === undefined) return keysOf(p) === "name,ref" ? { ref: p.ref, name: p.name as string } : null;
  const e = p.eta;
  if (keysOf(p) !== "eta,name,ref" || !isObject(e) || keysOf(e) !== "from_min,to_min") return null;
  const eta = parseShopPlaceEta(`${e.from_min}–${e.to_min} мин`);
  if (!eta || eta.from_min !== e.from_min || eta.to_min !== e.to_min) return null;
  return { ref: p.ref, name: p.name as string, eta };
}

/** Ответ Mac → проверенный результат. Кривой ответ — исключение, а не догадка. */
export function parseShopOutcome(raw: string, expected: ShopRequest["op"]): ShopOutcome {
  const d = JSON.parse(raw) as Record<string, unknown>;
  const bad = (): never => { throw new Error("invalid_shop_result"); };
  if (!isObject(d)) return bad();
  if (d.ok === false) {
    if (typeof d.code !== "string" || !FAIL_CODES.includes(d.code)) return bad();
    if (d.price_rub !== undefined && !isRub(d.price_rub)) return bad();
    if (d.screenshot !== undefined && !b64(d.screenshot)) return bad();
    if (d.busy_op !== undefined && !(SHOP_OPS as readonly unknown[]).includes(d.busy_op)) return bad();
    if (d.busy_ms !== undefined && !(Number.isSafeInteger(d.busy_ms) && (d.busy_ms as number) >= 0)) return bad();
    return {
      ok: false, code: d.code as ShopFailCode,
      ...(d.price_rub !== undefined ? { price_rub: d.price_rub as number } : {}),
      ...(d.screenshot !== undefined ? { screenshot: d.screenshot as string } : {}),
      ...(d.busy_op !== undefined ? { busy_op: d.busy_op as ShopRequest["op"] } : {}),
      ...(d.busy_ms !== undefined ? { busy_ms: d.busy_ms as number } : {}),
    };
  }
  if (d.ok !== true || d.op !== expected) return bad();
  const state = (v: unknown): v is ShopOrderState => (SHOP_ORDER_STATES as readonly unknown[]).includes(v);
  switch (expected) {
    case "quote": {
      const address = normalizeShopAddress(d.address);
      if (!address || address !== d.address || !(d.delivery_rub === null || isFee(d.delivery_rub))) return bad();
      let place: ShopPlace | undefined;
      if (d.place !== undefined) place = parsePlace(d.place) ?? bad();
      if (!Array.isArray(d.results) || d.results.length < 1 || d.results.length > SHOP_ITEMS_MAX) return bad();
      const results = d.results.map((r): ShopQuoteResult => {
        if (!isObject(r) || !exact(normalizeShopQuery, r.query) || !Array.isArray(r.candidates) || r.candidates.length > SHOP_CANDIDATES_MAX) return bad();
        const candidates = r.candidates.map((c): ShopCandidate => {
          if (!isObject(c) || typeof c.id !== "string" || !SHOP_PRODUCT_ID.test(c.id) || !exact(normalizeShopName, c.name) || !isRub(c.price_rub)) return bad();
          // Опции бывают только у блюд ресторана.
          if (c.options === undefined) return keysOf(c) === "id,name,price_rub" ? { id: c.id, name: c.name as string, price_rub: c.price_rub } : bad();
          const options = place && keysOf(c) === "id,name,options,price_rub" ? parseShopOptionGroups(c.options) : null;
          return options ? { id: c.id, name: c.name as string, price_rub: c.price_rub, options } : bad();
        });
        return { query: r.query as string, candidates };
      });
      const choices = results.reduce((n, r) => n + r.candidates.reduce((m, c) => m + (c.options ?? []).reduce((k, g) => k + g.choices.length, 0), 0), 0);
      if (choices > SHOP_QUOTE_CHOICES_MAX) return bad();
      return { ok: true, op: "quote", address, ...(place ? { place } : {}), delivery_rub: d.delivery_rub as number | null, results };
    }
    case "places": {
      const address = normalizeShopAddress(d.address);
      if (!address || address !== d.address || !Array.isArray(d.places) || d.places.length > SHOP_PLACES_MAX) return bad();
      const places = d.places.map((p) => parsePlace(p) ?? bad());
      if (new Set(places.map((p) => p.ref)).size !== places.length) return bad();
      return { ok: true, op: "places", address, places };
    }
    case "prepare": {
      const address = normalizeShopAddress(d.address);
      if (!address || address !== d.address || !isRub(d.total_rub)) return bad();
      if (!Array.isArray(d.lines) || d.lines.length < 1 || d.lines.length > SHOP_ITEMS_MAX) return bad();
      const lines = d.lines.map((l): ShopPreparedLine =>
        isObject(l) && typeof l.id === "string" && SHOP_PRODUCT_ID.test(l.id) && isQty(l.qty) && isRub(l.price_rub)
          ? { id: l.id, qty: l.qty, price_rub: l.price_rub } : bad());
      if (new Set(lines.map((l) => l.id)).size !== lines.length) return bad();
      return { ok: true, op: "prepare", address, lines, total_rub: d.total_rub };
    }
    case "confirm":
      return state(d.state) ? { ok: true, op: "confirm", state: d.state } : bad();
    case "status": {
      // `eta_min` появился позже самого `status`. Демон и сервер катятся
      // порознь, поэтому отсутствие поля — это «не знаем», а не отказ; мусор
      // в поле по-прежнему отказ.
      const eta = d.eta_min === undefined ? null : d.eta_min;
      return state(d.state) && isEta(eta) ? { ok: true, op: "status", state: d.state, eta_min: eta } : bad();
    }
    case "abandon":
      return { ok: true, op: "abandon" };
    case "reset":
      return typeof d.reset === "boolean" ? { ok: true, op: "reset", reset: d.reset } : bad();
    case "set_address": {
      const address = d.address === null ? null : normalizeShopAddress(d.address);
      if (d.address !== null && (!address || address !== d.address)) return bad();
      if (typeof d.matched !== "boolean") return bad();
      if (!Number.isSafeInteger(d.saved_count) || (d.saved_count as number) < 0 || (d.saved_count as number) > 100) return bad();
      if (d.matched && !address) return bad();
      return { ok: true, op: "set_address", matched: d.matched, address, saved_count: d.saved_count as number };
    }
  }
}

export const SHOP_STATE_LABEL: Record<ShopOrderState, string> = {
  none: "активного заказа нет",
  payment_pending: "ждёт подтверждения оплаты банком",
  accepted: "заказ принят",
  assembling: "собирают",
  delivering: "курьер в пути",
  pickup_ready: "приехал в пункт выдачи, можно забирать",
  delivered: "доставлен",
  cancelled: "заказ отменён",
  unknown: "состояние не распознано",
};

export const SHOP_FAIL_LABEL: Record<ShopFailCode, string> = {
  shop_disabled: "покупки на Mac выключены (SHOP_ENABLED)",
  profile_missing: "профиль браузера для покупок не настроен (SHOP_PROFILE_DIR)",
  profile_insecure: "профиль браузера доступен другим пользователям Mac — нужен chmod 700",
  browser_unavailable: "не удалось запустить Chrome для покупок",
  login_required: "в Яндекс не выполнен вход — владелец входит сам: bun mac-daemon/shop.ts login",
  address_required: "на сайте не выбран адрес доставки — владелец выбирает его сам в окне login",
  captcha: "Яндекс показал капчу — агент её не решает: владелец проходит её сам в окне Chrome агента на Mac (окно ждёт 15 минут), потом вызов повторяют",
  unexpected_page: "открылась неожиданная страница — остановился",
  place_not_found: "ресторан не найден или сейчас не принимает заказы",
  place_too_slow: "ресторан есть, но сейчас везёт дольше заданного времени — подбери другой через SHOP_PLACES",
  product_not_found: "товар не найден",
  product_mismatch: "на странице товара другое название — остановился",
  out_of_stock: "товара нет в наличии",
  options_required: "у товара надо выбрать опции (размер, соус, цвет): в Еде пересчитай через SHOP_QUOTE и назови выбор в options, в Маркете выбери вариант сам",
  options_mismatch: "опции блюда на сайте не совпали с подписанным выбором — остановился",
  cart_not_empty: "в корзине уже что-то лежит — чужую корзину агент не трогает, очисти её сам",
  cart_mismatch: "корзина не совпала с подписанным заказом",
  price_unreadable: "не удалось прочитать цену или итог",
  price_changed: "итог изменился сверх подписанного",
  checkout_unavailable: "оформление недоступно (минимальная сумма, закрыто или нет доставки)",
  payment_needs_owner: "нет сохранённой карты — агент карту не вводит, нужен владелец",
  pay_button_missing: "кнопка оплаты не найдена",
  session_unknown: "подготовленный заказ не найден или устарел",
  shop_busy: "браузер покупок занят другим запросом",
  shop_paying: "браузер покупок оформляет оплату — его не сбрасывают",
};

/**
 * Что делать агенту при отказе (этап 2 автономии). Инцидент 2026-09-18: на
 * shop_busy агент попросил владельца «повторить через пару минут», хотя повтор —
 * его работа. Теперь у каждого кода есть действие: `owner: false` — агент делает
 * `next` сам и владельцу технических просьб не пишет; `owner: true` — только то,
 * что агенту запрещено (вход, капча, карта, адрес, настройки Mac, чужая корзина).
 * Повторы, которые безопасны без агента (Mac не на связи, Chrome не запустился,
 * занятость), сервер уже сделал сам — см. askMac в lib/dispatch/shop.ts.
 */
export type ShopRecovery = { owner: boolean; next: string };
const RETRY_ONCE = "повтори этот же вызов сам один раз, владельца не проси; если снова — ";
export const SHOP_RECOVERY: Record<ShopFailCode, ShopRecovery> = {
  shop_disabled: { owner: true, next: "покупки на Mac выключены — скажи владельцу одной фразой, повторять бесполезно" },
  profile_missing: { owner: true, next: "профиль браузера не настроен — это настройка Mac, скажи владельцу одной фразой" },
  profile_insecure: { owner: true, next: "профиль браузера открыт другим пользователям — это настройка Mac, скажи владельцу одной фразой" },
  browser_unavailable: { owner: false, next: `сервер уже запускал Chrome повторно; ${RETRY_ONCE}скажи владельцу, что Chrome на Mac не запускается, и поставь SCHEDULE_FOLLOWUP через 10 мин повторить` },
  login_required: { owner: true, next: "вход в Яндекс делает только владелец — попроси его войти и не повторяй до его ответа" },
  address_required: { owner: true, next: "адрес на сайте выбирает только владелец — попроси его и не повторяй до его ответа" },
  captcha: { owner: true, next: "капчу агент не решает. Перешли владельцу скриншот: пусть пройдёт капчу в окне Chrome агента на Mac. Поставь SCHEDULE_FOLLOWUP через 3 мин — повторить этот же вызов один раз; владелец ответил «готово» раньше — повтори сразу. Снова капча — больше не повторяй. Оплату (confirm) сам не повторяй: заново подтверждение владельца" },
  unexpected_page: { owner: false, next: `${RETRY_ONCE}вызови SHOP_REPAIR {service, code: "unexpected_page"} — Mac сам починит селекторы и откроет PR; владельцу скажи одной фразой, что чинишь` },
  place_not_found: { owner: false, next: "найди другие рестораны через SHOP_PLACES и предложи владельцу выбор" },
  place_too_slow: { owner: false, next: "подбери успевающий ресторан через SHOP_PLACES с тем же max_eta_min и предложи владельцу" },
  product_not_found: { owner: false, next: "поищи замену через SHOP_QUOTE другими словами и предложи владельцу" },
  product_mismatch: { owner: false, next: "пересчитай через SHOP_QUOTE и SHOP_CHECKOUT, новый итог — владельцу" },
  out_of_stock: { owner: false, next: "подбери замену через SHOP_QUOTE и предложи владельцу; без его согласия замену не заказывай" },
  options_required: { owner: false, next: "пересчитай через SHOP_QUOTE и выбери опции; если выбор неочевиден — спроси владельца, какой вариант" },
  options_mismatch: { owner: false, next: "пересчитай через SHOP_QUOTE и SHOP_CHECKOUT с теми же опциями, новый итог — владельцу" },
  cart_not_empty: { owner: true, next: "в корзине чужие товары, агент их не трогает — попроси владельца очистить корзину" },
  cart_mismatch: { owner: false, next: "пересчитай через SHOP_QUOTE и SHOP_CHECKOUT, новый итог — владельцу" },
  price_unreadable: { owner: false, next: `${RETRY_ONCE}вызови SHOP_REPAIR {service, code: "price_unreadable"} — Mac сам починит селекторы и откроет PR; владельцу скажи одной фразой, что чинишь` },
  price_changed: { owner: false, next: "пересчитай через SHOP_QUOTE и SHOP_CHECKOUT, назови владельцу новый итог и жди его согласия" },
  checkout_unavailable: { owner: false, next: "если не хватает минимальной суммы — предложи владельцу добавить позицию; если закрыто — предложи другой ресторан через SHOP_PLACES" },
  payment_needs_owner: { owner: true, next: "карту агент не вводит — попроси владельца сохранить карту в Яндексе" },
  pay_button_missing: { owner: false, next: "заказ не повторяй: проверь SHOP_STATUS и скажи владельцу итог" },
  session_unknown: { owner: false, next: "подготовка устарела — заново SHOP_CHECKOUT и новое подтверждение владельца" },
  shop_busy: { owner: false, next: "сервер уже ждал и сбрасывал браузер; повтори этот же вызов сам, владельца не проси; если снова занято — SCHEDULE_FOLLOWUP через 5 мин" },
  shop_paying: { owner: false, next: "на Mac идёт оплата другого заказа — её итог придёт сам; ничего не повторяй, а своё дело отложи через SCHEDULE_FOLLOWUP через 5 мин" },
};

export const shopLineSum = (lines: ReadonlyArray<{ qty: number; price_rub: number }>) =>
  lines.reduce((sum, l) => sum + l.qty * l.price_rub, 0);

export const shopMaxFinal = (amountRub: number, deviationPct: number) => Math.floor((amountRub * (100 + deviationPct)) / 100);

/** «Яндекс Лавка» или «Яндекс Еда · Жарицца Пицца». */
export const shopStoreLabel = (service: ShopService, place?: string) =>
  place ? `${SHOP_SERVICES[service]} · ${place}` : SHOP_SERVICES[service];

/**
 * Позиция карточки и подписанного payload: «название × 2 — 198 ₽», с опциями —
 * «Пицца 385 г (Тонкое тесто, Бекон) × 1 — 909 ₽»; price_rub уже с доплатами.
 */
export const shopLineText = (l: { name: string; qty: number; price_rub: number; options?: ReadonlyArray<ShopOptionPick> }) =>
  `${l.name}${l.options?.length ? ` (${l.options.map((o) => o.name).join(", ")})` : ""} × ${l.qty} — ${l.qty * l.price_rub} ₽`;

export interface OrderFoodView {
  service: ShopService;
  /** Ресторан Еды — как в SHOP_QUOTE; у Лавки его нет. */
  place?: string;
  lines: Array<{ id: string; name: string; qty: number; price_rub: number; options?: ShopOptionPick[] }>;
  delivery_rub: number;
  /**
   * Итог со страницы оформления из SHOP_CHECKOUT — с доставкой, сервисным
   * сбором и доплатой за маленький заказ. Есть у Лавки и Еды, у Маркета нет.
   */
  total_rub?: number;
}

/**
 * Итог SHOP_CHECKOUT против товаров и доставки: сборы сверху не больше
 * тысячи, скидка — не ниже половины суммы. Остальное — чужая вёрстка.
 */
export const SHOP_CHECKOUT_EXTRA_MAX = 1_000;
export const shopCheckoutTotalFits = (total: number, base: number) =>
  isRub(total) && total <= base + SHOP_CHECKOUT_EXTRA_MAX && total * 2 >= base;

/**
 * Разбор payload ORDER_FOOD и MARKET_PURCHASE (build-payload его уже
 * нормализовал; здесь — второй рубеж). У MARKET_PURCHASE поля service нет:
 * его подставляет вызывающий.
 */
export function parseOrderFood(p: Record<string, unknown>): OrderFoodView | null {
  if (!isService(p.service) || !isFee(p.delivery_rub) || !Array.isArray(p.lines)) return null;
  if (p.service === "market" && p.delivery_rub > MARKET_DELIVERY_MAX) return null;
  if (shopNeedsPlace(p.service) ? !exact(normalizeShopPlaceName, p.place) : p.place !== undefined) return null;
  if (p.lines.length < 1 || p.lines.length > SHOP_ITEMS_MAX) return null;
  const lines: OrderFoodView["lines"] = [];
  for (const l of p.lines) {
    if (!isObject(l) || typeof l.id !== "string" || !idFits(p.service, l.id)) return null;
    if (!exact(normalizeShopName, l.name) || !isQty(l.qty) || !isRub(l.price_rub)) return null;
    if (l.options !== undefined && !shopNeedsPlace(p.service)) return null;
    const options = l.options === undefined ? undefined : parseShopOptionPicks(l.options);
    if (options === null) return null;
    const line = { id: l.id, name: l.name as string, qty: l.qty, price_rub: l.price_rub, ...(options ? { options } : {}) };
    if (shopLineText(line).length > SHOP_LINE_TEXT_MAX) return null;
    lines.push(line);
  }
  if (new Set(lines.map(lineKey)).size !== lines.length) return null;
  if (p.total_rub !== undefined && (p.service === "market" || !shopCheckoutTotalFits(p.total_rub as number, shopLineSum(lines) + p.delivery_rub))) return null;
  return {
    service: p.service,
    ...(p.place !== undefined ? { place: p.place as string } : {}),
    lines,
    delivery_rub: p.delivery_rub,
    ...(p.total_rub !== undefined ? { total_rub: p.total_rub as number } : {}),
  };
}

/**
 * Сырые позиции из вызова инструмента → вид для parseOrderFood: название
 * нормализовано, пустой список опций — то же, что без опций. Проверки — там.
 */
export function shopOrderLinesInput(raw: unknown[]): Array<Record<string, unknown>> {
  return raw.map((l) => {
    const o = (l && typeof l === "object" ? l : {}) as Record<string, unknown>;
    const options = Array.isArray(o.options) && o.options.length === 0 ? undefined : o.options === undefined ? undefined : parseShopOptionPicks(o.options, true) ?? o.options;
    return { id: o.id, name: normalizeShopName(o.name), qty: o.qty, price_rub: o.price_rub, ...(options !== undefined ? { options } : {}) };
  });
}

/** Сколько к товарам и доставке добавило оформление: сборы (плюс) или скидка (минус). */
export const shopOrderExtra = (o: Pick<OrderFoodView, "lines" | "delivery_rub" | "total_rub">) =>
  o.total_rub === undefined ? 0 : o.total_rub - shopLineSum(o.lines) - o.delivery_rub;

/** Сумма к подписи: итог оформления, если он есть, иначе товары плюс доставка. */
export const shopOrderAmount = (o: Pick<OrderFoodView, "lines" | "delivery_rub" | "total_rub">) =>
  o.total_rub ?? shopLineSum(o.lines) + o.delivery_rub;

/** «сборы 79 ₽» / «скидка 30 ₽» / "" — как карточка и подпись называют разницу. */
export const shopExtraText = (extra: number) => (extra > 0 ? `сборы ${extra} ₽` : extra < 0 ? `скидка ${-extra} ₽` : "");

/** Карточка ORDER_FOOD и MARKET_PURCHASE в чате: то же, что потом подпишет телефон. */
export function describeOrderFood(p: Record<string, unknown>, deviationPct: number): string {
  const o = parseOrderFood(p);
  if (!o) return "некорректный заказ";
  const amount = shopOrderAmount(o);
  const delivery = o.service === "market" ? `доставка до ${o.delivery_rub} ₽` : `доставка ${o.delivery_rub} ₽`;
  const extra = shopExtraText(shopOrderExtra(o));
  return `${shopStoreLabel(o.service, o.place)}: ${o.lines.map(shopLineText).join("; ")}; ${delivery}${extra ? `; ${extra}` : ""}. ` +
    `Всего ${amount} ₽ (итог на странице — не больше ${shopMaxFinal(amount, deviationPct)} ₽), дальше — подпись на телефоне`;
}
