/**
 * Шаг 10a: покупки в Яндекс Лавке через браузер на Mac владельца.
 *
 *   SHOP_QUOTE  {service?, queries}                     — инлайново: адрес, доставка
 *                                                         и до трёх товаров на запрос;
 *   ORDER_FOOD  {service, lines[{id,name,qty,price_rub}], delivery_rub}
 *                                                       — карточка в чате (money), затем
 *                                                         заявка в подписанный гейт;
 *   подпись на телефоне → исполнитель: claim → prepare → checkFinal → confirm;
 *   SHOP_STATUS {service?}                              — инлайново: состояние заказа.
 *
 * Деньги двигает только исполнитель и только по подписанному payload: в
 * корзину кладутся ровно подписанные товары, итог со страницы оформления
 * сверяется с подписанным потолком до нажатия «Оплатить». Адрес доставки
 * тоже подписан: если на сайте он сменился — отказ. Капчу не решаем.
 *
 * Ожидающие подписи заявки живут в памяти процесса — как у такси
 * (lib/dispatch/taxi.ts): рестарт их теряет, слот дневного лимита остаётся занят.
 */
import { randomBytes } from "node:crypto";
import { parseUserIdList } from "../allowlist.ts";
import type { PayloadByType } from "../action-payload.ts";
import { sendShopToMac } from "../mac-bridge.ts";
import { signedActions } from "../native-signing.ts";
import { limitsFromEnv, SignedActionRefusal, type SignedActions } from "../signed-actions.ts";
import { log } from "../log.ts";
import {
  normalizeShopQuery,
  normalizeShopService,
  parseShopOutcome,
  SHOP_FAIL_LABEL,
  SHOP_GATE_ACTION,
  SHOP_GATE_SERVICE,
  SHOP_ITEMS_MAX,
  SHOP_PLACED_STATES,
  SHOP_PRE_ORDER_CODES,
  SHOP_QUOTE_TTL_MS,
  SHOP_SERVICES,
  SHOP_STATE_LABEL,
  shopLineSum,
  shopLineText,
  shopMaxFinal,
  type ShopCandidate,
  type ShopOutcome,
  type ShopRequest,
  type ShopService,
} from "../shop.ts";
import type { HandlerResult } from "./helpers.ts";

export type ShopHandlerContext = { agentKey: string; chatId: number };
export type ShopInlineContext = { agentKey: string; chatId: number; triggerUserId?: string; delegationChain?: string[] };

export type ShopNotifier = {
  text: (userId: string, text: string) => Promise<void>;
  photo: (userId: string, jpegBase64: string, caption: string) => Promise<void>;
};

export type ShopDeps = {
  send: (request: ShopRequest, userId: string, chatId: number) => Promise<{ ok: boolean; stdout: string; error?: string }>;
  gate: () => SignedActions;
  notify?: ShopNotifier;
  now: () => number;
  session: () => string;
};

const defaults: ShopDeps = {
  send: sendShopToMac,
  gate: signedActions,
  now: Date.now,
  session: () => randomBytes(24).toString("base64url"),
};
let deps: ShopDeps = { ...defaults };

/** Подмена зависимостей (Telegram-уведомления на старте, заглушки в тестах). */
export function configureShop(patch: Partial<ShopDeps>) {
  const previous = deps;
  deps = { ...deps, ...patch };
  return () => { deps = previous; };
}

export const shopEnabled = () => process.env.SHOP_ENABLED === "true";

interface Quote { service: ShopService; address: string; delivery_rub: number | null; items: Map<string, ShopCandidate>; at: number }
interface PendingOrder {
  payload: string;
  userId: string;
  chatId: number;
  service: ShopService;
  address: string;
  lines: PayloadByType["ORDER_FOOD"]["lines"];
  at: number;
}

/** Последний расчёт на пользователя: заказывать можно только по нему. */
const quotes = new Map<string, Quote>();
/** nonce → заявка, ждущая подписи. */
const pendingOrders = new Map<string, PendingOrder>();
/** Исполнитель один: второй заказ ждёт, пока первый не закончится. */
let queue: Promise<void> = Promise.resolve();

export function resetShopState() {
  quotes.clear();
  pendingOrders.clear();
  queue = Promise.resolve();
}

function ownerRefusal(agentKey: string, chatId: number, userId: string | undefined, delegated: boolean): string | null {
  if (!shopEnabled()) return "покупки выключены (SHOP_ENABLED)";
  if (agentKey !== "orchestrator") return `forbidden: shopping is restricted to orchestrator (caller: ${agentKey})`;
  const owners = parseUserIdList(process.env.MINIAPP_ADMIN_USER_IDS);
  if (delegated || !userId || !owners.includes(Number(userId)) || String(chatId) !== userId) {
    return "forbidden: покупки — только по просьбе владельца в его личном чате";
  }
  return null;
}

export type ShopToolResult = { ok: boolean } & Record<string, unknown>;

const inlineDelegated = (ctx: ShopInlineContext) => (ctx.delegationChain ?? []).some((k) => k !== ctx.agentKey);

/** Запрос к Mac → проверенный ответ. Ошибка моста — исключение с её кодом. */
async function askMac(request: ShopRequest, userId: string, chatId: number): Promise<ShopOutcome> {
  const res = await deps.send(request, userId, chatId);
  if (!res.ok) throw new Error(res.error ?? "shop_failed");
  return parseShopOutcome(res.stdout, request.op);
}

const failText = (o: Extract<ShopOutcome, { ok: false }>) =>
  `${SHOP_FAIL_LABEL[o.code]}${o.price_rub ? ` (на странице ${o.price_rub} ₽)` : ""}`;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** SHOP_QUOTE: что нашлось по запросам. Ничего не кладёт в корзину; расчёт живёт SHOP_QUOTE_TTL_MS. */
export async function quoteShop(input: Record<string, unknown>, ctx: ShopInlineContext): Promise<ShopToolResult> {
  const refusal = ownerRefusal(ctx.agentKey, ctx.chatId, ctx.triggerUserId, inlineDelegated(ctx));
  if (refusal) return { ok: false, error: refusal };
  const service = normalizeShopService(input.service);
  if (!service) return { ok: false, error: `service must be one of: ${Object.keys(SHOP_SERVICES).join(", ")}` };
  const raw = input.queries;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > SHOP_ITEMS_MAX) {
    return { ok: false, error: `queries — от 1 до ${SHOP_ITEMS_MAX} запросов` };
  }
  const queries = raw.map(normalizeShopQuery);
  if (queries.some((q) => !q)) return { ok: false, error: "каждый запрос — одна строка, 2..80 символов" };
  const unique = [...new Set(queries as string[])];
  const userId = ctx.triggerUserId!;
  try {
    const out = await askMac({ op: "quote", service, queries: unique }, userId, ctx.chatId);
    if (!out.ok) return { ok: false, error: failText(out), code: out.code };
    if (out.op !== "quote") return { ok: false, error: "invalid_shop_result" };
    const items = new Map<string, ShopCandidate>();
    for (const r of out.results) for (const c of r.candidates) items.set(c.id, c);
    quotes.set(userId, { service, address: out.address, delivery_rub: out.delivery_rub, items, at: deps.now() });
    return {
      ok: true,
      service,
      store: SHOP_SERVICES[service],
      address: out.address,
      delivery_rub: out.delivery_rub,
      results: out.results,
      max_rub: limitsFromEnv().maxRub,
      valid_min: Math.round(SHOP_QUOTE_TTL_MS / 60_000),
      note:
        "Это поиск, не заказ. Для заказа — ORDER_FOOD с выбранными товарами: id, name и price_rub ровно из этого расчёта, qty — сколько просил владелец; " +
        "delivery_rub — из расчёта (null → 0). Если товар неочевиден, спроси владельца, какой из вариантов.",
    };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

/** SHOP_STATUS: что сейчас с последним заказом. */
export async function shopStatus(input: Record<string, unknown>, ctx: ShopInlineContext): Promise<ShopToolResult> {
  const refusal = ownerRefusal(ctx.agentKey, ctx.chatId, ctx.triggerUserId, inlineDelegated(ctx));
  if (refusal) return { ok: false, error: refusal };
  const service = normalizeShopService(input.service);
  if (!service) return { ok: false, error: `service must be one of: ${Object.keys(SHOP_SERVICES).join(", ")}` };
  try {
    const out = await askMac({ op: "status", service }, ctx.triggerUserId!, ctx.chatId);
    if (!out.ok) return { ok: false, error: failText(out), code: out.code };
    if (out.op !== "status") return { ok: false, error: "invalid_shop_result" };
    return { ok: true, service, state: out.state, state_text: SHOP_STATE_LABEL[out.state] };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

const GATE_TEXT: Partial<Record<string, string>> = {
  no_active_key: "на телефоне нет активного ключа подписи — владелец регистрирует его в приложении",
  limit_amount: "сумма выше лимита на один заказ (PAID_ACTION_MAX_RUB)",
  limit_daily: "дневной лимит платных действий исчерпан",
  payload_invalid: "заявка не проходит проверку гейта",
};

/** Позиции заявки → параметры подписи: магазин, адрес, товары, доставка. */
function gateParams(quote: Quote, lines: PendingOrder["lines"], deliveryRub: number): Record<string, string | number> {
  const params: Record<string, string | number> = { store: SHOP_SERVICES[quote.service], address: quote.address };
  lines.forEach((l, i) => { params[`item_${String(i + 1).padStart(2, "0")}`] = shopLineText(l); });
  params.delivery_rub = deliveryRub;
  return params;
}

/**
 * ORDER_FOOD после одобрения в чате: сверка с расчётом и заявка в гейт.
 * Сам заказ не делается — его сделает исполнитель после подписи.
 */
export async function handleOrderFood(payload: PayloadByType["ORDER_FOOD"], ctx: ShopHandlerContext): Promise<HandlerResult> {
  const refusal = ownerRefusal(ctx.agentKey, ctx.chatId, payload._userId, payload._delegated === true);
  if (refusal) return { ok: false, error: refusal };
  const userId = payload._userId!;
  const { service, lines, delivery_rub: delivery } = payload;
  const quote = quotes.get(userId);
  const now = deps.now();
  if (!quote || now - quote.at > SHOP_QUOTE_TTL_MS || quote.service !== service) {
    return { ok: false, error: "нет свежего расчёта в этом магазине: сначала SHOP_QUOTE и новое подтверждение" };
  }
  for (const line of lines) {
    const item = quote.items.get(line.id);
    if (!item) return { ok: false, error: `товара ${line.id} не было в расчёте` };
    if (item.name !== line.name || item.price_rub !== line.price_rub) {
      return { ok: false, error: `в расчёте «${item.name}» за ${item.price_rub} ₽, а в заявке «${line.name}» за ${line.price_rub} ₽: пересчитай через SHOP_QUOTE` };
    }
  }
  if (delivery !== (quote.delivery_rub ?? 0)) {
    return { ok: false, error: `доставка в расчёте ${quote.delivery_rub ?? 0} ₽, а в заявке ${delivery} ₽` };
  }
  const amount = shopLineSum(lines) + delivery;
  try {
    const { nonce, payload: signed } = deps.gate().issue(
      { service: SHOP_GATE_SERVICE[service], action: SHOP_GATE_ACTION, params: gateParams(quote, lines, delivery), amountRub: amount },
      now,
    );
    for (const [key, order] of pendingOrders) if (now - order.at > SHOP_QUOTE_TTL_MS) pendingOrders.delete(key);
    pendingOrders.set(nonce, { payload: signed, userId, chatId: ctx.chatId, service, address: quote.address, lines, at: now });
    return {
      ok: true,
      result: {
        status: "awaiting_signature",
        amount_rub: amount,
        max_final_rub: shopMaxFinal(amount, deps.gate().limits.deviationPct),
        note: "Заказ ещё НЕ сделан. Владелец подтверждает его Face ID в приложении в течение 2 минут; результат придёт отдельным сообщением.",
      },
    };
  } catch (e) {
    if (e instanceof SignedActionRefusal) return { ok: false, error: GATE_TEXT[e.code] ?? e.code };
    return { ok: false, error: errorText(e) };
  }
}

async function tell(userId: string, text: string, screenshot?: string) {
  const notify = deps.notify;
  if (!notify) {
    log.warn("[shop] notifier is not configured", { text });
    return;
  }
  try {
    if (screenshot) await notify.photo(userId, screenshot, text);
    else await notify.text(userId, text);
  } catch (error) {
    log.error("[shop] notify failed", { error: String(error) });
  }
}

const PRE_ORDER: readonly string[] = SHOP_PRE_ORDER_CODES;
const GATE_SERVICES: readonly string[] = Object.values(SHOP_GATE_SERVICE);

/** Исполнитель подписанного заказа. Зовётся из native-signing после approve. */
export function executeSignedShop(nonce: string): Promise<void> {
  const run = queue.then(() => runSignedShop(nonce));
  queue = run.catch(() => {});
  return run;
}

async function runSignedShop(nonce: string): Promise<void> {
  const order = pendingOrders.get(nonce);
  if (!order) return; // не наш nonce или заявка потеряна рестартом
  pendingOrders.delete(nonce);
  const gate = deps.gate();
  const { userId, chatId } = order;
  const store = SHOP_SERVICES[order.service];

  let maxFinal: number;
  try {
    const claimed = gate.claim(nonce, order.payload, deps.now());
    if (!GATE_SERVICES.includes(claimed.service) || claimed.service !== SHOP_GATE_SERVICE[order.service] || claimed.action !== SHOP_GATE_ACTION) {
      gate.abort(nonce, deps.now());
      return;
    }
    maxFinal = claimed.maxFinalRub;
  } catch (e) {
    await tell(userId, `${store}: заказ не сделан — подпись не принята (${e instanceof SignedActionRefusal ? e.code : errorText(e)}).`);
    return;
  }

  const session = deps.session();
  const stop = async (text: string, screenshot?: string) => {
    try { gate.abort(nonce, deps.now()); } catch {}
    await tell(userId, `${store}: заказ не сделан — ${text}.`, screenshot);
  };
  const abandon = () => deps.send({ op: "abandon", session }, userId, chatId).catch(() => {});

  // 1. Подготовка: подписанные товары в пустую корзину, итог со страницы оформления.
  let prepared: ShopOutcome;
  try {
    prepared = await askMac(
      { op: "prepare", session, service: order.service, lines: order.lines.map(({ id, name, qty }) => ({ id, name, qty })) },
      userId,
      chatId,
    );
  } catch (e) {
    // До «Оплатить» prepare не доходит никогда: заказа точно нет. Корзину мог оставить — просим убрать.
    await abandon();
    return stop(`Mac не ответил на подготовку (${errorText(e)}); проверь корзину`);
  }
  if (!prepared.ok) return stop(failText(prepared), prepared.screenshot);
  if (prepared.op !== "prepare") {
    await abandon();
    return stop("неожиданный ответ Mac");
  }
  if (prepared.address !== order.address) {
    await abandon();
    return stop(`адрес доставки на сайте сменился («${prepared.address}», подписан «${order.address}»)`);
  }

  // 2. Сверка итога гейтом: выше потолка — отказ, без нажатия.
  try {
    gate.checkFinal(nonce, prepared.total_rub, deps.now());
  } catch (e) {
    await abandon();
    const code = e instanceof SignedActionRefusal ? e.code : errorText(e);
    await tell(userId, code === "price_deviation"
      ? `${store}: заказ не сделан — итог вырос до ${prepared.total_rub} ₽, подписано не больше ${maxFinal} ₽. Пересчитай и подпиши заново.`
      : `${store}: заказ не сделан — сверка итога не прошла (${code}).`);
    return;
  }

  // 3. Нажатие «Оплатить» с тем же потолком на стороне Mac.
  const unknown = async (why: string, screenshot?: string) => {
    try { gate.complete(nonce, false, deps.now()); } catch {}
    await tell(userId, `Не знаю, оформлен ли заказ в ${store}: ${why}. Не повторяю — проверь SHOP_STATUS или приложение.`, screenshot);
  };
  let confirmed: ShopOutcome;
  try {
    confirmed = await askMac({ op: "confirm", session, maxRub: maxFinal }, userId, chatId);
  } catch (e) {
    // Кадр мог дойти и кнопка могла нажаться: не повторяем.
    return unknown(errorText(e));
  }
  if (!confirmed.ok) {
    if (PRE_ORDER.includes(confirmed.code)) return stop(failText(confirmed), confirmed.screenshot);
    return unknown(failText(confirmed), confirmed.screenshot);
  }
  if (confirmed.op !== "confirm") return unknown("неожиданный ответ Mac");
  if (!SHOP_PLACED_STATES.includes(confirmed.state)) {
    // Кнопка нажата, а оплаченного заказа не видно (3-D Secure, отмена, чужая вёрстка):
    // считаем в лимит, но не «успехом».
    return unknown(`после нажатия «${SHOP_STATE_LABEL[confirmed.state]}»`);
  }
  try { gate.complete(nonce, true, deps.now()); } catch (e) {
    log.error("[shop] complete failed", { error: errorText(e) });
  }
  await tell(userId, `${store}: заказ оформлен — ${order.lines.map(shopLineText).join("; ")}. Итог ${prepared.total_rub} ₽. Сейчас: ${SHOP_STATE_LABEL[confirmed.state]}.`);
}

/** Для тестов: есть ли заявка, ждущая подписи. */
export const hasPendingShopOrder = (nonce: string) => pendingOrders.has(nonce);
