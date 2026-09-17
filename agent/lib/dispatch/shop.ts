/**
 * Шаги 10a–10c: покупки в Яндекс Лавке, Яндекс Еде и Яндекс Маркете через браузер на Mac владельца.
 *
 *   SHOP_QUOTE  {service?, place?, queries}             — инлайново: адрес, доставка,
 *                                                         ресторан (Еда) и до трёх
 *                                                         товаров на запрос;
 *   ORDER_FOOD  {service, place?, lines[{id,name,qty,price_rub}], delivery_rub}
 *                                                       — карточка в чате (money), затем
 *                                                         заявка в подписанный гейт;
 *   MARKET_PURCHASE {lines[…], delivery_rub}            — то же для Маркета; доставка
 *                                                         там видна только на оформлении,
 *                                                         поэтому delivery_rub — сколько
 *                                                         владелец готов за неё заплатить;
 *   подпись на телефоне → исполнитель: claim → prepare → checkFinal → confirm;
 *   SHOP_STATUS {service?}                              — инлайново: состояние заказа.
 *
 * Деньги двигает только исполнитель и только по подписанному payload: в
 * корзину кладутся ровно подписанные товары, итог со страницы оформления
 * сверяется с подписанным потолком до нажатия «Оплатить». Адрес доставки
 * тоже подписан: если на сайте он сменился — отказ. В Еде подписан и ресторан:
 * исполнитель собирает корзину только в нём. Капчу не решаем.
 *
 * Ожидающие подписи заявки живут в памяти процесса — как у такси
 * (lib/dispatch/taxi.ts): рестарт их теряет, слот дневного лимита остаётся занят.
 */
import type { PayloadByType } from "../action-payload.ts";
import { sendShopToMac } from "../mac-bridge.ts";
import { signedActions } from "../native-signing.ts";
import { limitsFromEnv, maxRubFor, type SignedActions } from "../signed-actions.ts";
import { log } from "../log.ts";
import {
  MARKET_DELIVERY_MAX,
  normalizeShopPlaceName,
  normalizeShopQuery,
  normalizeShopService,
  parseShopOutcome,
  SHOP_FAIL_LABEL,
  SHOP_GATE_SERVICE,
  SHOP_ITEMS_MAX,
  SHOP_PLACED_STATES,
  SHOP_PRE_ORDER_CODES,
  SHOP_QUOTE_TTL_MS,
  SHOP_SERVICES,
  SHOP_STATE_LABEL,
  shopGateAction,
  shopLineSum,
  shopNeedsPlace,
  shopOrderType,
  shopStoreLabel,
  shopLineText,
  shopMaxFinal,
  type ShopCandidate,
  type ShopOutcome,
  type ShopPlace,
  type ShopRequest,
  type ShopService,
} from "../shop.ts";
import type { HandlerResult } from "./helpers.ts";
import {
  askYandexMac,
  errorText,
  gateIssueError,
  inlineDelegated,
  newYandexSession,
  refusalCode,
  serialQueue,
  yandexOwnerRefusal,
  yandexTeller,
  type MacReply,
  type YandexNotifier,
} from "./yandex-common.ts";

export type ShopHandlerContext = { agentKey: string; chatId: number };
export type ShopInlineContext = { agentKey: string; chatId: number; triggerUserId?: string; delegationChain?: string[] };

export type ShopNotifier = YandexNotifier;

export type ShopDeps = {
  send: (request: ShopRequest, userId: string, chatId: number) => Promise<MacReply>;
  gate: () => SignedActions;
  notify?: ShopNotifier;
  now: () => number;
  session: () => string;
};

const defaults: ShopDeps = {
  send: sendShopToMac,
  gate: signedActions,
  now: Date.now,
  session: newYandexSession,
};
let deps: ShopDeps = { ...defaults };

/** Подмена зависимостей (Telegram-уведомления на старте, заглушки в тестах). */
export function configureShop(patch: Partial<ShopDeps>) {
  const previous = deps;
  deps = { ...deps, ...patch };
  return () => { deps = previous; };
}

export const shopEnabled = () => process.env.SHOP_ENABLED === "true";

interface Quote {
  service: ShopService;
  place?: ShopPlace;
  address: string;
  delivery_rub: number | null;
  items: Map<string, ShopCandidate>;
  at: number;
}
interface PendingOrder {
  payload: string;
  userId: string;
  chatId: number;
  service: ShopService;
  place?: ShopPlace;
  address: string;
  lines: OrderLines;
  at: number;
}

type OrderLines = PayloadByType["ORDER_FOOD"]["lines"];

/** Последний расчёт на пользователя: заказывать можно только по нему. */
const quotes = new Map<string, Quote>();
/** nonce → заявка, ждущая подписи. */
const pendingOrders = new Map<string, PendingOrder>();
/** Исполнитель один: второй заказ ждёт, пока первый не закончится. */
const executor = serialQueue();

export function resetShopState() {
  quotes.clear();
  pendingOrders.clear();
  executor.reset();
}

const OWNER_POLICY = { enabled: shopEnabled, disabledText: "покупки выключены (SHOP_ENABLED)", scope: "shopping", ownerNoun: "покупки" };

function ownerRefusal(agentKey: string, chatId: number, userId: string | undefined, delegated: boolean): string | null {
  return yandexOwnerRefusal(OWNER_POLICY, agentKey, chatId, userId, delegated);
}

export type ShopToolResult = { ok: boolean } & Record<string, unknown>;

/** Запрос к Mac → проверенный ответ. Ошибка моста — исключение с её кодом. */
function askMac(request: ShopRequest, userId: string, chatId: number): Promise<ShopOutcome> {
  return askYandexMac<ShopRequest, ShopOutcome>(deps.send, parseShopOutcome, "shop_failed", request, userId, chatId);
}

const failText = (o: Extract<ShopOutcome, { ok: false }>) =>
  `${SHOP_FAIL_LABEL[o.code]}${o.price_rub ? ` (на странице ${o.price_rub} ₽)` : ""}`;

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
  const needsPlace = shopNeedsPlace(service);
  const placeQuery = needsPlace ? normalizeShopQuery(input.place) : undefined;
  if (needsPlace && !placeQuery) return { ok: false, error: "place — название ресторана, 2..80 символов" };
  if (!needsPlace && input.place !== undefined) return { ok: false, error: `у ${service} нет ресторана: place не нужен` };
  const userId = ctx.triggerUserId!;
  try {
    const request: ShopRequest = { op: "quote", service, ...(placeQuery ? { place: placeQuery } : {}), queries: unique };
    const out = await askMac(request, userId, ctx.chatId);
    if (!out.ok) return { ok: false, error: failText(out), code: out.code };
    if (out.op !== "quote") return { ok: false, error: "invalid_shop_result" };
    // Ресторан приходит ровно у тех сервисов, где он нужен.
    if (needsPlace !== (out.place !== undefined)) return { ok: false, error: "invalid_shop_result" };
    const items = new Map<string, ShopCandidate>();
    for (const r of out.results) for (const c of r.candidates) items.set(c.id, c);
    quotes.set(userId, { service, ...(out.place ? { place: out.place } : {}), address: out.address, delivery_rub: out.delivery_rub, items, at: deps.now() });
    return {
      ok: true,
      service,
      store: SHOP_SERVICES[service],
      ...(out.place ? { place: out.place.name } : {}),
      address: out.address,
      delivery_rub: out.delivery_rub,
      results: out.results,
      max_rub: maxRubFor(limitsFromEnv(), SHOP_GATE_SERVICE[service]),
      valid_min: Math.round(SHOP_QUOTE_TTL_MS / 60_000),
      note:
        `Это поиск, не заказ. Для заказа — ${shopOrderType(service)} с выбранными товарами: id, name и price_rub ровно из этого расчёта, qty — сколько просил владелец; ` +
        (out.place ? "place — ресторан ровно из расчёта; если он не тот, что имел в виду владелец, переспроси; " : "") +
        (service === "market" && out.delivery_rub === null
          ? `delivery_rub — сколько владелец готов заплатить за доставку (0..${MARKET_DELIVERY_MAX}; не сказал — спроси или 0). `
          : "delivery_rub — из расчёта (null → 0). ") +
        "Если товар неочевиден, спроси владельца, какой из вариантов.",
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

/** Позиции заявки → параметры подписи: магазин, ресторан, адрес, товары, доставка. */
function gateParams(quote: Quote, lines: OrderLines, deliveryRub: number): Record<string, string | number> {
  const params: Record<string, string | number> = { store: SHOP_SERVICES[quote.service] };
  if (quote.place) params.place = quote.place.name;
  params.address = quote.address;
  lines.forEach((l, i) => { params[`item_${String(i + 1).padStart(2, "0")}`] = shopLineText(l); });
  // В Маркете это потолок доставки, а не её цена.
  params[quote.service === "market" && quote.delivery_rub === null ? "delivery_max_rub" : "delivery_rub"] = deliveryRub;
  return params;
}

/**
 * ORDER_FOOD после одобрения в чате: сверка с расчётом и заявка в гейт.
 * Сам заказ не делается — его сделает исполнитель после подписи.
 */
export async function handleOrderFood(payload: PayloadByType["ORDER_FOOD"], ctx: ShopHandlerContext): Promise<HandlerResult> {
  if (payload.service === "market") return { ok: false, error: "для Маркета — MARKET_PURCHASE" };
  return issueShopOrder(payload.service, payload, ctx);
}

/** MARKET_PURCHASE после одобрения в чате: то же, что ORDER_FOOD, в Маркете. */
export async function handleMarketPurchase(payload: PayloadByType["MARKET_PURCHASE"], ctx: ShopHandlerContext): Promise<HandlerResult> {
  return issueShopOrder("market", payload, ctx);
}

type OrderInput = { place?: string; lines: OrderLines; delivery_rub: number; _userId?: string; _delegated?: boolean };

async function issueShopOrder(service: ShopService, payload: OrderInput, ctx: ShopHandlerContext): Promise<HandlerResult> {
  const refusal = ownerRefusal(ctx.agentKey, ctx.chatId, payload._userId, payload._delegated === true);
  if (refusal) return { ok: false, error: refusal };
  const userId = payload._userId!;
  const { lines, delivery_rub: delivery } = payload;
  const quote = quotes.get(userId);
  const now = deps.now();
  if (!quote || now - quote.at > SHOP_QUOTE_TTL_MS || quote.service !== service) {
    return { ok: false, error: "нет свежего расчёта в этом магазине: сначала SHOP_QUOTE и новое подтверждение" };
  }
  if ((quote.place?.name ?? undefined) !== (payload.place === undefined ? undefined : normalizeShopPlaceName(payload.place))) {
    return { ok: false, error: `в расчёте ресторан «${quote.place?.name ?? "—"}», а в заявке «${payload.place ?? "—"}»: пересчитай через SHOP_QUOTE` };
  }
  for (const line of lines) {
    const item = quote.items.get(line.id);
    if (!item) return { ok: false, error: `товара ${line.id} не было в расчёте` };
    if (item.name !== line.name || item.price_rub !== line.price_rub) {
      return { ok: false, error: `в расчёте «${item.name}» за ${item.price_rub} ₽, а в заявке «${line.name}» за ${line.price_rub} ₽: пересчитай через SHOP_QUOTE` };
    }
  }
  // Маркет не показывает доставку до оформления: владелец называет, сколько готов за неё отдать.
  const deliveryCap = service === "market" && quote.delivery_rub === null;
  if (deliveryCap ? !(Number.isSafeInteger(delivery) && delivery >= 0 && delivery <= MARKET_DELIVERY_MAX) : delivery !== (quote.delivery_rub ?? 0)) {
    return {
      ok: false,
      error: deliveryCap
        ? `delivery_rub — сколько владелец готов заплатить за доставку, 0..${MARKET_DELIVERY_MAX} ₽`
        : `доставка в расчёте ${quote.delivery_rub ?? 0} ₽, а в заявке ${delivery} ₽`,
    };
  }
  const amount = shopLineSum(lines) + delivery;
  try {
    const { nonce, payload: signed } = deps.gate().issue(
      { service: SHOP_GATE_SERVICE[service], action: shopGateAction(service), params: gateParams(quote, lines, delivery), amountRub: amount },
      now,
    );
    for (const [key, order] of pendingOrders) if (now - order.at > SHOP_QUOTE_TTL_MS) pendingOrders.delete(key);
    pendingOrders.set(nonce, { payload: signed, userId, chatId: ctx.chatId, service, ...(quote.place ? { place: quote.place } : {}), address: quote.address, lines, at: now });
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
    return { ok: false, error: gateIssueError(e) };
  }
}

const tell = yandexTeller("shop", () => deps.notify);

const PRE_ORDER: readonly string[] = SHOP_PRE_ORDER_CODES;
const GATE_SERVICES: readonly string[] = Object.values(SHOP_GATE_SERVICE);

/** Исполнитель подписанного заказа. Зовётся из native-signing после approve. */
export function executeSignedShop(nonce: string): Promise<void> {
  return executor.run(() => runSignedShop(nonce));
}

async function runSignedShop(nonce: string): Promise<void> {
  const order = pendingOrders.get(nonce);
  if (!order) return; // не наш nonce или заявка потеряна рестартом
  pendingOrders.delete(nonce);
  const gate = deps.gate();
  const { userId, chatId } = order;
  const store = shopStoreLabel(order.service, order.place?.name);

  let maxFinal: number;
  try {
    const claimed = gate.claim(nonce, order.payload, deps.now());
    if (!GATE_SERVICES.includes(claimed.service) || claimed.service !== SHOP_GATE_SERVICE[order.service] || claimed.action !== shopGateAction(order.service)) {
      gate.abort(nonce, deps.now());
      return;
    }
    maxFinal = claimed.maxFinalRub;
  } catch (e) {
    await tell(userId, `${store}: заказ не сделан — подпись не принята (${refusalCode(e)}).`);
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
      {
        op: "prepare",
        session,
        service: order.service,
        ...(order.place ? { place: order.place.ref } : {}),
        lines: order.lines.map(({ id, name, qty }) => ({ id, name, qty })),
      },
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
    const code = refusalCode(e);
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
