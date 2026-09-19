/**
 * Курьер через Яндекс Go («Доставка») в браузере на Mac владельца — шаг 10d.
 *
 * Модуль без побочек, устроен как lib/taxi.ts: его импортируют и сервер
 * (разбор ввода модели, карточка, разбор ответа Mac), и демон (строгий
 * повторный разбор кадра). Адреса и цены разбираются теми же функциями, что у
 * такси.
 *
 * Деньги уходят только так: DELIVERY_QUOTE → ORDER_DELIVERY (карточка в чате) →
 * подпись на телефоне (lib/signed-actions.ts, сервис yandex_delivery, потолок
 * 1000 ₽) → claim → prepare на Mac → checkFinal → confirm на Mac → complete.
 *
 * Контакты агент не придумывает: телефон отправителя подставляет Яндекс Go
 * (аккаунт владельца), пустой телефон получателя заполняется тем же номером —
 * из поля в поле, наружу он не читается. Если страница всё равно требует
 * контакт — отказ `contact_required`, владелец оформляет сам. Способ оплаты
 * агент не добавляет: без него кнопка заказа неактивна — отказ
 * `payment_needs_owner`. Подтвердить данные аккаунта (имя, телефон, код из
 * SMS) — тоже дело владельца: вместо «Заказать» Доставка показывает
 * «Подтвердите данные» — отказ `data_confirm_needs_owner`. Комментарий курьеру
 * (что забрать, подъезд) — необязательный, виден в карточке и подписывается.
 */
import { normalizeTaxiAddress, TAXI_SCREENSHOT_B64_MAX } from "./taxi.ts";

export const DELIVERY_TARIFFS = {
  courier: "Курьер",
  express: "Экспресс",
  cargo: "Грузовой",
} as const;
export type DeliveryTariff = keyof typeof DELIVERY_TARIFFS;
export const DELIVERY_TARIFF_KEYS = Object.keys(DELIVERY_TARIFFS) as DeliveryTariff[];

export const DELIVERY_COMMENT_MAX = 200;
export const DELIVERY_SESSION_TTL_MS = 3 * 60_000;
export const DELIVERY_QUOTE_TTL_MS = 10 * 60_000;

const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const SESSION = /^[A-Za-z0-9_-]{16,64}$/;

/** Отказы, после которых кнопка «Заказать» точно не нажималась. */
export const DELIVERY_PRE_ORDER_CODES = [
  "delivery_disabled",
  "profile_missing",
  "profile_insecure",
  "profile_shared",
  "browser_unavailable",
  "login_required",
  "captcha",
  "unexpected_page",
  "address_not_found",
  "tariff_unavailable",
  "contact_required",
  "comment_unavailable",
  "price_unreadable",
  "price_changed",
  "session_unknown",
  "order_button_missing",
  "payment_needs_owner",
  "data_confirm_needs_owner",
  "delivery_busy",
] as const;
export const DELIVERY_ORDER_CODES = ["no_active_order", "cancel_unavailable"] as const;
export type DeliveryFailCode = (typeof DELIVERY_PRE_ORDER_CODES)[number] | (typeof DELIVERY_ORDER_CODES)[number];
const FAIL_CODES: readonly string[] = [...DELIVERY_PRE_ORDER_CODES, ...DELIVERY_ORDER_CODES];

export const DELIVERY_ORDER_STATES = [
  "none",
  "searching",
  "courier_assigned",
  "picked_up",
  "delivered",
  "cancelled",
  "unknown",
] as const;
export type DeliveryOrderState = (typeof DELIVERY_ORDER_STATES)[number];

export type DeliveryRequest =
  | { op: "quote"; from: string; to: string }
  | { op: "prepare"; session: string; from: string; to: string; tariff: DeliveryTariff; comment: string | null }
  | { op: "confirm"; session: string; maxRub: number }
  | { op: "abandon"; session: string }
  | { op: "status" }
  | { op: "cancel" };

export interface DeliveryOption {
  tariff: DeliveryTariff;
  price_rub: number;
  eta_min: number | null;
}

export type DeliveryOutcome =
  | { ok: true; op: "quote"; options: DeliveryOption[] }
  | { ok: true; op: "prepare"; tariff: DeliveryTariff; price_rub: number; eta_min: number | null }
  | { ok: true; op: "confirm"; state: DeliveryOrderState }
  | { ok: true; op: "abandon" }
  | { ok: true; op: "status"; state: DeliveryOrderState; eta_min: number | null }
  | { ok: true; op: "cancel"; state: DeliveryOrderState }
  | { ok: false; code: DeliveryFailCode; price_rub?: number; screenshot?: string };

const isTariff = (v: unknown): v is DeliveryTariff => typeof v === "string" && Object.hasOwn(DELIVERY_TARIFFS, v);
const keysOf = (m: Record<string, unknown>) => Object.keys(m).sort().join(",");
const isRub = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0 && (v as number) <= 1_000_000;
const isEta = (v: unknown): v is number | null => v === null || (Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 600);

export const normalizeDeliveryAddress = normalizeTaxiAddress;

/** Ввод модели → тариф. Понимает и ключ, и русское название. */
export function normalizeDeliveryTariff(v: unknown): DeliveryTariff | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase().replace(/\s+/g, "");
  if (isTariff(s)) return s;
  return DELIVERY_TARIFF_KEYS.find((k) => DELIVERY_TARIFFS[k].toLowerCase() === s) ?? null;
}

/**
 * Комментарий курьеру: undefined/null/пустая строка → null (его нет);
 * иначе одна видимая строка до DELIVERY_COMMENT_MAX. Кривой — undefined (отказ).
 */
export function normalizeDeliveryComment(v: unknown): string | null | undefined {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") return undefined;
  const s = v.trim().replace(/[ \t]+/g, " ");
  if (!s) return null;
  if (s.length > DELIVERY_COMMENT_MAX || HIDDEN.test(s)) return undefined;
  return s;
}

/** Строгий разбор кадра: лишние поля и ненормализованные строки — отказ. */
export function parseDeliveryRequest(raw: unknown): DeliveryRequest | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  const keys = keysOf(m);
  const addr = (v: unknown) => normalizeDeliveryAddress(v) === v;
  const session = (v: unknown) => typeof v === "string" && SESSION.test(v);
  const comment = (v: unknown) => v === null || (typeof v === "string" && normalizeDeliveryComment(v) === v);
  switch (m.op) {
    case "quote":
      return keys === "from,op,to" && addr(m.from) && addr(m.to)
        ? { op: "quote", from: m.from as string, to: m.to as string } : null;
    case "prepare":
      return keys === "comment,from,op,session,tariff,to" && session(m.session) && addr(m.from) && addr(m.to) &&
        isTariff(m.tariff) && comment(m.comment)
        ? { op: "prepare", session: m.session as string, from: m.from as string, to: m.to as string, tariff: m.tariff, comment: m.comment as string | null }
        : null;
    case "confirm":
      return keys === "maxRub,op,session" && session(m.session) && isRub(m.maxRub)
        ? { op: "confirm", session: m.session as string, maxRub: m.maxRub } : null;
    case "abandon":
      return keys === "op,session" && session(m.session) ? { op: "abandon", session: m.session as string } : null;
    case "status":
    case "cancel":
      return keys === "op" ? { op: m.op } : null;
    default:
      return null;
  }
}

/** Ответ Mac → проверенный результат. Кривой ответ — исключение, а не догадка. */
export function parseDeliveryOutcome(raw: string, expected: DeliveryRequest["op"]): DeliveryOutcome {
  const d = JSON.parse(raw) as Record<string, unknown>;
  const bad = (): never => { throw new Error("invalid_delivery_result"); };
  if (!d || typeof d !== "object") return bad();
  if (d.ok === false) {
    if (typeof d.code !== "string" || !FAIL_CODES.includes(d.code)) return bad();
    if (d.price_rub !== undefined && !isRub(d.price_rub)) return bad();
    if (d.screenshot !== undefined && (typeof d.screenshot !== "string" || d.screenshot.length > TAXI_SCREENSHOT_B64_MAX || !/^[A-Za-z0-9+/=]+$/.test(d.screenshot))) return bad();
    return {
      ok: false, code: d.code as DeliveryFailCode,
      ...(d.price_rub !== undefined ? { price_rub: d.price_rub as number } : {}),
      ...(d.screenshot !== undefined ? { screenshot: d.screenshot as string } : {}),
    };
  }
  if (d.ok !== true || d.op !== expected) return bad();
  const state = (v: unknown) => (DELIVERY_ORDER_STATES as readonly unknown[]).includes(v);
  switch (expected) {
    case "quote": {
      if (!Array.isArray(d.options) || d.options.length > DELIVERY_TARIFF_KEYS.length) return bad();
      const options = (d.options as Record<string, unknown>[]).map((o) =>
        o && isTariff(o.tariff) && isRub(o.price_rub) && isEta(o.eta_min)
          ? { tariff: o.tariff, price_rub: o.price_rub, eta_min: o.eta_min } : bad());
      if (new Set(options.map((o) => o.tariff)).size !== options.length) return bad();
      return { ok: true, op: "quote", options };
    }
    case "prepare":
      return isTariff(d.tariff) && isRub(d.price_rub) && isEta(d.eta_min)
        ? { ok: true, op: "prepare", tariff: d.tariff, price_rub: d.price_rub, eta_min: d.eta_min } : bad();
    case "confirm":
    case "cancel":
      return state(d.state) ? { ok: true, op: expected, state: d.state as DeliveryOrderState } : bad();
    case "abandon":
      return { ok: true, op: "abandon" };
    case "status":
      return state(d.state) && isEta(d.eta_min)
        ? { ok: true, op: "status", state: d.state as DeliveryOrderState, eta_min: d.eta_min } : bad();
  }
}

export const DELIVERY_STATE_LABEL: Record<DeliveryOrderState, string> = {
  none: "активной доставки нет",
  searching: "ищем курьера",
  courier_assigned: "курьер назначен и едет за отправлением",
  picked_up: "курьер забрал отправление и везёт",
  delivered: "доставлено",
  cancelled: "доставка отменена",
  unknown: "состояние не распознано",
};

export const DELIVERY_FAIL_LABEL: Record<DeliveryFailCode, string> = {
  delivery_disabled: "доставка на Mac выключена (DELIVERY_ENABLED)",
  profile_missing: "профиль браузера для доставки не настроен (DELIVERY_PROFILE_DIR)",
  profile_insecure: "профиль браузера доступен другим пользователям Mac — нужен chmod 700",
  profile_shared: "DELIVERY_PROFILE_DIR совпадает с TAXI_PROFILE_DIR — нужен отдельный профиль",
  browser_unavailable: "не удалось запустить Chrome для доставки",
  login_required: "в Яндекс Go не выполнен вход — владелец входит сам: bun mac-daemon/delivery.ts login",
  captcha: "Яндекс показал капчу — агент её не решает: владелец проходит её сам в окне Chrome агента на Mac (окно ждёт 15 минут), потом вызов повторяют",
  unexpected_page: "открылась неожиданная страница — остановился",
  address_not_found: "адрес не найден",
  tariff_unavailable: "тариф доставки сейчас недоступен",
  contact_required: "страница просит контакт, которого у агента нет (подставляет только телефон владельца) — оформи сам",
  comment_unavailable: "поле комментария курьеру не найдено",
  price_unreadable: "не удалось прочитать цену",
  price_changed: "цена изменилась сверх подписанной",
  session_unknown: "подготовленный заказ не найден или устарел",
  order_button_missing: "кнопка заказа не найдена",
  payment_needs_owner: "в Доставке не выбран способ оплаты — агент его не добавляет, выбери в Яндекс Go сам",
  data_confirm_needs_owner: "Доставка просит подтвердить данные (имя, телефон, код из SMS) — агент это не делает, подтверди в Яндекс Go сам",
  delivery_busy: "браузер доставки занят другим запросом",
  no_active_order: "активной доставки нет",
  cancel_unavailable: "доставку нельзя отменить со страницы",
};

type DeliveryOrder = { from: string; to: string; tariff: DeliveryTariff; price_rub: number; comment: string | null };

/** Карточка подтверждения ORDER_DELIVERY. */
export function describeDeliveryOrder(o: DeliveryOrder, maxRub: number): string {
  const comment = o.comment ? `, комментарий курьеру: «${o.comment}»` : "";
  return `курьер ${DELIVERY_TARIFFS[o.tariff]}: ${o.from} → ${o.to}${comment}, ${o.price_rub} ₽ (списание не больше ${maxRub} ₽), дальше — подпись на телефоне`;
}

/** Карточка ORDER_DELIVERY в чате по payload: то же, что потом подпишет телефон. */
export function describeDeliveryPayload(p: Record<string, unknown>, deviationPct: number): string {
  const from = normalizeDeliveryAddress(p.from);
  const to = normalizeDeliveryAddress(p.to);
  const tariff = normalizeDeliveryTariff(p.tariff);
  const comment = normalizeDeliveryComment(p.comment);
  const price = p.price_rub;
  if (!from || !to || !tariff || comment === undefined || !isRub(price)) return "некорректный заказ доставки";
  return describeDeliveryOrder({ from, to, tariff, price_rub: price, comment }, deliveryMaxFinal(price, deviationPct));
}

export const deliveryMaxFinal = (priceRub: number, deviationPct: number) => Math.floor((priceRub * (100 + deviationPct)) / 100);
