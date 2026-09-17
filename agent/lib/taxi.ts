/**
 * Такси через Яндекс Go в браузере на Mac владельца — шаг 9 плана.
 *
 * Модуль без побочек: его импортируют и сервер (разбор ввода модели, карточки,
 * разбор ответа Mac), и демон (строгий повторный разбор кадра, разбор цены со
 * страницы). Один источник на список тарифов, коды отказов и форму ответов.
 *
 * Деньги уходят только так: TAXI_QUOTE → ORDER_TAXI (карточка в чате) →
 * подпись на телефоне (lib/signed-actions.ts) → claim → prepare на Mac →
 * checkFinal → confirm на Mac → complete. Капчу агент не решает и не обходит:
 * отказ `captcha` и скриншот владельцу.
 */

/** Порядок — как на странице Яндекс Go. */
export const TAXI_TARIFFS = {
  econom: "Эконом",
  comfort: "Комфорт",
  comfortplus: "Комфорт+",
  business: "Бизнес",
  premier: "Премьер",
  elite: "Элит",
  child: "Детский",
  minivan: "Минивэн",
  cruise: "Круиз",
} as const;
export type TaxiTariff = keyof typeof TAXI_TARIFFS;
export const TAXI_TARIFF_KEYS = Object.keys(TAXI_TARIFFS) as TaxiTariff[];

export const TAXI_ADDRESS_MAX = 200;
/** Сессия prepare → confirm живёт недолго: страница и цена успевают устареть. */
export const TAXI_SESSION_TTL_MS = 3 * 60_000;
/** Сколько живёт расчёт, по которому можно заказать. */
export const TAXI_QUOTE_TTL_MS = 10 * 60_000;
/** Скриншот в кадре моста: base64 должен уместиться в хвост потока (64 КБ). */
export const TAXI_SCREENSHOT_B64_MAX = 56_000;

const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const SESSION = /^[A-Za-z0-9_-]{16,64}$/;

/** Отказы, после которых кнопка «Заказать» точно не нажималась. */
export const TAXI_PRE_ORDER_CODES = [
  "taxi_disabled",
  "profile_missing",
  "profile_insecure",
  "browser_unavailable",
  "login_required",
  "captcha",
  "unexpected_page",
  "address_not_found",
  "tariff_unavailable",
  "price_unreadable",
  "price_changed",
  "session_unknown",
  "order_button_missing",
  "taxi_busy",
] as const;
/** Отказы cancel и status: заказа нет или он уже не отменяется. */
export const TAXI_ORDER_CODES = ["no_active_order", "cancel_unavailable"] as const;
export type TaxiFailCode = (typeof TAXI_PRE_ORDER_CODES)[number] | (typeof TAXI_ORDER_CODES)[number];
const FAIL_CODES: readonly string[] = [...TAXI_PRE_ORDER_CODES, ...TAXI_ORDER_CODES];

export const TAXI_ORDER_STATES = [
  "none",
  "searching",
  "driver_assigned",
  "driver_arrived",
  "riding",
  "finished",
  "cancelled",
  "unknown",
] as const;
export type TaxiOrderState = (typeof TAXI_ORDER_STATES)[number];

export type TaxiRequest =
  | { op: "quote"; from: string; to: string }
  | { op: "prepare"; session: string; from: string; to: string; tariff: TaxiTariff }
  | { op: "confirm"; session: string; maxRub: number }
  | { op: "abandon"; session: string }
  | { op: "status" }
  | { op: "cancel" };

export interface TaxiOption {
  tariff: TaxiTariff;
  price_rub: number;
  eta_min: number | null;
}

export interface TaxiDriver {
  car: string | null;
  plate: string | null;
  eta_min: number | null;
}

export type TaxiOutcome =
  | { ok: true; op: "quote"; options: TaxiOption[] }
  | { ok: true; op: "prepare"; tariff: TaxiTariff; price_rub: number; eta_min: number | null }
  | { ok: true; op: "confirm"; state: TaxiOrderState }
  | { ok: true; op: "abandon" }
  | { ok: true; op: "status"; state: TaxiOrderState; driver: TaxiDriver | null }
  | { ok: true; op: "cancel"; state: TaxiOrderState }
  | { ok: false; code: TaxiFailCode; price_rub?: number; screenshot?: string };

const isTariff = (v: unknown): v is TaxiTariff => typeof v === "string" && Object.hasOwn(TAXI_TARIFFS, v);
const keysOf = (m: Record<string, unknown>) => Object.keys(m).sort().join(",");
const isRub = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0 && (v as number) <= 1_000_000;
const isEta = (v: unknown): v is number | null => v === null || (Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 600);

/** Адрес: одна видимая строка. Яндекс сам его геокодирует, карточка показывает как есть. */
export function taxiAddressError(v: unknown): string | null {
  if (typeof v !== "string") return "address must be a string";
  const s = v.trim();
  if (s.length < 3 || s.length > TAXI_ADDRESS_MAX) return `address must be 3..${TAXI_ADDRESS_MAX} chars`;
  if (HIDDEN.test(s)) return "address must not contain control or invisible characters";
  return null;
}

export function normalizeTaxiAddress(v: unknown): string | null {
  return taxiAddressError(v) ? null : (v as string).trim().replace(/\s+/g, " ");
}

const tariffWord = (v: string) =>
  v.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/ё/g, "е")
    .replace(/(?<![\p{L}\d])(?:тариф|tariff|класс)(?![\p{L}\d])/gu, "").replace(/[\s._-]+/g, "");

/** Как тариф называют голосом: транскрипция, латиница, разговорные формы. */
const TARIFF_ALIASES: Record<string, TaxiTariff> = Object.fromEntries(
  ([
    ["econom", ["эконом", "economy", "эконом класс", "эконому"]],
    ["comfort", ["комфорт", "комфортный"]],
    ["comfortplus", ["комфорт+", "комфорт плюс", "comfort+", "comfort plus"]],
    ["business", ["бизнес", "business", "бизнесс"]],
    ["premier", ["премьер", "premier", "премьера"]],
    ["elite", ["элит", "элита", "elite", "élite"]],
    ["child", ["детский", "детское", "с детским креслом", "детское кресло", "kids"]],
    ["minivan", ["минивэн", "минивен", "minivan"]],
    ["cruise", ["круиз", "cruise"]],
  ] as Array<[TaxiTariff, string[]]>).flatMap(([key, words]) => [key, TAXI_TARIFFS[key], ...words].map((w) => [tariffWord(w), key])),
);

/**
 * Ввод модели → тариф. Понимает ключ, русское название и то, как тариф
 * произносят голосом («комфорт плюс», «элит», «с детским креслом»).
 */
export function normalizeTaxiTariff(v: unknown): TaxiTariff | null {
  if (typeof v !== "string" || v.length > 60) return null;
  const key = tariffWord(v.trim());
  return Object.hasOwn(TARIFF_ALIASES, key) ? TARIFF_ALIASES[key] : null;
}

/** Строгий разбор кадра: лишние поля и ненормализованные адреса — отказ. */
export function parseTaxiRequest(raw: unknown): TaxiRequest | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  const keys = keysOf(m);
  const addr = (v: unknown) => normalizeTaxiAddress(v) === v;
  const session = (v: unknown) => typeof v === "string" && SESSION.test(v);
  switch (m.op) {
    case "quote":
      return keys === "from,op,to" && addr(m.from) && addr(m.to)
        ? { op: "quote", from: m.from as string, to: m.to as string } : null;
    case "prepare":
      return keys === "from,op,session,tariff,to" && session(m.session) && addr(m.from) && addr(m.to) && isTariff(m.tariff)
        ? { op: "prepare", session: m.session as string, from: m.from as string, to: m.to as string, tariff: m.tariff } : null;
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

/**
 * Цена со страницы → целые рубли. «349 ₽», «1 234 ₽», «от 349 ₽»,
 * «349–420 ₽» (берётся верхняя граница: сверка должна быть строже, а не мягче).
 * Без знака рубля — null: число без валюты может оказаться чем угодно.
 */
export function parseRubles(text: unknown): number | null {
  if (typeof text !== "string" || text.length > 80 || !/₽|руб/i.test(text)) return null;
  const numbers = [...text.replace(/[\u00a0\u202f\u2009]/g, " ").matchAll(/\d{1,3}(?: \d{3})+|\d+/g)]
    .map((match) => Number(match[0].replace(/ /g, "")));
  if (!numbers.length || numbers.length > 2) return null;
  const value = Math.max(...numbers);
  return isRub(value) ? value : null;
}

/** «5 мин», «1 ч 10 мин» → минуты; иначе null. */
export function parseEtaMinutes(text: unknown): number | null {
  if (typeof text !== "string" || text.length > 40) return null;
  const hours = text.match(/(\d+)\s*ч/);
  const minutes = text.match(/(\d+)\s*мин/);
  if (!hours && !minutes) return null;
  const total = (hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0);
  return isEta(total) ? total : null;
}

const shortText = (v: unknown, max: number) => v === null || (typeof v === "string" && v.length <= max && !HIDDEN.test(v));

/** Ответ Mac → проверенный результат. Кривой ответ — исключение, а не догадка. */
export function parseTaxiOutcome(raw: string, expected: TaxiRequest["op"]): TaxiOutcome {
  const d = JSON.parse(raw) as Record<string, unknown>;
  const bad = (): never => { throw new Error("invalid_taxi_result"); };
  if (!d || typeof d !== "object") return bad();
  if (d.ok === false) {
    if (typeof d.code !== "string" || !FAIL_CODES.includes(d.code)) return bad();
    if (d.price_rub !== undefined && !isRub(d.price_rub)) return bad();
    if (d.screenshot !== undefined && (typeof d.screenshot !== "string" || d.screenshot.length > TAXI_SCREENSHOT_B64_MAX || !/^[A-Za-z0-9+/=]+$/.test(d.screenshot))) return bad();
    return {
      ok: false, code: d.code as TaxiFailCode,
      ...(d.price_rub !== undefined ? { price_rub: d.price_rub as number } : {}),
      ...(d.screenshot !== undefined ? { screenshot: d.screenshot as string } : {}),
    };
  }
  if (d.ok !== true || d.op !== expected) return bad();
  const state = (v: unknown) => (TAXI_ORDER_STATES as readonly unknown[]).includes(v);
  switch (expected) {
    case "quote": {
      if (!Array.isArray(d.options) || d.options.length > TAXI_TARIFF_KEYS.length) return bad();
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
      return state(d.state) ? { ok: true, op: expected, state: d.state as TaxiOrderState } : bad();
    case "abandon":
      return { ok: true, op: "abandon" };
    case "status": {
      if (!state(d.state)) return bad();
      const driver = d.driver as Record<string, unknown> | null | undefined;
      if (driver !== null && driver !== undefined &&
          !(shortText(driver.car, 80) && shortText(driver.plate, 20) && isEta(driver.eta_min))) return bad();
      return {
        ok: true, op: "status", state: d.state as TaxiOrderState,
        driver: driver ? { car: driver.car as string | null, plate: driver.plate as string | null, eta_min: driver.eta_min as number | null } : null,
      };
    }
  }
}

export const TAXI_STATE_LABEL: Record<TaxiOrderState, string> = {
  none: "активного заказа нет",
  searching: "ищем машину",
  driver_assigned: "водитель назначен",
  driver_arrived: "водитель на месте",
  riding: "в пути",
  finished: "поездка завершена",
  cancelled: "заказ отменён",
  unknown: "состояние не распознано",
};

export const TAXI_FAIL_LABEL: Record<TaxiFailCode, string> = {
  taxi_disabled: "такси на Mac выключено (TAXI_ENABLED)",
  profile_missing: "профиль браузера для такси не настроен (TAXI_PROFILE_DIR)",
  profile_insecure: "профиль браузера доступен другим пользователям Mac — нужен chmod 700",
  browser_unavailable: "не удалось запустить Chrome для такси",
  login_required: "в Яндекс Go не выполнен вход — владелец входит сам: bun mac-daemon/taxi.ts login",
  captcha: "Яндекс показал капчу — агент её не решает, нужен владелец",
  unexpected_page: "открылась неожиданная страница — остановился",
  address_not_found: "адрес не найден",
  tariff_unavailable: "тариф сейчас недоступен",
  price_unreadable: "не удалось прочитать цену",
  price_changed: "цена изменилась сверх подписанной",
  session_unknown: "подготовленный заказ не найден или устарел",
  order_button_missing: "кнопка заказа не найдена",
  taxi_busy: "браузер такси занят другим запросом",
  no_active_order: "активного заказа нет",
  cancel_unavailable: "заказ нельзя отменить со страницы",
};

/** Карточка подтверждения ORDER_TAXI. */
export function describeTaxiOrder(o: { from: string; to: string; tariff: TaxiTariff; price_rub: number }, maxRub: number): string {
  return `такси ${TAXI_TARIFFS[o.tariff]}: ${o.from} → ${o.to}, ${o.price_rub} ₽ (списание не больше ${maxRub} ₽), дальше — подпись на телефоне`;
}

/** Карточка ORDER_TAXI в чате по payload: то же, что потом подпишет телефон. */
export function describeTaxiPayload(p: Record<string, unknown>, deviationPct: number): string {
  const from = normalizeTaxiAddress(p.from);
  const to = normalizeTaxiAddress(p.to);
  const tariff = normalizeTaxiTariff(p.tariff);
  const price = p.price_rub;
  if (!from || !to || !tariff || !isRub(price)) return "некорректный заказ такси";
  return describeTaxiOrder({ from, to, tariff, price_rub: price }, taxiMaxFinal(price, deviationPct));
}

export const taxiMaxFinal = (priceRub: number, deviationPct: number) => Math.floor((priceRub * (100 + deviationPct)) / 100);
