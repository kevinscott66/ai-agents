/**
 * Шаги 10a–10c: Яндекс Лавка, Еда и Маркет. Всё на заглушках: страница, мост и Telegram
 * подменены, настоящий браузер не запускается и заказ не делается.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvalCategories } from "../lib/approval-policy.ts";
import { approvalPreview } from "../lib/approvals.ts";
import { buildPayload } from "../lib/dispatch/build-payload.ts";
import {
  checkoutShop,
  configureShop,
  executeSignedShop,
  handleMarketPurchase,
  handleOrderFood,
  hasPendingShopOrder,
  listShopPlaces,
  quoteShop,
  resetShopState,
  setShopAddress,
  SHOP_BUSY_WAIT_MS,
  SHOP_OFFLINE_WAIT_MS,
  shopStatus,
} from "../lib/dispatch/shop.ts";
import { SignedActions } from "../lib/signed-actions.ts";
import {
  describeOrderFood,
  edaDishId,
  edaVariantId,
  matchSavedAddress,
  normalizeShopName,
  normalizeShopService,
  parseDeliveryRubles,
  parseShopOutcome,
  parseShopRequest,
  parseShopRubles,
  parseOrderFood,
  parseShopOptionGroups,
  parseShopOptionPicks,
  resolveShopOptions,
  shopAddressHas,
  shopAddressTokens,
  shopLineText,
  SHOP_PRE_ORDER_CODES,
  SHOP_RECOVERY,
  type ShopOptionGroup,
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
import { lavkaCardName, lavkaLdProductId, productIdFromHref, routeShopPage, RUB_AMOUNT } from "../mac-daemon/shop-playwright.ts";
import {
  dishMatches,
  dishName,
  edaBasePrice,
  edaOptionGroups,
  edaPlaceUrl,
  isBlankContact,
  optionDelta,
  parseEdaCartRow,
  edaPlacesFromLinks,
  placeRefFromHref,
  type RawOptionGroup,
} from "../mac-daemon/eda-playwright.ts";
import { marketIdFromHref, marketUrlFor } from "../mac-daemon/market-playwright.ts";
import { MARKET_TESTID, MARKET_TEXT } from "../mac-daemon/market-selectors.ts";
import { LAVKA_TEXT } from "../mac-daemon/shop-selectors.ts";
import { EDA_TESTID, EDA_TEXT } from "../mac-daemon/eda-selectors.ts";
import {
  parseShopPlaceEta,
  pickShopPlace,
  rankShopPlaces,
  shopPlaceEtaText,
  type ShopPlace,
} from "../lib/shop.ts";

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
    expect(parseDeliveryRubles("5–10 мин, 0–59 ₽")).toBe(59);
    expect(parseDeliveryRubles("0-59 ₽")).toBe(59);
    expect(parseDeliveryRubles("бесплатно")).toBeNull();
    expect(normalizeShopName("Моло­ко  3,2% 1 л")).toBe("Молоко 3,2% 1 л");
    expect(normalizeShopName("Молоко​ 1 л")).toBeNull();
    expect(normalizeShopService(undefined)).toBe("lavka");
    expect(normalizeShopService("Лавка")).toBe("lavka");
    expect(normalizeShopService("ozon")).toBeNull();
    expect(productIdFromHref("/good/moloko-3-2-1l?from=search")).toBe("moloko-3-2-1l");
    expect(productIdFromHref("https://evil.example.com/good/x")).toBeNull();
    // Подпись ссылки короткая, полное имя — в alt; как на странице товара: заголовок + фасовка.
    expect(lavkaCardName("Хлеб тосто\u00adвый Аютин\u00adский хлеб 570 г", "Хлеб тостовый «Аютинский хлеб» в нарезке"))
      .toBe("Хлеб тостовый «Аютинский хлеб» в нарезке 570 г");
    expect(lavkaCardName("Вода Святой источник 6 × 1,5 л", "Вода «Святой источник» негазированная")).toBe("Вода «Святой источник» негазированная 6 × 1,5 л");
    expect(lavkaCardName("Молоко 3,2% 1 л", "")).toBe("Молоко 3,2% 1 л");
    expect(lavkaCardName("Набор без фасовки", "Набор «Полный»")).toBe("Набор без фасовки");
    // Мини-корзина ссылается на hex-id: берём его из JSON-LD ровно по заголовку.
    const hex = "9e915676cf1244f39f7b6bebb9dc364f000300010000";
    const ld = [{ "@graph": [{ "@type": "BreadcrumbList", itemListElement: [{ name: "Хлеб" }] }, { "@type": "Product", "@id": hex, name: "Хлеб тостовый «Аютинский хлеб» в нарезке" }, { "@type": "Product", "@id": "a".repeat(44), name: "Батон" }] }];
    expect(lavkaLdProductId(ld, "Хлеб  тостовый «Аютинский хлеб» в нарезке")).toBe(hex);
    expect(lavkaLdProductId(ld, "Батон нарезной")).toBeNull();
    expect(lavkaLdProductId([{ "@type": "Product", "@id": "not-hex", name: "Батон" }], "Батон")).toBeNull();
    expect(lavkaLdProductId([{ "@type": "Product", "@id": hex, name: "Батон" }, { "@type": "Product", "@id": "b".repeat(44), name: "Батон" }], "Батон")).toBeNull();
  });

  test("lavka saved card and payment step texts", () => {
    // Экран оформления показывает карту как «MIR · 0000» — с одной точкой.
    expect(LAVKA_TEXT.savedCard.test("Способ оплаты MIR · 0000 Адрес доставки")).toBe(true);
    expect(LAVKA_TEXT.savedCard.test("Visa ·1234")).toBe(true);
    expect(LAVKA_TEXT.savedCard.test("Карта •• 1234")).toBe(true);
    expect(LAVKA_TEXT.savedCard.test("Способ оплаты Добавить карту")).toBe(false);
    expect(LAVKA_TEXT.savedCard.test("MIR · 00001")).toBe(false);
    expect(LAVKA_TEXT.toPayment.test("Перейти к оплате")).toBe(true);
    expect(LAVKA_TEXT.pay.test("Перейти к оплате")).toBe(false);
  });

  test("daemon frame is strict", () => {
    const lines = [{ id: MILK.id, name: MILK.name, qty: 2 }];
    expect(parseShopRequest({ op: "quote", service: "lavka", queries: ["молоко"] })).toEqual({ op: "quote", service: "lavka", queries: ["молоко"] });
    expect(parseShopRequest({ op: "quote", service: "lavka", queries: [] })).toBeNull();
    expect(parseShopRequest({ op: "reset" })).toEqual({ op: "reset" });
    expect(parseShopRequest({ op: "reset", service: "lavka" })).toBeNull();
    expect(parseShopOutcome(JSON.stringify({ ok: true, op: "reset", reset: true }), "reset")).toEqual({ ok: true, op: "reset", reset: true });
    expect(parseShopOutcome(JSON.stringify({ ok: false, code: "shop_busy", busy_op: "confirm", busy_ms: 1200 }), "status"))
      .toEqual({ ok: false, code: "shop_busy", busy_op: "confirm", busy_ms: 1200 });
    expect(parseShopOutcome(JSON.stringify({ ok: false, code: "shop_paying", busy_op: "confirm", busy_ms: 5 }), "reset"))
      .toMatchObject({ ok: false, code: "shop_paying" });
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
    eta_min: null as number | null,
    clicks: [] as string[],
    shots: 0,
    place: null as ShopPlace | null,
    /** Список ресторанов; null — только place. */
    places: null as ShopPlace[] | null,
    placeQueries: [] as (string | null)[],
    qtyResult: "ok" as QtyResult,
    opened: [] as string[],
    addresses: ["Краснодар, Красная 1", "Краснодар, Ленина 5, кв 12"] as string[],
  };
  const total = () => [...s.cart].reduce((sum, [id, qty]) => sum + qty * (s.products.get(id)?.price_rub ?? 0), 0) + (s.delivery ?? 0);
  const page: ShopPage = {
    openHome: async (t) => { s.current = "home"; s.opened.push(`home:${t.place ?? t.service}`); },
    places: async (q) => { s.placeQueries.push(q); return (s.places ?? (s.place ? [s.place] : [])).map((p) => ({ ...p })); },
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
    savedAddresses: async () => { s.clicks.push("addresses"); return [...s.addresses]; },
    chooseAddress: async (i) => { s.clicks.push(`address:${i}`); s.address = s.addresses[i] ?? s.address; },
    closeAddresses: async () => { s.clicks.push("addresses:close"); },
    cart: async () => [...s.cart].map(([id, qty]) => ({ id, qty, price_rub: s.products.get(id)?.price_rub ?? null })),
    openCheckout: async () => { s.current = "checkout"; return s.cart.size > 0; },
    checkout: async () => ({ total_rub: total(), blocked: false, saved_card: true, pay_button: true, ...s.checkout }),
    clickPay: async () => { s.clicks.push("pay"); s.state = s.stateAfterPay; },
    orderState: async () => ({ state: s.state, eta_min: s.eta_min }),
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

  test("оформление подписывается именем и почтой из окружения", async () => {
    // Еда просит имя и почту «для уточнения по заказу». Значения живут в
    // пускаче, а не в репозитории: исполнитель только передаёт их странице,
    // и та заполняет пустое поле. Нет значений — нечего и передавать.
    const { page } = fakePage();
    const seen: Array<{ name?: string; email?: string }> = [];
    page.fillContacts = async (c) => { seen.push(c); };
    const withEnv = runner(page, { SHOP_ENABLED: "true", SHOP_PROFILE_DIR: "/profile", SHOP_CONTACT_NAME: "Имя Фамилия", SHOP_CONTACT_EMAIL: "kto@example.com" });
    expect((await withEnv.run(prepare) as { ok: boolean }).ok).toBe(true);
    expect(seen).toEqual([{ name: "Имя Фамилия", email: "kto@example.com" }]);
    await withEnv.close();

    const { page: bare } = fakePage();
    const blank: Array<{ name?: string; email?: string }> = [];
    bare.fillContacts = async (c) => { blank.push(c); };
    const noEnv = runner(bare);
    expect((await noEnv.run(prepare) as { ok: boolean }).ok).toBe(true);
    expect(blank).toEqual([{ name: undefined, email: undefined }]);
    await noEnv.close();
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
    expect(await r.run({ op: "status", service: "lavka" })).toEqual({ ok: true, op: "status", state: "delivering", eta_min: null });
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
  // Предпросмотр SHOP_CHECKOUT перед заказом: свои ответы Mac и свой журнал,
  // чтобы проверки исполнителя видели только его запросы.
  type Preview = { total: number; prepare?: ShopOutcome; abandon?: boolean };
  let preview: Preview | null = null;
  const previewRequests: ShopRequest[] = [];
  const restore = configureShop({
    gate: () => gate,
    now: () => T0,
    session: () => SESSION,
    send: async (request) => {
      if (preview) {
        previewRequests.push(request);
        if (request.op === "abandon") {
          return preview.abandon === false ? { ok: false, stdout: "", error: "mac_unreachable" } : { ok: true, stdout: JSON.stringify({ ok: true, op: "abandon" }) };
        }
        if (request.op !== "prepare") return { ok: false, stdout: "", error: "unexpected_op" };
        if (preview.prepare) return { ok: true, stdout: JSON.stringify(preview.prepare) };
        const prepared = { ok: true, op: "prepare", address: ADDRESS, lines: request.lines.map((l) => ({ id: l.id, qty: l.qty, price_rub: 1 })), total_rub: preview.total };
        return { ok: true, stdout: JSON.stringify(prepared) };
      }
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
  /** SHOP_CHECKOUT с заданным итогом (по умолчанию — товары плюс доставка из расчёта, без сборов). */
  const checkout = async (lines: Array<Record<string, unknown>>, total?: number, extra: Record<string, unknown> = {}, mac: Omit<Preview, "total"> = {}) => {
    preview = { total: total ?? lines.reduce((sum, l) => sum + (l.qty as number) * (l.price_rub as number), 0), ...mac };
    try {
      return await checkoutShop({ service: "lavka", lines, ...extra }, ctx);
    } finally {
      preview = null;
    }
  };
  const order = async (lines = [{ ...MILK, qty: 2 }], delivery_rub = 0, total_rub?: number) => {
    await checkout(lines, total_rub);
    const total = total_rub ?? lines.reduce((sum, l) => sum + l.qty * l.price_rub, 0) + delivery_rub;
    return handleOrderFood({ service: "lavka", lines, delivery_rub, total_rub: total, _userId: String(OWNER) }, { agentKey: "orchestrator", chatId: OWNER });
  };
  const sign = async () => {
    const { nonce, payload } = gate.pending(T0).at(-1)!;
    await gate.approve(nonce, await owner.sign(payload), T0);
    return nonce;
  };
  const status = (nonce: string) => (gate.db.query("SELECT status FROM signed_actions WHERE nonce=?").get(nonce) as { status: string }).status;
  return { gate, requests, previewRequests, texts, photos, restore, ctx, quote, checkout, order, sign, status };
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
    h = await harness({ quote: QUOTE, status: { ok: true, op: "status", state: "none", eta_min: null } });
    expect((await quoteShop({ queries: ["молоко"] }, { ...h.ctx, chatId: -100 })).ok).toBe(false);
    expect((await quoteShop({ queries: ["молоко"] }, { ...h.ctx, agentKey: "qa" })).ok).toBe(false);
    expect((await quoteShop({ queries: ["молоко"] }, { ...h.ctx, triggerUserId: "555", chatId: 555 })).ok).toBe(false);
    expect((await quoteShop({ queries: ["молоко"] }, { ...h.ctx, delegationChain: ["orchestrator", "devops"] })).ok).toBe(false);
    expect((await handleOrderFood({ service: "lavka", lines: [{ ...MILK, qty: 1 }], delivery_rub: 0, total_rub: 99, _userId: String(OWNER), _delegated: true }, { agentKey: "orchestrator", chatId: OWNER })).ok).toBe(false);
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

describe("SHOP_CHECKOUT: итог с оформления до подписи", () => {
  let h: Awaited<ReturnType<typeof harness>> | null = null;
  const LINES = [{ ...MILK, qty: 2 }];
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

  test("сборы: итог с оформления, корзина очищена, подпись и карточка на итог", async () => {
    h = await harness({ quote: QUOTE, prepare: { ...PREPARED, total_rub: 277 }, confirm: { ok: true, op: "confirm", state: "accepted" } });
    await h.quote();
    const res = await h.checkout(LINES, 277);
    expect(res).toMatchObject({ ok: true, items_rub: 198, delivery_rub: 0, extra_rub: 79, total_rub: 277 });
    expect(JSON.stringify(res)).toContain("маленький заказ");
    expect(h.previewRequests.map((r) => r.op)).toEqual(["prepare", "abandon"]);
    const order = await handleOrderFood({ service: "lavka", lines: LINES, delivery_rub: 0, total_rub: 277, _userId: String(OWNER) }, { agentKey: "orchestrator", chatId: OWNER });
    expect(order).toMatchObject({ ok: true, result: { status: "awaiting_signature", amount_rub: 277 } });
    const { payload } = h.gate.pending(T0).at(-1)!;
    expect(JSON.parse(payload)).toMatchObject({ amount_rub: 277, params: { fees_rub: 79 } });
    expect(approvalPreview("ORDER_FOOD", { service: "lavka", lines: LINES, delivery_rub: 0, total_rub: 277 })).toContain("сборы 79 ₽");
    const nonce = await h.sign();
    await executeSignedShop(nonce);
    expect(h.status(nonce)).toBe("executed");
  });

  test("без SHOP_CHECKOUT, с другим итогом или другими позициями — отказ", async () => {
    h = await harness({ quote: QUOTE });
    await h.quote();
    const order = (total_rub: number, lines = LINES) =>
      handleOrderFood({ service: "lavka", lines, delivery_rub: 0, total_rub, _userId: String(OWNER) }, { agentKey: "orchestrator", chatId: OWNER });
    expect(await order(198)).toMatchObject({ ok: false });
    await h.checkout(LINES, 277);
    expect(await order(198)).toMatchObject({ ok: false });
    expect(await order(99, [{ ...MILK, qty: 1 }])).toMatchObject({ ok: false });
    expect(h.gate.pending(T0)).toEqual([]);
  });

  test("отказ Mac на сборке: корзину всё равно очищают", async () => {
    h = await harness({ quote: QUOTE });
    await h.quote();
    const res = await h.checkout(LINES, 0, {}, { prepare: { ok: false, op: "prepare", code: "captcha", error: "captcha" } as ShopOutcome });
    expect(res).toMatchObject({ ok: false });
    expect(h.previewRequests.map((r) => r.op)).toEqual(["prepare", "abandon"]);
  });

  test("корзина не очистилась — итог не запоминается", async () => {
    h = await harness({ quote: QUOTE });
    await h.quote();
    expect(await h.checkout(LINES, 198, {}, { abandon: false })).toMatchObject({ ok: false });
    const order = await handleOrderFood({ service: "lavka", lines: LINES, delivery_rub: 0, total_rub: 198, _userId: String(OWNER) }, { agentKey: "orchestrator", chatId: OWNER });
    expect(order).toMatchObject({ ok: false });
  });

  test("неправдоподобный итог и Маркет — отказ", async () => {
    h = await harness({ quote: QUOTE });
    await h.quote();
    expect(await h.checkout(LINES, 198 + 5_000)).toMatchObject({ ok: false, error: "invalid_shop_result" });
    expect(await h.checkout(LINES, 198, { service: "market" })).toMatchObject({ ok: false });
    expect(h.previewRequests.map((r) => r.op)).toEqual(["prepare", "abandon"]);
  });

  test("buildPayload без total_rub — отказ со ссылкой на SHOP_CHECKOUT", () => {
    const res = buildPayload("ORDER_FOOD", { service: "lavka", lines: LINES, delivery_rub: 0 }, { agentKey: "orchestrator" });
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).toContain("SHOP_CHECKOUT");
  });
});

describe("браузер покупок занят", () => {
  const ctx = { agentKey: "orchestrator", chatId: OWNER, triggerUserId: String(OWNER) };
  const STATUS = { ok: true, op: "status", state: "delivering", eta_min: 20 };
  const BUSY = { ok: true, stdout: JSON.stringify({ ok: false, code: "shop_busy" }) };
  let restore: (() => void) | null = null;
  beforeEach(() => {
    resetShopState();
    process.env.SHOP_ENABLED = "true";
    process.env.MINIAPP_ADMIN_USER_IDS = `123,${OWNER}`;
  });
  afterEach(() => {
    restore?.();
    restore = null;
    resetShopState();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
    }
  });

  test("shop_busy — хвост брошенного запроса: сервер пережидает и повторяет", async () => {
    let clock = T0;
    let calls = 0;
    restore = configureShop({
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      send: async () => (++calls < 4 ? BUSY : { ok: true, stdout: JSON.stringify(STATUS) }),
    });
    expect(await shopStatus({ service: "eda" }, ctx)).toMatchObject({ ok: true, state: "delivering" });
    expect(calls).toBe(4);
  });

  test("занят дольше SHOP_BUSY_WAIT_MS — отказ с кодом, без вечного цикла", async () => {
    let clock = T0;
    let calls = 0;
    restore = configureShop({
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      send: async () => { calls++; return BUSY; },
    });
    expect(await shopStatus({ service: "eda" }, ctx)).toMatchObject({ ok: false, code: "shop_busy" });
    expect(clock - T0).toBeGreaterThanOrEqual(SHOP_BUSY_WAIT_MS);
    expect(calls).toBeLessThan(30);
  });

  test("запросы к Mac идут по одному: второй ждёт первого, а не ловит shop_busy", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    restore = configureShop({
      now: () => T0,
      send: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return { ok: true, stdout: JSON.stringify(STATUS) };
      },
    });
    const both = await Promise.all([shopStatus({ service: "eda" }, ctx), shopStatus({ service: "lavka" }, ctx)]);
    expect(both.every((r) => r.ok)).toBe(true);
    expect(maxInFlight).toBe(1);
  });

  test("занят второй раз подряд — сервер сам просит Mac сбросить брошенный запуск, один раз", async () => {
    let clock = T0;
    const ops: string[] = [];
    restore = configureShop({
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      send: async (req) => {
        ops.push(req.op);
        if (req.op === "reset") return { ok: true, stdout: JSON.stringify({ ok: true, op: "reset", reset: true }) };
        return ops.filter((o) => o === "status").length < 4 ? BUSY : { ok: true, stdout: JSON.stringify(STATUS) };
      },
    });
    expect(await shopStatus({ service: "eda" }, ctx)).toMatchObject({ ok: true, state: "delivering" });
    expect(ops).toEqual(["status", "status", "reset", "status", "status"]);
  });

  test("Mac оформляет оплату (shop_paying) — не сбрасывается, сервер ждёт дальше", async () => {
    let clock = T0;
    const ops: string[] = [];
    const held = { ok: false, code: "shop_busy", busy_op: "confirm", busy_ms: 40_000 };
    restore = configureShop({
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      send: async (req) => {
        ops.push(req.op);
        if (req.op === "reset") return { ok: true, stdout: JSON.stringify({ ok: false, code: "shop_paying", busy_op: "confirm", busy_ms: 45_000 }) };
        return ops.length < 6 ? { ok: true, stdout: JSON.stringify(held) } : { ok: true, stdout: JSON.stringify(STATUS) };
      },
    });
    expect(await shopStatus({ service: "eda" }, ctx)).toMatchObject({ ok: true, state: "delivering" });
    expect(ops.filter((o) => o === "reset")).toEqual(["reset"]);
  });

  test("старый демон не знает reset — ошибка сброса не рвёт ожидание", async () => {
    let clock = T0;
    const ops: string[] = [];
    restore = configureShop({
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      send: async (req) => {
        ops.push(req.op);
        if (req.op === "reset") return { ok: false, stdout: "", error: "invalid_shop_request" };
        return ops.length < 5 ? BUSY : { ok: true, stdout: JSON.stringify(STATUS) };
      },
    });
    expect(await shopStatus({ service: "eda" }, ctx)).toMatchObject({ ok: true, state: "delivering" });
    expect(ops).toContain("reset");
  });

  // Этап 2 автономии: известные временные сбои сервер лечит сам.
  const fakeClock = () => {
    const c = { now: T0 };
    return { c, now: () => c.now, sleep: async (ms: number) => { c.now += ms; } };
  };
  const reply = (o: unknown) => ({ ok: true, stdout: JSON.stringify(o) });

  test("Mac не на связи — сервер ждёт переподключения, агент получает статус", async () => {
    const { now, sleep } = fakeClock();
    let calls = 0;
    restore = configureShop({ now, sleep, send: async () => (++calls < 4 ? { ok: false, stdout: "", error: "mac_offline" } : reply(STATUS)) });
    expect(await shopStatus({ service: "eda" }, ctx)).toMatchObject({ ok: true, state: "delivering" });
    expect(calls).toBe(4);
  });

  test("Mac не на связи дольше минуты — отказ с кодом, next и owner_needed", async () => {
    const { c, now, sleep } = fakeClock();
    restore = configureShop({ now, sleep, send: async () => ({ ok: false, stdout: "", error: "mac_offline" }) });
    const out = await shopStatus({ service: "eda" }, ctx);
    expect(out).toMatchObject({ ok: false, code: "mac_offline", owner_needed: true });
    expect(String(out.next)).toContain("SCHEDULE_FOLLOWUP");
    expect(c.now - T0).toBeGreaterThanOrEqual(SHOP_OFFLINE_WAIT_MS);
  });

  test("Chrome не запустился — второй запуск сам, без агента", async () => {
    const { now, sleep } = fakeClock();
    let calls = 0;
    restore = configureShop({ now, sleep, send: async () => (++calls === 1 ? reply({ ok: false, code: "browser_unavailable" }) : reply(STATUS)) });
    expect(await shopStatus({ service: "eda" }, ctx)).toMatchObject({ ok: true, state: "delivering" });
    expect(calls).toBe(2);
  });

  test("Chrome не запустился дважды — агенту действие, а не просьба к владельцу", async () => {
    const { now, sleep } = fakeClock();
    let calls = 0;
    restore = configureShop({ now, sleep, send: async () => { calls++; return reply({ ok: false, code: "browser_unavailable" }); } });
    expect(await shopStatus({ service: "eda" }, ctx)).toMatchObject({ ok: false, code: "browser_unavailable", owner_needed: false });
    expect(calls).toBe(2);
  });

  test("обрыв связи на чтении — один повтор; второй обрыв отдаётся агенту", async () => {
    const { now, sleep } = fakeClock();
    let calls = 0;
    restore = configureShop({ now, sleep, send: async () => (++calls === 1 ? { ok: false, stdout: "", error: "mac_disconnected" } : reply(STATUS)) });
    expect(await shopStatus({ service: "eda" }, ctx)).toMatchObject({ ok: true });
    expect(calls).toBe(2);

    restore();
    calls = 0;
    restore = configureShop({ now, sleep, send: async () => { calls++; return { ok: false, stdout: "", error: "mac_disconnected" }; } });
    expect(await shopStatus({ service: "eda" }, ctx)).toMatchObject({ ok: false, code: "mac_disconnected", owner_needed: false });
    expect(calls).toBe(2);
  });

  test("капча — за владельцем; у каждого кода отказа есть действие", async () => {
    restore = configureShop({ now: () => T0, send: async () => reply({ ok: false, code: "captcha" }) });
    expect(await shopStatus({ service: "eda" }, ctx)).toMatchObject({ ok: false, code: "captcha", owner_needed: true });
    for (const code of [...SHOP_PRE_ORDER_CODES, "shop_paying"] as const) {
      expect(SHOP_RECOVERY[code].next.length).toBeGreaterThan(10);
    }
    for (const code of ["login_required", "captcha", "payment_needs_owner", "address_required"] as const) expect(SHOP_RECOVERY[code].owner).toBe(true);
    for (const code of ["shop_busy", "browser_unavailable", "price_changed", "unexpected_page"] as const) expect(SHOP_RECOVERY[code].owner).toBe(false);
  });
});

describe("mac runner: занятость и сброс", () => {
  function hungRunner(page: ShopPage, clock: { now: number }, onClose: () => void) {
    return new ShopRunner({ SHOP_ENABLED: "true", SHOP_PROFILE_DIR: "/profile" }, {
      launch: async () => ({ page: () => page, close: async () => { onClose(); } }),
      checkProfile: (dir) => dir ?? "",
      now: () => clock.now,
      sleep: async () => {},
      idleMs: 60_000,
    });
  }
  const tick = () => new Promise((r) => setTimeout(r, 1));

  test("занятость говорит, что держит браузер; сброс рвёт висящий запуск и отпускает замок", async () => {
    const { s, page } = fakePage();
    const clock = { now: T0 };
    let fail: ((e: Error) => void) | null = null;
    const r = hungRunner(page, clock, () => fail?.(new Error("Target closed")));
    expect(await r.run({ op: "reset" })).toEqual({ ok: true, op: "reset", reset: false });

    const orderState = page.orderState;
    page.orderState = () => new Promise((_, reject) => { fail = reject; });
    const stuck = r.run({ op: "status", service: "lavka" }).catch(() => null);
    await tick();
    clock.now += 30_000;
    expect(await r.run({ op: "status", service: "eda" })).toEqual({ ok: false, code: "shop_busy", busy_op: "status", busy_ms: 30_000 });

    expect(await r.run({ op: "reset" })).toEqual({ ok: true, op: "reset", reset: true });
    await stuck;
    page.orderState = orderState;
    s.state = "delivering";
    expect(await r.run({ op: "status", service: "lavka" })).toMatchObject({ ok: true, op: "status", state: "delivering" });
    await r.close();
  });

  test("оформление с оплатой не сбрасывается", async () => {
    const { s, page } = fakePage();
    const clock = { now: T0 };
    const r = hungRunner(page, clock, () => {});
    const prepare: ShopRequest = { op: "prepare", session: SESSION, service: "lavka", lines: [{ id: MILK.id, name: MILK.name, qty: 1 }] };
    await r.run(prepare);
    let pay: (() => void) | null = null;
    const clickPay = page.clickPay;
    page.clickPay = () => new Promise<void>((resolve) => { pay = () => { s.state = s.stateAfterPay; resolve(); }; });
    const paying = r.run({ op: "confirm", session: SESSION, maxRub: 1000 });
    await tick();
    clock.now += 10_000;
    expect(await r.run({ op: "reset" })).toEqual({ ok: false, code: "shop_paying", busy_op: "confirm", busy_ms: 10_000 });
    pay!();
    expect(await paying).toMatchObject({ ok: true, op: "confirm" });
    page.clickPay = clickPay;
    await r.close();
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
    expect(buildPayload("ORDER_FOOD", { service: "лавка", lines: [line], delivery_rub: 0, total_rub: 198 }, { agentKey: "orchestrator" }))
      .toEqual({ ok: true, payload: { service: "lavka", lines: [{ ...MILK, qty: 2 }], delivery_rub: 0, total_rub: 198 } });
    expect(buildPayload("ORDER_FOOD", { service: "lavka", lines: [{ ...line, qty: "2" }], delivery_rub: 0, total_rub: 198 }, { agentKey: "orchestrator" }).ok).toBe(false);
    expect(buildPayload("ORDER_FOOD", { service: "lavka", lines: [line, line], delivery_rub: 0, total_rub: 198 }, { agentKey: "orchestrator" }).ok).toBe(false);
    expect(buildPayload("ORDER_FOOD", { service: "market", lines: [line], delivery_rub: 0, total_rub: 198 }, { agentKey: "orchestrator" }).ok).toBe(false);
    expect(buildPayload("ORDER_FOOD", { service: "lavka", lines: [], delivery_rub: 0, total_rub: 198 }, { agentKey: "orchestrator" }).ok).toBe(false);
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
    expect(pickShopPlace("бургер хаус", places)).toEqual({ place: places[1]! });
    expect(pickShopPlace("экспресс", places)).toEqual({ place: places[0]! });
    expect(pickShopPlace("пицца", places)).toBeNull();
    expect(pickShopPlace("  ", places)).toBeNull();
    expect(dishMatches("Чизбургер 250 г", "чизбургер")).toBe(true);
    expect(dishMatches("Двойной чизбургер", "чизбургеры двойные")).toBe(true);
    expect(dishMatches("Картофель фри", "чизбургер")).toBe(false);
    expect(dishName(" Чизбургер ", "250 г")).toBe("Чизбургер 250 г");
    expect(dishName("Чизбургер", "")).toBe("Чизбургер");
    // Карточка меню: «950 г · 2548 ккал», окно блюда: «950 г» — одно и то же блюдо.
    expect(dishName("40 см Маргарита Пицца", "950 г · 2548 ккал")).toBe(dishName("40 см Маргарита Пицца", "950 г"));
    expect(dishName("Морс", "320 ккал")).toBe("Морс");
  });

  test("router sends each call to the page of the opened service", async () => {
    const lavka = fakePage();
    const eda = fakePage();
    eda.s.place = PLACE;
    eda.s.address = "Еда-адрес";
    const page = routeShopPage({ lavka: lavka.page, eda: eda.page, market: fakePage().page });
    await page.openHome({ service: "lavka" });
    expect(await page.address()).toBe("Краснодар, Красная 1");
    expect(await page.places("бургер")).toEqual([PLACE]);
    await page.openHome({ service: "eda", place: PLACE.ref });
    expect(await page.address()).toBe("Еда-адрес");
    expect(lavka.s.opened).toEqual(["home:lavka"]);
    expect(eda.s.opened).toEqual([`home:${PLACE.ref}`]);
    // Необязательный метод роутер не теряет: иначе контакты не доходят до Еды.
    const seen: unknown[] = [];
    eda.page.fillContacts = async (c) => { seen.push(c); };
    await page.fillContacts!({ name: "Имя", email: "a@b.c" });
    expect(seen).toEqual([{ name: "Имя", email: "a@b.c" }]);
    await page.openHome({ service: "lavka" });
    await page.fillContacts!({ name: "Имя" });
    expect(seen).toHaveLength(1);
  });

  test("checkout amounts and contact placeholders", () => {
    const last = (t: string) => { const m = t.match(new RegExp(RUB_AMOUNT.source, "g")); return m ? parseShopRubles(m[m.length - 1]) : null; };
    // Еда: разряды отбиты U+2009, у позиций — U+2006.
    expect(last("\n1\u202f075\u2006₽\n189\u2006₽\nОплатить\n1\u2009\u2009317\u2009₽")).toBe(1317);
    expect(last("К оплате 288 ₽")).toBe(288);
    expect(last("Итого 2\u00a0450 ₽")).toBe(2450);
    expect(isBlankContact("")).toBe(true);
    expect(isBlankContact(" Пользователь ")).toBe(true);
    expect(isBlankContact("Пользователь Иванов")).toBe(false);
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
  /** Цена штуки по id варианта: без опций — цена блюда, с опциями — из prices. */
  const prices = new Map<string, number>();
  const unit = (id: string) => prices.get(id) ?? f.s.products.get(id)?.price_rub ?? null;
  f.page.addWithOptions = async (qty, picks) => {
    f.s.clicks.push(`add:${f.s.current}:${qty}${picks.length ? `:${picks.map((p) => p.name).join("+")}` : ""}`);
    if (f.s.qtyResult !== "ok") return f.s.qtyResult;
    const name = f.s.products.get(f.s.current)!.name!;
    const id = edaVariantId(PLACE.ref, name, picks.map((p) => p.name));
    f.s.cart.set(id, (f.s.cart.get(id) ?? 0) + qty);
    return "ok";
  };
  f.page.removeCartRows = async (ids) => {
    f.s.clicks.push(`remove:${ids.length}`);
    for (const id of ids) f.s.cart.delete(id);
  };
  f.page.cart = async () => [...f.s.cart].map(([id, qty]) => ({ id, qty, price_rub: unit(id) }));
  const total = () => [...f.s.cart].reduce((sum, [id, qty]) => sum + qty * (unit(id) ?? 0), 0) + (f.s.delivery ?? 0);
  f.page.checkout = async () => ({ total_rub: total(), blocked: false, saved_card: true, pay_button: true, ...f.s.checkout });
  return { ...f, prices };
}

const SAUCE: ShopOptionGroup = { name: "Соус", min: 1, max: 1, choices: [{ name: "Кетчуп", price_rub: 0 }, { name: "Сырный", price_rub: 40 }] };
const EXTRA: ShopOptionGroup = { name: "Добавки", min: 0, max: 2, choices: [{ name: "Бекон", price_rub: 90 }, { name: "Халапеньо", price_rub: 30 }, { name: "Сыр", price_rub: 50 }] };

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

  test("quote carries dish options; lavka cards with options are skipped", async () => {
    const { page } = edaPage();
    page.searchCards = async () => [{ ...BURGER, available: true, options: [SAUCE, EXTRA] }];
    const r = runner(page);
    expect(await r.run({ op: "quote", service: "eda", place: "бургер хаус", queries: ["чизбургер"] })).toMatchObject({
      ok: true,
      results: [{ query: "чизбургер", candidates: [{ ...BURGER, options: [SAUCE, EXTRA] }] }],
    });
    await r.close();
    const lavka = fakePage();
    lavka.page.searchCards = async () => [{ ...MILK, available: true, options: [SAUCE] }];
    const r2 = runner(lavka.page);
    expect(await r2.run({ op: "quote", service: "lavka", queries: ["молоко"] })).toMatchObject({ ok: true, results: [{ query: "молоко", candidates: [] }] });
    await r2.close();
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
    const add = page.addWithOptions!;
    page.addWithOptions = async (qty, picks) => (s.current === FRIES.id && !picks.length ? "options_required" : add(qty, picks));
    expect(await r.run(prepare)).toEqual({ ok: false, code: "options_required", screenshot: "U0NSRUVO" });
    expect(s.cart.size).toBe(0);
    expect(s.clicks).not.toContain("pay");
    page.addWithOptions = async (qty, picks) => (s.current === FRIES.id ? "options_mismatch" : add(qty, picks));
    expect(await r.run(prepare)).toEqual({ ok: false, code: "options_mismatch", screenshot: "U0NSRUVO" });
    expect(s.cart.size).toBe(0);
    await r.close();
  });

  test("signed options go to the dish window; cart rows are matched by variant", async () => {
    const { s, page, prices } = edaPage();
    const picks = [{ group: "Соус", name: "Сырный" }, { group: "Добавки", name: "Бекон" }];
    const variant = edaVariantId(PLACE.ref, BURGER.name, ["Сырный", "Бекон"]);
    prices.set(variant, 480);
    const r = runner(page);
    const withOptions: ShopRequest = { ...prepare, lines: [{ id: BURGER.id, name: BURGER.name, qty: 1, options: picks }, { id: BURGER.id, name: BURGER.name, qty: 1 }] };
    expect(await r.run(withOptions)).toEqual({
      ok: true,
      op: "prepare",
      address: ADDRESS,
      lines: [{ id: variant, qty: 1, price_rub: 480 }, { id: BURGER.id, qty: 1, price_rub: 350 }],
      total_rub: 929,
    });
    expect(s.clicks).toEqual([`add:${BURGER.id}:1:Сырный+Бекон`, `add:${BURGER.id}:1`]);
    await r.run({ op: "abandon", session: SESSION });
    expect(s.cart.size).toBe(0);
    await r.close();
  });

  test("options for lavka are refused before any click", async () => {
    const { s, page } = fakePage();
    const r = runner(page);
    const lines = [{ id: MILK.id, name: MILK.name, qty: 1, options: [{ group: "Объём", name: "1 л" }] }];
    expect(parseShopRequest({ op: "prepare", session: SESSION, service: "lavka", lines })).toBeNull();
    expect((await r.run({ op: "prepare", session: SESSION, service: "lavka", lines } as unknown as ShopRequest) as { code: string }).code).toBe("product_mismatch");
    expect(s.clicks).toEqual([]);
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

describe("eda: dish options", () => {
  test("groups, picks and resolution", () => {
    expect(parseShopOptionGroups([SAUCE, EXTRA])).toEqual([SAUCE, EXTRA]);
    expect(parseShopOptionGroups([])).toBeNull();
    expect(parseShopOptionGroups([{ ...SAUCE, max: 3 }])).toBeNull();
    expect(parseShopOptionGroups([{ ...SAUCE, min: 2, max: 1 }])).toBeNull();
    expect(parseShopOptionGroups([{ ...SAUCE, extra: 1 }])).toBeNull();
    expect(parseShopOptionGroups([{ ...SAUCE, choices: [{ name: "Кетчуп", price_rub: -1 }] }])).toBeNull();
    expect(parseShopOptionGroups([{ ...SAUCE, choices: [SAUCE.choices[0], SAUCE.choices[0]] }])).toBeNull();
    expect(parseShopOptionGroups([SAUCE, SAUCE])).toBeNull();

    expect(parseShopOptionPicks([{ group: "Соус", name: "Сырный" }])).toEqual([{ group: "Соус", name: "Сырный" }]);
    expect(parseShopOptionPicks([{ group: " Соус ", name: "Сырный" }])).toBeNull();
    expect(parseShopOptionPicks([{ group: " Соус ", name: "Сырный" }], true)).toEqual([{ group: "Соус", name: "Сырный" }]);
    expect(parseShopOptionPicks([{ group: "Соус", name: "Сырный" }, { group: "Соус", name: "Сырный" }])).toBeNull();
    expect(parseShopOptionPicks([])).toBeNull();

    expect(resolveShopOptions(undefined, undefined)).toEqual({ ok: true, picks: [], extra_rub: 0 });
    expect(resolveShopOptions(undefined, [{ group: "Соус", name: "Сырный" }]).ok).toBe(false);
    const missing = resolveShopOptions([SAUCE, EXTRA], []);
    expect(missing.ok).toBe(false);
    expect((missing as { error: string }).error).toContain("Кетчуп, Сырный");
    expect(resolveShopOptions([SAUCE, EXTRA], [{ group: "Соус", name: "Барбекю" }]).ok).toBe(false);
    expect(resolveShopOptions([SAUCE], [{ group: "Соус", name: "Кетчуп" }, { group: "Соус", name: "Сырный" }]).ok).toBe(false);
    expect(resolveShopOptions([SAUCE, EXTRA], [{ group: "Добавки", name: "Бекон" }, { group: "Соус", name: "Сырный" }])).toEqual({
      ok: true,
      picks: [{ group: "Соус", name: "Сырный" }, { group: "Добавки", name: "Бекон" }],
      extra_rub: 130,
    });
  });

  test("variant ids and line text", () => {
    expect(edaVariantId(PLACE.ref, BURGER.name, [])).toBe(BURGER.id);
    const a = edaVariantId(PLACE.ref, BURGER.name, ["Сырный", "Бекон"]);
    expect(a).toBe(edaVariantId(PLACE.ref, BURGER.name, ["Бекон", "Сырный"]));
    expect(a).not.toBe(BURGER.id);
    expect(a).not.toBe(edaVariantId(PLACE.ref, BURGER.name, ["Сырный"]));
    expect(shopLineText({ name: BURGER.name, qty: 2, price_rub: 480, options: [{ group: "Соус", name: "Сырный" }, { group: "Добавки", name: "Бекон" }] }))
      .toBe("Чизбургер 250 г (Сырный, Бекон) × 2 — 960 ₽");
  });

  test("order view and daemon frame: options only for eda", () => {
    const options = [{ group: "Соус", name: "Сырный" }];
    const line = { ...BURGER, price_rub: 390, qty: 1, options };
    expect(parseOrderFood({ service: "eda", place: PLACE.name, lines: [line], delivery_rub: 99 })?.lines).toEqual([line]);
    expect(parseOrderFood({ service: "eda", place: PLACE.name, lines: [line, line], delivery_rub: 99 })).toBeNull();
    expect(parseOrderFood({ service: "eda", place: PLACE.name, lines: [line, { ...BURGER, qty: 1 }], delivery_rub: 99 })).not.toBeNull();
    expect(parseOrderFood({ service: "lavka", lines: [{ ...MILK, qty: 1, options }], delivery_rub: 0 })).toBeNull();
    const frame = { op: "prepare", session: SESSION, service: "eda", place: PLACE.ref, lines: [{ id: BURGER.id, name: BURGER.name, qty: 1, options }] };
    expect(parseShopRequest(frame)).toEqual(frame as ShopRequest);
    expect(parseShopRequest({ ...frame, lines: [{ ...frame.lines[0], options: [] }] })).toBeNull();
    const quote = { ok: true, op: "quote", address: ADDRESS, place: PLACE, delivery_rub: 99, results: [{ query: "чизбургер", candidates: [{ ...BURGER, options: [SAUCE] }] }] };
    expect(parseShopOutcome(JSON.stringify(quote), "quote")).toEqual(quote as ShopOutcome);
    const { place: _p, ...noPlace } = quote;
    expect(() => parseShopOutcome(JSON.stringify(noPlace), "quote")).toThrow();
    expect(() => parseShopOutcome(JSON.stringify({ ...quote, results: [{ query: "чизбургер", candidates: [{ ...BURGER, options: [{ ...SAUCE, max: 5 }] }] }] }), "quote")).toThrow();
  });

  test("dish window: deltas, group limits, base price", () => {
    expect(optionDelta("")).toBe(0);
    expect(optionDelta("+ 150 ₽")).toBe(150);
    expect(optionDelta("+\u00a01\u00a0200\u00a0₽")).toBe(1200);
    expect(optionDelta("− 50 ₽")).toBeNull();
    expect(optionDelta("от 50 ₽")).toBeNull();
    const choice = (name: string, delta: string, type: string, checked = false, label = 0) => ({ name, delta, type, checked, label });
    const raw: RawOptionGroup[] = [
      { title: "Размер", hint: "", choices: [choice("25 см", "", "radio", true, 0), choice("30 см", "+ 200 ₽", "radio", false, 1)] },
      { title: "Соус", hint: "", choices: [choice("Кетчуп", "", "radio", true, 2), choice("Чеcночно-сырная", "+ 40 ₽", "radio", false, 3)] },
      { title: "Добавки", hint: "Выберите до 100", choices: [choice("Бекон", "+ 90 ₽", "checkbox", true, 4), choice("Сыр", "+ 50 ₽", "checkbox", false, 5)] },
    ];
    const groups = edaOptionGroups(raw)!;
    expect(groups.map((g) => [g.name, g.min, g.max])).toEqual([["Размер", 1, 1], ["Соус", 1, 1], ["Добавки", 0, 2]]);
    expect(groups[1]!.choices[1]).toEqual({ name: "Чеcночно-сырная", price_rub: 40 });
    const hint = (h: string) => edaOptionGroups([{ ...raw[2]!, hint: h }])?.[0];
    expect(hint("Выберите 1")).toMatchObject({ min: 1, max: 1 });
    expect(hint("Выберите от 1 до 2")).toMatchObject({ min: 1, max: 2 });
    expect(hint("Выберите 3")).toBeUndefined();
    expect(hint("Что-нибудь")).toBeUndefined();
    expect(edaOptionGroups([{ ...raw[0]!, hint: "Выберите" }])).toBeNull();
    expect(edaOptionGroups([{ ...raw[0]!, choices: [raw[0]!.choices[0]!, raw[2]!.choices[0]!] }])).toBeNull();
    expect(edaOptionGroups([raw[0]!, raw[0]!])).toBeNull();
    // 2 шт. по (699 + бекон 90) = 1578.
    expect(edaBasePrice({ name: "Пепперони", weight: "", price: "1 578 ₽", qty: "2", groups: raw }, groups)).toBe(699);
    expect(edaBasePrice({ name: "Пепперони", weight: "", price: "1 579 ₽", qty: "2", groups: raw }, groups)).toBeNull();
    expect(edaBasePrice({ name: "Пепперони", weight: "", price: "от 699 ₽", qty: "1", groups: raw }, groups)).toBeNull();
  });

  test("cart rows: options are part of the variant", () => {
    const row = parseEdaCartRow(PLACE.ref, { name: "Пепперони", qty: "2", text: "Пепперони\n30 см\nЧеcночно-сырная\n1\u00a0818 ₽\n·385 г\n2" });
    expect(row).toEqual({ id: edaVariantId(PLACE.ref, "Пепперони 385 г", ["30 см", "Чеcночно-сырная"]), qty: 2, price_rub: 909 });
    expect(parseEdaCartRow(PLACE.ref, { name: "Пепперони", qty: "1", text: "Пепперони\n699 ₽\n·385 г\n1" }))
      .toEqual({ id: edaDishId(PLACE.ref, "Пепперони 385 г"), qty: 1, price_rub: 699 });
    expect(parseEdaCartRow(PLACE.ref, { name: "Пепперони", qty: "1", text: "Маргарита\n699 ₽\n1" })).toBeNull();
    expect(parseEdaCartRow(PLACE.ref, { name: "Пепперони", qty: "1", text: "Пепперони\n30 см" })).toBeNull();
    expect(parseEdaCartRow(PLACE.ref, { name: "Пепперони", qty: "?", text: "Пепперони\n699 ₽" })).toMatchObject({ qty: -1, price_rub: null });
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
  const edaOrder = async (place: string | null = PLACE.name, lines = [{ ...BURGER, qty: 2 }]) => {
    const total_rub = lines.reduce((sum, l) => sum + l.qty * l.price_rub, 0) + 99;
    await h!.checkout(lines, total_rub, { service: "eda", ...(place === null ? {} : { place }) });
    return handleOrderFood({ service: "eda", ...(place === null ? {} : { place }), lines, delivery_rub: 99, total_rub, _userId: String(OWNER) }, { agentKey: "orchestrator", chatId: OWNER });
  };
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

  test("options: price with deltas, required groups, canonical picks signed and sent", async () => {
    const quote: ShopOutcome = { ...EDA_QUOTE, results: [{ query: "чизбургер", candidates: [{ ...BURGER, options: [SAUCE, EXTRA] }] }] } as ShopOutcome;
    const variant = edaVariantId(PLACE.ref, BURGER.name, ["Сырный", "Бекон"]);
    h = await harness({ quote, prepare: { ok: true, op: "prepare", address: ADDRESS, lines: [{ id: variant, qty: 1, price_rub: 480 }], total_rub: 579 }, confirm: { ok: true, op: "confirm", state: "accepted" } });
    const q = await quoteShop({ service: "eda", place: "бургер хаус", queries: ["чизбургер"] }, h.ctx);
    expect(JSON.stringify(q)).toContain("Сырный");
    const picks = [{ group: "Добавки", name: "Бекон" }, { group: "Соус", name: "Сырный" }];
    const noSauce = await edaOrder(PLACE.name, [{ ...BURGER, qty: 1 }]);
    expect(noSauce).toMatchObject({ ok: false });
    expect((noSauce as { error: string }).error).toContain("Соус");
    const wrongPrice = await edaOrder(PLACE.name, [{ ...BURGER, qty: 1, options: picks } as typeof BURGER & { qty: number }]);
    expect((wrongPrice as { error: string }).error).toContain("480 ₽");
    expect(await edaOrder(PLACE.name, [{ ...BURGER, price_rub: 480, qty: 1, options: [{ group: "Соус", name: "Горчица" }] } as typeof BURGER & { qty: number }])).toMatchObject({ ok: false });
    const res = await edaOrder(PLACE.name, [{ ...BURGER, price_rub: 480, qty: 1, options: picks } as typeof BURGER & { qty: number }]);
    expect(res).toMatchObject({ ok: true, result: { status: "awaiting_signature", amount_rub: 579 } });
    expect(JSON.parse(h.gate.pending(T0).at(-1)!.payload).params.item_01).toBe("Чизбургер 250 г (Сырный, Бекон) × 1 — 480 ₽");
    const nonce = await h.sign();
    await executeSignedShop(nonce);
    expect(h.requests[1]).toEqual({
      op: "prepare",
      session: SESSION,
      service: "eda",
      place: PLACE.ref,
      lines: [{ id: BURGER.id, name: BURGER.name, qty: 1, options: [{ group: "Соус", name: "Сырный" }, { group: "Добавки", name: "Бекон" }] }],
    });
    expect(h.status(nonce)).toBe("executed");
  });

  test("buildPayload: options normalized, empty dropped", () => {
    const ctx = { agentKey: "orchestrator" };
    const line = { ...BURGER, qty: 1 };
    expect(buildPayload("ORDER_FOOD", { service: "eda", place: PLACE.name, lines: [{ ...line, options: [{ group: " Соус", name: "Сырный " }] }], delivery_rub: 0, total_rub: 400 }, ctx))
      .toEqual({ ok: true, payload: { service: "eda", place: PLACE.name, lines: [{ ...line, options: [{ group: "Соус", name: "Сырный" }] }], delivery_rub: 0, total_rub: 400 } });
    expect(buildPayload("ORDER_FOOD", { service: "eda", place: PLACE.name, lines: [{ ...line, options: [] }], delivery_rub: 0, total_rub: 400 }, ctx))
      .toEqual({ ok: true, payload: { service: "eda", place: PLACE.name, lines: [line], delivery_rub: 0, total_rub: 400 } });
    expect(buildPayload("ORDER_FOOD", { service: "eda", place: PLACE.name, lines: [{ ...line, options: [{ group: "Соус" }] }], delivery_rub: 0, total_rub: 400 }, ctx).ok).toBe(false);
  });

  test("buildPayload: place required for eda, refused for lavka", () => {
    const line = { ...BURGER, qty: 1 };
    const ctx = { agentKey: "orchestrator" };
    expect(buildPayload("ORDER_FOOD", { service: "еда", place: " Бургер  Хаус ", lines: [line], delivery_rub: 0, total_rub: 400 }, ctx))
      .toEqual({ ok: true, payload: { service: "eda", place: PLACE.name, lines: [line], delivery_rub: 0, total_rub: 400 } });
    expect(buildPayload("ORDER_FOOD", { service: "eda", lines: [line], delivery_rub: 0, total_rub: 400 }, ctx).ok).toBe(false);
    expect(buildPayload("ORDER_FOOD", { service: "lavka", place: PLACE.name, lines: [{ ...MILK, qty: 1 }], delivery_rub: 0, total_rub: 400 }, ctx).ok).toBe(false);
    expect(approvalCategories("ORDER_FOOD", { service: "eda", place: PLACE.name, lines: [line], delivery_rub: 0, total_rub: 400 })).toEqual(["money"]);
  });
});

const CHARGER = { id: "123456789", name: "Зарядное устройство USB-C 65 Вт", price_rub: 2490 };
const CABLE = { id: "987654321", name: "Кабель USB-C 1 м", price_rub: 590 };

describe("market: parsing and page helpers", () => {
  test("service names, product ids and links", () => {
    expect(normalizeShopService("Маркет")).toBe("market");
    expect(normalizeShopService("яндекс.маркет")).toBe("market");
    expect(marketIdFromHref("/card/zaryadka/123456789?ogV=333&do-waremd5=x&sponsored=1")).toBe(CHARGER.id);
    expect(marketIdFromHref("https://market.yandex.ru/card/zaryadka/123456789")).toBe(CHARGER.id);
    expect(marketIdFromHref("/product--zaryadka/123456789?sku=100200300")).toBeNull();
    expect(marketIdFromHref("/card/zaryadka/0123")).toBeNull();
    expect(marketIdFromHref("/card/zaryadka/12ab")).toBeNull();
    expect(marketIdFromHref("https://evil.example.com/card/x/123456789")).toBeNull();
    expect(marketIdFromHref(null)).toBeNull();
    expect(marketUrlFor(CHARGER.id)).toBe("https://market.yandex.ru/card/x/123456789");
  });

  test("«Корзина пустая» на живой странице — это пустая корзина", () => {
    // Живьём Маркет пишет «Корзина пустая», а не «Корзина пуста»: из-за этого
    // пустую корзину читали как непустую и уборка врала об успехе.
    expect(MARKET_TEXT.cartEmpty.test("Корзина пустая")).toBe(true);
    expect(MARKET_TEXT.cartEmpty.test("Корзина пуста")).toBe(true);
    expect(MARKET_TEXT.cartEmpty.test("В корзине пока пусто")).toBe(true);
    expect(MARKET_TEXT.cartEmpty.test("В корзине 1 товар")).toBe(false);
  });

  test("на странице оформления Маркета нет слова «Итого»", () => {
    // Живьём итог лежит в отдельном узле `summaryTotalPrice`, а рядом с ним
    // стоит подпись способа — «Оплата онлайн 142 ₽». Регулярка по «Итого»
    // не находила ничего, и `checkout()` не мог прочитать сумму.
    expect(MARKET_TESTID.checkoutTotal).toBe('[data-auto="summaryTotalPrice"]');
    expect(Object.keys(MARKET_TEXT)).not.toContain("total");
  });

  test("платит отмеченный способ, а не любая сохранённая карта на странице", () => {
    // В списке способов рядом лежат чужие карты и «Оплата при получении»:
    // читать надо подпись отмеченного способа, иначе нули на балансе
    // прочитаются как готовность платить.
    expect(MARKET_TEXT.savedCard.test("•• 1288")).toBe(true);
    expect(MARKET_TEXT.savedCard.test("Яндекс Пэй")).toBe(true);
    expect(MARKET_TEXT.savedCard.test("Оплата при получении")).toBe(false);
    expect(MARKET_TEXT.payOnDelivery.test("Оплата при получении")).toBe(true);
    // Денег не хватает — кнопка подписана иначе, и без владельца не заплатить.
    expect(MARKET_TEXT.topUpNeeded.test("Пополнить и оплатить")).toBe(true);
    expect(MARKET_TEXT.topUpNeeded.test("Оплатить")).toBe(false);
    expect(MARKET_TEXT.pay.test("Пополнить и оплатить")).toBe(true);
    expect(MARKET_TEXT.checkout.test("Перейти к оформлению")).toBe(true);
  });

  test("кнопка корзины Еды подписана «Далее», а зовётся «Корзина»", () => {
    // Живьём у кнопки `aria-label="Корзина 1040 ₽"` перекрывает видимый текст
    // «Далее 1040 ₽»: поиск по роли сверяет доступное имя и ничего не находит,
    // поэтому в `openCheckout()` нужен ещё и путь по тексту узла.
    expect(EDA_TEXT.checkout.test("Далее 1040 ₽")).toBe(true);
    expect(EDA_TEXT.checkout.test("Оформить заказ")).toBe(true);
    expect(EDA_TEXT.checkout.test("Корзина 1040 ₽")).toBe(false);
  });

  test("предзаказ — это закрытое оформление", () => {
    // Ресторан вне часов работы отвечает модалкой вместо страницы оформления:
    // заказать на сейчас нельзя, и это отказ, а не сломанный селектор.
    expect(EDA_TEXT.checkoutBlocked.test("Доступен только предзаказ")).toBe(true);
    expect(EDA_TEXT.checkoutBlocked.test("Минимальная сумма заказа 500 ₽")).toBe(true);
    expect(EDA_TEXT.checkoutBlocked.test("Доставим за 30 минут")).toBe(false);
  });

  test("меню Еды читается без блока «Выбор пользователей»", () => {
    // Живьём на «Топ пончик» 75 карточек и 8 названий по два раза: блок
    // «Выбор пользователей» лежит в `div#popular_3158171` и повторяет блюда из
    // настоящих категорий (`div#5005180366_3158171`). Из-за повтора
    // `cardIndex()` находит две карточки с одним названием, отказывается
    // угадывать — и блюдо, которое сам же предложил поиск, не кладётся в корзину.
    expect(EDA_TESTID.menuCard).toBe(`${EDA_TESTID.dishCard}:not(${EDA_TESTID.popularBlock} *)`);
    expect(EDA_TESTID.popularBlock).toBe('[id^="popular_"]');
    // Префикс из селектора отличает блок повторов от контейнера категории.
    const prefix = EDA_TESTID.popularBlock.slice('[id^="'.length, -'"]'.length);
    expect("popular_3158171".startsWith(prefix)).toBe(true);
    expect("5005180366_3158171".startsWith(prefix)).toBe(false);
  });

  test("карточки меню везде берутся одним селектором", () => {
    // `readMenu()` возвращает массив, а клики идут через `.nth(i)` по тому же
    // селектору: стоит где-то одному остаться `dishCard`, и индексы разъедутся —
    // в корзину поедет соседнее блюдо.
    const src = readFileSync(new URL("../mac-daemon/eda-playwright.ts", import.meta.url), "utf8");
    expect(src.includes("EDA_TESTID.dishCard")).toBe(false);
    expect(src.includes("sel.dishCard")).toBe(false);
    expect(src.includes("EDA_TESTID.menuCard")).toBe(true);
  });

  test("«Ресторан ещё закрыт» — тоже закрытый ресторан", () => {
    // Живьём на Бургер Кинге страница пишет «Ресторан ещё закрыт», а прошлый
    // шаблон ждал «Ресторан закрыт» — закрытое заведение проходило проверку.
    expect(EDA_TEXT.placeClosed.test("Ресторан ещё закрыт")).toBe(true);
    expect(EDA_TEXT.placeClosed.test("Ресторан еще закрыт")).toBe(true);
    expect(EDA_TEXT.placeClosed.test("Ресторан закрыт")).toBe(true);
    expect(EDA_TEXT.placeClosed.test("Сейчас закрыт")).toBe(true);
    expect(EDA_TEXT.placeClosed.test("Откроется в 10:00")).toBe(true);
    expect(EDA_TEXT.placeClosed.test("Ресторан открыт круглосуточно")).toBe(false);
  });

  test("итог Еды снимается со строки кнопки «Оплатить»", () => {
    // Живьём на оформлении нет слова «Итого»: разбор подписан «Что в цене»
    // (товары 87 ₽, тариф доставки 99 ₽, маленький заказ 30 ₽, сервисный сбор
    // 29 ₽), а сумма 245 ₽ стоит одной строкой с кнопкой «Оплатить». Пока
    // шаблон ждал «Итого», `checkout()` возвращал null — и заказ падал в
    // `price_unreadable` прямо перед оплатой.
    expect(EDA_TEXT.total.test("Оплатить")).toBe(true);
    expect(EDA_TEXT.total.test("Итого")).toBe(true);
    expect(EDA_TEXT.total.test("Способ оплаты")).toBe(false);
    expect(EDA_TEXT.total.test("Товары в заказе")).toBe(false);
    expect(EDA_TEXT.total.test("Сервисный сбор")).toBe(false);
  });

  test("поля «Личные данные» на оформлении Еды — по именам формы", () => {
    // Сверено живьём: у полей нет testid, зато есть name. Имя приходит
    // заполненным, почта пустая и не обязательная — кнопка оплаты активна и
    // без неё, поэтому пустая почта не повод отказываться от заказа.
    expect(EDA_TESTID.contactName).toBe('input[name="name"]');
    expect(EDA_TESTID.contactEmail).toBe('input[name="email"]');
  });

  test("daemon frame: market lines need a card number id, no place", () => {
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
    expect((await handleOrderFood({ service: "market", lines: [{ ...CHARGER, qty: 1 }], delivery_rub: 0, total_rub: 2490, _userId: String(OWNER) }, { agentKey: "orchestrator", chatId: OWNER })).ok).toBe(false);
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

describe("адрес доставки", () => {
  const SAVED = ["Краснодар, Красная 1", "Краснодар, Ленина 5, кв 12"];

  test("слова адреса: сокращения и знаки не мешают, номер дома разбирается", () => {
    expect(shopAddressTokens("ул. Ленина, д. 5, кв. 12")).toEqual(["ленина", "5", "12"]);
    expect(shopAddressTokens("Красная 12/1к2")).toEqual(["красная", "12", "1", "2"]);
    expect(shopAddressHas("Краснодар, Ленина 5, кв 12", "на Ленина 5")).toBe(true);
    expect(shopAddressHas("Краснодар, Ленина 5", "Ленина 7")).toBe(false);
    // Пустой запрос ничему не равен: «поменяй адрес» без адреса ничего не выберет.
    expect(shopAddressHas("Краснодар, Ленина 5", "на")).toBe(false);
  });

  test("выбираем только при единственном совпадении", () => {
    expect(matchSavedAddress("Ленина 5", SAVED)).toBe(1);
    expect(matchSavedAddress("Красная", SAVED)).toBe(0);
    // Подходит обоим — не выбираем сами.
    expect(matchSavedAddress("Краснодар", SAVED)).toBe(null);
    expect(matchSavedAddress("Гагарина 3", SAVED)).toBe(null);
    expect(matchSavedAddress("Ленина 5", [])).toBe(null);
  });

  test("заявка и ответ Mac разбираются, Маркет отвергается", () => {
    expect(parseShopRequest({ op: "set_address", service: "lavka", address: "Ленина 5" }))
      .toEqual({ op: "set_address", service: "lavka", address: "Ленина 5" });
    expect(parseShopRequest({ op: "set_address", service: "eda", address: "Ленина 5" })).not.toBe(null);
    // У Маркета адрес — пункт выдачи.
    expect(parseShopRequest({ op: "set_address", service: "market", address: "Ленина 5" })).toBe(null);
    expect(parseShopRequest({ op: "set_address", service: "lavka", address: "  " })).toBe(null);
    expect(parseShopRequest({ op: "set_address", service: "lavka" })).toBe(null);

    const out = (d: Record<string, unknown>) => parseShopOutcome(JSON.stringify(d), "set_address");
    expect(out({ ok: true, op: "set_address", matched: true, address: "Краснодар, Ленина 5", saved_count: 2 }))
      .toEqual({ ok: true, op: "set_address", matched: true, address: "Краснодар, Ленина 5", saved_count: 2 });
    expect(out({ ok: true, op: "set_address", matched: false, address: null, saved_count: 0 }))
      .toMatchObject({ ok: true, matched: false, address: null });
    // Сменили, но адрес не прочитали — такому ответу не верим.
    expect(() => out({ ok: true, op: "set_address", matched: true, address: null, saved_count: 2 })).toThrow("invalid_shop_result");
    expect(() => out({ ok: true, op: "set_address", matched: true, address: "Ленина 5", saved_count: 101 })).toThrow("invalid_shop_result");
    expect(() => out({ ok: true, op: "status", state: "none" })).toThrow("invalid_shop_result");
  });

  test("исполнитель: один подходящий адрес выбирается, лишнего не жмёт", async () => {
    const { s, page } = fakePage();
    const r = runner(page);
    expect(await r.run({ op: "set_address", service: "lavka", address: "Ленина 5" })).toEqual({
      ok: true,
      op: "set_address",
      matched: true,
      address: "Краснодар, Ленина 5, кв 12",
      saved_count: 2,
    });
    expect(s.opened).toEqual(["home:lavka"]);
    expect(s.clicks).toEqual(["addresses", "address:1"]);
    expect(s.cart.size).toBe(0);
    await r.close();
  });

  test("исполнитель: неоднозначный и ненайденный адрес — окно закрыли, адрес прежний", async () => {
    const { s, page } = fakePage();
    const r = runner(page);
    expect(await r.run({ op: "set_address", service: "lavka", address: "Краснодар" })).toEqual({
      ok: true,
      op: "set_address",
      matched: false,
      address: "Краснодар, Красная 1",
      saved_count: 2,
    });
    expect(await r.run({ op: "set_address", service: "eda", address: "Гагарина 3" })).toMatchObject({ matched: false });
    expect(s.clicks).toEqual(["addresses", "addresses:close", "addresses", "addresses:close"]);
    expect(s.address).toBe("Краснодар, Красная 1");
    await r.close();
  });

  test("исполнитель: пока собрана корзина, адрес не трогаем", async () => {
    const { s, page } = fakePage();
    const r = runner(page);
    await r.run({ op: "prepare", session: SESSION, service: "lavka", lines: [{ id: MILK.id, name: MILK.name, qty: 1 }] });
    expect(await r.run({ op: "set_address", service: "lavka", address: "Ленина 5" })).toMatchObject({ ok: false, code: "shop_busy" });
    expect(s.clicks).not.toContain("addresses");
    await r.close();
  });
});

describe("адрес доставки: инструмент", () => {
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

  test("только владелец, только Лавка и Еда, расчёт после смены недействителен", async () => {
    h = await harness({
      quote: QUOTE,
      set_address: { ok: true, op: "set_address", matched: true, address: "Краснодар, Ленина 5, кв 12", saved_count: 2 },
    });
    expect((await setShopAddress({ service: "lavka", address: "Ленина 5" }, { ...h.ctx, chatId: -100 })).ok).toBe(false);
    expect((await setShopAddress({ service: "lavka", address: "Ленина 5" }, { ...h.ctx, agentKey: "qa" })).ok).toBe(false);
    expect((await setShopAddress({ service: "market", address: "Ленина 5" }, h.ctx)).ok).toBe(false);
    expect((await setShopAddress({ service: "lavka", address: " " }, h.ctx)).ok).toBe(false);
    expect(h.requests).toEqual([]);

    expect(await h.quote()).toMatchObject({ ok: true });
    expect(await setShopAddress({ service: "lavka", address: "Ленина 5" }, h.ctx))
      .toMatchObject({ ok: true, service: "lavka", address: "Краснодар, Ленина 5, кв 12" });
    expect(h.requests.at(-1)).toEqual({ op: "set_address", service: "lavka", address: "Ленина 5" });
    // Старый расчёт был про старый адрес — заказать по нему уже нельзя.
    expect((await h.order()).ok).toBe(false);
  });

  test("не нашёлся — отказ с числом адресов, сами ничего не заводим", async () => {
    h = await harness({ set_address: { ok: true, op: "set_address", matched: false, address: "Краснодар, Красная 1", saved_count: 2 } });
    const out = await setShopAddress({ service: "eda", address: "Гагарина 3" }, h.ctx);
    expect(out).toMatchObject({ ok: false, saved_count: 2 });
    expect(String(out.note)).toContain("не заводит");
  });
});

describe("eda: время доставки", () => {
  const eta = (from_min: number, to_min: number) => ({ from_min, to_min });
  const FAST: ShopPlace = { ref: "shaurma:fast-1", name: "Шаурма Душевная", eta: eta(20, 25) };
  const SLOW: ShopPlace = { ref: "shaurma:slow-2", name: "Шаурма Душевная", eta: eta(35, 45) };
  const PIZZA: ShopPlace = { ref: "pizza:center", name: "Пицца Центр", eta: eta(30, 40) };
  const CLOSED: ShopPlace = { ref: "grill:closed", name: "Гриль Бар" };

  test("время с карточки: интервал, одно число, мусор", () => {
    expect(parseShopPlaceEta("4.8 (1800+) · 20 – 25 мин")).toEqual(eta(20, 25));
    expect(parseShopPlaceEta("35\u00a0–\u00a045\u00a0мин")).toEqual(eta(35, 45));
    expect(parseShopPlaceEta("25 мин")).toEqual(eta(25, 25));
    expect(parseShopPlaceEta("4.9 · 10-15 мин")).toEqual(eta(10, 15));
    expect(parseShopPlaceEta("45 – 35 мин")).toBeNull();
    expect(parseShopPlaceEta("0 мин")).toBeNull();
    expect(parseShopPlaceEta("300 мин")).toBeNull();
    expect(parseShopPlaceEta("Закрыто до 10:00")).toBeNull();
    expect(parseShopPlaceEta(null)).toBeNull();
    expect(shopPlaceEtaText(eta(20, 25))).toBe("20–25 мин");
    expect(shopPlaceEtaText(eta(25, 25))).toBe("25 мин");
  });

  test("выбор филиала: с пределом самый быстрый успевающий, иначе too_slow", () => {
    const places = [SLOW, FAST, PIZZA];
    expect(pickShopPlace("шаурма душевная", places)).toEqual({ place: SLOW });
    expect(pickShopPlace("шаурма душевная", places, 45)).toEqual({ place: FAST });
    expect(pickShopPlace("шаурма душевная", [SLOW], 30)).toEqual({ too_slow: SLOW });
    expect(pickShopPlace("гриль бар", [CLOSED], 60)).toEqual({ too_slow: CLOSED });
    expect(pickShopPlace("суши", places, 45)).toBeNull();
  });

  test("список: без повторов, быстрые первыми, без времени в конце, с пределом — только успевающие", () => {
    expect(rankShopPlaces([CLOSED, SLOW, FAST, SLOW, PIZZA])).toEqual([FAST, PIZZA, SLOW, CLOSED]);
    expect(rankShopPlaces([CLOSED, SLOW, FAST, PIZZA], 40)).toEqual([FAST, PIZZA]);
    const many = Array.from({ length: 15 }, (_, i) => ({ ref: `p:${i}`, name: `Место ${i}`, eta: eta(20, 30) }));
    expect(rankShopPlaces(many)).toHaveLength(10);
  });

  test("ссылки со страницы: без названия и чужие отбрасываются, время из подписи", () => {
    expect(edaPlacesFromLinks([
      { href: "/r/shaurma?placeSlug=fast-1", name: "Шаурма Душевная", meta: "20 – 25 мин" },
      { href: "/r/shaurma?placeSlug=fast-1", name: "", meta: "" },
      { href: "/r/grill?placeSlug=closed", name: "Гриль Бар", meta: "Закрыто" },
      { href: "https://evil.example.com/r/x?placeSlug=y", name: "Чужой", meta: "10 мин" },
    ])).toEqual([{ ref: "shaurma:fast-1", name: "Шаурма Душевная", eta: eta(20, 25) }, CLOSED]);
  });

  test("кадры демона: places только у Еды, max_eta_min строго", () => {
    expect(parseShopRequest({ op: "places", service: "eda", query: "шаурма" })).toEqual({ op: "places", service: "eda", query: "шаурма" });
    expect(parseShopRequest({ op: "places", service: "eda", query: "шаурма", max_eta_min: 45 }))
      .toEqual({ op: "places", service: "eda", query: "шаурма", max_eta_min: 45 });
    expect(parseShopRequest({ op: "places", service: "lavka", query: "шаурма" })).toBeNull();
    expect(parseShopRequest({ op: "places", service: "eda", query: "шаурма", max_eta_min: 5 })).toBeNull();
    expect(parseShopRequest({ op: "places", service: "eda", query: "шаурма", max_eta_min: 45.5 })).toBeNull();
    expect(parseShopRequest({ op: "quote", service: "eda", place: "шаурма", max_eta_min: 45, queries: ["шаурма"] }))
      .toEqual({ op: "quote", service: "eda", place: "шаурма", max_eta_min: 45, queries: ["шаурма"] });
    expect(parseShopRequest({ op: "quote", service: "lavka", max_eta_min: 45, queries: ["молоко"] })).toBeNull();
  });

  test("ответ демона: ресторан с временем и без, время сверяется строго", () => {
    const base = { ok: true, op: "quote", address: ADDRESS, delivery_rub: 0, results: [{ query: "шаурма", candidates: [] }] };
    expect(parseShopOutcome(JSON.stringify({ ...base, place: FAST }), "quote")).toMatchObject({ place: FAST });
    expect(parseShopOutcome(JSON.stringify({ ...base, place: CLOSED }), "quote")).toMatchObject({ place: CLOSED });
    expect(() => parseShopOutcome(JSON.stringify({ ...base, place: { ...FAST, eta: eta(45, 35) } }), "quote")).toThrow("invalid_shop_result");
    expect(() => parseShopOutcome(JSON.stringify({ ...base, place: { ...FAST, eta: { ...eta(20, 25), x: 1 } } }), "quote")).toThrow("invalid_shop_result");
    const list = { ok: true, op: "places", address: ADDRESS, places: [FAST, CLOSED] };
    expect(parseShopOutcome(JSON.stringify(list), "places")).toEqual(list as ShopOutcome);
    expect(() => parseShopOutcome(JSON.stringify({ ...list, places: [FAST, FAST] }), "places")).toThrow("invalid_shop_result");
  });

  test("исполнитель: places с предела, ничего не открывает и не кликает", async () => {
    const { s, page } = edaPage();
    s.places = [SLOW, CLOSED, FAST, { ref: "bad ref", name: "Кривая" }];
    const r = runner(page);
    expect(await r.run({ op: "places", service: "eda", query: "шаурма", max_eta_min: 30 })).toEqual({ ok: true, op: "places", address: ADDRESS, places: [FAST] });
    expect(await r.run({ op: "places", service: "eda", query: "шаурма" })).toEqual({ ok: true, op: "places", address: ADDRESS, places: [FAST, SLOW, CLOSED] });
    expect(s.opened).toEqual(["home:eda", "home:eda"]);
    expect(s.clicks).toEqual([]);
    await r.close();
  });

  test("исполнитель: quote с пределом берёт быстрый филиал, медленный — place_too_slow", async () => {
    const { s, page } = edaPage();
    s.places = [SLOW, FAST];
    const r = runner(page);
    expect(await r.run({ op: "quote", service: "eda", place: "шаурма душевная", max_eta_min: 45, queries: ["чизбургер"] })).toMatchObject({ ok: true, place: FAST });
    expect(s.opened.at(-1)).toBe(`home:${FAST.ref}`);
    s.places = [SLOW];
    expect(await r.run({ op: "quote", service: "eda", place: "шаурма душевная", max_eta_min: 30, queries: ["чизбургер"] }))
      .toEqual({ ok: false, code: "place_too_slow", screenshot: "U0NSRUVO" });
    expect(s.clicks).toEqual([]);
    await r.close();
  });

  test("исполнитель: нет в поиске — ищет на главной", async () => {
    const { s, page } = edaPage();
    s.places = [PIZZA];
    const r = runner(page);
    expect((await r.run({ op: "quote", service: "eda", place: "бургер хаус", queries: ["чизбургер"] }) as { code: string }).code).toBe("place_not_found");
    expect(s.placeQueries).toEqual(["бургер хаус", null]);
    await r.close();
  });

  describe("сервер", () => {
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

    test("SHOP_PLACES: проверка ввода, запрос к Mac и время текстом", async () => {
      h = await harness({ places: { ok: true, op: "places", address: ADDRESS, places: [FAST, PIZZA] } });
      expect((await listShopPlaces({ query: "шаурма", max_eta_min: 5 }, h.ctx)).ok).toBe(false);
      expect((await listShopPlaces({ query: "шаурма", max_eta_min: "45" }, h.ctx)).ok).toBe(false);
      expect((await listShopPlaces({ query: "" }, h.ctx)).ok).toBe(false);
      expect((await listShopPlaces({ query: "шаурма" }, { ...h.ctx, agentKey: "qa" })).ok).toBe(false);
      expect(h.requests).toEqual([]);
      expect(await listShopPlaces({ query: "шаурма", max_eta_min: 45 }, h.ctx)).toMatchObject({
        ok: true,
        max_eta_min: 45,
        places: [{ name: FAST.name, eta: "20–25 мин" }, { name: PIZZA.name, eta: "30–40 мин" }],
      });
      expect(h.requests).toEqual([{ op: "places", service: "eda", query: "шаурма", max_eta_min: 45 }]);
    });

    test("SHOP_PLACES: Mac вернул неуспевающий ресторан — отказ", async () => {
      h = await harness({ places: { ok: true, op: "places", address: ADDRESS, places: [SLOW] } });
      expect(await listShopPlaces({ query: "шаурма", max_eta_min: 30 }, h.ctx)).toMatchObject({ ok: false, error: "invalid_shop_result" });
    });

    test("SHOP_QUOTE: предел только у Еды, ответ с временем ресторана, неуспевающий — отказ", async () => {
      const quote = (place: ShopPlace): ShopOutcome => ({ ok: true, op: "quote", address: ADDRESS, place, delivery_rub: 99, results: [{ query: "шаурма", candidates: [] }] });
      h = await harness({ quote: quote(FAST) });
      expect((await quoteShop({ service: "lavka", max_eta_min: 45, queries: ["молоко"] }, h.ctx)).ok).toBe(false);
      expect((await quoteShop({ service: "eda", place: "шаурма", max_eta_min: 200, queries: ["шаурма"] }, h.ctx)).ok).toBe(false);
      expect(h.requests).toEqual([]);
      expect(await quoteShop({ service: "eda", place: "шаурма", max_eta_min: 45, queries: ["шаурма"] }, h.ctx))
        .toMatchObject({ ok: true, place: FAST.name, place_eta: "20–25 мин" });
      expect(h.requests.at(-1)).toEqual({ op: "quote", service: "eda", place: "шаурма", max_eta_min: 45, queries: ["шаурма"] });
      h.restore();
      h = await harness({ quote: quote(SLOW) });
      expect(await quoteShop({ service: "eda", place: "шаурма", max_eta_min: 30, queries: ["шаурма"] }, h.ctx)).toMatchObject({ ok: false, error: "invalid_shop_result" });
      h.restore();
      h = await harness({ quote: quote(CLOSED) });
      expect(await quoteShop({ service: "eda", place: "гриль", max_eta_min: 60, queries: ["шаурма"] }, h.ctx)).toMatchObject({ ok: false, error: "invalid_shop_result" });
    });
  });
});
