/**
 * ShopPage Яндекс Маркета поверх Playwright. Вкладка и помощники — общие с
 * Лавкой (shop-playwright.ts), вёрстка — только из market-selectors.ts.
 *
 * Товар — `<modelId>-<sku>`: у Маркета одна модель продаётся в разных
 * вариантах, и заказываем ровно подписанный sku. Если после «В корзину»
 * страница просит выбрать размер или цвет — отказ `options_required`, если
 * открылось своё окно — окно закрывается, товар не заказывается. Оплата — только
 * сохранённой картой: «при получении» агент не выбирает.
 */
import { MARKET_PRODUCT_ID, parseShopRubles } from "../lib/shop.ts";
import {
  MARKET_CAPTCHA_FRAME,
  MARKET_CAPTCHA_TEXT,
  MARKET_CAPTCHA_URL,
  MARKET_CART_URL,
  MARKET_HOSTS,
  MARKET_LOGIN_HOSTS,
  MARKET_ORDERS_URL,
  MARKET_ORIGIN,
  MARKET_STATE_TEXT,
  MARKET_TESTID,
  MARKET_TEXT,
  marketProductUrl,
  marketSearchUrl,
} from "./market-selectors.ts";
import { hostMatches, NAV_TIMEOUT_MS, pageKit, QTY_CLICKS_MAX, UI_TIMEOUT_MS, visible, wait } from "./shop-playwright.ts";
import type { CartRow, SearchCard, ShopPage } from "./shop.ts";

/** `/card/<slug>/<modelId>?sku=<sku>` или `/product--<slug>/<modelId>?sku=<sku>` → `modelId-sku`. */
export function marketIdFromHref(href: unknown): string | null {
  if (typeof href !== "string") return null;
  let url: URL;
  try {
    url = new URL(href, MARKET_ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== MARKET_ORIGIN) return null;
  const m = url.pathname.match(/^\/(?:card\/[^/]+|product--[^/]+|product)\/(\d+)\/?$/);
  const sku = url.searchParams.get("sku");
  if (!m || !sku) return null;
  const id = `${m[1]}-${sku}`;
  return MARKET_PRODUCT_ID.test(id) ? id : null;
}

export const marketUrlFor = (id: string) => {
  const [model, sku] = id.split("-");
  return marketProductUrl(model!, sku!);
};

export function marketShopPage(page: any): ShopPage {
  const { bodyText, goto, text, totalNear, screenshot, probe, stateFromBody } = pageKit(page);
  const offer = () => page.locator(MARKET_TESTID.productOffer).first();
  const qtyNow = async (): Promise<number> => {
    const value = page.locator(MARKET_TESTID.qtyValue).first();
    if (!(await visible(value))) return 0;
    const raw = String((await value.innerText().catch(() => "")) ?? "").trim();
    return /^\d{1,3}$/.test(raw) ? Number(raw) : -1;
  };
  const dialogOpen = () => visible(page.getByRole("dialog").first(), 1_500);
  const payLocator = () => page.getByRole("button", { name: MARKET_TEXT.pay }).first();

  return {
    openHome: () => goto(`${MARKET_ORIGIN}/`),
    findPlace: async () => null,
    openSearch: (_target, query) => goto(marketSearchUrl(query)),
    openProduct: (_target, item) => goto(marketUrlFor(item.id)),
    openCart: () => goto(MARKET_CART_URL),
    openOrders: () => goto(MARKET_ORDERS_URL),
    async guard() {
      const url = String(page.url());
      if (MARKET_CAPTCHA_URL.test(url)) return "captcha";
      if (page.frames().some((f: any) => MARKET_CAPTCHA_FRAME.test(String(f.url())))) return "captcha";
      if (hostMatches(url, MARKET_LOGIN_HOSTS)) return "login_required";
      if (!hostMatches(url, MARKET_HOSTS)) return "unexpected_page";
      if (MARKET_CAPTCHA_TEXT.test(await bodyText())) return "captcha";
      if (await visible(page.getByRole("button", { name: MARKET_TEXT.signIn }).first())) return "login_required";
      return "ok";
    },
    async address() {
      const label = await text(page.locator(MARKET_TESTID.addressButton).first());
      if (!label || MARKET_TEXT.addressUnset.test(label)) return null;
      const s = label.replace(/\s+/g, " ").trim();
      return s.length >= 3 && s.length <= 200 ? s : null;
    },
    // Доставка Маркета зависит от продавцов и видна только на оформлении.
    deliveryFee: async () => null,
    async searchCards() {
      await page.locator(MARKET_TESTID.snippet).first().waitFor({ state: "visible", timeout: UI_TIMEOUT_MS }).catch(() => {});
      const raw: Array<{ href: string | null; name: string; price: string; text: string }> = await page.evaluate(
        (sel: typeof MARKET_TESTID) => {
          const doc = (globalThis as any).document;
          return [...doc.querySelectorAll(sel.snippet)].slice(0, 12).map((card: any) => ({
            href: card.querySelector(sel.snippetLink)?.getAttribute("href") ?? null,
            name: String(card.querySelector(sel.snippetTitle)?.innerText ?? ""),
            price: String(card.querySelector(sel.snippetPrice)?.innerText ?? ""),
            text: String(card.innerText ?? "").slice(0, 400),
          }));
        },
        MARKET_TESTID,
      );
      const cards: SearchCard[] = [];
      for (const r of raw) {
        const id = marketIdFromHref(r.href);
        if (!id) continue;
        cards.push({ id, name: r.name, price_rub: parseShopRubles(r.price), available: !MARKET_TEXT.outOfStock.test(r.text) });
      }
      return cards;
    },
    async product() {
      const titleLocator = page.locator(MARKET_TESTID.productTitle).first();
      await visible(titleLocator, UI_TIMEOUT_MS);
      const name = await text(titleLocator);
      if (!name) return { name: null, price_rub: null, available: false };
      const offerVisible = await visible(offer(), UI_TIMEOUT_MS);
      const offerText = offerVisible ? (await text(offer())) ?? "" : "";
      const price = parseShopRubles(await text(offer().locator(MARKET_TESTID.productPrice).first()));
      return { name, price_rub: price, available: offerVisible && !MARKET_TEXT.outOfStock.test(offerText) };
    },
    async setProductQty(qty) {
      let current = await qtyNow();
      if (current === 0 && qty > 0) {
        const add = offer().getByRole("button", { name: MARKET_TEXT.addToCart }).first();
        if (!(await visible(add, UI_TIMEOUT_MS))) return "blocked";
        await add.click();
        await wait(700);
        if (MARKET_TEXT.optionsRequired.test(await bodyText())) return "options_required";
        if (await dialogOpen()) {
          // Допродажа или своё окно Маркета: ничего не выбираем, окно закрываем.
          await page.keyboard.press("Escape").catch(() => {});
          await wait(300);
        }
        current = await qtyNow();
      }
      for (let i = 0; i < QTY_CLICKS_MAX && current >= 0 && current !== qty; i++) {
        const button = page.locator(current < qty ? MARKET_TESTID.qtyPlus : MARKET_TESTID.qtyMinus).first();
        if (!(await visible(button))) break;
        await button.click();
        await wait(500);
        const next = await qtyNow();
        if (next === current) break; // упёрлись в остаток: сверка корзины это поймает
        current = next;
      }
      return "ok";
    },
    async cart() {
      await page.locator(MARKET_TESTID.cartItem).first().waitFor({ state: "visible", timeout: UI_TIMEOUT_MS }).catch(() => {});
      if (MARKET_TEXT.cartEmpty.test(await bodyText())) return [];
      const raw: Array<{ href: string | null; qty: string; price: string }> = await page.evaluate((sel: typeof MARKET_TESTID) => {
        const doc = (globalThis as any).document;
        return [...doc.querySelectorAll(sel.cartItem)].slice(0, 60).map((row: any) => ({
          href: row.querySelector(sel.cartItemLink)?.getAttribute("href") ?? null,
          qty: String(row.querySelector(sel.cartItemQty)?.innerText ?? row.querySelector(sel.cartItemQty)?.value ?? ""),
          price: String(row.querySelector(sel.cartItemPrice)?.innerText ?? ""),
        }));
      }, MARKET_TESTID);
      const rows: CartRow[] = [];
      for (const r of raw) {
        // Строка без читаемого товара — чужая вёрстка: id не совпадёт, сверка корзины упадёт.
        const id = marketIdFromHref(r.href) ?? `unreadable-${rows.length}`;
        const qty = /^\d{1,3}$/.test(r.qty.trim()) ? Number(r.qty.trim()) : -1;
        const lineRub = parseShopRubles(r.price);
        rows.push({ id, qty, price_rub: lineRub !== null && qty > 0 ? Math.ceil(lineRub / qty) : null });
      }
      return rows;
    },
    async openCheckout() {
      const button = page.getByRole("button", { name: MARKET_TEXT.checkout }).first()
        .or(page.getByRole("link", { name: MARKET_TEXT.checkout }).first());
      if (!(await visible(button.first(), UI_TIMEOUT_MS))) return false;
      await button.first().click();
      await page.waitForLoadState("load", { timeout: NAV_TIMEOUT_MS }).catch(() => {});
      await wait(1_500);
      return true;
    },
    async checkout() {
      const body = await bodyText();
      return {
        total_rub: parseShopRubles(await totalNear(MARKET_TEXT.total)),
        blocked: MARKET_TEXT.checkoutBlocked.test(body),
        // Выбрана оплата при получении — это не сохранённая карта, способ оплаты агент не меняет.
        saved_card: MARKET_TEXT.savedCard.test(body) && !MARKET_TEXT.payOnDelivery.test(body),
        pay_button: await visible(payLocator(), UI_TIMEOUT_MS),
      };
    },
    async clickPay() {
      await payLocator().click();
    },
    orderState: () => stateFromBody(MARKET_STATE_TEXT),
    screenshot,
    probe,
  };
}
