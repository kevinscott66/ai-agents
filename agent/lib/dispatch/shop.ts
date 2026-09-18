/**
 * Шаги 10a–10c: покупки в Яндекс Лавке, Яндекс Еде и Яндекс Маркете через браузер на Mac владельца.
 *
 *   SHOP_PLACES {query, max_eta_min?}                   — инлайново: рестораны Еды по
 *                                                         запросу и время доставки;
 *   SHOP_QUOTE  {service?, place?, max_eta_min?, queries} — инлайново: адрес, доставка,
 *                                                         ресторан (Еда) и до трёх
 *                                                         товаров на запрос;
 *   SHOP_CHECKOUT {service, place?, lines[…]}           — инлайново: выбранное в пустую
 *                                                         корзину, итог со страницы
 *                                                         оформления (сервисный сбор,
 *                                                         маленький заказ), корзину —
 *                                                         обратно пустой;
 *   ORDER_FOOD  {service, place?, lines[{id,name,qty,price_rub,options?}], delivery_rub, total_rub}
 *                                                       — карточка в чате (money), затем
 *                                                         заявка в подписанный гейт на
 *                                                         итог из SHOP_CHECKOUT;
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
import { watchPlacedOrder } from "../order-watch.ts";
import { signedActions } from "../native-signing.ts";
import { limitsFromEnv, maxRubFor, type SignedActions } from "../signed-actions.ts";
import { log } from "../log.ts";
import {
  isShopMaxEta,
  MARKET_DELIVERY_MAX,
  SHOP_MAX_ETA_MAX,
  SHOP_MAX_ETA_MIN,
  shopPlaceEtaText,
  shopPlaceFits,
  normalizeShopAddress,
  normalizeShopPlaceName,
  normalizeShopQuery,
  parseOrderFood,
  shopCheckoutTotalFits,
  shopExtraText,
  shopOrderExtra,
  shopOrderLinesInput,
  normalizeShopService,
  parseShopOutcome,
  resolveShopOptions,
  SHOP_FAIL_LABEL,
  SHOP_RECOVERY,
  type ShopRecovery,
  SHOP_GATE_SERVICE,
  SHOP_ITEMS_MAX,
  SHOP_LINE_TEXT_MAX,
  SHOP_PLACED_STATES,
  SHOP_PRE_ORDER_CODES,
  SHOP_QUOTE_TTL_MS,
  SHOP_SERVICES,
  SHOP_STATE_LABEL,
  shopCanSetAddress,
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
  sleep: (ms: number) => Promise<void>;
};

const defaults: ShopDeps = {
  send: sendShopToMac,
  gate: signedActions,
  now: Date.now,
  session: newYandexSession,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
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
  /** Последний SHOP_CHECKOUT по этому расчёту: какие позиции и какой итог. */
  checkout?: { key: string; total_rub: number; at: number };
}
interface PendingOrder {
  payload: string;
  userId: string;
  chatId: number;
  agentKey: string;
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
/**
 * Браузер покупок на Mac один: все запросы к нему — поиск, статус, предпросмотр,
 * подписанный заказ — идут отсюда по одному. Иначе второй получает `shop_busy`.
 */
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

const SERVICE_ERROR = `service must be one of: ${Object.keys(SHOP_SERVICES).join(", ")}`;

/** Пролог инлайновых инструментов: владелец в личном чате и известный сервис. */
function inlineService(input: Record<string, unknown>, ctx: ShopInlineContext): { service: ShopService } | { error: string } {
  const refusal = ownerRefusal(ctx.agentKey, ctx.chatId, ctx.triggerUserId, inlineDelegated(ctx));
  if (refusal) return { error: refusal };
  const service = normalizeShopService(input.service);
  return service ? { service } : { error: SERVICE_ERROR };
}

/** Расчёт этого пользователя в этом магазине, если ещё не истёк. */
function freshQuote(userId: string, service: ShopService, now: number): Quote | null {
  const quote = quotes.get(userId);
  return quote && now - quote.at <= SHOP_QUOTE_TTL_MS && quote.service === service ? quote : null;
}

/** Ресторан заявки не тот, что в расчёте: текст отказа, иначе null. */
function placeMismatch(quote: Quote, place: string | null | undefined, where: string): string | null {
  return (quote.place?.name ?? undefined) === place
    ? null
    : `в расчёте ресторан «${quote.place?.name ?? "—"}», а ${where} «${place ?? "—"}»: пересчитай через SHOP_QUOTE`;
}

/** Запрос на сборку корзины: только то, что Mac нужно знать о позициях. */
function prepareRequest(session: string, service: ShopService, place: ShopPlace | undefined, lines: OrderLines): ShopRequest {
  return {
    op: "prepare",
    session,
    service,
    ...(place ? { place: place.ref } : {}),
    lines: lines.map(({ id, name, qty, options }) => ({ id, name, qty, ...(options ? { options } : {}) })),
  };
}

/**
 * Сколько ждать, пока браузер покупок на Mac освободится. Мост бросает запрос
 * через MAC_SHOP_TIMEOUT_MS, а Mac дорабатывает до своего срока (плюс отмена и
 * закрытие браузера) — ещё около минуты. Все свои запросы сервер ставит в
 * очередь, так что `shop_busy` — это хвост брошенного запроса: переждать его
 * дешевле, чем отдать агенту отказ, после которого он бросает заказ.
 *
 * Переждать удаётся не всегда: 2026-09-18 после выкатки очереди Mac держал
 * замок дольше этих 75 с. Поэтому если занятость не прошла за один опрос,
 * сервер просит Mac сбросить браузер (op reset) — чужой хвост никому не нужен.
 * Оформление с «Оплатить» Mac не сбрасывает (shop_paying), его сервер ждёт.
 */
export const SHOP_BUSY_WAIT_MS = 75_000;
const SHOP_BUSY_POLL_MS = 5_000;
/** С какого по счёту shop_busy подряд просить сброс: первый может быть мгновенным хвостом. */
const SHOP_BUSY_RESET_AT = 2;

/** Сброс брошенного запуска. Сбой сброса (старый демон, обрыв) — только в журнал: дальше обычное ожидание. */
async function resetMac(held: Extract<ShopOutcome, { ok: false }>, userId: string, chatId: number): Promise<void> {
  const busy = { busy_op: held.busy_op ?? null, busy_ms: held.busy_ms ?? null };
  try {
    const out = await askYandexMac<ShopRequest, ShopOutcome>(deps.send, parseShopOutcome, "shop_failed", { op: "reset" }, userId, chatId);
    log.warn("[shop] mac reset", { ...busy, ok: out.ok, ...(out.ok ? { reset: out.op === "reset" && out.reset } : { code: out.code }) });
  } catch (e) {
    log.warn("[shop] mac reset", { ...busy, error: errorText(e) });
  }
}

/**
 * Сколько ждать переподключения Mac. `mac_offline` мост отдаёт до отправки —
 * запрос не ушёл, так что повтор безопасен для любой операции, даже оплаты.
 * Частый случай — демон перезапускается или ноутбук просыпается.
 */
export const SHOP_OFFLINE_WAIT_MS = 60_000;
/**
 * Операции, которые можно повторить после обрыва связи (`mac_disconnected`):
 * запрос мог дойти, но они только читают. prepare и confirm трогают корзину и
 * деньги — их после обрыва не повторяем.
 */
const SHOP_REDIAL_OPS: readonly ShopRequest["op"][] = ["quote", "places", "status"];

/**
 * Запрос к Mac → проверенный ответ. Ошибка моста — исключение с её кодом.
 * Известные временные сбои сервер лечит сам, не отдавая их агенту (этап 2
 * автономии): занятость (ожидание и сброс), Mac не на связи (ожидание
 * переподключения), Chrome не запустился (ещё один запуск), обрыв на чтении
 * (один повтор).
 */
async function askMac(request: ShopRequest, userId: string, chatId: number): Promise<ShopOutcome> {
  const started = deps.now();
  let busyCount = 0;
  let relaunched = false;
  let redialed = false;
  for (;;) {
    let out: ShopOutcome;
    try {
      out = await askYandexMac<ShopRequest, ShopOutcome>(deps.send, parseShopOutcome, "shop_failed", request, userId, chatId);
    } catch (e) {
      const code = errorText(e);
      const ms = deps.now() - started;
      if (code === "mac_offline" && ms < SHOP_OFFLINE_WAIT_MS) {
        await deps.sleep(SHOP_BUSY_POLL_MS);
        continue;
      }
      if (code === "mac_disconnected" && !redialed && SHOP_REDIAL_OPS.includes(request.op)) {
        redialed = true;
        log.warn("[shop] mac redial", { op: request.op, ms });
        await deps.sleep(SHOP_BUSY_POLL_MS);
        continue;
      }
      log.warn("[shop] mac", { op: request.op, error: code, ms });
      throw e;
    }
    // Chrome не поднялся (профиль ещё держит прошлый процесс, Mac только проснулся):
    // второй запуск через паузу. Для confirm смысла нет — без браузера нет и сессии.
    if (!out.ok && out.code === "browser_unavailable" && !relaunched && request.op !== "confirm") {
      relaunched = true;
      log.warn("[shop] mac relaunch", { op: request.op, ms: deps.now() - started });
      await deps.sleep(SHOP_BUSY_POLL_MS);
      continue;
    }
    const busy = !out.ok && out.code === "shop_busy";
    if (!busy || deps.now() - started >= SHOP_BUSY_WAIT_MS) {
      // Только операция и исход: адреса и товары — личные, в журнал не идут.
      const held = !out.ok && out.busy_op ? { busy_op: out.busy_op, busy_ms: out.busy_ms } : {};
      log.info("[shop] mac", { op: request.op, ok: out.ok, ...(out.ok ? {} : { code: out.code }), ...held, ms: deps.now() - started });
      return out;
    }
    busyCount++;
    if (busyCount === SHOP_BUSY_RESET_AT && !out.ok) await resetMac(out, userId, chatId);
    await deps.sleep(SHOP_BUSY_POLL_MS);
  }
}

const failText = (o: Extract<ShopOutcome, { ok: false }>) =>
  `${SHOP_FAIL_LABEL[o.code]}${o.price_rub ? ` (на странице ${o.price_rub} ₽)` : ""}`;

const recoveryFields = (r: ShopRecovery) => ({ next: r.next, owner_needed: r.owner });

/** Отказ Mac для агента: текст, код и что делать дальше (SHOP_RECOVERY). */
const shopFail = (o: Extract<ShopOutcome, { ok: false }>): ShopToolResult => ({
  ok: false, error: failText(o), code: o.code, ...recoveryFields(SHOP_RECOVERY[o.code]),
});

/** Сбои моста — те же поля, что у отказов Mac. Повторы, безопасные без агента, askMac уже сделал. */
const MAC_ERROR_RECOVERY: Record<string, ShopRecovery> = {
  mac_offline: { owner: true, next: "Mac не на связи больше минуты (крышка закрыта или нет сети) — скажи владельцу одной фразой; не проси перезапускать демон" },
  mac_disconnected: { owner: false, next: "связь с Mac оборвалась посреди запроса — повтори вызов сам один раз; заказ (ORDER_FOOD) не повторяй, сначала SHOP_STATUS" },
  mac_timeout: { owner: false, next: "Mac не успел ответить — повтори вызов сам один раз; заказ (ORDER_FOOD) не повторяй, сначала SHOP_STATUS" },
};

function macFail(e: unknown, suffix = ""): ShopToolResult {
  const message = errorText(e);
  const code = /^[a-z_]+/.exec(message)?.[0] ?? "shop_failed";
  const recovery = MAC_ERROR_RECOVERY[code];
  return { ok: false, error: `${message}${suffix}`, code, ...(recovery ? recoveryFields(recovery) : {}) };
}

/** SHOP_QUOTE: что нашлось по запросам. Ничего не кладёт в корзину; расчёт живёт SHOP_QUOTE_TTL_MS. */
export async function quoteShop(input: Record<string, unknown>, ctx: ShopInlineContext): Promise<ShopToolResult> {
  const picked = inlineService(input, ctx);
  if ("error" in picked) return { ok: false, error: picked.error };
  const { service } = picked;
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
  const maxEta = input.max_eta_min;
  if (maxEta !== undefined && !needsPlace) return { ok: false, error: `у ${service} нет ресторана: max_eta_min не нужен` };
  if (maxEta !== undefined && !isShopMaxEta(maxEta)) return { ok: false, error: MAX_ETA_ERROR };
  const userId = ctx.triggerUserId!;
  try {
    const request: ShopRequest = {
      op: "quote", service, ...(placeQuery ? { place: placeQuery } : {}), ...(maxEta !== undefined ? { max_eta_min: maxEta } : {}), queries: unique,
    };
    const out = await executor.run(() => askMac(request, userId, ctx.chatId));
    if (!out.ok) return shopFail(out);
    if (out.op !== "quote") return { ok: false, error: "invalid_shop_result" };
    // Ресторан приходит ровно у тех сервисов, где он нужен.
    if (needsPlace !== (out.place !== undefined)) return { ok: false, error: "invalid_shop_result" };
    // С пределом Mac обязан вернуть успевающий ресторан — не верим на слово.
    if (maxEta !== undefined && !shopPlaceFits(out.place!, maxEta)) return { ok: false, error: "invalid_shop_result" };
    const items = new Map<string, ShopCandidate>();
    for (const r of out.results) for (const c of r.candidates) items.set(c.id, c);
    quotes.set(userId, { service, ...(out.place ? { place: out.place } : {}), address: out.address, delivery_rub: out.delivery_rub, items, at: deps.now() });
    return {
      ok: true,
      service,
      store: SHOP_SERVICES[service],
      ...(out.place ? { place: out.place.name } : {}),
      ...(out.place?.eta ? { place_eta: shopPlaceEtaText(out.place.eta) } : {}),
      address: out.address,
      delivery_rub: out.delivery_rub,
      results: out.results,
      max_rub: maxRubFor(limitsFromEnv(), SHOP_GATE_SERVICE[service]),
      valid_min: Math.round(SHOP_QUOTE_TTL_MS / 60_000),
      note:
        `Это поиск, не заказ. Для заказа — ${shopOrderType(service)} с выбранными товарами: id, name и price_rub ровно из этого расчёта, qty — сколько просил владелец; ` +
        (out.place ? "place — ресторан ровно из расчёта; если он не тот, что имел в виду владелец, переспроси; " : "") +
        (out.results.some((r) => r.candidates.some((c) => c.options))
          ? "у блюда с options выбор делает владелец: в каждой группе отметь от min до max вариантов (min ≥ 1 — обязательно, не знаешь выбор — спроси, не выбирай сам), " +
            "в заявке options — [{group, name}] ровно из расчёта, price_rub — цена блюда плюс доплаты выбранных вариантов; " : "") +
        (service === "market" && out.delivery_rub === null
          ? `delivery_rub — сколько владелец готов заплатить за доставку (0..${MARKET_DELIVERY_MAX}; не сказал — спроси или 0). `
          : "delivery_rub — из расчёта (null → 0). ") +
        "Если товар неочевиден, спроси владельца, какой из вариантов.",
    };
  } catch (e) {
    return macFail(e);
  }
}

const MAX_ETA_ERROR = `max_eta_min — целые минуты от ${SHOP_MAX_ETA_MIN} до ${SHOP_MAX_ETA_MAX}`;

/**
 * SHOP_PLACES: рестораны Еды по запросу («шаверма», «пицца», название) и
 * сколько каждый сейчас везёт. С пределом — только успевающие, быстрые
 * первыми. Ничего не открывает в ресторанах и не трогает корзину.
 */
export async function listShopPlaces(input: Record<string, unknown>, ctx: ShopInlineContext): Promise<ShopToolResult> {
  const refusal = ownerRefusal(ctx.agentKey, ctx.chatId, ctx.triggerUserId, inlineDelegated(ctx));
  if (refusal) return { ok: false, error: refusal };
  const query = normalizeShopQuery(input.query);
  if (!query) return { ok: false, error: "query — что искать, одна строка 2..80 символов" };
  const maxEta = input.max_eta_min;
  if (maxEta !== undefined && !isShopMaxEta(maxEta)) return { ok: false, error: MAX_ETA_ERROR };
  try {
    const out = await executor.run(() => askMac(
      { op: "places", service: "eda", query, ...(maxEta !== undefined ? { max_eta_min: maxEta } : {}) },
      ctx.triggerUserId!, ctx.chatId,
    ));
    if (!out.ok) return shopFail(out);
    if (out.op !== "places") return { ok: false, error: "invalid_shop_result" };
    if (maxEta !== undefined && !out.places.every((p) => shopPlaceFits(p, maxEta))) return { ok: false, error: "invalid_shop_result" };
    return {
      ok: true,
      store: SHOP_SERVICES.eda,
      address: out.address,
      ...(maxEta !== undefined ? { max_eta_min: maxEta } : {}),
      places: out.places.map((p) => ({ name: p.name, eta: p.eta ? shopPlaceEtaText(p.eta) : null })),
      note:
        (out.places.length
          ? "eta — сколько ресторан сейчас обещает везти (null — не пишет, скорее всего закрыт). Покажи владельцу варианты или возьми тот, что он назвал; "
          : maxEta !== undefined ? "Никто не успевает к этому сроку: скажи владельцу и спроси, подождёт ли дольше. " : "Ничего не нашлось: спроси владельца, как ещё поискать. ") +
        "дальше — SHOP_QUOTE {service: \"eda\", place: name ровно отсюда" +
        (maxEta !== undefined ? ", max_eta_min — тот же" : "") +
        ", queries}. У сети бывает несколько точек с одним названием: с max_eta_min расчёт возьмёт самую быструю из успевающих.",
    };
  } catch (e) {
    return macFail(e);
  }
}

/**
 * SHOP_CHECKOUT: выбранные позиции в пустую корзину, итог со страницы
 * оформления — туда Еда и Лавка добавляют сервисный сбор и доплату за
 * маленький заказ, которых нет в меню, — и корзину обратно пустой. Денег не
 * трогает: «Оплатить» жмёт только исполнитель после подписи. Итог
 * запоминается при расчёте, ORDER_FOOD подписывает ровно его.
 */
export async function checkoutShop(input: Record<string, unknown>, ctx: ShopInlineContext): Promise<ShopToolResult> {
  const picked = inlineService(input, ctx);
  if ("error" in picked) return { ok: false, error: picked.error };
  const { service } = picked;
  if (service === "market") return { ok: false, error: "у Маркета доставка видна только на оформлении: сразу MARKET_PURCHASE" };
  const userId = ctx.triggerUserId!;
  const quote = freshQuote(userId, service, deps.now());
  if (!quote) return { ok: false, error: "нет свежего расчёта в этом магазине: сначала SHOP_QUOTE" };
  if (!Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > SHOP_ITEMS_MAX) {
    return { ok: false, error: `lines — от 1 до ${SHOP_ITEMS_MAX} товаров из SHOP_QUOTE` };
  }
  const parsed = parseOrderFood({
    service,
    ...(input.place !== undefined ? { place: normalizeShopPlaceName(input.place) } : {}),
    lines: shopOrderLinesInput(input.lines),
    delivery_rub: quote.delivery_rub ?? 0,
  });
  if (!parsed) return { ok: false, error: "каждый товар — {id, name, qty, price_rub, options?} ровно как для ORDER_FOOD" };
  const wrongPlace = placeMismatch(quote, parsed.place, "здесь");
  if (wrongPlace) return { ok: false, error: wrongPlace };
  const checked = checkLines(quote, parsed.lines);
  if ("error" in checked) return { ok: false, error: checked.error };
  const lines = checked.lines;
  // Тот же исполнитель, что у подписанных заказов: браузер один, пусть ждёт, а не отбивается «занят».
  return executor.run(async () => {
    const session = deps.session();
    let out: ShopOutcome;
    try {
      out = await askMac(prepareRequest(session, service, quote.place, lines), userId, ctx.chatId);
    } catch (e) {
      await deps.send({ op: "abandon", session }, userId, ctx.chatId).catch(() => {});
      return macFail(e, "; корзину попросил очистить");
    }
    // Корзина собрана (или собрана наполовину, если Mac отказал) — очищаем сразу,
    // до любых проверок: заказ сделает исполнитель заново.
    const cleared = await askMac({ op: "abandon", session }, userId, ctx.chatId).then((done) => done.ok, () => false);
    if (!out.ok) {
      const fail = shopFail(out);
      return cleared ? fail : { ...fail, error: `${fail.error}; корзину очистить не удалось` };
    }
    if (!cleared) return { ok: false, error: "итог прочитан, но корзину очистить не удалось — пусть владелец проверит корзину, потом повтори" };
    if (out.op !== "prepare") return { ok: false, error: "invalid_shop_result" };
    if (out.address !== quote.address) {
      return { ok: false, error: "адрес доставки на сайте сменился после расчёта: пересчитай через SHOP_QUOTE" };
    }
    const delivery = quote.delivery_rub ?? 0;
    const items = shopLineSum(lines);
    if (!shopCheckoutTotalFits(out.total_rub, items + delivery)) return { ok: false, error: "invalid_shop_result" };
    quote.checkout = { key: linesKey(lines), total_rub: out.total_rub, at: deps.now() };
    const extra = shopOrderExtra({ lines, delivery_rub: delivery, total_rub: out.total_rub });
    return {
      ok: true,
      service,
      store: SHOP_SERVICES[service],
      ...(quote.place ? { place: quote.place.name } : {}),
      items_rub: items,
      delivery_rub: delivery,
      extra_rub: extra,
      total_rub: out.total_rub,
      note:
        "Корзина снова пуста, ничего не заказано. total_rub — сколько спишут на самом деле: " +
        (extra > 0
          ? `сверху товаров и доставки ${shopExtraText(extra)} (сервисный сбор, доплата за маленький заказ). Назови владельцу итог и из чего он сложился; ` +
            "если часть — доплата за маленький заказ, предложи добавить позицию (новый SHOP_QUOTE и SHOP_CHECKOUT) — решает владелец. "
          : extra < 0 ? `это на ${-extra} ₽ меньше товаров с доставкой — скидка или промокод. ` : "сборов сверху нет. ") +
        "Согласие владельца на эту сумму — только его слова в чате, за него не решай. Дальше — ORDER_FOOD с этими же позициями и total_rub ровно отсюда.",
    };
  });
}

/** SHOP_STATUS: что сейчас с последним заказом. */
export async function shopStatus(input: Record<string, unknown>, ctx: ShopInlineContext): Promise<ShopToolResult> {
  const picked = inlineService(input, ctx);
  if ("error" in picked) return { ok: false, error: picked.error };
  const { service } = picked;
  try {
    const out = await executor.run(() => askMac({ op: "status", service }, ctx.triggerUserId!, ctx.chatId));
    if (!out.ok) return shopFail(out);
    if (out.op !== "status") return { ok: false, error: "invalid_shop_result" };
    return { ok: true, service, state: out.state, state_text: SHOP_STATE_LABEL[out.state], eta_min: out.eta_min };
  } catch (e) {
    return macFail(e);
  }
}

/**
 * SHOP_SET_ADDRESS: переключить доставку на другой адрес владельца.
 *
 * Выбираем только из уже сохранённых в сервисе адресов и только когда запрос
 * подходит ровно одному из них: новых адресов агент не заводит и сам за
 * владельца не решает. Список сохранённых наружу не отдаём — это личные данные;
 * в ответе только сколько их и что стоит в шапке сейчас.
 */
export async function setShopAddress(input: Record<string, unknown>, ctx: ShopInlineContext): Promise<ShopToolResult> {
  const picked = inlineService(input, ctx);
  if ("error" in picked) return { ok: false, error: picked.error };
  const { service } = picked;
  if (!shopCanSetAddress(service)) {
    return { ok: false, error: `у ${SHOP_SERVICES[service]} адрес — это пункт выдачи, его выбирает владелец сам` };
  }
  const address = normalizeShopAddress(input.address);
  if (!address) return { ok: false, error: "address — одна строка, 3..200 символов" };
  const userId = ctx.triggerUserId!;
  try {
    const out = await executor.run(() => askMac({ op: "set_address", service, address }, userId, ctx.chatId));
    if (!out.ok) return shopFail(out);
    if (out.op !== "set_address") return { ok: false, error: "invalid_shop_result" };
    // Адрес сменился — прошлый расчёт больше не про этот адрес.
    if (out.matched) quotes.delete(userId);
    return out.matched
      ? { ok: true, service, store: SHOP_SERVICES[service], address: out.address, note: "Адрес доставки переключён. Прошлый расчёт больше не действует — посчитай заново." }
      : {
        ok: false,
        service,
        store: SHOP_SERVICES[service],
        address: out.address,
        saved_count: out.saved_count,
        error: out.saved_count === 0
          ? "в этом сервисе нет сохранённых адресов"
          : "такой адрес не нашёлся среди сохранённых или подходит сразу нескольким",
        note: "Новый адрес агент не заводит: попроси владельца добавить или выбрать адрес самому. Адрес доставки не менялся.",
      };
  } catch (e) {
    return macFail(e);
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

type OrderInput = { place?: string; lines: OrderLines; delivery_rub: number; total_rub?: number; _userId?: string; _delegated?: boolean };

async function issueShopOrder(service: ShopService, payload: OrderInput, ctx: ShopHandlerContext): Promise<HandlerResult> {
  const refusal = ownerRefusal(ctx.agentKey, ctx.chatId, payload._userId, payload._delegated === true);
  if (refusal) return { ok: false, error: refusal };
  const userId = payload._userId!;
  const { lines, delivery_rub: delivery } = payload;
  const now = deps.now();
  const quote = freshQuote(userId, service, now);
  if (!quote) return { ok: false, error: "нет свежего расчёта в этом магазине: сначала SHOP_QUOTE и новое подтверждение" };
  const wrongPlace = placeMismatch(quote, payload.place === undefined ? undefined : normalizeShopPlaceName(payload.place), "в заявке");
  if (wrongPlace) return { ok: false, error: wrongPlace };
  const checked = checkLines(quote, lines);
  if ("error" in checked) return { ok: false, error: checked.error };
  const signedLines = checked.lines;
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
  // Лавка и Еда подписывают итог со страницы оформления: только он знает
  // сервисный сбор и доплату за маленький заказ. Без него подписанная сумма
  // ниже настоящей, и исполнитель честно откажет на сверке.
  let amount = shopLineSum(signedLines) + delivery;
  if (service !== "market") {
    const checkout = quote.checkout;
    if (!checkout || checkout.key !== linesKey(signedLines) || now - checkout.at > SHOP_QUOTE_TTL_MS) {
      return { ok: false, error: "нет свежего SHOP_CHECKOUT ровно с этими позициями: сначала SHOP_CHECKOUT и новое подтверждение" };
    }
    if (payload.total_rub !== checkout.total_rub) {
      return { ok: false, error: `итог в SHOP_CHECKOUT ${checkout.total_rub} ₽, а в заявке ${payload.total_rub ?? "—"} ₽: исправь заявку` };
    }
    amount = checkout.total_rub;
  }
  const params = gateParams(quote, signedLines, delivery);
  const extra = shopOrderExtra({ lines: signedLines, delivery_rub: delivery, total_rub: amount });
  if (extra > 0) params.fees_rub = extra;
  if (extra < 0) params.discount_rub = -extra;
  if (Object.values(params).some((v) => typeof v === "string" && v.length > SHOP_LINE_TEXT_MAX)) {
    return { ok: false, error: `строка позиции длиннее ${SHOP_LINE_TEXT_MAX} символов — раздели заказ или выбери меньше опций` };
  }
  try {
    const { nonce, payload: signed } = deps.gate().issue(
      { service: SHOP_GATE_SERVICE[service], action: shopGateAction(service), params, amountRub: amount },
      now,
    );
    for (const [key, order] of pendingOrders) if (now - order.at > SHOP_QUOTE_TTL_MS) pendingOrders.delete(key);
    pendingOrders.set(nonce, { payload: signed, userId, chatId: ctx.chatId, agentKey: ctx.agentKey, service, ...(quote.place ? { place: quote.place } : {}), address: quote.address, lines: signedLines, at: now });
    return {
      ok: true,
      result: {
        status: "awaiting_signature",
        amount_rub: amount,
        max_final_rub: shopMaxFinal(amount, deps.gate().limits.deviationPct),
        note:
          "Заказ ещё НЕ сделан. Владелец подписывает его Face ID в приложении в течение 2 минут; после подписи Mac сам соберёт корзину, " +
          "заполнит контакты и нажмёт «Оплатить» — владельцу на сайте или в приложении Еды ничего нажимать и заполнять не надо. Результат придёт отдельным сообщением.",
      },
    };
  } catch (e) {
    return { ok: false, error: gateIssueError(e) };
  }
}

/** Позиции заявки против расчёта: те же товары, названия, опции и цены. */
function checkLines(quote: Quote, lines: OrderLines): { lines: OrderLines } | { error: string } {
  const signedLines: OrderLines = [];
  for (const line of lines) {
    const item = quote.items.get(line.id);
    if (!item) return { error: `товара ${line.id} не было в расчёте` };
    // Опции сверяются с группами расчёта: обязательные выбраны, лимиты соблюдены, доплаты посчитаны.
    const options = resolveShopOptions(item.options, line.options);
    if (!options.ok) return { error: `«${item.name}»: ${options.error}` };
    const unit = item.price_rub + options.extra_rub;
    if (item.name !== line.name || unit !== line.price_rub) {
      return {
        error: `в расчёте «${item.name}»${options.extra_rub ? ` с выбранными опциями` : ""} за ${unit} ₽, а в заявке «${line.name}» за ${line.price_rub} ₽: исправь заявку или пересчитай через SHOP_QUOTE`,
      };
    }
    signedLines.push({ id: line.id, name: line.name, qty: line.qty, price_rub: unit, ...(options.picks.length ? { options: options.picks } : {}) });
  }
  if (new Set(signedLines.map(lineIdentity)).size !== signedLines.length) {
    return { error: "одинаковое блюдо с одинаковыми опциями — одной строкой с qty" };
  }
  return { lines: signedLines };
}

const lineIdentity = (l: OrderLines[number]) => `${l.id}\n${(l.options ?? []).map((o) => o.name).sort().join("\n")}`;

/** Позиции с количеством — ключ, по которому заявка находит свой SHOP_CHECKOUT. */
const linesKey = (lines: OrderLines) => lines.map((l) => `${lineIdentity(l)}\n${l.qty}\n${l.price_rub}`).sort().join("\n\n");

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
    prepared = await askMac(prepareRequest(session, order.service, order.place, order.lines), userId, chatId);
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
      ? `${store}: заказ не сделан — итог вырос до ${prepared.total_rub} ₽, подписано не больше ${maxFinal} ₽. Напиши «оформи» — пересчитаю и пришлю новый итог на подпись.`
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
  // Дальше за заказом следит lib/order-watch.ts. У Маркета слежение кончается
  // на пункте выдачи — ровно то событие, ради которого его и заводят.
  watchPlacedOrder({ kind: order.service, chatId: order.chatId, userId, agentKey: order.agentKey, state: confirmed.state });
  await tell(userId, `${store}: заказ оформлен — ${order.lines.map(shopLineText).join("; ")}. Итог ${prepared.total_rub} ₽. Сейчас: ${SHOP_STATE_LABEL[confirmed.state]}.`);
}

/** Для тестов: есть ли заявка, ждущая подписи. */
export const hasPendingShopOrder = (nonce: string) => pendingOrders.has(nonce);
