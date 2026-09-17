/**
 * Шаг 9: такси через Яндекс Go в браузере на Mac владельца.
 *
 *   TAXI_QUOTE  {from, to}                    — инлайново: цены по тарифам;
 *   ORDER_TAXI  {from, to, tariff, price_rub} — карточка в чате (money), затем
 *                                               заявка в подписанный гейт;
 *   подпись на телефоне → исполнитель: claim → prepare → checkFinal → confirm;
 *   TAXI_STATUS {}                            — инлайново: состояние заказа;
 *   TAXI_CANCEL {}                            — карточка в чате, затем отмена.
 *
 * Деньги двигает только исполнитель и только по подписанному payload. Всё, что
 * он делает на странице, — ровно подписанные адреса и тариф; цена со страницы
 * сверяется с подписанным потолком до нажатия «Заказать». Капчу не решаем:
 * отказ и скриншот владельцу.
 *
 * Ожидающие подписи заявки живут в памяти процесса. Рестарт их теряет: nonce
 * остаётся в гейте, подпись по нему проходит, но исполнять некому — строка
 * `approved` при этом занимает слот дневного лимита до конца дня.
 */
import type { PayloadByType } from "../action-payload.ts";
import { sendTaxiToMac } from "../mac-bridge.ts";
import { signedActions } from "../native-signing.ts";
import { limitsFromEnv, maxRubFor, type SignedActions } from "../signed-actions.ts";
import { log } from "../log.ts";
import {
  normalizeTaxiAddress,
  parseTaxiOutcome,
  TAXI_FAIL_LABEL,
  TAXI_PRE_ORDER_CODES,
  TAXI_QUOTE_TTL_MS,
  TAXI_STATE_LABEL,
  TAXI_TARIFFS,
  taxiMaxFinal,
  type TaxiOption,
  type TaxiOutcome,
  type TaxiRequest,
  type TaxiTariff,
} from "../taxi.ts";
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

export const TAXI_SERVICE = "yandex_go";
export const TAXI_ACTION = "order_taxi";

export type TaxiHandlerContext = { agentKey: string; chatId: number };
export type TaxiInlineContext = { agentKey: string; chatId: number; triggerUserId?: string; delegationChain?: string[] };

export type TaxiNotifier = YandexNotifier;

export type TaxiDeps = {
  send: (request: TaxiRequest, userId: string, chatId: number) => Promise<MacReply>;
  gate: () => SignedActions;
  notify?: TaxiNotifier;
  now: () => number;
  session: () => string;
};

const defaults: TaxiDeps = {
  send: sendTaxiToMac,
  gate: signedActions,
  now: Date.now,
  session: newYandexSession,
};
let deps: TaxiDeps = { ...defaults };

/** Подмена зависимостей (Telegram-уведомления на старте, заглушки в тестах). */
export function configureTaxi(patch: Partial<TaxiDeps>) {
  const previous = deps;
  deps = { ...deps, ...patch };
  return () => { deps = previous; };
}

export const taxiEnabled = () => process.env.TAXI_ENABLED === "true";

interface Quote { from: string; to: string; options: TaxiOption[]; at: number }
interface PendingOrder { payload: string; userId: string; chatId: number; from: string; to: string; tariff: TaxiTariff; at: number }

/** Последний расчёт на пользователя: заказывать можно только по нему. */
const quotes = new Map<string, Quote>();
/** nonce → заявка, ждущая подписи. */
const pendingOrders = new Map<string, PendingOrder>();
/** Исполнитель один: второй заказ ждёт, пока первый не закончится. */
const executor = serialQueue();

export function resetTaxiState() {
  quotes.clear();
  pendingOrders.clear();
  executor.reset();
}

const OWNER_POLICY = { enabled: taxiEnabled, disabledText: "такси выключено (TAXI_ENABLED)", scope: "taxi", ownerNoun: "такси" };

function ownerRefusal(agentKey: string, chatId: number, userId: string | undefined, delegated: boolean): string | null {
  return yandexOwnerRefusal(OWNER_POLICY, agentKey, chatId, userId, delegated);
}

export type TaxiToolResult = { ok: boolean } & Record<string, unknown>;


/** Запрос к Mac → проверенный ответ. Ошибка моста — исключение с её кодом. */
function askMac<Op extends TaxiRequest["op"]>(request: TaxiRequest & { op: Op }, userId: string, chatId: number): Promise<TaxiOutcome> {
  return askYandexMac<TaxiRequest, TaxiOutcome>(deps.send, parseTaxiOutcome, "taxi_failed", request, userId, chatId);
}

const failText = (o: Extract<TaxiOutcome, { ok: false }>) =>
  `${TAXI_FAIL_LABEL[o.code]}${o.price_rub ? ` (на странице ${o.price_rub} ₽)` : ""}`;

/** TAXI_QUOTE: цены по тарифам. Ничего не заказывает; расчёт живёт TAXI_QUOTE_TTL_MS. */
export async function quoteTaxi(input: Record<string, unknown>, ctx: TaxiInlineContext): Promise<TaxiToolResult> {
  const refusal = ownerRefusal(ctx.agentKey, ctx.chatId, ctx.triggerUserId, inlineDelegated(ctx));
  if (refusal) return { ok: false, error: refusal };
  const from = normalizeTaxiAddress(input.from);
  const to = normalizeTaxiAddress(input.to);
  if (!from || !to) return { ok: false, error: "from и to — адреса одной строкой, 3..200 символов" };
  const userId = ctx.triggerUserId!;
  try {
    const out = await askMac({ op: "quote", from, to }, userId, ctx.chatId);
    if (!out.ok) return { ok: false, error: failText(out), code: out.code };
    if (out.op !== "quote") return { ok: false, error: "invalid_taxi_result" };
    quotes.set(userId, { from, to, options: out.options, at: deps.now() });
    const limits = limitsFromEnv();
    return {
      ok: true,
      from,
      to,
      options: out.options.map((o) => ({ tariff: o.tariff, name: TAXI_TARIFFS[o.tariff], price_rub: o.price_rub, eta_min: o.eta_min })),
      max_rub: maxRubFor(limits, TAXI_SERVICE),
      valid_min: Math.round(TAXI_QUOTE_TTL_MS / 60_000),
      note: "Это расчёт, не заказ. Для заказа — ORDER_TAXI с тем же from/to, выбранным tariff и его price_rub; дальше подтверждение в чате и подпись на телефоне.",
    };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

/** TAXI_STATUS: что сейчас с заказом. */
export async function taxiStatus(ctx: TaxiInlineContext): Promise<TaxiToolResult> {
  const refusal = ownerRefusal(ctx.agentKey, ctx.chatId, ctx.triggerUserId, inlineDelegated(ctx));
  if (refusal) return { ok: false, error: refusal };
  try {
    const out = await askMac({ op: "status" }, ctx.triggerUserId!, ctx.chatId);
    if (!out.ok) return { ok: false, error: failText(out), code: out.code };
    if (out.op !== "status") return { ok: false, error: "invalid_taxi_result" };
    return { ok: true, state: out.state, state_text: TAXI_STATE_LABEL[out.state], driver: out.driver };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

/**
 * ORDER_TAXI после одобрения в чате: сверка с расчётом и заявка в гейт.
 * Сам заказ не делается — его сделает исполнитель после подписи.
 */
export async function handleOrderTaxi(payload: PayloadByType["ORDER_TAXI"], ctx: TaxiHandlerContext): Promise<HandlerResult> {
  const refusal = ownerRefusal(ctx.agentKey, ctx.chatId, payload._userId, payload._delegated === true);
  if (refusal) return { ok: false, error: refusal };
  const userId = payload._userId!;
  const { from, to, tariff, price_rub: price } = payload;
  const quote = quotes.get(userId);
  const now = deps.now();
  if (!quote || now - quote.at > TAXI_QUOTE_TTL_MS || quote.from !== from || quote.to !== to) {
    return { ok: false, error: "нет свежего расчёта на этот маршрут: сначала TAXI_QUOTE и новое подтверждение" };
  }
  const option = quote.options.find((o) => o.tariff === tariff);
  if (!option) return { ok: false, error: `тарифа ${TAXI_TARIFFS[tariff]} не было в расчёте` };
  if (option.price_rub !== price) {
    return { ok: false, error: `в расчёте ${option.price_rub} ₽, а в заявке ${price} ₽: пересчитай через TAXI_QUOTE` };
  }
  try {
    const { nonce, payload: signed } = deps.gate().issue(
      { service: TAXI_SERVICE, action: TAXI_ACTION, params: { from, to, tariff: TAXI_TARIFFS[tariff] }, amountRub: price },
      now,
    );
    for (const [key, order] of pendingOrders) if (now - order.at > TAXI_QUOTE_TTL_MS) pendingOrders.delete(key);
    pendingOrders.set(nonce, { payload: signed, userId, chatId: ctx.chatId, from, to, tariff, at: now });
    return {
      ok: true,
      result: {
        status: "awaiting_signature",
        price_rub: price,
        max_final_rub: taxiMaxFinal(price, deps.gate().limits.deviationPct),
        note: "Заказ ещё НЕ сделан. Владелец подтверждает его Face ID в приложении в течение 2 минут; результат придёт отдельным сообщением.",
      },
    };
  } catch (e) {
    return { ok: false, error: gateIssueError(e) };
  }
}

/** TAXI_CANCEL после одобрения в чате. Отмена может стоить денег — поэтому карточка. */
export async function handleTaxiCancel(payload: PayloadByType["TAXI_CANCEL"], ctx: TaxiHandlerContext): Promise<HandlerResult> {
  const refusal = ownerRefusal(ctx.agentKey, ctx.chatId, payload._userId, payload._delegated === true);
  if (refusal) return { ok: false, error: refusal };
  try {
    const out = await askMac({ op: "cancel" }, payload._userId!, ctx.chatId);
    if (!out.ok) return { ok: false, error: failText(out) };
    if (out.op !== "cancel") return { ok: false, error: "invalid_taxi_result" };
    return { ok: true, result: { state: out.state, state_text: TAXI_STATE_LABEL[out.state] } };
  } catch (e) {
    // Кадр мог дойти: повторять отмену вслепую нельзя, сначала TAXI_STATUS.
    return { ok: false, error: `${errorText(e)} — проверь TAXI_STATUS, прежде чем повторять`, sideEffect: true };
  }
}

const tell = yandexTeller("taxi", () => deps.notify);

const PRE_ORDER: readonly string[] = TAXI_PRE_ORDER_CODES;

/** Исполнитель подписанного заказа. Зовётся из native-signing после approve. */
export function executeSignedTaxi(nonce: string): Promise<void> {
  return executor.run(() => runSignedTaxi(nonce));
}

async function runSignedTaxi(nonce: string): Promise<void> {
  const order = pendingOrders.get(nonce);
  if (!order) return; // не наш nonce или заявка потеряна рестартом
  pendingOrders.delete(nonce);
  const gate = deps.gate();
  const { userId, chatId } = order;

  let maxFinal: number;
  try {
    const claimed = gate.claim(nonce, order.payload, deps.now());
    if (claimed.service !== TAXI_SERVICE || claimed.action !== TAXI_ACTION) {
      gate.abort(nonce, deps.now());
      return;
    }
    maxFinal = claimed.maxFinalRub;
  } catch (e) {
    await tell(userId, `Такси не заказано: подпись не принята (${refusalCode(e)}).`);
    return;
  }

  const session = deps.session();
  const stop = async (text: string, screenshot?: string) => {
    try { gate.abort(nonce, deps.now()); } catch {}
    await tell(userId, `Такси не заказано: ${text}.`, screenshot);
  };

  // 1. Подготовка: подписанные адреса и тариф, цена со страницы.
  let prepared: TaxiOutcome;
  try {
    prepared = await askMac({ op: "prepare", session, from: order.from, to: order.to, tariff: order.tariff }, userId, chatId);
  } catch (e) {
    // До «Заказать» prepare не доходит никогда: заказа точно нет.
    return stop(`Mac не ответил на подготовку (${errorText(e)})`);
  }
  if (!prepared.ok) return stop(failText(prepared), prepared.screenshot);
  if (prepared.op !== "prepare") return stop("неожиданный ответ Mac");

  // 2. Сверка цены гейтом: выше потолка — отказ, без нажатия.
  try {
    gate.checkFinal(nonce, prepared.price_rub, deps.now());
  } catch (e) {
    await deps.send({ op: "abandon", session }, userId, chatId).catch(() => {});
    const code = refusalCode(e);
    await tell(userId, code === "price_deviation"
      ? `Такси не заказано: цена выросла до ${prepared.price_rub} ₽, подписано не больше ${maxFinal} ₽. Пересчитай и подпиши заново.`
      : `Такси не заказано: сверка цены не прошла (${code}).`);
    return;
  }

  // 3. Нажатие «Заказать» с тем же потолком на стороне Mac.
  let confirmed: TaxiOutcome;
  try {
    confirmed = await askMac({ op: "confirm", session, maxRub: maxFinal }, userId, chatId);
  } catch (e) {
    // Кадр мог дойти и кнопка могла нажаться: не повторяем.
    try { gate.complete(nonce, false, deps.now()); } catch {}
    await tell(userId, `Не знаю, заказано ли такси: ${errorText(e)}. Не повторяю — проверь TAXI_STATUS или приложение Яндекс Go.`);
    return;
  }
  if (!confirmed.ok) {
    if (PRE_ORDER.includes(confirmed.code)) return stop(failText(confirmed), confirmed.screenshot);
    try { gate.complete(nonce, false, deps.now()); } catch {}
    await tell(userId, `Не знаю, заказано ли такси: ${failText(confirmed)}. Не повторяю — проверь TAXI_STATUS.`, confirmed.screenshot);
    return;
  }
  if (confirmed.op !== "confirm") {
    try { gate.complete(nonce, false, deps.now()); } catch {}
    await tell(userId, "Не знаю, заказано ли такси: неожиданный ответ Mac. Не повторяю — проверь TAXI_STATUS.");
    return;
  }
  if (confirmed.state === "none" || confirmed.state === "unknown" || confirmed.state === "cancelled") {
    // Кнопка нажата, а заказа на странице не видно: считаем в лимит, но не «успехом».
    try { gate.complete(nonce, false, deps.now()); } catch {}
    await tell(userId, `Не знаю, заказано ли такси: после нажатия «${TAXI_STATE_LABEL[confirmed.state]}». Не повторяю — проверь TAXI_STATUS или приложение Яндекс Go.`);
    return;
  }
  try { gate.complete(nonce, true, deps.now()); } catch (e) {
    log.error("[taxi] complete failed", { error: errorText(e) });
  }
  await tell(userId, `Такси ${TAXI_TARIFFS[order.tariff]} заказано: ${order.from} → ${order.to}, ${prepared.price_rub} ₽. Сейчас: ${TAXI_STATE_LABEL[confirmed.state]}.`);
}

/** Для тестов: есть ли заявка, ждущая подписи. */
export const hasPendingTaxiOrder = (nonce: string) => pendingOrders.has(nonce);
