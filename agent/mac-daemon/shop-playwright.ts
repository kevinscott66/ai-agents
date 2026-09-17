/**
 * ShopPage поверх Playwright: настоящий Chrome владельца с отдельным профилем.
 *
 * playwright-core лежит только в mac-daemon/node_modules — на сервере его нет,
 * поэтому модуль грузится динамически по имени из переменной и без импорта
 * типов. Никаких «стелс»-приёмов: обычный Chrome, обычный профиль; капча — это
 * остановка и скриншот, а не повод прятаться.
 */
import { SHOP_ORDER_STATES, SHOP_PRODUCT_ID, SHOP_SCREENSHOT_B64_MAX, parseDeliveryRubles, parseShopRubles, type ShopOrderState } from "../lib/shop.ts";
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

const PLAYWRIGHT = "playwright-core";
const NAV_TIMEOUT_MS = 30_000;
const UI_TIMEOUT_MS = 8_000;
const BODY_TEXT_MAX = 20_000;
const QTY_CLICKS_MAX = 40;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function launchPlaywrightShop(env: ShopEnv, profileDir: string, opts: { headless?: boolean } = {}): Promise<ShopBrowser> {
  let pw: any;
  try {
    pw = await import(PLAYWRIGHT);
  } catch {
    throw new Error("browser_unavailable");
  }
  let context: any;
  try {
    context = await pw.chromium.launchPersistentContext(profileDir, {
      channel: env.SHOP_BROWSER_CHANNEL || "chrome",
      headless: opts.headless ?? env.SHOP_HEADLESS === "true",
      viewport: { width: 1280, height: 800 },
      locale: "ru-RU",
      timezoneId: "Europe/Moscow",
      acceptDownloads: false,
    });
  } catch {
    throw new Error("browser_unavailable");
  }
  const raw = context.pages()[0] ?? (await context.newPage());
  raw.setDefaultTimeout(UI_TIMEOUT_MS);
  raw.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
  const page = playwrightShopPage(raw);
  return { page: () => page, close: () => context.close() };
}

function hostMatches(url: string, hosts: RegExp[]): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && hosts.some((h) => h.test(u.hostname));
  } catch {
    return false;
  }
}

async function visible(locator: any, timeout = 0): Promise<boolean> {
  try {
    if (timeout) await locator.waitFor({ state: "visible", timeout });
    return await locator.isVisible();
  } catch {
    return false;
  }
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

export function playwrightShopPage(page: any): ShopPage {
  const bodyText = async (): Promise<string> => {
    try {
      return String(await page.locator("body").innerText({ timeout: UI_TIMEOUT_MS })).slice(0, BODY_TEXT_MAX);
    } catch {
      return "";
    }
  };
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
    openSearch: (_service, query) => goto(lavkaSearchUrl(query)),
    openProduct: (_service, id) => goto(lavkaProductUrl(id)),
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
      const total: string | null = await page.evaluate((re: string) => {
        const doc = (globalThis as any).document;
        const label = new RegExp(re, "i");
        const leaf = [...doc.querySelectorAll("body *")].reverse().find((el: any) =>
          el.children.length === 0 && label.test(String(el.textContent ?? "").trim()) && el.getClientRects().length > 0);
        let row: any = leaf;
        for (let i = 0; i < 4 && row && !/\d\s?₽/.test(String(row.innerText ?? "")); i++) row = row.parentElement;
        const m = String(row?.innerText ?? "").match(/\d[\d \u00a0\u202f]*(?:[,.]\d{1,2})?\s?₽/g);
        return m ? m[m.length - 1] : null;
      }, LAVKA_TEXT.total.source);
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
    async orderState() {
      const body = await bodyText();
      const hit = LAVKA_STATE_TEXT.find(([, re]) => re.test(body));
      const state: ShopOrderState = hit ? hit[0] : /Заказов (?:пока )?нет|У вас нет заказов/i.test(body) ? "none" : "unknown";
      return SHOP_ORDER_STATES.includes(state) ? state : "unknown";
    },
    async screenshot() {
      for (const quality of [45, 30, 18]) {
        try {
          const buf: Uint8Array = await page.screenshot({ type: "jpeg", quality, scale: "css", timeout: UI_TIMEOUT_MS });
          const b64 = Buffer.from(buf).toString("base64");
          if (b64.length <= SHOP_SCREENSHOT_B64_MAX) return b64;
        } catch {
          return null;
        }
      }
      return null;
    },
    async probe() {
      try {
        return String(await page.locator("body").ariaSnapshot({ timeout: UI_TIMEOUT_MS }));
      } catch (e) {
        return `probe failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  };
}
