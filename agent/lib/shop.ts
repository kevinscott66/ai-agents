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
/** Товар Маркета: `<modelId>-<sku>` из ссылки `/card/<slug>/<modelId>?sku=<sku>`. Подмножество SHOP_PRODUCT_ID. */
export const MARKET_PRODUCT_ID = /^[1-9]\d{0,19}-[1-9]\d{0,19}$/;

/**
 * У блюд Еды нет своих страниц: блюдо — это название в меню ресторана. id
 * выводится из ресторана и названия, так что другое блюдо или другой ресторан
 * дают другой id, а сверка на Mac идёт по названию.
 */
export function edaDishId(placeRef: string, name: string): string {
  return `d${createHash("sha256").update(`${placeRef}\n${name}`).digest("hex").slice(0, 24)}`;
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
  | { op: "status"; service: ShopService };

export interface ShopCandidate {
  id: string;
  name: string;
  price_rub: number;
}

export interface ShopQuoteResult {
  query: string;
  candidates: ShopCandidate[];
}

export interface ShopPreparedLine {
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

const idFits = (service: ShopService, id: string) => SHOP_PRODUCT_ID.test(id) && (service !== "market" || MARKET_PRODUCT_ID.test(id));

function parseLines(raw: unknown, service: ShopService): ShopLine[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > SHOP_ITEMS_MAX) return null;
  const lines: ShopLine[] = [];
  for (const l of raw) {
    if (!isObject(l) || keysOf(l) !== "id,name,qty") return null;
    if (typeof l.id !== "string" || !idFits(service, l.id) || !exact(normalizeShopName, l.name) || !isQty(l.qty)) return null;
    lines.push({ id: l.id, name: l.name as string, qty: l.qty });
  }
  return new Set(lines.map((l) => l.id)).size === lines.length ? lines : null;
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

/** «5–10 мин, 0 ₽» или «Доставка 149 ₽» → стоимость доставки; иначе null. */
export function parseDeliveryRubles(text: unknown): number | null {
  if (typeof text !== "string" || text.length > 80) return null;
  const m = text.replace(/[\u00a0\u202f\u2009]/g, " ").match(/(?:^|[\s,])(\d{1,5})\s?₽\s*$/);
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
        const candidates = r.candidates.map((c): ShopCandidate =>
          isObject(c) && typeof c.id === "string" && SHOP_PRODUCT_ID.test(c.id) && exact(normalizeShopName, c.name) && isRub(c.price_rub)
            ? { id: c.id, name: c.name as string, price_rub: c.price_rub } : bad());
        return { query: r.query as string, candidates };
      });
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
  options_required: "у блюда надо выбрать опции (размер, соус) — агент их не выбирает, закажи это блюдо сам",
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

/** Позиция карточки и подписанного payload: «название × 2 — 198 ₽». */
export const shopLineText = (l: { name: string; qty: number; price_rub: number }) => `${l.name} × ${l.qty} — ${l.qty * l.price_rub} ₽`;

export interface OrderFoodView {
  service: ShopService;
  /** Ресторан Еды — как в SHOP_QUOTE; у Лавки его нет. */
  place?: string;
  lines: Array<{ id: string; name: string; qty: number; price_rub: number }>;
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
    lines.push({ id: l.id, name: l.name as string, qty: l.qty, price_rub: l.price_rub });
  }
  if (new Set(lines.map((l) => l.id)).size !== lines.length) return null;
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
