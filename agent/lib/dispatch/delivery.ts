/**
 * Шаг 10d: курьер через Яндекс Go («Доставка») в браузере на Mac владельца.
 * Устроено ровно как такси (lib/dispatch/taxi.ts), свой браузер и свой флаг:
 *
 *   DELIVERY_QUOTE  {from, to}                              — инлайново: цены по тарифам;
 *   ORDER_DELIVERY  {from, to, tariff, price_rub, comment?} — карточка в чате (money),
 *                                                             затем заявка в гейт;
 *   подпись на телефоне → исполнитель: claim → prepare → checkFinal → confirm;
 *   DELIVERY_STATUS {}                                      — инлайново: состояние;
 *   DELIVERY_CANCEL {}                                      — карточка в чате, затем отмена.
 *
 * Контакты отправителя и получателя агент не вводит (остаются из аккаунта
 * владельца), комментарий курьеру — только подписанный. Капчу не решаем:
 * отказ и скриншот владельцу.
 *
 * Ожидающие подписи заявки живут в памяти процесса: рестарт их теряет, а
 * строка `approved` занимает слот дневного лимита до конца дня — как у такси.
 */
import { randomBytes } from "node:crypto";
import { parseUserIdList } from "../allowlist.ts";
import type { PayloadByType } from "../action-payload.ts";
import {
  DELIVERY_FAIL_LABEL,
  DELIVERY_PRE_ORDER_CODES,
  DELIVERY_QUOTE_TTL_MS,
  DELIVERY_STATE_LABEL,
  DELIVERY_TARIFFS,
  deliveryMaxFinal,
  normalizeDeliveryAddress,
  parseDeliveryOutcome,
  type DeliveryOption,
  type DeliveryOutcome,
  type DeliveryRequest,
  type DeliveryTariff,
} from "../delivery.ts";
import { sendDeliveryToMac } from "../mac-bridge.ts";
import { signedActions } from "../native-signing.ts";
import { limitsFromEnv, maxRubFor, SignedActionRefusal, type SignedActions } from "../signed-actions.ts";
import { log } from "../log.ts";
import type { HandlerResult } from "./helpers.ts";

export const DELIVERY_SERVICE = "yandex_delivery";
export const DELIVERY_ACTION = "order_delivery";

export type DeliveryHandlerContext = { agentKey: string; chatId: number };
export type DeliveryInlineContext = { agentKey: string; chatId: number; triggerUserId?: string; delegationChain?: string[] };

export type DeliveryNotifier = {
  text: (userId: string, text: string) => Promise<void>;
  photo: (userId: string, jpegBase64: string, caption: string) => Promise<void>;
};

export type DeliveryDeps = {
  send: (request: DeliveryRequest, userId: string, chatId: number) => Promise<{ ok: boolean; stdout: string; error?: string }>;
  gate: () => SignedActions;
  notify?: DeliveryNotifier;
  now: () => number;
  session: () => string;
};

const defaults: DeliveryDeps = {
  send: sendDeliveryToMac,
  gate: signedActions,
  now: Date.now,
  session: () => randomBytes(24).toString("base64url"),
};
let deps: DeliveryDeps = { ...defaults };

/** Подмена зависимостей (Telegram-уведомления на старте, заглушки в тестах). */
export function configureDelivery(patch: Partial<DeliveryDeps>) {
  const previous = deps;
  deps = { ...deps, ...patch };
  return () => { deps = previous; };
}

export const deliveryEnabled = () => process.env.DELIVERY_ENABLED === "true";

interface Quote { from: string; to: string; options: DeliveryOption[]; at: number }
interface PendingOrder {
  payload: string;
  userId: string;
  chatId: number;
  from: string;
  to: string;
  tariff: DeliveryTariff;
  comment: string | null;
  at: number;
}

/** Последний расчёт на пользователя: заказывать можно только по нему. */
const quotes = new Map<string, Quote>();
/** nonce → заявка, ждущая подписи. */
const pendingOrders = new Map<string, PendingOrder>();
/** Исполнитель один: второй заказ ждёт, пока первый не закончится. */
let queue: Promise<void> = Promise.resolve();

export function resetDeliveryState() {
  quotes.clear();
  pendingOrders.clear();
  queue = Promise.resolve();
}

function ownerRefusal(agentKey: string, chatId: number, userId: string | undefined, delegated: boolean): string | null {
  if (!deliveryEnabled()) return "доставка выключена (DELIVERY_ENABLED)";
  if (agentKey !== "orchestrator") return `forbidden: delivery is restricted to orchestrator (caller: ${agentKey})`;
  const owners = parseUserIdList(process.env.MINIAPP_ADMIN_USER_IDS);
  if (delegated || !userId || !owners.includes(Number(userId)) || String(chatId) !== userId) {
    return "forbidden: доставка — только по просьбе владельца в его личном чате";
  }
  return null;
}

export type DeliveryToolResult = { ok: boolean } & Record<string, unknown>;

const inlineDelegated = (ctx: DeliveryInlineContext) => (ctx.delegationChain ?? []).some((k) => k !== ctx.agentKey);

/** Запрос к Mac → проверенный ответ. Ошибка моста — исключение с её кодом. */
async function askMac(request: DeliveryRequest, userId: string, chatId: number): Promise<DeliveryOutcome> {
  const res = await deps.send(request, userId, chatId);
  if (!res.ok) throw new Error(res.error ?? "delivery_failed");
  return parseDeliveryOutcome(res.stdout, request.op);
}

const failText = (o: Extract<DeliveryOutcome, { ok: false }>) =>
  `${DELIVERY_FAIL_LABEL[o.code]}${o.price_rub ? ` (на странице ${o.price_rub} ₽)` : ""}`;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** DELIVERY_QUOTE: цены по тарифам доставки. Ничего не заказывает. */
export async function quoteDelivery(input: Record<string, unknown>, ctx: DeliveryInlineContext): Promise<DeliveryToolResult> {
  const refusal = ownerRefusal(ctx.agentKey, ctx.chatId, ctx.triggerUserId, inlineDelegated(ctx));
  if (refusal) return { ok: false, error: refusal };
  const from = normalizeDeliveryAddress(input.from);
  const to = normalizeDeliveryAddress(input.to);
  if (!from || !to) return { ok: false, error: "from и to — адреса одной строкой, 3..200 символов" };
  const userId = ctx.triggerUserId!;
  try {
    const out = await askMac({ op: "quote", from, to }, userId, ctx.chatId);
    if (!out.ok) return { ok: false, error: failText(out), code: out.code };
    if (out.op !== "quote") return { ok: false, error: "invalid_delivery_result" };
    quotes.set(userId, { from, to, options: out.options, at: deps.now() });
    return {
      ok: true,
      from,
      to,
      options: out.options.map((o) => ({ tariff: o.tariff, name: DELIVERY_TARIFFS[o.tariff], price_rub: o.price_rub, eta_min: o.eta_min })),
      max_rub: maxRubFor(limitsFromEnv(), DELIVERY_SERVICE),
      valid_min: Math.round(DELIVERY_QUOTE_TTL_MS / 60_000),
      note: "Это расчёт, не заказ. Для заказа — ORDER_DELIVERY с тем же from/to, выбранным tariff, его price_rub и, если владелец назвал, comment; дальше подтверждение в чате и подпись на телефоне.",
    };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

/** DELIVERY_STATUS: что сейчас с доставкой. */
export async function deliveryStatus(ctx: DeliveryInlineContext): Promise<DeliveryToolResult> {
  const refusal = ownerRefusal(ctx.agentKey, ctx.chatId, ctx.triggerUserId, inlineDelegated(ctx));
  if (refusal) return { ok: false, error: refusal };
  try {
    const out = await askMac({ op: "status" }, ctx.triggerUserId!, ctx.chatId);
    if (!out.ok) return { ok: false, error: failText(out), code: out.code };
    if (out.op !== "status") return { ok: false, error: "invalid_delivery_result" };
    return { ok: true, state: out.state, state_text: DELIVERY_STATE_LABEL[out.state], eta_min: out.eta_min };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

const GATE_TEXT: Partial<Record<string, string>> = {
  no_active_key: "на телефоне нет активного ключа подписи — владелец регистрирует его в приложении",
  limit_amount: "сумма выше лимита на один заказ (PAID_ACTION_MAX_RUB_YANDEX_DELIVERY)",
  limit_daily: "дневной лимит платных действий исчерпан",
  payload_invalid: "заявка не проходит проверку гейта",
};

/**
 * ORDER_DELIVERY после одобрения в чате: сверка с расчётом и заявка в гейт.
 * Сам заказ не делается — его сделает исполнитель после подписи.
 */
export async function handleOrderDelivery(payload: PayloadByType["ORDER_DELIVERY"], ctx: DeliveryHandlerContext): Promise<HandlerResult> {
  const refusal = ownerRefusal(ctx.agentKey, ctx.chatId, payload._userId, payload._delegated === true);
  if (refusal) return { ok: false, error: refusal };
  const userId = payload._userId!;
  const { from, to, tariff, price_rub: price } = payload;
  const comment = payload.comment ?? null;
  const quote = quotes.get(userId);
  const now = deps.now();
  if (!quote || now - quote.at > DELIVERY_QUOTE_TTL_MS || quote.from !== from || quote.to !== to) {
    return { ok: false, error: "нет свежего расчёта на этот маршрут: сначала DELIVERY_QUOTE и новое подтверждение" };
  }
  const option = quote.options.find((o) => o.tariff === tariff);
  if (!option) return { ok: false, error: `тарифа ${DELIVERY_TARIFFS[tariff]} не было в расчёте` };
  if (option.price_rub !== price) {
    return { ok: false, error: `в расчёте ${option.price_rub} ₽, а в заявке ${price} ₽: пересчитай через DELIVERY_QUOTE` };
  }
  try {
    const params = { from, to, tariff: DELIVERY_TARIFFS[tariff], ...(comment ? { comment } : {}) };
    const { nonce, payload: signed } = deps.gate().issue(
      { service: DELIVERY_SERVICE, action: DELIVERY_ACTION, params, amountRub: price },
      now,
    );
    for (const [key, order] of pendingOrders) if (now - order.at > DELIVERY_QUOTE_TTL_MS) pendingOrders.delete(key);
    pendingOrders.set(nonce, { payload: signed, userId, chatId: ctx.chatId, from, to, tariff, comment, at: now });
    return {
      ok: true,
      result: {
        status: "awaiting_signature",
        price_rub: price,
        max_final_rub: deliveryMaxFinal(price, deps.gate().limits.deviationPct),
        note: "Доставка ещё НЕ заказана. Владелец подтверждает её Face ID в приложении в течение 2 минут; результат придёт отдельным сообщением.",
      },
    };
  } catch (e) {
    if (e instanceof SignedActionRefusal) return { ok: false, error: GATE_TEXT[e.code] ?? e.code };
    return { ok: false, error: errorText(e) };
  }
}

/** DELIVERY_CANCEL после одобрения в чате. Отмена может стоить денег — поэтому карточка. */
export async function handleDeliveryCancel(payload: PayloadByType["DELIVERY_CANCEL"], ctx: DeliveryHandlerContext): Promise<HandlerResult> {
  const refusal = ownerRefusal(ctx.agentKey, ctx.chatId, payload._userId, payload._delegated === true);
  if (refusal) return { ok: false, error: refusal };
  try {
    const out = await askMac({ op: "cancel" }, payload._userId!, ctx.chatId);
    if (!out.ok) return { ok: false, error: failText(out) };
    if (out.op !== "cancel") return { ok: false, error: "invalid_delivery_result" };
    return { ok: true, result: { state: out.state, state_text: DELIVERY_STATE_LABEL[out.state] } };
  } catch (e) {
    // Кадр мог дойти: повторять отмену вслепую нельзя, сначала DELIVERY_STATUS.
    return { ok: false, error: `${errorText(e)} — проверь DELIVERY_STATUS, прежде чем повторять`, sideEffect: true };
  }
}

async function tell(userId: string, text: string, screenshot?: string) {
  const notify = deps.notify;
  if (!notify) {
    log.warn("[delivery] notifier is not configured", { text });
    return;
  }
  try {
    if (screenshot) await notify.photo(userId, screenshot, text);
    else await notify.text(userId, text);
  } catch (error) {
    log.error("[delivery] notify failed", { error: String(error) });
  }
}

const PRE_ORDER: readonly string[] = DELIVERY_PRE_ORDER_CODES;

/** Исполнитель подписанного заказа. Зовётся из native-signing после approve. */
export function executeSignedDelivery(nonce: string): Promise<void> {
  const run = queue.then(() => runSignedDelivery(nonce));
  queue = run.catch(() => {});
  return run;
}

async function runSignedDelivery(nonce: string): Promise<void> {
  const order = pendingOrders.get(nonce);
  if (!order) return; // не наш nonce или заявка потеряна рестартом
  pendingOrders.delete(nonce);
  const gate = deps.gate();
  const { userId, chatId } = order;

  let maxFinal: number;
  try {
    const claimed = gate.claim(nonce, order.payload, deps.now());
    if (claimed.service !== DELIVERY_SERVICE || claimed.action !== DELIVERY_ACTION) {
      gate.abort(nonce, deps.now());
      return;
    }
    maxFinal = claimed.maxFinalRub;
  } catch (e) {
    await tell(userId, `Доставка не заказана: подпись не принята (${e instanceof SignedActionRefusal ? e.code : errorText(e)}).`);
    return;
  }

  const session = deps.session();
  const stop = async (text: string, screenshot?: string) => {
    try { gate.abort(nonce, deps.now()); } catch {}
    await tell(userId, `Доставка не заказана: ${text}.`, screenshot);
  };

  // 1. Подготовка: подписанные адреса, тариф и комментарий, цена со страницы.
  let prepared: DeliveryOutcome;
  try {
    prepared = await askMac({ op: "prepare", session, from: order.from, to: order.to, tariff: order.tariff, comment: order.comment }, userId, chatId);
  } catch (e) {
    return stop(`Mac не ответил на подготовку (${errorText(e)})`);
  }
  if (!prepared.ok) return stop(failText(prepared), prepared.screenshot);
  if (prepared.op !== "prepare") return stop("неожиданный ответ Mac");

  // 2. Сверка цены гейтом: выше потолка — отказ, без нажатия.
  try {
    gate.checkFinal(nonce, prepared.price_rub, deps.now());
  } catch (e) {
    await deps.send({ op: "abandon", session }, userId, chatId).catch(() => {});
    const code = e instanceof SignedActionRefusal ? e.code : errorText(e);
    await tell(userId, code === "price_deviation"
      ? `Доставка не заказана: цена выросла до ${prepared.price_rub} ₽, подписано не больше ${maxFinal} ₽. Пересчитай и подпиши заново.`
      : `Доставка не заказана: сверка цены не прошла (${code}).`);
    return;
  }

  // 3. Нажатие «Заказать» с тем же потолком на стороне Mac.
  let confirmed: DeliveryOutcome;
  try {
    confirmed = await askMac({ op: "confirm", session, maxRub: maxFinal }, userId, chatId);
  } catch (e) {
    // Кадр мог дойти и кнопка могла нажаться: не повторяем.
    try { gate.complete(nonce, false, deps.now()); } catch {}
    await tell(userId, `Не знаю, заказана ли доставка: ${errorText(e)}. Не повторяю — проверь DELIVERY_STATUS или приложение Яндекс Go.`);
    return;
  }
  if (!confirmed.ok) {
    if (PRE_ORDER.includes(confirmed.code)) return stop(failText(confirmed), confirmed.screenshot);
    try { gate.complete(nonce, false, deps.now()); } catch {}
    await tell(userId, `Не знаю, заказана ли доставка: ${failText(confirmed)}. Не повторяю — проверь DELIVERY_STATUS.`, confirmed.screenshot);
    return;
  }
  if (confirmed.op !== "confirm" || confirmed.state === "none" || confirmed.state === "unknown" || confirmed.state === "cancelled") {
    // Кнопка нажата, а заказа на странице не видно: считаем в лимит, но не «успехом».
    try { gate.complete(nonce, false, deps.now()); } catch {}
    const seen = confirmed.op === "confirm" ? `после нажатия «${DELIVERY_STATE_LABEL[confirmed.state]}»` : "неожиданный ответ Mac";
    await tell(userId, `Не знаю, заказана ли доставка: ${seen}. Не повторяю — проверь DELIVERY_STATUS или приложение Яндекс Go.`);
    return;
  }
  try { gate.complete(nonce, true, deps.now()); } catch (e) {
    log.error("[delivery] complete failed", { error: errorText(e) });
  }
  await tell(userId, `Курьер ${DELIVERY_TARIFFS[order.tariff]} заказан: ${order.from} → ${order.to}, ${prepared.price_rub} ₽. Сейчас: ${DELIVERY_STATE_LABEL[confirmed.state]}.`);
}

/** Для тестов: есть ли заявка, ждущая подписи. */
export const hasPendingDeliveryOrder = (nonce: string) => pendingOrders.has(nonce);
