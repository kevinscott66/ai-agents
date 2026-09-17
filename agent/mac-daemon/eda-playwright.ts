/**
 * ShopPage Яндекс Еды поверх Playwright. Вкладка и помощники — общие с Лавкой
 * (shop-playwright.ts), вёрстка — только из eda-selectors.ts.
 *
 * У блюд нет своих страниц: «открыть товар» — это открыть меню ресторана и
 * запомнить название; карточка ищется по точному названию (заголовок + вес),
 * а id блюда выводится из ресторана и названия (edaDishId). Если после «В
 * корзину» открылось окно (опции, корзина другого ресторана) — окно
 * закрывается, блюдо не заказывается.
 */
import { edaDishId, normalizeShopName, parseShopRubles, SHOP_PLACE_REF, type ShopPlace } from "../lib/shop.ts";
import {
  EDA_CAPTCHA_FRAME,
  EDA_CAPTCHA_TEXT,
  EDA_CAPTCHA_URL,
  EDA_HOSTS,
  EDA_LOGIN_HOSTS,
  EDA_MENU_SCROLLS,
  EDA_ORDERS_URL,
  EDA_ORIGIN,
  EDA_STATE_TEXT,
  EDA_TESTID,
  EDA_TEXT,
  edaSearchUrl,
} from "./eda-selectors.ts";
import { hostMatches, NAV_TIMEOUT_MS, pageKit, QTY_CLICKS_MAX, UI_TIMEOUT_MS, visible, wait } from "./shop-playwright.ts";
import type { CartRow, SearchCard, ShopPage } from "./shop.ts";

export const edaPlaceUrl = (ref: string) => {
  const [brand, slug] = ref.split(":");
  return `${EDA_ORIGIN}/r/${encodeURIComponent(brand!)}?placeSlug=${encodeURIComponent(slug!)}`;
};

/** `/r/<бренд>?placeSlug=<slug>` → `бренд:slug`, если оба похожи на идентификаторы. */
export function placeRefFromHref(href: unknown): string | null {
  if (typeof href !== "string") return null;
  let url: URL;
  try {
    url = new URL(href, EDA_ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== EDA_ORIGIN) return null;
  const m = url.pathname.match(/^\/r\/([^/]+)\/?$/);
  const slug = url.searchParams.get("placeSlug");
  if (!m || !slug) return null;
  const ref = `${m[1]}:${slug}`;
  return SHOP_PLACE_REF.test(ref) ? ref : null;
}

const fold = (s: string) => s.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * Выбор ресторана из найденных: точное совпадение названия, потом название,
 * содержащее запрос. Первый попавшийся не берём: владелец просил конкретный.
 */
export function pickPlace(query: string, places: ReadonlyArray<ShopPlace>): ShopPlace | null {
  const q = fold(query);
  if (!q) return null;
  return places.find((p) => fold(p.name) === q) ?? places.find((p) => fold(p.name).includes(q)) ?? null;
}

/** Блюдо подходит к запросу, если каждое слово запроса (по первым пяти буквам) есть в названии. */
export function dishMatches(name: string, query: string): boolean {
  const words = fold(name).split(" ");
  const tokens = fold(query).split(" ").filter(Boolean);
  return tokens.length > 0 && tokens.every((t) => words.some((w) => w.startsWith(t.slice(0, 5))));
}

/** Название блюда как в расчёте: заголовок и вес через пробел. */
export const dishName = (title: string, meta: string) => normalizeShopName([title, meta].filter((s) => s.trim()).join(" "));

interface RawDish {
  title: string;
  meta: string;
  price: string;
  text: string;
  plus: boolean;
}

export function edaShopPage(page: any): ShopPage {
  const { bodyText, goto, text, totalNear, screenshot, probe, stateFromBody } = pageKit(page);
  let place: string | null = null;
  let query: string | null = null;
  let item: string | null = null;

  const openPlace = async (ref: string) => {
    const url = edaPlaceUrl(ref);
    if (place === ref && String(page.url()).startsWith(url)) return;
    await goto(url);
    place = ref;
  };

  /** Прокрутить меню до конца, чтобы догрузились карточки, и прочитать их. */
  const readMenu = async (): Promise<RawDish[]> => {
    await page.locator(EDA_TESTID.dishCard).first().waitFor({ state: "visible", timeout: UI_TIMEOUT_MS }).catch(() => {});
    let count = -1;
    for (let i = 0; i < EDA_MENU_SCROLLS; i++) {
      const next = await page.locator(EDA_TESTID.dishCard).count().catch(() => 0);
      if (next === count) break;
      count = next;
      await page.mouse.wheel(0, 4_000).catch(() => {});
      await wait(400);
    }
    return page.evaluate((sel: typeof EDA_TESTID) => {
      const doc = (globalThis as any).document;
      return [...doc.querySelectorAll(sel.dishCard)].slice(0, 600).map((card: any) => ({
        title: String(card.querySelector(sel.dishTitle)?.innerText ?? ""),
        meta: String(card.querySelector(sel.dishMeta)?.innerText ?? ""),
        price: String(card.querySelector(sel.dishPrice)?.innerText ?? ""),
        text: String(card.innerText ?? "").slice(0, 400),
        plus: Boolean(card.querySelector(sel.dishPlus)),
      }));
    }, EDA_TESTID);
  };

  /** Индекс карточки с точным названием; несколько одинаковых — не угадываем. */
  const cardIndex = async (): Promise<number> => {
    if (!item) return -1;
    const dishes = await readMenu();
    const hits = dishes.flatMap((d, i) => (dishName(d.title, d.meta) === item ? [i] : []));
    return hits.length === 1 ? hits[0]! : -1;
  };

  const dialogOpen = () => visible(page.getByRole("dialog").first(), 1_500);

  const counterIn = async (card: any): Promise<number> => {
    const counter = card.locator(EDA_TESTID.dishCounter).first();
    if (!(await visible(counter))) return 0;
    const raw = String((await counter.innerText().catch(() => "")) ?? "").trim();
    return /^\d{1,3}$/.test(raw) ? Number(raw) : -1;
  };

  const payLocator = () => page.getByRole("button", { name: EDA_TEXT.pay }).first();

  return {
    openHome: async (target) => {
      if (target.place) await openPlace(target.place);
      else {
        await goto(`${EDA_ORIGIN}/`);
        place = null;
      }
    },
    async findPlace(q) {
      const collect = async (): Promise<ShopPlace[]> => {
        await page.locator(EDA_TESTID.placeTitle).first().waitFor({ state: "visible", timeout: UI_TIMEOUT_MS }).catch(() => {});
        const raw: Array<{ href: string | null; name: string }> = await page.evaluate((sel: typeof EDA_TESTID) => {
          const doc = (globalThis as any).document;
          return [...doc.querySelectorAll(sel.placeLink)].slice(0, 200).map((a: any) => ({
            href: a.getAttribute("href"),
            name: String(a.querySelector(sel.placeTitle)?.innerText ?? ""),
          }));
        }, EDA_TESTID);
        const out: ShopPlace[] = [];
        for (const r of raw) {
          const ref = placeRefFromHref(r.href);
          const name = normalizeShopName(r.name);
          if (ref && name && !out.some((p) => p.ref === ref)) out.push({ ref, name });
        }
        return out;
      };
      await goto(edaSearchUrl(q));
      let found = pickPlace(q, await collect());
      if (!found) {
        await goto(`${EDA_ORIGIN}/`);
        found = pickPlace(q, await collect());
      }
      return found;
    },
    openSearch: async (target, q) => {
      if (target.place) await openPlace(target.place);
      query = q;
    },
    openProduct: async (target, it) => {
      if (target.place) await openPlace(target.place);
      item = it.name;
    },
    openCart: async (target) => {
      // Корзина на десктопе — боковая панель на странице ресторана.
      if (target.place) await openPlace(target.place);
      else await goto(`${EDA_ORIGIN}/`);
    },
    openOrders: async () => {
      await goto(EDA_ORDERS_URL);
      place = null;
    },
    async guard() {
      const url = String(page.url());
      if (EDA_CAPTCHA_URL.test(url)) return "captcha";
      if (page.frames().some((f: any) => EDA_CAPTCHA_FRAME.test(String(f.url())))) return "captcha";
      if (hostMatches(url, EDA_LOGIN_HOSTS)) return "login_required";
      if (!hostMatches(url, EDA_HOSTS)) return "unexpected_page";
      const body = await bodyText();
      if (EDA_CAPTCHA_TEXT.test(body)) return "captcha";
      if (await visible(page.getByRole("button", { name: EDA_TEXT.signIn }).first())) return "login_required";
      return "ok";
    },
    async address() {
      if (EDA_TEXT.addressModal.test(await bodyText())) return null;
      const label = await text(page.locator(EDA_TESTID.addressButton).first());
      if (!label || EDA_TEXT.addressUnset.test(label)) return null;
      const s = label.replace(/\s+/g, " ").trim();
      return s.length >= 3 && s.length <= 200 ? s : null;
    },
    async deliveryFee() {
      const body = await bodyText();
      if (EDA_TEXT.freeDelivery.test(body)) return 0;
      const m = body.match(EDA_TEXT.deliveryFee);
      return m ? Number(m[1]) : null;
    },
    async searchCards() {
      if (!place || !query) return [];
      if (EDA_TEXT.placeClosed.test(await bodyText())) return [];
      const cards: SearchCard[] = [];
      for (const d of await readMenu()) {
        const name = dishName(d.title, d.meta);
        if (!name || !dishMatches(name, query)) continue;
        // «от 350 ₽» — у блюда выбор размера: parseShopRubles вернёт null, в расчёт не попадёт.
        cards.push({ id: edaDishId(place, name), name, price_rub: parseShopRubles(d.price), available: d.plus && !EDA_TEXT.outOfStock.test(d.text) });
      }
      return cards;
    },
    async product() {
      const i = await cardIndex();
      if (i < 0) return { name: null, price_rub: null, available: false };
      const card = page.locator(EDA_TESTID.dishCard).nth(i);
      const name = dishName((await text(card.locator(EDA_TESTID.dishTitle).first())) ?? "", (await text(card.locator(EDA_TESTID.dishMeta).first())) ?? "");
      const price = parseShopRubles(await text(card.locator(EDA_TESTID.dishPrice).first()));
      const plus = await visible(card.locator(EDA_TESTID.dishPlus).first());
      const cardText = (await text(card)) ?? "";
      return { name, price_rub: price, available: plus && !EDA_TEXT.outOfStock.test(cardText) };
    },
    async setProductQty(qty) {
      const i = await cardIndex();
      if (i < 0) return qty === 0 ? "ok" : "blocked";
      const card = page.locator(EDA_TESTID.dishCard).nth(i);
      let current = await counterIn(card);
      for (let n = 0; n < QTY_CLICKS_MAX && current >= 0 && current !== qty; n++) {
        const button = card.locator(current < qty ? EDA_TESTID.dishPlus : EDA_TESTID.dishMinus).first();
        if (!(await visible(button))) break;
        await button.click();
        await wait(500);
        if (await dialogOpen()) {
          // Опции блюда или «корзина другого ресторана»: ничего не выбираем.
          const dialog = (await text(page.getByRole("dialog").first())) ?? "";
          await page.keyboard.press("Escape").catch(() => {});
          await wait(300);
          return /корзин|другого ресторана|очистить/i.test(dialog) ? "blocked" : "options_required";
        }
        const next = await counterIn(card);
        if (next === current) break; // сверка корзины это поймает
        current = next;
      }
      return "ok";
    },
    async cart() {
      const cart = page.locator(EDA_TESTID.cart).first();
      if (!place || !(await visible(cart, UI_TIMEOUT_MS))) return [];
      if (EDA_TEXT.cartEmpty.test((await text(cart)) ?? "")) return [];
      const raw: Array<{ title: string; qty: string; price: string }> = await cart.evaluate((root: any, sel: typeof EDA_TESTID) =>
        [...root.querySelectorAll(sel.cartItem)].map((row: any) => ({
          title: String(row.querySelector(sel.cartItemTitle)?.innerText ?? ""),
          qty: String(row.querySelector(sel.cartItemCounter)?.innerText ?? ""),
          price: String(row.querySelector(sel.cartItemPrice)?.innerText ?? ""),
        })), EDA_TESTID);
      const rows: CartRow[] = [];
      for (const r of raw) {
        const name = normalizeShopName(r.title);
        // Строка без названия — чужая вёрстка: id не совпадёт, сверка корзины упадёт.
        const id = name ? edaDishId(place, name) : `unreadable-${rows.length}`;
        const qty = /^\d{1,3}$/.test(r.qty.trim()) ? Number(r.qty.trim()) : -1;
        const lineRub = parseShopRubles(r.price);
        rows.push({ id, qty, price_rub: lineRub !== null && qty > 0 ? Math.ceil(lineRub / qty) : null });
      }
      return rows;
    },
    async openCheckout() {
      const button = page.getByRole("button", { name: EDA_TEXT.checkout }).first();
      if (!(await visible(button, UI_TIMEOUT_MS))) return false;
      await button.click();
      await page.waitForLoadState("load", { timeout: NAV_TIMEOUT_MS }).catch(() => {});
      await wait(1_000);
      return true;
    },
    async checkout() {
      const body = await bodyText();
      return {
        total_rub: parseShopRubles(await totalNear(EDA_TEXT.total)),
        blocked: EDA_TEXT.checkoutBlocked.test(body),
        saved_card: EDA_TEXT.savedCard.test(body),
        pay_button: await visible(payLocator(), UI_TIMEOUT_MS),
      };
    },
    async clickPay() {
      await payLocator().click();
    },
    orderState: () => stateFromBody(EDA_STATE_TEXT),
    screenshot,
    probe,
  };
}
