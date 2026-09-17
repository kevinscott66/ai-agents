/**
 * Шаги 10a–10c: Яндекс Лавка, Еда и Маркет. Всё на заглушках: страница, мост и Telegram
 * подменены, настоящий браузер не запускается и заказ не делается.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvalCategories } from "../lib/approval-policy.ts";
import { approvalPreview } from "../lib/approvals.ts";
import { buildPayload } from "../lib/dispatch/build-payload.ts";
import {
  configureShop,
  executeSignedShop,
  handleMarketPurchase,
  handleOrderFood,
  hasPendingShopOrder,
  quoteShop,
  resetShopState,
  shopStatus,
} from "../lib/dispatch/shop.ts";
import { SignedActions } from "../lib/signed-actions.ts";
import {
  describeOrderFood,
  edaDishId,
  normalizeShopName,
  normalizeShopService,
  parseDeliveryRubles,
  parseShopOutcome,
  parseShopRequest,
  parseShopRubles,
  type ShopOrderState,
  type ShopOutcome,
  type ShopRequest,
} from "../lib/shop.ts";
import {
  checkShopProfile,
  ShopRunner,
  type CheckoutInfo,
  type ProductInfo,
  type SearchCard,
  type ShopGuard,
  type QtyResult,
  type ShopPage,
} from "../mac-daemon/shop.ts";
import { productIdFromHref, routeShopPage } from "../mac-daemon/shop-playwright.ts";
import { dishMatches, dishName, edaPlaceUrl, pickPlace, placeRefFromHref } from "../mac-daemon/eda-playwright.ts";
import { marketIdFromHref, marketUrlFor } from "../mac-daemon/market-playwright.ts";
import type { ShopPlace } from "../lib/shop.ts";

const T0 = Date.UTC(2026, 8, 17, 9, 0, 0);
const OWNER = 777_000_444;
const SESSION = "sess_0123456789abcdef";
const MILK = { id: "moloko-3-2-1l", name: "Молоко 3,2% 1 л", price_rub: 99 };
const BREAD = { id: "hleb-borodinskiy", name: "Хлеб Бородинский 300 г", price_rub: 65 };

async function phone() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const spki = Buffer.from(await crypto.subtle.exportKey("spki", pair.publicKey)).toString("base64");
  const sign = async (payload: string) =>
    Buffer.from(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(payload))).toString("base64");
  return { spki, sign };
}

describe("parsing", () => {
  test("prices, delivery, names and services", () => {
    expect(parseShopRubles("99 ₽")).toBe(99);
    expect(parseShopRubles("1 234 ₽")).toBe(1234);
    expect(parseShopRubles("89,90 ₽")).toBe(90);
    expect(parseShopRubles("89,00 ₽")).toBe(89);
    expect(parseShopRubles("Итого 512 ₽")).toBe(512);
    expect(parseShopRubles("99 ₽ вместо 109 ₽")).toBeNull();
    expect(parseShopRubles("99")).toBeNull();
    expect(parseDeliveryRubles("15–25 мин, 0 ₽")).toBe(0);
    expect(parseDeliveryRubles("Доставка 149 ₽")).toBe(149);
    expect(parseDeliveryRubles("бесплатно")).toBeNull();
    expect(normalizeShopName("Моло­ко  3,2% 1 л")).toBe("Молоко 3,2% 1 л");
    expect(normalizeShopName("Молоко​ 1 л")).toBeNull();
    expect(normalizeShopService(undefined)).toBe("lavka");
    expect(normalizeShopService("Лавка")).toBe("lavka");
    expect(normalizeShopService("ozon")).toBeNull();
    expect(productIdFromHref("/good/moloko-3-2-1l?from=search")).toBe("moloko-3-2-1l");
    expect(productIdFromHref("https://evil.example.com/good/x")).toBeNull();
  });

  test("daemon frame is strict", () => {
    const lines = [{ id: MILK.id, name: MILK.name, qty: 2 }];
    expect(parseShopRequest({ op: "quote", service: "lavka", queries: ["молоко"] })).toEqual({ op: "quote", service: "lavka", queries: ["молоко"] });
    expect(parseShopRequest({ op: "quote", service: "lavka", queries: [] })).toBeNull();
    expect(parseShopRequest({ op: "prepare", session: SESSION, service: "lavka", lines })).toEqual({ op: "prepare", session: SESSION, service: "lavka", lines });
    expect(parseShopRequest({ op: "prepare", session: SESSION, service: "lavka", lines: [...lines, ...lines] })).toBeNull();
    expect(parseShopRequest({ op: "prepare", session: SESSION, service: "lavka", lines: [{ ...lines[0], qty: 21 }] })).toBeNull();
    expect(parseShopRequest({ op: "prepare", session: SESSION, service: "lavka", lines: [{ ...lines[0], id: "../cart" }] })).toBeNull();
    expect(parseShopRequest({ op: "confirm", session: SESSION, maxRub: 500, extra: 1 })).toBeNull();
    expect(parseShopRequest({ op: "confirm", session: "short", maxRub: 500 })).toBeNull();
    expect(parseShopRequest({ op: "status", service: "ozon" })).toBeNull();
  });

  test("daemon answer is checked, junk throws", () => {
    expect(parseShopOutcome('{"ok":false,"code":"captcha","screenshot":"QUJD"}', "quote")).toEqual({ ok: false, code: "captcha", screenshot: "QUJD" });
    expect(() => parseShopOutcome('{"ok":false,"code":"whatever"}', "quote")).toThrow("invalid_shop_result");
    expect(() => parseShopOutcome('{"ok":true,"op":"confirm","state":"accepted"}', "prepare")).toThrow("invalid_shop_result");
    expect(() => parseShopOutcome('{"ok":true,"op":"prepare","address":"Красная 1","lines":[],"total_rub":-1}', "prepare")).toThrow();
  });

  test("approval card matches what the phone signs", () => {
    const p = { service: "lavka", lines: [{ ...MILK, qty: 2 }], delivery_rub: 0 };
    expect(describeOrderFood(p, 15)).toBe(
      "Яндекс Лавка: Молоко 3,2% 1 л × 2 — 198 ₽; доставка 0 ₽. Всего 198 ₽ (итог на странице — не больше 227 ₽), дальше — подпись на телефоне",
    );
    expect(describeOrderFood({ ...p, delivery_rub: "0" }, 15)).toBe("некорректный заказ");
  });
});

/** Страница-заглушка: корзина, товары и оформление в памяти, журнал нажатий. */
function fakePage() {
  const s = {
    guard: "ok" as ShopGuard,
    address: "Краснодар, Красная 1" as string | null,
    delivery: 0 as number | null,
    cards: [
      { id: MILK.id, name: `${MILK.name}`, price_rub: 99, available: true },
      { id: "moloko-dorogoe", name: "Молоко фермерское 1 л", price_rub: 189, available: true },
      { id: "moloko-net", name: "Молоко 2,5%", price_rub: 79, available: false },
    ] as SearchCard[],
    products: new Map<string, ProductInfo>([
      [MILK.id, { name: MILK.name, price_rub: 99, available: true }],
      [BREAD.id, { name: BREAD.name, price_rub: 65, available: true }],
    ]),
    cart: new Map<string, number>(),
    checkout: null as Partial<CheckoutInfo> | null,
    current: "",
    state: "none" as ShopOrderState,
    stateAfterPay: "accepted" as ShopOrderState,
    clicks: [] as string[],
    shots: 0,
    place: null as ShopPlace | null,
    qtyResult: "ok" as QtyResult,
    opened: [] as string[],
  };
  const total = () => [...s.cart].reduce((sum, [id, qty]) => sum + qty * (s.products.get(id)?.price_rub ?? 0), 0) + (s.delivery ?? 0);
  const page: ShopPage = {
    openHome: async (t) => { s.current = "home"; s.opened.push(`home:${t.place ?? t.service}`); },
    findPlace: async () => s.place,
    openSearch: async () => { s.current = "search"; },
    openProduct: async (_t, item) => { s.current = item.id; },
    openCart: async (t) => { s.current = "cart"; s.opened.push(`cart:${t.place ?? t.service}`); },
    openOrders: async () => { s.current = "orders"; },
    guard: async () => s.guard,
    address: async () => s.address,
    deliveryFee: async () => s.delivery,
    searchCards: async () => s.cards.map((c) => ({ ...c })),
    product: async () => s.products.get(s.current) ?? { name: null, price_rub: null, available: false },
    setProductQty: async (qty) => {
      s.clicks.push(`qty:${s.current}:${qty}`);
      if (qty > 0 && s.qtyResult !== "ok") return s.qtyResult;
      if (qty === 0) s.cart.delete(s.current); else s.cart.set(s.current, qty);
      return "ok";
    },
    cart: async () => [...s.cart].map(([id, qty]) => ({ id, qty, price_rub: s.products.get(id)?.price_rub ?? null })),
    openCheckout: async () => { s.current = "checkout"; return s.cart.size > 0; },
    checkout: async () => ({ total_rub: total(), blocked: false, saved_card: true, pay_button: true, ...s.checkout }),
    clickPay: async () => { s.clicks.push("pay"); s.state = s.stateAfterPay; },
    orderState: async () => s.state,
    screenshot: async () => { s.shots++; return "U0NSRUVO"; },
    probe: async () => "",
  };
  return { s, page };
}

function runner(page: ShopPage, env: Record<string, string> = { SHOP_ENABLED: "true", SHOP_PROFILE_DIR: "/profile" }, now = () => T0) {
  return new ShopRunner(env, {
    launch: async () => ({ page: () => page, close: async () => {} }),
    checkProfile: (dir) => dir ?? "",
    now,
    sleep: async () => {},
    idleMs: 60_000,
  });
}

describe("mac runner", () => {
  const prepare: ShopRequest = {
    op: "prepare",
    session: SESSION,
    service: "lavka",
    lines: [{ id: MILK.id, name: MILK.name, qty: 2 }, { id: BREAD.id, name: BREAD.name, qty: 1 }],
  };

  test("disabled by default, nothing is launched", async () => {
    let launched = false;
    const r = new ShopRunner({}, { launch: async () => { launched = true; throw new Error("no"); } });
    expect(await r.run({ op: "status", service: "lavka" })).toEqual({ ok: false, code: "shop_disabled" });
    expect(launched).toBe(false);
  });

  test("quote lists available priced items and never touches the cart", async () => {
    const { s, page } = fakePage();
    const r = runner(page);
    expect(await r.run({ op: "quote", service: "lavka", queries: ["молоко"] })).toEqual({
      ok: true,
      op: "quote",
      address: "Краснодар, Красная 1",
      delivery_rub: 0,
      results: [{ query: "молоко", candidates: [MILK, { id: "moloko-dorogoe", name: "Молоко фермерское 1 л", price_rub: 189 }] }],
    });
    expect(s.clicks).toEqual([]);
    await r.close();
  });

  test("no address, captcha or login: stop with a screenshot, nothing is touched", async () => {
    const { s, page } = fakePage();
    const r = runner(page);
    s.address = null;
    expect(await r.run(prepare)).toEqual({ ok: false, code: "address_required", screenshot: "U0NSRUVO" });
    s.address = "Краснодар, Красная 1";
    for (const guard of ["captcha", "login_required"] as const) {
      s.guard = guard;
      expect(await r.run(prepare)).toEqual({ ok: false, code: guard, screenshot: "U0NSRUVO" });
    }
    expect(s.clicks).toEqual([]);
    await r.close();
  });

  test("a cart with someone else's items is refused as is", async () => {
    const { s, page } = fakePage();
    s.cart.set("chuzhoe", 1);
    const r = runner(page);
    expect((await r.run(prepare) as { code: string }).code).toBe("cart_not_empty");
    expect(s.clicks).toEqual([]);
    expect([...s.cart]).toEqual([["chuzhoe", 1]]);
    await r.close();
  });

  test("renamed product: refusal, screenshot before cleanup, added items removed", async () => {
    const { s, page } = fakePage();
    s.products.set(BREAD.id, { name: "Хлеб Бородинский 250 г", price_rub: 65, available: true });
    let cartAtShot = -1;
    page.screenshot = async () => { cartAtShot = s.cart.size; return "U0NSRUVO"; };
    const r = runner(page);
    expect(await r.run(prepare)).toEqual({ ok: false, code: "product_mismatch", screenshot: "U0NSRUVO" });
    expect(cartAtShot).toBe(1);
    expect(s.cart.size).toBe(0);
    expect(s.clicks).toEqual([`qty:${MILK.id}:2`, `qty:${MILK.id}:0`]);
    await r.close();
  });

  test("no saved card or blocked checkout never becomes a click", async () => {
    for (const [checkout, code] of [
      [{ saved_card: false }, "payment_needs_owner"],
      [{ blocked: true }, "checkout_unavailable"],
      [{ total_rub: null }, "price_unreadable"],
      [{ pay_button: false }, "pay_button_missing"],
    ] as const) {
      const { s, page } = fakePage();
      s.checkout = checkout;
      const r = runner(page);
      expect((await r.run(prepare) as { code: string }).code).toBe(code);
      expect(s.clicks).not.toContain("pay");
      expect(s.cart.size).toBe(0);
      await r.close();
    }
  });

  test("prepare fills the cart; confirm pays once when the total holds", async () => {
    const { s, page } = fakePage();
    const r = runner(page);
    expect(await r.run(prepare)).toEqual({
      ok: true,
      op: "prepare",
      address: "Краснодар, Красная 1",
      lines: [{ id: MILK.id, qty: 2, price_rub: 99 }, { id: BREAD.id, qty: 1, price_rub: 65 }],
      total_rub: 263,
    });
    expect(await r.run({ op: "confirm", session: SESSION, maxRub: 302 })).toEqual({ ok: true, op: "confirm", state: "accepted" });
    expect(s.clicks.filter((c) => c === "pay")).toHaveLength(1);
    expect(await r.run({ op: "confirm", session: SESSION, maxRub: 302 })).toEqual({ ok: false, code: "session_unknown" });
    expect(s.clicks.filter((c) => c === "pay")).toHaveLength(1);
    await r.close();
  });

  test("total above the signed ceiling: no click, cart cleared, session gone", async () => {
    const { s, page } = fakePage();
    const r = runner(page);
    await r.run(prepare);
    s.delivery = 99;
    expect(await r.run({ op: "confirm", session: SESSION, maxRub: 302 })).toEqual({ ok: false, code: "price_changed", price_rub: 362, screenshot: "U0NSRUVO" });
    expect(s.clicks).not.toContain("pay");
    expect(s.cart.size).toBe(0);
    expect(await r.run({ op: "confirm", session: SESSION, maxRub: 1000 })).toEqual({ ok: false, code: "session_unknown" });
    await r.close();
  });

  test("cart changed between prepare and confirm: refusal", async () => {
    const { s, page } = fakePage();
    const r = runner(page);
    await r.run(prepare);
    s.cart.set(MILK.id, 3);
    expect((await r.run({ op: "confirm", session: SESSION, maxRub: 1000 }) as { code: string }).code).toBe("cart_mismatch");
    expect(s.clicks).not.toContain("pay");
    await r.close();
  });

  test("session expires, foreign sessions are refused, abandon clears", async () => {
    let now = T0;
    const { s, page } = fakePage();
    const r = runner(page, undefined, () => now);
    await r.run(prepare);
    expect(await r.run({ op: "confirm", session: "other_0123456789abcd", maxRub: 1000 })).toEqual({ ok: false, code: "session_unknown" });
    expect((await r.run({ ...prepare, session: "other_0123456789abcd" }) as { code: string }).code).toBe("shop_busy");
    expect(await r.run({ op: "abandon", session: SESSION })).toEqual({ ok: true, op: "abandon" });
    expect(s.cart.size).toBe(0);
    await r.run(prepare);
    now += 5 * 60_000 + 1;
    expect(await r.run({ op: "confirm", session: SESSION, maxRub: 1000 })).toEqual({ ok: false, code: "session_unknown" });
    expect(s.clicks).not.toContain("pay");
    await r.close();
  });

  test("after the click the page state decides", async () => {
    const { s, page } = fakePage();
    s.stateAfterPay = "none";
    const r = runner(page);
    await r.run(prepare);
    expect(await r.run({ op: "confirm", session: SESSION, maxRub: 1000 })).toEqual({ ok: true, op: "confirm", state: "unknown" });
    s.state = "delivering";
    expect(await r.run({ op: "status", service: "lavka" })).toEqual({ ok: true, op: "status", state: "delivering" });
    await r.close();
  });

  test("profile must be private", () => {
    const dir = mkdtempSync(join(tmpdir(), "shop-profile-"));
    try {
      chmodSync(dir, 0o755);
      expect(() => checkShopProfile(dir)).toThrow("profile_insecure");
      chmodSync(dir, 0o700);
      expect(checkShopProfile(dir)).toBe(dir);
      expect(() => checkShopProfile("relative/dir")).toThrow("profile_missing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const ENV_KEYS = ["SHOP_ENABLED", "MINIAPP_ADMIN_USER_IDS"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

type Script = Partial<Record<ShopRequest["op"], ShopOutcome | Error>>;

async function harness(script: Script, limits = { maxRub: 1000, dailyMax: 5, deviationPct: 15 }) {
  const gate = new SignedActions(new Database(":memory:"), limits);
  const owner = await phone();
  const { keyId, code } = await gate.registerKey("iphone", owner.spki, T0);
  gate.activateKey(keyId, code, T0);
  const requests: ShopRequest[] = [];
  const texts: string[] = [];
  const photos: string[] = [];
  const restore = configureShop({
    gate: () => gate,
    now: () => T0,
    session: () => SESSION,
    send: async (request) => {
      requests.push(request);
      const out = script[request.op];
      if (out instanceof Error) return { ok: false, stdout: "", error: out.message };
      if (!out) return { ok: false, stdout: "", error: "unexpected_op" };
      return { ok: true, stdout: JSON.stringify(out) };
    },
    notify: {
      text: async (_u, text) => { texts.push(text); },
      photo: async (_u, _jpeg, caption) => { photos.push(caption); },
    },
  });
  const ctx = { agentKey: "orchestrator", chatId: OWNER, triggerUserId: String(OWNER) };
  const quote = () => quoteShop({ queries: ["молоко", "хлеб"] }, ctx);
  const order = (lines = [{ ...MILK, qty: 2 }], delivery_rub = 0) =>
    handleOrderFood({ service: "lavka", lines, delivery_rub, _userId: String(OWNER) }, { agentKey: "orchestrator", chatId: OWNER });
  const sign = async () => {
    const { nonce, payload } = gate.pending(T0).at(-1)!;
    await gate.approve(nonce, await owner.sign(payload), T0);
    return nonce;
  };
  const status = (nonce: string) => (gate.db.query("SELECT status FROM signed_actions WHERE nonce=?").get(nonce) as { status: string }).status;
  return { gate, requests, texts, photos, restore, ctx, quote, order, sign, status };
}

const ADDRESS = "Краснодар, Красная 1";
const QUOTE: ShopOutcome = {
  ok: true,
  op: "quote",
  address: ADDRESS,
  delivery_rub: 0,
  results: [{ query: "молоко", candidates: [MILK] }, { query: "хлеб", candidates: [BREAD] }],
};
const PREPARED: ShopOutcome = { ok: true, op: "prepare", address: ADDRESS, lines: [{ id: MILK.id, qty: 2, price_rub: 99 }], total_rub: 198 };

describe("server flow", () => {
  let h: Awaited<ReturnType<typeof harness>> | null = null;
  beforeEach(() => {
    resetShopState();
    process.env.SHOP_ENABLED = "true";
    process.env.MINIAPP_ADMIN_USER_IDS = `123,${OWNER}`;
  });
  afterEach(() => {
    h?.restore();
    h = null;
    resetShopState();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
    }
  });

  test("owner only, own chat, not delegated, orchestrator only", async () => {
    h = await harness({ quote: QUOTE, status: { ok: true, op: "status", state: "none" } });
    expect((await quoteShop({ queries: ["молоко"] }, { ...h.ctx, chatId: -100 })).ok).toBe(false);
    expect((await quoteShop({ queries: ["молоко"] }, { ...h.ctx, agentKey: "qa" })).ok).toBe(false);
    expect((await quoteShop({ queries: ["молоко"] }, { ...h.ctx, triggerUserId: "555", chatId: 555 })).ok).toBe(false);
    expect((await quoteShop({ queries: ["молоко"] }, { ...h.ctx, delegationChain: ["orchestrator", "devops"] })).ok).toBe(false);
    expect((await handleOrderFood({ service: "lavka", lines: [{ ...MILK, qty: 1 }], delivery_rub: 0, _userId: String(OWNER), _delegated: true }, { agentKey: "orchestrator", chatId: OWNER })).ok).toBe(false);
    expect((await quoteShop({ queries: [] }, h.ctx)).ok).toBe(false);
    expect(h.requests).toEqual([]);
    expect(await shopStatus({}, h.ctx)).toMatchObject({ ok: true, state: "none" });
    process.env.SHOP_ENABLED = "false";
    expect((await shopStatus({}, h.ctx)).ok).toBe(false);
  });

  test("order requires a fresh matching quote and issues a nonce, nothing is ordered yet", async () => {
    h = await harness({ quote: QUOTE });
    expect((await h.order()).ok).toBe(false);
    expect(await h.quote()).toMatchObject({ ok: true, address: ADDRESS, delivery_rub: 0 });
    expect((await h.order([{ ...MILK, price_rub: 89, qty: 2 }])).ok).toBe(false);
    expect((await h.order([{ ...MILK, name: "Молоко 1 л", qty: 2 }])).ok).toBe(false);
    expect((await h.order([{ id: "net-v-raschete", name: "Сыр", price_rub: 10, qty: 1 }])).ok).toBe(false);
    expect((await h.order(undefined, 149)).ok).toBe(false);
    const res = await h.order([{ ...MILK, qty: 2 }, { ...BREAD, qty: 1 }]);
    expect(res).toMatchObject({ ok: true, result: { status: "awaiting_signature", amount_rub: 263, max_final_rub: 302 } });
    const { nonce, payload } = h.gate.pending(T0).at(-1)!;
    expect(JSON.parse(payload)).toMatchObject({
      service: "yandex_lavka",
      action: "order_food",
      amount_rub: 263,
      params: {
        store: "Яндекс Лавка",
        address: ADDRESS,
        item_01: "Молоко 3,2% 1 л × 2 — 198 ₽",
        item_02: "Хлеб Бородинский 300 г × 1 — 65 ₽",
        delivery_rub: 0,
      },
    });
    expect(hasPendingShopOrder(nonce)).toBe(true);
    expect(h.requests.map((r) => r.op)).toEqual(["quote"]);
  });

  test("gate refusals come back readable", async () => {
    h = await harness({ quote: QUOTE }, { maxRub: 150, dailyMax: 5, deviationPct: 15 });
    await h.quote();
    const res = await h.order();
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain("лимита");
  });

  test("signed order: prepare with signed lines, total check, one confirm, success", async () => {
    h = await harness({ quote: QUOTE, prepare: PREPARED, confirm: { ok: true, op: "confirm", state: "accepted" } });
    await h.quote();
    await h.order();
    const nonce = await h.sign();
    await executeSignedShop(nonce);
    expect(h.requests.map((r) => r.op)).toEqual(["quote", "prepare", "confirm"]);
    expect(h.requests[1]).toEqual({ op: "prepare", session: SESSION, service: "lavka", lines: [{ id: MILK.id, name: MILK.name, qty: 2 }] });
    expect(h.requests[2]).toEqual({ op: "confirm", session: SESSION, maxRub: 227 });
    expect(h.status(nonce)).toBe("executed");
    expect(h.texts).toHaveLength(1);
    expect(h.texts[0]).toContain("заказ оформлен");
    await executeSignedShop(nonce);
    expect(h.requests).toHaveLength(3);
  });

  test("total above the ceiling: abandon, no confirm, aborted", async () => {
    h = await harness({ quote: QUOTE, prepare: { ...PREPARED, total_rub: 300 }, abandon: { ok: true, op: "abandon" } });
    await h.quote();
    await h.order();
    const nonce = await h.sign();
    await executeSignedShop(nonce);
    expect(h.requests.map((r) => r.op)).toEqual(["quote", "prepare", "abandon"]);
    expect(h.status(nonce)).toBe("aborted");
    expect(h.texts[0]).toContain("300");
  });

  test("delivery address changed on the site: abandon, aborted", async () => {
    h = await harness({ quote: QUOTE, prepare: { ...PREPARED, address: "Москва, Тверская 1" }, abandon: { ok: true, op: "abandon" } });
    await h.quote();
    await h.order();
    const nonce = await h.sign();
    await executeSignedShop(nonce);
    expect(h.requests.map((r) => r.op)).toEqual(["quote", "prepare", "abandon"]);
    expect(h.status(nonce)).toBe("aborted");
    expect(h.texts[0]).toContain("адрес");
  });

  test("captcha before payment: aborted, owner gets the screenshot", async () => {
    h = await harness({ quote: QUOTE, prepare: { ok: false, code: "captcha", screenshot: "U0NSRUVO" } });
    await h.quote();
    await h.order();
    const nonce = await h.sign();
    await executeSignedShop(nonce);
    expect(h.requests.map((r) => r.op)).toEqual(["quote", "prepare"]);
    expect(h.status(nonce)).toBe("aborted");
    expect(h.photos).toHaveLength(1);
    expect(h.photos[0]).toContain("капч");
  });

  test("bridge failure on confirm: failed, counted, never retried", async () => {
    h = await harness({ quote: QUOTE, prepare: PREPARED, confirm: new Error("mac_timeout") });
    await h.quote();
    await h.order();
    const nonce = await h.sign();
    await executeSignedShop(nonce);
    expect(h.requests.map((r) => r.op)).toEqual(["quote", "prepare", "confirm"]);
    expect(h.status(nonce)).toBe("failed");
    expect(h.texts[0]).toContain("Не знаю");
  });

  test("pre-payment refusal on confirm aborts; unclear state after the click fails", async () => {
    h = await harness({ quote: QUOTE, prepare: PREPARED, confirm: { ok: false, code: "price_changed", price_rub: 400 } });
    await h.quote();
    await h.order();
    let nonce = await h.sign();
    await executeSignedShop(nonce);
    expect(h.status(nonce)).toBe("aborted");
    h.restore();

    h = await harness({ quote: QUOTE, prepare: PREPARED, confirm: { ok: true, op: "confirm", state: "payment_pending" } });
    resetShopState();
    await h.quote();
    await h.order();
    nonce = await h.sign();
    await executeSignedShop(nonce);
    expect(h.status(nonce)).toBe("failed");
    expect(h.texts[0]).toContain("Не знаю");
  });

  test("foreign nonce is ignored", async () => {
    h = await harness({});
    await executeSignedShop("x".repeat(43));
    expect(h.requests).toEqual([]);
    expect(h.texts).toEqual([]);
  });
});

describe("chat approval", () => {
  test("order is money; preview shows the ceiling", () => {
    const payload = { service: "lavka", lines: [{ ...MILK, qty: 2 }], delivery_rub: 0 };
    expect(approvalCategories("ORDER_FOOD", payload)).toEqual(["money"]);
    expect(approvalPreview("ORDER_FOOD", payload)).toContain("не больше 227 ₽");
  });

  test("buildPayload normalizes and rejects junk", () => {
    const line = { id: MILK.id, name: "Молоко  3,2% 1 л", qty: 2, price_rub: 99 };
    expect(buildPayload("ORDER_FOOD", { service: "лавка", lines: [line], delivery_rub: 0 }, { agentKey: "orchestrator" }))
      .toEqual({ ok: true, payload: { service: "lavka", lines: [{ ...MILK, qty: 2 }], delivery_rub: 0 } });
    expect(buildPayload("ORDER_FOOD", { service: "lavka", lines: [{ ...line, qty: "2" }], delivery_rub: 0 }, { agentKey: "orchestrator" }).ok).toBe(false);
    expect(buildPayload("ORDER_FOOD", { service: "lavka", lines: [line, line], delivery_rub: 0 }, { agentKey: "orchestrator" }).ok).toBe(false);
    expect(buildPayload("ORDER_FOOD", { service: "market", lines: [line], delivery_rub: 0 }, { agentKey: "orchestrator" }).ok).toBe(false);
    expect(buildPayload("ORDER_FOOD", { service: "lavka", lines: [], delivery_rub: 0 }, { agentKey: "orchestrator" }).ok).toBe(false);
  });
});

const PLACE: ShopPlace = { ref: "burger-house:krasnaya-1", name: "Бургер Хаус" };
const BURGER = { id: edaDishId(PLACE.ref, "Чизбургер 250 г"), name: "Чизбургер 250 г", price_rub: 350 };
const FRIES = { id: edaDishId(PLACE.ref, "Картофель фри 150 г"), name: "Картофель фри 150 г", price_rub: 150 };

describe("eda: parsing and page helpers", () => {
  test("dish id derives from place and name", () => {
    expect(BURGER.id).toMatch(/^d[0-9a-f]{24}$/);
    expect(edaDishId(PLACE.ref, BURGER.name)).toBe(BURGER.id);
    expect(edaDishId("other:place", BURGER.name)).not.toBe(BURGER.id);
    expect(edaDishId(PLACE.ref, "Чизбургер 300 г")).not.toBe(BURGER.id);
    expect(normalizeShopService("Яндекс Еда")).toBe("eda");
    expect(normalizeShopService("еда")).toBe("eda");
  });

  test("daemon frame: place required for eda, forbidden for lavka", () => {
    const lines = [{ id: BURGER.id, name: BURGER.name, qty: 1 }];
    expect(parseShopRequest({ op: "quote", service: "eda", place: "бургер хаус", queries: ["чизбургер"] }))
      .toEqual({ op: "quote", service: "eda", place: "бургер хаус", queries: ["чизбургер"] });
    expect(parseShopRequest({ op: "quote", service: "eda", queries: ["чизбургер"] })).toBeNull();
    expect(parseShopRequest({ op: "quote", service: "lavka", place: "бургер хаус", queries: ["молоко"] })).toBeNull();
    expect(parseShopRequest({ op: "prepare", session: SESSION, service: "eda", place: PLACE.ref, lines }))
      .toEqual({ op: "prepare", session: SESSION, service: "eda", place: PLACE.ref, lines });
    expect(parseShopRequest({ op: "prepare", session: SESSION, service: "eda", place: "Бургер Хаус", lines })).toBeNull();
    expect(parseShopRequest({ op: "prepare", session: SESSION, service: "eda", place: "../x:y", lines })).toBeNull();
    expect(parseShopRequest({ op: "prepare", session: SESSION, service: "eda", lines })).toBeNull();
  });

  test("quote answer carries the place strictly", () => {
    const base = { ok: true, op: "quote", address: ADDRESS, delivery_rub: 0, results: [{ query: "чизбургер", candidates: [BURGER] }] };
    expect(parseShopOutcome(JSON.stringify({ ...base, place: PLACE }), "quote")).toMatchObject({ place: PLACE });
    expect(() => parseShopOutcome(JSON.stringify({ ...base, place: { ...PLACE, extra: 1 } }), "quote")).toThrow("invalid_shop_result");
    expect(() => parseShopOutcome(JSON.stringify({ ...base, place: { ...PLACE, ref: "no ref" } }), "quote")).toThrow("invalid_shop_result");
  });

  test("approval card names the restaurant", () => {
    const p = { service: "eda", place: PLACE.name, lines: [{ ...BURGER, qty: 2 }], delivery_rub: 99 };
    expect(describeOrderFood(p, 15)).toBe(
      "Яндекс Еда · Бургер Хаус: Чизбургер 250 г × 2 — 700 ₽; доставка 99 ₽. Всего 799 ₽ (итог на странице — не больше 918 ₽), дальше — подпись на телефоне",
    );
    expect(describeOrderFood({ ...p, place: undefined }, 15)).toBe("некорректный заказ");
    expect(describeOrderFood({ ...p, service: "lavka" }, 15)).toBe("некорректный заказ");
  });

  test("place links, place choice and dish matching", () => {
    expect(placeRefFromHref("/r/burger-house?placeSlug=krasnaya-1")).toBe(PLACE.ref);
    expect(placeRefFromHref("https://eda.yandex.ru/r/burger-house?placeSlug=krasnaya-1&a=1")).toBe(PLACE.ref);
    expect(placeRefFromHref("https://evil.example.com/r/burger-house?placeSlug=krasnaya-1")).toBeNull();
    expect(placeRefFromHref("/r/burger-house")).toBeNull();
    expect(placeRefFromHref("/r/Burger House?placeSlug=x")).toBeNull();
    expect(edaPlaceUrl(PLACE.ref)).toBe("https://eda.yandex.ru/r/burger-house?placeSlug=krasnaya-1");
    const places = [{ ref: "a:1", name: "Бургер Хаус Экспресс" }, { ref: "b:2", name: "Бургер хаус" }, { ref: "c:3", name: "Суши Мастер" }];
    expect(pickPlace("бургер хаус", places)).toEqual(places[1]!);
    expect(pickPlace("экспресс", places)).toEqual(places[0]!);
    expect(pickPlace("пицца", places)).toBeNull();
    expect(pickPlace("  ", places)).toBeNull();
    expect(dishMatches("Чизбургер 250 г", "чизбургер")).toBe(true);
    expect(dishMatches("Двойной чизбургер", "чизбургеры двойные")).toBe(true);
    expect(dishMatches("Картофель фри", "чизбургер")).toBe(false);
    expect(dishName(" Чизбургер ", "250 г")).toBe("Чизбургер 250 г");
    expect(dishName("Чизбургер", "")).toBe("Чизбургер");
  });

  test("router sends each call to the page of the opened service", async () => {
    const lavka = fakePage();
    const eda = fakePage();
    eda.s.place = PLACE;
    eda.s.address = "Еда-адрес";
    const page = routeShopPage({ lavka: lavka.page, eda: eda.page, market: fakePage().page });
    await page.openHome({ service: "lavka" });
    expect(await page.address()).toBe("Краснодар, Красная 1");
    expect(await page.findPlace("бургер")).toEqual(PLACE);
    await page.openHome({ service: "eda", place: PLACE.ref });
    expect(await page.address()).toBe("Еда-адрес");
    expect(lavka.s.opened).toEqual(["home:lavka"]);
    expect(eda.s.opened).toEqual([`home:${PLACE.ref}`]);
  });
});

function edaPage() {
  const f = fakePage();
  f.s.place = PLACE;
  f.s.delivery = 99;
  f.s.cards = [
    { ...BURGER, available: true },
    { id: "d000000000000000000000000", name: "Чизбургер из другого ресторана", price_rub: 1, available: true },
  ];
  f.s.products = new Map([
    [BURGER.id, { name: BURGER.name, price_rub: 350, available: true }],
    [FRIES.id, { name: FRIES.name, price_rub: 150, available: true }],
  ]);
  return f;
}

describe("eda: mac runner", () => {
  const prepare: ShopRequest = {
    op: "prepare",
    session: SESSION,
    service: "eda",
    place: PLACE.ref,
    lines: [{ id: BURGER.id, name: BURGER.name, qty: 2 }, { id: FRIES.id, name: FRIES.name, qty: 1 }],
  };

  test("quote finds the place, opens it and keeps only its own dishes", async () => {
    const { s, page } = edaPage();
    const r = runner(page);
    expect(await r.run({ op: "quote", service: "eda", place: "бургер хаус", queries: ["чизбургер"] })).toEqual({
      ok: true,
      op: "quote",
      address: ADDRESS,
      place: PLACE,
      delivery_rub: 99,
      results: [{ query: "чизбургер", candidates: [BURGER] }],
    });
    expect(s.opened).toEqual(["home:eda", `home:${PLACE.ref}`]);
    expect(s.clicks).toEqual([]);
    await r.close();
  });

  test("unknown place: refusal with a screenshot, nothing searched", async () => {
    const { s, page } = edaPage();
    s.place = null;
    const r = runner(page);
    expect(await r.run({ op: "quote", service: "eda", place: "нет такого", queries: ["чизбургер"] })).toEqual({ ok: false, code: "place_not_found", screenshot: "U0NSRUVO" });
    s.place = { ref: "not a ref", name: "Бургер Хаус" };
    expect((await r.run({ op: "quote", service: "eda", place: "бургер хаус", queries: ["чизбургер"] }) as { code: string }).code).toBe("place_not_found");
    expect(s.opened).toEqual(["home:eda", "home:eda"]);
    await r.close();
  });

  test("prepare and confirm in the signed restaurant", async () => {
    const { s, page } = edaPage();
    const r = runner(page);
    expect(await r.run(prepare)).toMatchObject({ ok: true, op: "prepare", total_rub: 949 });
    expect(s.opened.every((o) => o === `cart:${PLACE.ref}`)).toBe(true);
    expect(await r.run({ op: "confirm", session: SESSION, maxRub: 1100 })).toEqual({ ok: true, op: "confirm", state: "accepted" });
    await r.close();
  });

  test("dish id not derived from the signed place: refusal before any click", async () => {
    const { s, page } = edaPage();
    const r = runner(page);
    const foreign = { ...prepare, place: "other:place" };
    expect((await r.run(foreign) as { code: string }).code).toBe("product_mismatch");
    expect(s.clicks).toEqual([]);
    const { place: _p, ...noPlace } = prepare as ShopRequest & { place: string };
    expect((await r.run(noPlace as ShopRequest) as { code: string }).code).toBe("place_not_found");
    await r.close();
  });

  test("dish with options: refusal, added dishes removed", async () => {
    const { s, page } = edaPage();
    const r = runner(page);
    page.setProductQty = async (qty) => {
      s.clicks.push(`qty:${s.current}:${qty}`);
      if (qty > 0 && s.current === FRIES.id) return "options_required";
      if (qty === 0) s.cart.delete(s.current); else s.cart.set(s.current, qty);
      return "ok";
    };
    expect(await r.run(prepare)).toEqual({ ok: false, code: "options_required", screenshot: "U0NSRUVO" });
    expect(s.cart.size).toBe(0);
    expect(s.clicks).not.toContain("pay");
    await r.close();
  });

  test("page asks something of its own (blocked): unexpected_page, cart cleared", async () => {
    const { s, page } = edaPage();
    s.qtyResult = "blocked";
    const r = runner(page);
    expect((await r.run(prepare) as { code: string }).code).toBe("unexpected_page");
    expect(s.cart.size).toBe(0);
    await r.close();
  });
});

describe("eda: server flow", () => {
  let h: Awaited<ReturnType<typeof harness>> | null = null;
  const EDA_QUOTE: ShopOutcome = {
    ok: true,
    op: "quote",
    address: ADDRESS,
    place: PLACE,
    delivery_rub: 99,
    results: [{ query: "чизбургер", candidates: [BURGER] }],
  };
  const edaOrder = (place: string | null = PLACE.name, lines = [{ ...BURGER, qty: 2 }]) =>
    handleOrderFood({ service: "eda", ...(place === null ? {} : { place }), lines, delivery_rub: 99, _userId: String(OWNER) }, { agentKey: "orchestrator", chatId: OWNER });
  beforeEach(() => {
    resetShopState();
    process.env.SHOP_ENABLED = "true";
    process.env.MINIAPP_ADMIN_USER_IDS = `123,${OWNER}`;
  });
  afterEach(() => {
    h?.restore();
    h = null;
    resetShopState();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
    }
  });

  test("quote needs a place for eda and refuses one for lavka", async () => {
    h = await harness({ quote: EDA_QUOTE });
    expect((await quoteShop({ service: "eda", queries: ["чизбургер"] }, h.ctx)).ok).toBe(false);
    expect((await quoteShop({ service: "lavka", place: "бургер хаус", queries: ["молоко"] }, h.ctx)).ok).toBe(false);
    expect(h.requests).toEqual([]);
    expect(await quoteShop({ service: "eda", place: "Бургер  хаус", queries: ["чизбургер"] }, h.ctx)).toMatchObject({ ok: true, place: PLACE.name, delivery_rub: 99 });
    expect(h.requests).toEqual([{ op: "quote", service: "eda", place: "Бургер хаус", queries: ["чизбургер"] }]);
  });

  test("daemon answer without the place is rejected", async () => {
    const { place: _p, ...noPlace } = EDA_QUOTE as ShopOutcome & { place: ShopPlace };
    h = await harness({ quote: noPlace as ShopOutcome });
    expect(await quoteShop({ service: "eda", place: "бургер хаус", queries: ["чизбургер"] }, h.ctx)).toMatchObject({ ok: false });
  });

  test("order must name the quoted restaurant; signed params include it; prepare sends the ref", async () => {
    h = await harness({ quote: EDA_QUOTE, prepare: { ok: true, op: "prepare", address: ADDRESS, lines: [{ id: BURGER.id, qty: 2, price_rub: 350 }], total_rub: 799 }, confirm: { ok: true, op: "confirm", state: "accepted" } });
    await quoteShop({ service: "eda", place: "бургер хаус", queries: ["чизбургер"] }, h.ctx);
    expect((await edaOrder("Суши Мастер")).ok).toBe(false);
    expect((await edaOrder(null)).ok).toBe(false);
    const res = await edaOrder();
    expect(res).toMatchObject({ ok: true, result: { status: "awaiting_signature", amount_rub: 799 } });
    const { payload } = h.gate.pending(T0).at(-1)!;
    expect(JSON.parse(payload)).toMatchObject({
      service: "yandex_eda",
      action: "order_food",
      amount_rub: 799,
      params: { store: "Яндекс Еда", place: PLACE.name, address: ADDRESS, item_01: "Чизбургер 250 г × 2 — 700 ₽", delivery_rub: 99 },
    });
    const nonce = await h.sign();
    await executeSignedShop(nonce);
    expect(h.requests[1]).toEqual({ op: "prepare", session: SESSION, service: "eda", place: PLACE.ref, lines: [{ id: BURGER.id, name: BURGER.name, qty: 2 }] });
    expect(h.status(nonce)).toBe("executed");
  });

  test("buildPayload: place required for eda, refused for lavka", () => {
    const line = { ...BURGER, qty: 1 };
    const ctx = { agentKey: "orchestrator" };
    expect(buildPayload("ORDER_FOOD", { service: "еда", place: " Бургер  Хаус ", lines: [line], delivery_rub: 0 }, ctx))
      .toEqual({ ok: true, payload: { service: "eda", place: PLACE.name, lines: [line], delivery_rub: 0 } });
    expect(buildPayload("ORDER_FOOD", { service: "eda", lines: [line], delivery_rub: 0 }, ctx).ok).toBe(false);
    expect(buildPayload("ORDER_FOOD", { service: "lavka", place: PLACE.name, lines: [{ ...MILK, qty: 1 }], delivery_rub: 0 }, ctx).ok).toBe(false);
    expect(approvalCategories("ORDER_FOOD", { service: "eda", place: PLACE.name, lines: [line], delivery_rub: 0 })).toEqual(["money"]);
  });
});

const CHARGER = { id: "123456789-100200300", name: "Зарядное устройство USB-C 65 Вт", price_rub: 2490 };
const CABLE = { id: "987654321-400500600", name: "Кабель USB-C 1 м", price_rub: 590 };

describe("market: parsing and page helpers", () => {
  test("service names, product ids and links", () => {
    expect(normalizeShopService("Маркет")).toBe("market");
    expect(normalizeShopService("яндекс.маркет")).toBe("market");
    expect(marketIdFromHref("/card/zaryadka/123456789?sku=100200300&do-waremd5=x")).toBe(CHARGER.id);
    expect(marketIdFromHref("https://market.yandex.ru/product--zaryadka/123456789?sku=100200300")).toBe(CHARGER.id);
    expect(marketIdFromHref("/card/zaryadka/123456789")).toBeNull();
    expect(marketIdFromHref("/card/zaryadka/123456789?sku=abc")).toBeNull();
    expect(marketIdFromHref("https://evil.example.com/card/x/123456789?sku=1")).toBeNull();
    expect(marketIdFromHref(null)).toBeNull();
    expect(marketUrlFor(CHARGER.id)).toBe("https://market.yandex.ru/product/123456789?sku=100200300");
  });

  test("daemon frame: market lines need a model-sku id, no place", () => {
    const lines = [{ id: CHARGER.id, name: CHARGER.name, qty: 1 }];
    expect(parseShopRequest({ op: "prepare", session: SESSION, service: "market", lines })).toEqual({ op: "prepare", session: SESSION, service: "market", lines });
    expect(parseShopRequest({ op: "prepare", session: SESSION, service: "market", lines: [{ ...lines[0], id: "zaryadka" }] })).toBeNull();
    expect(parseShopRequest({ op: "prepare", session: SESSION, service: "market", place: "a:b", lines })).toBeNull();
    expect(parseShopRequest({ op: "quote", service: "market", queries: ["зарядка"] })).toEqual({ op: "quote", service: "market", queries: ["зарядка"] });
  });

  test("approval card says delivery is a ceiling", () => {
    expect(describeOrderFood({ service: "market", lines: [{ ...CHARGER, qty: 1 }], delivery_rub: 300 }, 15)).toBe(
      "Яндекс Маркет: Зарядное устройство USB-C 65 Вт × 1 — 2490 ₽; доставка до 300 ₽. Всего 2790 ₽ (итог на странице — не больше 3208 ₽), дальше — подпись на телефоне",
    );
    expect(describeOrderFood({ service: "market", lines: [{ ...CHARGER, qty: 1 }], delivery_rub: 1001 }, 15)).toBe("некорректный заказ");
    expect(approvalPreview("MARKET_PURCHASE", { lines: [{ ...CHARGER, qty: 1 }], delivery_rub: 0 })).toContain("Яндекс Маркет");
    expect(approvalCategories("MARKET_PURCHASE", { lines: [{ ...CHARGER, qty: 1 }], delivery_rub: 0 })).toEqual(["money"]);
  });

  test("buildPayload: MARKET_PURCHASE has no service or place, ORDER_FOOD refuses market", () => {
    const line = { ...CHARGER, qty: 1 };
    const ctx = { agentKey: "orchestrator" };
    expect(buildPayload("MARKET_PURCHASE", { lines: [line], delivery_rub: 200 }, ctx)).toEqual({ ok: true, payload: { lines: [line], delivery_rub: 200 } });
    expect(buildPayload("MARKET_PURCHASE", { lines: [line] }, ctx)).toEqual({ ok: true, payload: { lines: [line], delivery_rub: 0 } });
    expect(buildPayload("MARKET_PURCHASE", { lines: [line], delivery_rub: 1500 }, ctx).ok).toBe(false);
    expect(buildPayload("MARKET_PURCHASE", { service: "lavka", lines: [line], delivery_rub: 0 }, ctx).ok).toBe(false);
    expect(buildPayload("MARKET_PURCHASE", { place: "x", lines: [line], delivery_rub: 0 }, ctx).ok).toBe(false);
    expect(buildPayload("MARKET_PURCHASE", { lines: [{ ...line, id: "zaryadka" }], delivery_rub: 0 }, ctx).ok).toBe(false);
  });
});

function marketPage() {
  const f = fakePage();
  f.s.delivery = null;
  f.s.cards = [
    { ...CHARGER, available: true },
    { id: "zaryadka-bez-sku", name: "Зарядка без варианта", price_rub: 990, available: true },
  ];
  f.s.products = new Map([
    [CHARGER.id, { name: CHARGER.name, price_rub: 2490, available: true }],
    [CABLE.id, { name: CABLE.name, price_rub: 590, available: true }],
  ]);
  return f;
}

describe("market: mac runner", () => {
  const prepare: ShopRequest = {
    op: "prepare",
    session: SESSION,
    service: "market",
    lines: [{ id: CHARGER.id, name: CHARGER.name, qty: 1 }, { id: CABLE.id, name: CABLE.name, qty: 2 }],
  };

  test("quote keeps only concrete variants, delivery unknown", async () => {
    const { s, page } = marketPage();
    const r = runner(page);
    expect(await r.run({ op: "quote", service: "market", queries: ["зарядка"] })).toEqual({
      ok: true,
      op: "quote",
      address: ADDRESS,
      delivery_rub: null,
      results: [{ query: "зарядка", candidates: [CHARGER] }],
    });
    expect(s.clicks).toEqual([]);
    await r.close();
  });

  test("prepare and confirm with signed variants", async () => {
    const { s, page } = marketPage();
    const r = runner(page);
    expect(await r.run(prepare)).toMatchObject({ ok: true, op: "prepare", total_rub: 3670 });
    expect(await r.run({ op: "confirm", session: SESSION, maxRub: 4300 })).toEqual({ ok: true, op: "confirm", state: "accepted" });
    expect(s.clicks.filter((c) => c === "pay")).toHaveLength(1);
    await r.close();
  });

  test("variant with options: refusal, cart cleared, no pay", async () => {
    const { s, page } = marketPage();
    s.qtyResult = "options_required";
    const r = runner(page);
    expect(await r.run(prepare)).toEqual({ ok: false, code: "options_required", screenshot: "U0NSRUVO" });
    expect(s.cart.size).toBe(0);
    expect(s.clicks).not.toContain("pay");
    await r.close();
  });
});

describe("market: server flow", () => {
  let h: Awaited<ReturnType<typeof harness>> | null = null;
  const MARKET_QUOTE: ShopOutcome = {
    ok: true,
    op: "quote",
    address: ADDRESS,
    delivery_rub: null,
    results: [{ query: "зарядка", candidates: [CHARGER] }],
  };
  const buy = (delivery_rub = 300, lines = [{ ...CHARGER, qty: 1 }]) =>
    handleMarketPurchase({ lines, delivery_rub, _userId: String(OWNER) }, { agentKey: "orchestrator", chatId: OWNER });
  beforeEach(() => {
    resetShopState();
    process.env.SHOP_ENABLED = "true";
    process.env.MINIAPP_ADMIN_USER_IDS = `123,${OWNER}`;
  });
  afterEach(() => {
    h?.restore();
    h = null;
    resetShopState();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
    }
  });

  test("ORDER_FOOD refuses market; MARKET_PURCHASE signs market_purchase with a delivery ceiling", async () => {
    h = await harness(
      { quote: MARKET_QUOTE, prepare: { ok: true, op: "prepare", address: ADDRESS, lines: [{ id: CHARGER.id, qty: 1, price_rub: 2490 }], total_rub: 2690 }, confirm: { ok: true, op: "confirm", state: "accepted" } },
      { maxRub: 5000, dailyMax: 5, deviationPct: 15 },
    );
    expect(await quoteShop({ service: "market", queries: ["зарядка"] }, h.ctx)).toMatchObject({ ok: true, delivery_rub: null });
    expect((await handleOrderFood({ service: "market", lines: [{ ...CHARGER, qty: 1 }], delivery_rub: 0, _userId: String(OWNER) }, { agentKey: "orchestrator", chatId: OWNER })).ok).toBe(false);
    expect((await buy(1001)).ok).toBe(false);
    expect((await buy(300, [{ ...CHARGER, price_rub: 1990, qty: 1 }])).ok).toBe(false);
    expect(await buy()).toMatchObject({ ok: true, result: { status: "awaiting_signature", amount_rub: 2790 } });
    const { payload } = h.gate.pending(T0).at(-1)!;
    const signed = JSON.parse(payload);
    expect(signed).toMatchObject({
      service: "yandex_market",
      action: "market_purchase",
      amount_rub: 2790,
      params: { store: "Яндекс Маркет", address: ADDRESS, item_01: "Зарядное устройство USB-C 65 Вт × 1 — 2490 ₽", delivery_max_rub: 300 },
    });
    expect(signed.params.delivery_rub).toBeUndefined();
    const nonce = await h.sign();
    await executeSignedShop(nonce);
    expect(h.requests.map((r) => r.op)).toEqual(["quote", "prepare", "confirm"]);
    expect(h.requests[1]).toEqual({ op: "prepare", session: SESSION, service: "market", lines: [{ id: CHARGER.id, name: CHARGER.name, qty: 1 }] });
    expect(h.status(nonce)).toBe("executed");
  });

  test("known delivery must be matched exactly", async () => {
    h = await harness({ quote: { ...MARKET_QUOTE, delivery_rub: 199 } }, { maxRub: 5000, dailyMax: 5, deviationPct: 15 });
    await quoteShop({ service: "market", queries: ["зарядка"] }, h.ctx);
    expect((await buy(300)).ok).toBe(false);
    expect(await buy(199)).toMatchObject({ ok: true, result: { amount_rub: 2689 } });
    expect(JSON.parse(h.gate.pending(T0).at(-1)!.payload).params).toMatchObject({ delivery_rub: 199 });
  });
});
