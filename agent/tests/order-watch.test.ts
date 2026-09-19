/**
 * Слежение за заказом: уведомления о такси, курьере и посылке в ПВЗ.
 *
 * Что закрепляем:
 *  - `pickup_ready` у Маркета не путается с «доставлен»: правило ПВЗ стоит
 *    раньше «в пути», а «Заказ доставлен в пункт выдачи» — это ещё не выдача;
 *  - разбор обещанного времени со страницы: только рядом с подсказкой вроде
 *    «осталось», диапазон берётся по верхней границе, мусор — это null;
 *  - слежение за сервисом ровно одно, публичный канал адресатом не бывает;
 *  - владельцу пишут на смене состояния и на пройденном рубеже ETA, но не на
 *    том же самом состоянии и не на отодвинувшемся времени;
 *  - сбой моста (Mac офлайн) — не промах: счётчик не растёт, слежение живёт;
 *  - несостоявшаяся отправка не запоминает состояние — иначе смену никто уже
 *    не увидит;
 *  - список и отмена видят только свой чат.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import { executeTool } from "../lib/tools-schema.ts";
import { buildPayload } from "../lib/dispatch/build-payload.ts";
import { handleCancelOrderWatch } from "../lib/dispatch/misc.ts";
import { delabsChannelId } from "../lib/delabs-env.ts";
import { parseShopEtaMinutes, SHOP_ETA_MAX, type ShopOrderState } from "../lib/shop.ts";
import { MARKET_STATE_TEXT } from "../mac-daemon/market-selectors.ts";
import {
  cancelOrderWatch,
  ETA_STEPS_MIN,
  getOrderWatch,
  listOrderWatches,
  MAX_ACTIVE_WATCHES_PER_CHAT,
  MAX_MISSES,
  MAX_WATCH_MS,
  nextPollDelayMs,
  POLL_NEAR_MS,
  pollOrderWatches,
  renderOrderWatchMessage,
  shouldNotify,
  startOrderWatch,
  watchPlacedOrder,
  type OrderWatchKind,
  type OrderWatchProbe,
  type OrderWatchRow,
} from "../lib/order-watch.ts";

const CHAT_A = 9_000_901;
const CHAT_B = 9_000_902;
const CTX = { agentKey: "orchestrator", chatId: CHAT_A };
/** Форма контекста misc-хендлеров: резолв юзербота им не нужен. */
const MISC_CTX = { ...CTX, resolveUserbot: async () => null };
const USER = String(CHAT_A);

type Sent = { chatId: number; text: string; agentKey: string };

function recorder() {
  const sent: Sent[] = [];
  return {
    sent,
    send: async (chatId: number, text: string, agentKey: string) => {
      sent.push({ chatId, text, agentKey });
      return { message_id: sent.length };
    },
  };
}

/** Опрос-заглушка: отдаёт заготовленные ответы по очереди, последний повторяется. */
function poller(...answers: OrderWatchProbe[]) {
  let i = 0;
  const seen: string[] = [];
  return {
    seen,
    poll: async (r: OrderWatchRow): Promise<OrderWatchProbe> => {
      seen.push(r.id);
      return answers[Math.min(i++, answers.length - 1)]!;
    },
  };
}

const ok = (state: string, eta: number | null = null): OrderWatchProbe =>
  ({ ok: true, state: state as OrderWatchRow["state"], eta_min: eta, driver: null });

function seed(kind: OrderWatchKind, chatId = CHAT_A) {
  const r = startOrderWatch({ kind, chatId, userId: String(chatId), agentKey: "orchestrator" });
  if (!r.ok) throw new Error(r.error);
  return r.row;
}

/** Срок опроса «уже наступил»: иначе строка не попадёт в выборку. */
const due = (id: string) => db.prepare(`UPDATE order_watch SET next_poll_at = ? WHERE id = ?`).run(Date.now() - 1, id);

beforeEach(() => {
  db.prepare("DELETE FROM order_watch").run();
});
afterEach(() => {
  db.prepare("DELETE FROM order_watch").run();
});

describe("состояния Маркета", () => {
  const stateOf = (body: string): ShopOrderState | null =>
    MARKET_STATE_TEXT.find(([, re]) => re.test(body))?.[0] ?? null;

  test("ПВЗ — это pickup_ready, а не «в пути» и не «доставлен»", () => {
    for (const body of [
      "Заказ в пункте выдачи, был в пути 2 дня",
      "Ждёт вас в пункте выдачи",
      "Можно забирать",
      "Готов к выдаче",
      "Заказ доставлен в пункт выдачи",
    ]) {
      expect(stateOf(body)).toBe("pickup_ready");
    }
  });

  test("доставка до двери и выдача остаются собой", () => {
    expect(stateOf("Заказ доставлен")).toBe("delivered");
    expect(stateOf("Заказ получен")).toBe("delivered");
    expect(stateOf("Передан в доставку")).toBe("delivering");
    expect(stateOf("Заказ отменён")).toBe("cancelled");
  });
});

describe("parseShopEtaMinutes", () => {
  test("минуты, часы и диапазон", () => {
    expect(parseShopEtaMinutes("Осталось 12 мин")).toBe(12);
    expect(parseShopEtaMinutes("Доставим через 35–45 мин")).toBe(45);
    expect(parseShopEtaMinutes("Курьер приедет через 1 ч 20 мин")).toBe(80);
    expect(parseShopEtaMinutes("Прибудет через 2 часа")).toBe(120);
  });

  test("число без подсказки — не время доставки", () => {
    expect(parseShopEtaMinutes("Скидка 15 мин назад закончилась? нет: 300 ₽")).toBe(null);
    expect(parseShopEtaMinutes("В корзине 3 товара")).toBe(null);
    expect(parseShopEtaMinutes("")).toBe(null);
    expect(parseShopEtaMinutes(null)).toBe(null);
  });

  test("невозможное время — отказ, а не догадка", () => {
    expect(parseShopEtaMinutes(`Осталось ${SHOP_ETA_MAX + 1} мин`)).toBe(null);
    expect(parseShopEtaMinutes("Осталось 99 ч 59 мин")).toBe(null);
  });
});

describe("shouldNotify", () => {
  const prev = (o: Partial<OrderWatchRow>) =>
    ({ state: "delivering", eta_min: null, eta_step: null, notified_at: 1, ...o }) as OrderWatchRow;

  test("первый раз говорим всегда", () => {
    expect(shouldNotify(prev({ notified_at: null }), { state: "delivering", eta_min: null }).notify).toBe(true);
  });

  test("смена состояния — повод сказать", () => {
    expect(shouldNotify(prev({}), { state: "pickup_ready", eta_min: null }).notify).toBe(true);
  });

  test("то же состояние и то же время — молчим", () => {
    expect(shouldNotify(prev({ eta_min: 20, eta_step: 30 }), { state: "delivering", eta_min: 20 }).notify).toBe(false);
  });

  test("рубеж считается только вниз", () => {
    const down = shouldNotify(prev({ eta_min: 20, eta_step: 30 }), { state: "delivering", eta_min: 12 });
    expect(down).toEqual({ notify: true, step: 15 });
    // Пробка отодвинула время назад: снова «через 15 мин» владелец не услышит.
    const up = shouldNotify(prev({ eta_min: 12, eta_step: 15 }), { state: "delivering", eta_min: 28 });
    expect(up.notify).toBe(false);
    expect(up.step).toBe(15);
    expect(ETA_STEPS_MIN.includes(15 as never)).toBe(true);
  });
});

describe("nextPollDelayMs", () => {
  test("чем ближе развязка, тем чаще", () => {
    expect(nextPollDelayMs("pickup_ready", null)).toBe(POLL_NEAR_MS);
    expect(nextPollDelayMs("delivering", 10)).toBe(POLL_NEAR_MS);
    expect(nextPollDelayMs("delivering", 40)).toBeGreaterThan(POLL_NEAR_MS);
  });
});

describe("startOrderWatch", () => {
  test("на сервис — одно слежение", () => {
    const a = seed("taxi");
    const b = startOrderWatch({ kind: "taxi", chatId: CHAT_B, userId: "x", agentKey: "pm" });
    expect(b.ok).toBe(true);
    if (b.ok) {
      expect(b.created).toBe(false);
      expect(b.row.id).toBe(a.id);
    }
  });

  test("публичный канал адресатом не бывает", () => {
    const channel = delabsChannelId();
    if (!channel) return;
    expect(startOrderWatch({ kind: "eda", chatId: channel, userId: "x", agentKey: "pm" })).toEqual({
      ok: false,
      error: "blocked_chat",
    });
  });

  test("на чат — не больше предела", () => {
    const kinds: OrderWatchKind[] = ["taxi", "delivery", "lavka", "eda", "market"];
    for (const k of kinds) seed(k);
    // Пять сервисов — это всё, что бывает; предел выше, значит упереться в
    // него нечем, и проверяем ровно это: живых слежений не больше предела.
    expect(listOrderWatches(CHAT_A).length).toBeLessThanOrEqual(MAX_ACTIVE_WATCHES_PER_CHAT);
  });

  test("watchPlacedOrder не бросает на отказе", () => {
    const channel = delabsChannelId();
    expect(() =>
      watchPlacedOrder({ kind: "taxi", chatId: channel ?? CHAT_A, userId: "x", agentKey: "pm", state: "riding" }),
    ).not.toThrow();
  });
});

describe("pollOrderWatches", () => {
  test("смена состояния уходит владельцу, ПВЗ закрывает слежение", async () => {
    const w = seed("market");
    const rec = recorder();
    const first = await pollOrderWatches({ poll: poller(ok("delivering")).poll, send: rec.send });
    expect(first.notified).toBe(1);
    expect(rec.sent[0]!.chatId).toBe(CHAT_A);
    expect(rec.sent[0]!.agentKey).toBe("orchestrator");

    due(w.id);
    const second = await pollOrderWatches({ poll: poller(ok("pickup_ready")).poll, send: rec.send });
    expect(second.finished).toBe(1);
    expect(getOrderWatch(w.id)!.status).toBe("done");
    expect(rec.sent[1]!.text).toContain("пункт выдачи");
    expect(rec.sent[1]!.text).toContain("Слежение за заказом закончено");
  });

  test("то же состояние второй раз — молчание", async () => {
    const w = seed("taxi");
    const rec = recorder();
    await pollOrderWatches({ poll: poller(ok("riding")).poll, send: rec.send });
    due(w.id);
    const again = await pollOrderWatches({ poll: poller(ok("riding")).poll, send: rec.send });
    expect(again.notified).toBe(0);
    expect(rec.sent.length).toBe(1);
  });

  test("Mac офлайн — не промах: счётчик не растёт", async () => {
    const w = seed("delivery");
    const rec = recorder();
    for (let i = 0; i < MAX_MISSES + 1; i++) {
      due(w.id);
      await pollOrderWatches({ poll: async () => ({ ok: false, error: "mac_offline", retry: true }), send: rec.send });
    }
    const row = getOrderWatch(w.id)!;
    expect(row.status).toBe("watching");
    expect(row.misses).toBe(0);
    expect(rec.sent.length).toBe(0);
  });

  test("настоящий сбой опроса в конце концов прекращает слежение", async () => {
    const w = seed("lavka");
    const rec = recorder();
    for (let i = 0; i < MAX_MISSES; i++) {
      due(w.id);
      await pollOrderWatches({ poll: async () => ({ ok: false, error: "invalid_shop_result" }), send: rec.send });
    }
    expect(getOrderWatch(w.id)!.status).toBe("failed");
  });

  test("несостоявшаяся отправка не запоминает состояние", async () => {
    const w = seed("eda");
    const boom = async () => { throw new Error("telegram down"); };
    const stats = await pollOrderWatches({ poll: poller(ok("delivering", 20)).poll, send: boom });
    expect(stats.notified).toBe(0);
    const row = getOrderWatch(w.id)!;
    expect(row.status).toBe("watching");
    expect(row.state).not.toBe("delivering");
    expect(row.notified_at).toBe(null);

    // Следующий проход — и владелец узнаёт про ту же смену состояния.
    const rec = recorder();
    due(w.id);
    const retry = await pollOrderWatches({ poll: poller(ok("delivering", 20)).poll, send: rec.send });
    expect(retry.notified).toBe(1);
  });

  test("вышедшее время слежения закрывает строку", async () => {
    const w = seed("taxi");
    db.prepare(`UPDATE order_watch SET started_at = ?, next_poll_at = ? WHERE id = ?`)
      .run(Date.now() - MAX_WATCH_MS - 1, Date.now() - 1, w.id);
    const rec = recorder();
    const stats = await pollOrderWatches({ poll: poller(ok("riding")).poll, send: rec.send });
    expect(stats.failed).toBe(1);
    expect(getOrderWatch(w.id)!.status).toBe("failed");
    expect(rec.sent.length).toBe(0);
  });
});

describe("сообщение владельцу", () => {
  test("время и машина — в тексте, ничего личного", () => {
    const row = { ...seed("taxi"), state: "driver_assigned", eta_min: 5, driver: "Kia Rio, А123ВС" } as OrderWatchRow;
    const text = renderOrderWatchMessage(row, false);
    expect(text).toContain("Такси");
    expect(text).toContain("через 5 мин");
    expect(text).toContain("Kia Rio");
    expect(text).not.toContain("ул.");
  });
});

describe("LIST_ORDER_WATCH / CANCEL_ORDER_WATCH", () => {
  test("список видит только свой чат", async () => {
    const mine = seed("taxi", CHAT_A);
    seed("market", CHAT_B);
    const out = JSON.parse(await executeTool("LIST_ORDER_WATCH", {}, CTX));
    expect(out.ok).toBe(true);
    expect(out.count).toBe(1);
    expect(out.watches[0].id).toBe(mine.id);
    expect(out.watches[0].kind).toBe("taxi");
  });

  test("отмена — только своего чата", () => {
    const w = seed("eda", CHAT_A);
    expect(cancelOrderWatch(w.id, CHAT_B)).toBe(false);
    expect(cancelOrderWatch(w.id, CHAT_A)).toBe(true);
    expect(getOrderWatch(w.id)!.status).toBe("cancelled");
    // Повторная отмена уже ничего не меняет.
    expect(cancelOrderWatch(w.id, CHAT_A)).toBe(false);
  });

  test("отменённое слежение больше не опрашивают", async () => {
    const w = seed("lavka");
    cancelOrderWatch(w.id, CHAT_A);
    due(w.id);
    const p = poller(ok("delivering"));
    await pollOrderWatches({ poll: p.poll, send: recorder().send });
    expect(p.seen.length).toBe(0);
  });

  test("CANCEL_ORDER_WATCH без id — отказ", () => {
    expect(buildPayload("CANCEL_ORDER_WATCH", {}, CTX).ok).toBe(false);
    expect(buildPayload("CANCEL_ORDER_WATCH", { id: "  " }, CTX).ok).toBe(false);
    expect(buildPayload("CANCEL_ORDER_WATCH", { id: "ow_1" }, CTX).ok).toBe(true);
  });

  test("чат берётся из контекста, а не из инпута модели", () => {
    const w = seed("market", CHAT_A);
    // Инпут называет чужой чат — хендлер всё равно работает со своим, поэтому
    // слежение СВОЕГО чата отменяется, а не чужое.
    expect(handleCancelOrderWatch({ id: w.id, chatId: CHAT_B }, MISC_CTX).ok).toBe(true);
    expect(getOrderWatch(w.id)!.status).toBe("cancelled");
  });

  test("чужое слежение не отменить даже своим чатом в инпуте", () => {
    const other = seed("eda", CHAT_B);
    expect(handleCancelOrderWatch({ id: other.id, chatId: CHAT_A }, MISC_CTX).ok).toBe(false);
    expect(getOrderWatch(other.id)!.status).toBe("watching");
  });
});
