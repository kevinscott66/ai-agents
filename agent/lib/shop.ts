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
export type ShopFailCode = (typeof SHOP_PRE_ORDER_CODES)[number];
const FAIL_CODES: readonly string[] = SHOP_PRE_ORDER_CODES;

export const SHOP_ORDER_STATES = [
  "none",
  "payment_pending",
  "accepted",
  "assembling",
  "delivering",
  "delivered",
  "cancelled",
  "unknown",
] as const;
export type ShopOrderState = (typeof SHOP_ORDER_STATES)[number];
/** Состояния, в которых заказ точно оформлен и оплачен. */
export const SHOP_PLACED_STATES: readonly ShopOrderState[] = ["accepted", "assembling", "delivering", "delivered"];

export interface ShopLine {
  id: string;
  name: string;
  qty: number;
  /** Только Еда: отмеченные опции в порядке групп расчёта. */
  options?: ShopOptionPick[];
}

export interface ShopPlace {
  ref: string;
  name: string;
}

/** `place` есть ровно у сервисов, где shopNeedsPlace: в quote — название для поиска, в prepare — ref. */
export type ShopRequest =
  | { op: "quote"; service: ShopService; place?: string; queries: string[] }
  | { op: "prepare"; session: string; service: ShopService; place?: string; lines: ShopLine[] }
  | { op: "confirm"; session: string; maxRub: number }
  | { op: "abandon"; session: string }
  | { op: "status"; service: ShopService }
  | { op: "set_address"; service: ShopService; address: string };

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
  | { ok: true; op: "prepare"; address: string; lines: ShopPreparedLine[]; total_rub: number }
  | { ok: true; op: "confirm"; state: ShopOrderState }
  | { ok: true; op: "abandon" }
  | { ok: true; op: "status"; state: ShopOrderState }
  /** Адрес после попытки: matched — нашёлся ровно один сохранённый и он выбран. */
  | { ok: true; op: "set_address"; matched: boolean; address: string | null; saved_count: number }
  | { ok: false; code: ShopFailCode; price_rub?: number; screenshot?: string };

const isService = (v: unknown): v is ShopService => typeof v === "string" && Object.hasOwn(SHOP_SERVICES, v);
const keysOf = (m: Record<string, unknown>) => Object.keys(m).sort().join(",");
const isRub = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0 && (v as number) <= 1_000_000;
const isFee = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 10_000;
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
      if (keys !== (place ? "op,place,queries,service" : "op,queries,service")) return null;
      if (place && !exact(normalizeShopQuery, m.place)) return null;
      if (m.queries.length < 1 || m.queries.length > SHOP_ITEMS_MAX || !m.queries.every((q) => exact(normalizeShopQuery, q))) return null;
      return { op: "quote", service: m.service, ...(place ? { place: m.place as string } : {}), queries: [...(m.queries as string[])] };
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

/** Ответ Mac → проверенный результат. Кривой ответ — исключение, а не догадка. */
export function parseShopOutcome(raw: string, expected: ShopRequest["op"]): ShopOutcome {
  const d = JSON.parse(raw) as Record<string, unknown>;
  const bad = (): never => { throw new Error("invalid_shop_result"); };
  if (!isObject(d)) return bad();
  if (d.ok === false) {
    if (typeof d.code !== "string" || !FAIL_CODES.includes(d.code)) return bad();
    if (d.price_rub !== undefined && !isRub(d.price_rub)) return bad();
    if (d.screenshot !== undefined && !b64(d.screenshot)) return bad();
    return {
      ok: false, code: d.code as ShopFailCode,
      ...(d.price_rub !== undefined ? { price_rub: d.price_rub as number } : {}),
      ...(d.screenshot !== undefined ? { screenshot: d.screenshot as string } : {}),
    };
  }
  if (d.ok !== true || d.op !== expected) return bad();
  const state = (v: unknown): v is ShopOrderState => (SHOP_ORDER_STATES as readonly unknown[]).includes(v);
  switch (expected) {
    case "quote": {
      const address = normalizeShopAddress(d.address);
      if (!address || address !== d.address || !(d.delivery_rub === null || isFee(d.delivery_rub))) return bad();
      let place: ShopPlace | undefined;
      if (d.place !== undefined) {
        const p = d.place;
        if (!isObject(p) || keysOf(p) !== "name,ref" || typeof p.ref !== "string" || !SHOP_PLACE_REF.test(p.ref) || !exact(normalizeShopPlaceName, p.name)) return bad();
        place = { ref: p.ref, name: p.name as string };
      }
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
    case "status":
      return state(d.state) ? { ok: true, op: expected, state: d.state } : bad();
    case "abandon":
      return { ok: true, op: "abandon" };
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
  captcha: "Яндекс показал капчу — агент её не решает, нужен владелец",
  unexpected_page: "открылась неожиданная страница — остановился",
  place_not_found: "ресторан не найден или сейчас не принимает заказы",
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
}

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
  return { service: p.service, ...(p.place !== undefined ? { place: p.place as string } : {}), lines, delivery_rub: p.delivery_rub };
}

/** Карточка ORDER_FOOD и MARKET_PURCHASE в чате: то же, что потом подпишет телефон. */
export function describeOrderFood(p: Record<string, unknown>, deviationPct: number): string {
  const o = parseOrderFood(p);
  if (!o) return "некорректный заказ";
  const amount = shopLineSum(o.lines) + o.delivery_rub;
  const delivery = o.service === "market" ? `доставка до ${o.delivery_rub} ₽` : `доставка ${o.delivery_rub} ₽`;
  return `${shopStoreLabel(o.service, o.place)}: ${o.lines.map(shopLineText).join("; ")}; ${delivery}. ` +
    `Всего ${amount} ₽ (итог на странице — не больше ${shopMaxFinal(amount, deviationPct)} ₽), дальше — подпись на телефоне`;
}
