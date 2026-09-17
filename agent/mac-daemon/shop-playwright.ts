/**
 * ShopPage поверх Playwright: настоящий Chrome владельца с отдельным профилем.
 * Лавка — здесь, Еда — eda-playwright.ts, Маркет — market-playwright.ts; одна вкладка, маршрутизатор отдаёт
 * вызовы адаптеру сервиса, страницу которого открыли последней.
 *
 * playwright-core лежит только в mac-daemon/node_modules — на сервере его нет,
 * поэтому модуль грузится динамически по имени из переменной и без импорта
 * типов. Никаких «стелс»-приёмов: обычный Chrome, обычный профиль; капча — это
 * остановка и скриншот, а не повод прятаться.
 */
import {
  SHOP_ORDER_STATES,
  SHOP_PRODUCT_ID,
  SHOP_SCREENSHOT_B64_MAX,
  parseDeliveryRubles,
  parseShopRubles,
  type ShopOrderState,
  type ShopService,
} from "../lib/shop.ts";
import {
  LAVKA_CAPTCHA_FRAME,
  LAVKA_CAPTCHA_TEXT,
  LAVKA_CAPTCHA_URL,
  LAVKA_HOSTS,
  LAVKA_LOGIN_HOSTS,
  LAVKA_ORDERS_URL,
  LAVKA_ORIGIN,
  LAVKA_STATE_TEXT,
  LAVKA_TESTID,
  LAVKA_TEXT,
  lavkaProductUrl,
  lavkaSearchUrl,
} from "./shop-selectors.ts";
import type { CartRow, SearchCard, ShopBrowser, ShopEnv, ShopPage } from "./shop.ts";
import {
  ariaProbe,
  bodyText as pageBodyText,
  hostMatches,
  jpegScreenshot,
  launchProfileChrome,
  NAV_TIMEOUT_MS,
  UI_TIMEOUT_MS,
  visible,
  wait,
} from "./playwright-kit.ts";

// Адаптеры Еды и Маркета берут эти приёмы отсюда.
export { hostMatches, NAV_TIMEOUT_MS, UI_TIMEOUT_MS, visible, wait };

export const QTY_CLICKS_MAX = 40;

export async function launchPlaywrightShop(env: ShopEnv, profileDir: string, opts: { headless?: boolean } = {}): Promise<ShopBrowser> {
  const { context, page: raw } = await launchProfileChrome(profileDir, {
    channel: env.SHOP_BROWSER_CHANNEL || "chrome",
    headless: opts.headless ?? env.SHOP_HEADLESS === "true",
    viewport: { width: 1280, height: 800 },
  });
  const { edaShopPage } = await import("./eda-playwright.ts");
  const { marketShopPage } = await import("./market-playwright.ts");
  const page = routeShopPage({ lavka: playwrightShopPage(raw), eda: edaShopPage(raw), market: marketShopPage(raw) });
  return { page: () => page, close: () => context.close() };
}

/**
 * Одна вкладка на все сервисы: open* выбирает адаптер, остальные вызовы идут
 * туда, где открыли страницу последней.
 */
export function routeShopPage(pages: Record<ShopService, ShopPage>): ShopPage {
  let current: ShopPage = pages.lavka;
  const on = (service: ShopService) => (current = pages[service]);
  return {
    openHome: (t) => on(t.service).openHome(t),
    findPlace: (q) => on("eda").findPlace(q),
    openSearch: (t, q) => on(t.service).openSearch(t, q),
    openProduct: (t, item) => on(t.service).openProduct(t, item),
    openCart: (t) => on(t.service).openCart(t),
    openOrders: (service) => on(service).openOrders(service),
    guard: () => current.guard(),
    address: () => current.address(),
    deliveryFee: () => current.deliveryFee(),
    searchCards: () => current.searchCards(),
    product: () => current.product(),
    setProductQty: (qty) => current.setProductQty(qty),
    // Опции умеет только Еда; у остальных — отказ, а не молчаливый заказ без выбора.
    addWithOptions: async (qty, picks) => (current.addWithOptions ? current.addWithOptions(qty, picks) : "options_required"),
    removeCartRows: async (ids) => { await current.removeCartRows?.(ids); },
    cart: () => current.cart(),
    openCheckout: () => current.openCheckout(),
    checkout: () => current.checkout(),
    clickPay: () => current.clickPay(),
    orderState: () => current.orderState(),
    screenshot: () => current.screenshot(),
    probe: () => current.probe(),
  };
}

/** `/good/<slug>?…` → slug, если он похож на идентификатор товара. */
export function productIdFromHref(href: unknown): string | null {
  if (typeof href !== "string") return null;
  const m = href.match(/^(?:https:\/\/lavka\.yandex\.ru)?\/good\/([^/?#]+)/);
  if (!m) return null;
  let id: string;
  try {
    id = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  return SHOP_PRODUCT_ID.test(id) ? id : null;
}

/** Общие приёмы работы со страницей для адаптеров Лавки, Еды и Маркета. */
export function pageKit(page: any) {
  const bodyText = () => pageBodyText(page);
  const goto = async (url: string) => {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("load", { timeout: NAV_TIMEOUT_MS }).catch(() => {});
  };
  const text = async (locator: any): Promise<string | null> => {
    if (!(await visible(locator))) return null;
    try {
      return String(await locator.innerText({ timeout: UI_TIMEOUT_MS }));
    } catch {
      return null;
    }
  };
  /** Последняя сумма в строке рядом с видимой подписью `label` («Итого»). */
  const totalNear = (label: RegExp): Promise<string | null> => page.evaluate((re: string) => {
    const doc = (globalThis as any).document;
    const labelRe = new RegExp(re, "i");
    const leaf = [...doc.querySelectorAll("body *")].reverse().find((el: any) =>
      el.children.length === 0 && labelRe.test(String(el.textContent ?? "").trim()) && el.getClientRects().length > 0);
    let row: any = leaf;
    for (let i = 0; i < 4 && row && !/\d\s?₽/.test(String(row.innerText ?? "")); i++) row = row.parentElement;
    const m = String(row?.innerText ?? "").match(/\d[\d \u00a0\u202f]*(?:[,.]\d{1,2})?\s?₽/g);
    return m ? m[m.length - 1] : null;
  }, label.source);
  const screenshot = () => jpegScreenshot(page, SHOP_SCREENSHOT_B64_MAX);
  const probe = () => ariaProbe(page);
  /** Состояние заказа по тексту страницы; порядок правил важен. */
  const stateFromBody = async (rules: ReadonlyArray<[ShopOrderState, RegExp]>): Promise<ShopOrderState> => {
    const body = await bodyText();
    const hit = rules.find(([, re]) => re.test(body));
    const state: ShopOrderState = hit ? hit[0] : /Заказов (?:пока )?нет|У вас нет заказов/i.test(body) ? "none" : "unknown";
    return SHOP_ORDER_STATES.includes(state) ? state : "unknown";
  };
  return { bodyText, goto, text, totalNear, screenshot, probe, stateFromBody };
}

export function playwrightShopPage(page: any): ShopPage {
  const { bodyText, goto, text, totalNear, screenshot, probe, stateFromBody } = pageKit(page);
  const bar = () => page.locator(LAVKA_TESTID.addToCartBar).first();
  const qtyInBar = async (): Promise<number> => {
    const input = bar().locator(LAVKA_TESTID.qtyInput).first();
    if (!(await visible(input))) return 0;
    const raw = String((await input.inputValue().catch(() => null)) ?? (await input.innerText().catch(() => "")));
    return /^\d{1,3}$/.test(raw.trim()) ? Number(raw.trim()) : -1;
  };
  const payLocator = () => page.getByRole("button", { name: LAVKA_TEXT.pay }).first();

  return {
    openHome: () => goto(`${LAVKA_ORIGIN}/`),
    findPlace: async () => null,
    openSearch: (_target, query) => goto(lavkaSearchUrl(query)),
    openProduct: (_target, item) => goto(lavkaProductUrl(item.id)),
    // Корзина на десктопе — боковая мини-корзина на любой странице каталога.
    openCart: () => goto(`${LAVKA_ORIGIN}/`),
    openOrders: () => goto(LAVKA_ORDERS_URL),
    async guard() {
      const url = String(page.url());
      if (LAVKA_CAPTCHA_URL.test(url)) return "captcha";
      if (page.frames().some((f: any) => LAVKA_CAPTCHA_FRAME.test(String(f.url())))) return "captcha";
      if (hostMatches(url, LAVKA_LOGIN_HOSTS)) return "login_required";
      if (!hostMatches(url, LAVKA_HOSTS)) return "unexpected_page";
      if (LAVKA_CAPTCHA_TEXT.test(await bodyText())) return "captcha";
      if (await visible(page.locator(LAVKA_TESTID.signIn).first())) return "login_required";
      return "ok";
    },
    async address() {
      if (LAVKA_TEXT.demoCatalog.test(await bodyText())) return null;
      const label = await text(page.locator(LAVKA_TESTID.addressButton).first());
      if (!label || LAVKA_TEXT.addressUnset.test(label)) return null;
      const s = label.replace(/\s+/g, " ").trim();
      return s.length >= 3 && s.length <= 200 ? s : null;
    },
    async deliveryFee() {
      return parseDeliveryRubles(await text(page.locator(LAVKA_TESTID.miniCartDelivery).first()));
    },
    async searchCards() {
      await page.locator(LAVKA_TESTID.productCard).first().waitFor({ state: "visible", timeout: UI_TIMEOUT_MS }).catch(() => {});
      const raw: Array<{ href: string | null; name: string; price: string; text: string }> = await page.evaluate(
        (sel: { card: string; link: string; price: string }) => {
          const doc = (globalThis as any).document;
          return [...doc.querySelectorAll(sel.card)].slice(0, 12).map((card: any) => {
            const link = card.querySelector(sel.link);
            return {
              href: link?.getAttribute("href") ?? null,
              name: String(link?.innerText ?? link?.textContent ?? ""),
              price: String(card.querySelector(sel.price)?.innerText ?? ""),
              text: String(card.innerText ?? "").slice(0, 400),
            };
          });
        },
        { card: LAVKA_TESTID.productCard, link: LAVKA_TESTID.productLink, price: LAVKA_TESTID.price },
      );
      const cards: SearchCard[] = [];
      for (const r of raw) {
        const id = productIdFromHref(r.href);
        if (!id) continue;
        cards.push({ id, name: r.name, price_rub: parseShopRubles(r.price), available: !LAVKA_TEXT.outOfStock.test(r.text) });
      }
      return cards;
    },
    async product() {
      const titleLocator = page.locator(LAVKA_TESTID.productTitle).first();
      await visible(titleLocator, UI_TIMEOUT_MS);
      const title = await text(titleLocator);
      if (!title) return { name: null, price_rub: null, available: false };
      const amount = await text(page.locator(LAVKA_TESTID.productAmount).first());
      const name = [title, amount].filter(Boolean).join(" ");
      const barVisible = await visible(bar(), UI_TIMEOUT_MS);
      const barText = barVisible ? (await text(bar())) ?? "" : "";
      const price = parseShopRubles(await text(bar().locator(LAVKA_TESTID.price).first()));
      return { name, price_rub: price, available: barVisible && !LAVKA_TEXT.outOfStock.test(barText) };
    },
    async setProductQty(qty) {
      let current = await qtyInBar();
      if (current === 0 && qty > 0) {
        await bar().locator(LAVKA_TESTID.addToCartButton).first().click();
        await wait(500);
        current = await qtyInBar();
      }
      for (let i = 0; i < QTY_CLICKS_MAX && current >= 0 && current !== qty; i++) {
        await bar().locator(current < qty ? LAVKA_TESTID.qtyPlus : LAVKA_TESTID.qtyMinus).first().click();
        await wait(400);
        const next = await qtyInBar();
        if (next === current) break; // упёрлись (остаток на складе): сверка корзины это поймает
        current = next;
      }
      return "ok";
    },
    async cart() {
      const cart = page.locator(LAVKA_TESTID.miniCart).first();
      if (!(await visible(cart, UI_TIMEOUT_MS))) return [];
      if (LAVKA_TEXT.cartEmpty.test((await text(cart)) ?? "")) return [];
      const raw: Array<{ href: string | null; qty: string; price: string }> = await cart.evaluate(
        (root: any, sel: { link: string; qty: string; price: string }) => {
          const rows: Array<{ href: string | null; qty: string; price: string }> = [];
          for (const link of root.querySelectorAll(sel.link)) {
            let row: any = link;
            for (let i = 0; i < 6 && row && !row.querySelector(sel.qty); i++) row = row.parentElement;
            const input = row?.querySelector(sel.qty);
            rows.push({
              href: link.getAttribute("href"),
              qty: String(input?.value ?? input?.innerText ?? ""),
              price: String(row?.querySelector(sel.price)?.innerText ?? ""),
            });
          }
          return rows;
        },
        { link: LAVKA_TESTID.productLink, qty: LAVKA_TESTID.qtyInput, price: LAVKA_TESTID.price },
      );
      const rows = new Map<string, CartRow>();
      for (const r of raw) {
        const id = productIdFromHref(r.href);
        if (!id) continue;
        // Строка без читаемого количества — чужая вёрстка: пусть сверка корзины упадёт.
        const qty = /^\d{1,3}$/.test(r.qty.trim()) ? Number(r.qty.trim()) : -1;
        const lineRub = parseShopRubles(r.price);
        // В мини-корзине цена строки — за всё количество.
        rows.set(id, { id, qty, price_rub: lineRub !== null && qty > 0 ? Math.ceil(lineRub / qty) : null });
      }
      return [...rows.values()];
    },
    async openCheckout() {
      const button = page.locator(LAVKA_TESTID.miniCartButton).first()
        .or(page.getByRole("button", { name: LAVKA_TEXT.checkout }).first());
      if (!(await visible(button.first(), UI_TIMEOUT_MS))) return false;
      await button.first().click();
      await page.waitForLoadState("load", { timeout: NAV_TIMEOUT_MS }).catch(() => {});
      await wait(1_000);
      return true;
    },
    async checkout() {
      const body = await bodyText();
      const total = await totalNear(LAVKA_TEXT.total);
      return {
        total_rub: parseShopRubles(total),
        blocked: LAVKA_TEXT.checkoutBlocked.test(body),
        saved_card: LAVKA_TEXT.savedCard.test(body),
        pay_button: await visible(payLocator(), UI_TIMEOUT_MS),
      };
    },
    async clickPay() {
      await payLocator().click();
    },
    orderState: () => stateFromBody(LAVKA_STATE_TEXT),
    screenshot,
    probe,
  };
}
