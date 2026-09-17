/**
 * Покупки в Яндекс Лавке через браузер на Mac владельца — шаг 10a плана.
 *
 * Модуль без побочек: его импортируют и сервер (разбор ввода модели, карточка,
 * разбор ответа Mac), и демон (строгий повторный разбор кадра, разбор цены со
 * страницы). Один источник на сервисы, коды отказов и форму ответов.
 *
 * Деньги уходят только так: SHOP_QUOTE → ORDER_FOOD (карточка в чате) →
 * подпись на телефоне (lib/signed-actions.ts) → claim → prepare на Mac
 * (корзина собирается из подписанных позиций) → checkFinal по итогу со
 * страницы → confirm на Mac (одно нажатие «Оплатить») → complete. Капчу агент
 * не решает, в Яндекс не входит, адрес и карту не вводит.
 */

export const SHOP_SERVICES = {
  lavka: "Яндекс Лавка",
} as const;
export type ShopService = keyof typeof SHOP_SERVICES;
export const SHOP_SERVICE_KEYS = Object.keys(SHOP_SERVICES) as ShopService[];
/** Имя сервиса в подписанном payload (то, что видит телефон). */
export const SHOP_GATE_SERVICE: Record<ShopService, string> = { lavka: "yandex_lavka" };
export const SHOP_GATE_ACTION = "order_food";

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
  "product_not_found",
  "product_mismatch",
  "out_of_stock",
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

export type ShopRequest =
  | { op: "quote"; service: ShopService; queries: string[] }
  | { op: "prepare"; session: string; service: ShopService; lines: ShopLine[] }
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
  | { ok: true; op: "quote"; address: string; delivery_rub: number | null; results: ShopQuoteResult[] }
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
  return s === "лавка" || s === "яндекс лавка" ? "lavka" : null;
}

const exact = <T>(norm: (v: unknown) => T | null, v: unknown) => norm(v) !== null && norm(v) === v;

function parseLines(raw: unknown): ShopLine[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > SHOP_ITEMS_MAX) return null;
  const lines: ShopLine[] = [];
  for (const l of raw) {
    if (!isObject(l) || keysOf(l) !== "id,name,qty") return null;
    if (typeof l.id !== "string" || !SHOP_PRODUCT_ID.test(l.id) || !exact(normalizeShopName, l.name) || !isQty(l.qty)) return null;
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
      if (keys !== "op,queries,service" || !isService(m.service) || !Array.isArray(m.queries)) return null;
      if (m.queries.length < 1 || m.queries.length > SHOP_ITEMS_MAX || !m.queries.every((q) => exact(normalizeShopQuery, q))) return null;
      return { op: "quote", service: m.service, queries: [...(m.queries as string[])] };
    }
    case "prepare": {
      if (keys !== "lines,op,service,session" || !session(m.session) || !isService(m.service)) return null;
      const lines = parseLines(m.lines);
      return lines ? { op: "prepare", session: m.session as string, service: m.service, lines } : null;
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
      if (!Array.isArray(d.results) || d.results.length < 1 || d.results.length > SHOP_ITEMS_MAX) return bad();
      const results = d.results.map((r): ShopQuoteResult => {
        if (!isObject(r) || !exact(normalizeShopQuery, r.query) || !Array.isArray(r.candidates) || r.candidates.length > SHOP_CANDIDATES_MAX) return bad();
        const candidates = r.candidates.map((c): ShopCandidate =>
          isObject(c) && typeof c.id === "string" && SHOP_PRODUCT_ID.test(c.id) && exact(normalizeShopName, c.name) && isRub(c.price_rub)
            ? { id: c.id, name: c.name as string, price_rub: c.price_rub } : bad());
        return { query: r.query as string, candidates };
      });
      return { ok: true, op: "quote", address, delivery_rub: d.delivery_rub as number | null, results };
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
  product_not_found: "товар не найден",
  product_mismatch: "на странице товара другое название — остановился",
  out_of_stock: "товара нет в наличии",
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

/** Позиция карточки и подписанного payload: «название × 2 — 198 ₽». */
export const shopLineText = (l: { name: string; qty: number; price_rub: number }) => `${l.name} × ${l.qty} — ${l.qty * l.price_rub} ₽`;

export interface OrderFoodView {
  service: ShopService;
  lines: Array<{ id: string; name: string; qty: number; price_rub: number }>;
  delivery_rub: number;
}

/** Разбор payload ORDER_FOOD (build-payload его уже нормализовал; здесь — второй рубеж). */
export function parseOrderFood(p: Record<string, unknown>): OrderFoodView | null {
  if (!isService(p.service) || !isFee(p.delivery_rub) || !Array.isArray(p.lines)) return null;
  if (p.lines.length < 1 || p.lines.length > SHOP_ITEMS_MAX) return null;
  const lines: OrderFoodView["lines"] = [];
  for (const l of p.lines) {
    if (!isObject(l) || typeof l.id !== "string" || !SHOP_PRODUCT_ID.test(l.id)) return null;
    if (!exact(normalizeShopName, l.name) || !isQty(l.qty) || !isRub(l.price_rub)) return null;
    lines.push({ id: l.id, name: l.name as string, qty: l.qty, price_rub: l.price_rub });
  }
  if (new Set(lines.map((l) => l.id)).size !== lines.length) return null;
  return { service: p.service, lines, delivery_rub: p.delivery_rub };
}

/** Карточка ORDER_FOOD в чате: то же, что потом подпишет телефон. */
export function describeOrderFood(p: Record<string, unknown>, deviationPct: number): string {
  const o = parseOrderFood(p);
  if (!o) return "некорректный заказ";
  const amount = shopLineSum(o.lines) + o.delivery_rub;
  return `${SHOP_SERVICES[o.service]}: ${o.lines.map(shopLineText).join("; ")}; доставка ${o.delivery_rub} ₽. ` +
    `Всего ${amount} ₽ (итог на странице — не больше ${shopMaxFinal(amount, deviationPct)} ₽), дальше — подпись на телефоне`;
}
