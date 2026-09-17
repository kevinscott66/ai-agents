/**
 * ShopPage Яндекс Еды поверх Playwright. Вкладка и помощники — общие с Лавкой
 * (shop-playwright.ts), вёрстка — только из eda-selectors.ts.
 *
 * У блюд нет своих страниц: «открыть товар» — это открыть меню ресторана и
 * запомнить название; карточка ищется по точному названию (заголовок + вес),
 * а id блюда выводится из ресторана и названия (edaDishId).
 *
 * Опции (размер, тесто, соус, добавки) — в окне блюда, которое открывается
 * кликом по карточке. Расчёт читает группы опций и цену без доплат; заказ
 * отмечает ровно подписанный выбор, перечитывает отметки и только тогда жмёт
 * «Добавить». В корзине вариант блюда узнаётся по названию и названиям опций
 * (edaVariantId). Окно «корзина другого ресторана» — отказ, ничего не чистим.
 */
import {
  edaDishId,
  edaVariantId,
  normalizeShopName,
  normalizeShopOptionName,
  parseShopRubles,
  resolveShopOptions,
  SHOP_CANDIDATES_MAX,
  SHOP_OPTION_CHOICES_MAX,
  SHOP_OPTION_GROUPS_MAX,
  SHOP_ADDRESSES_MAX,
  SHOP_PLACE_REF,
  type ShopOptionGroup,
  type ShopOptionPick,
  type ShopPlace,
} from "../lib/shop.ts";
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
import { waitFor } from "./playwright-kit.ts";
import type { CartRow, QtyResult, SearchCard, ShopPage } from "./shop.ts";

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

/** Вариант опции, как его видно в окне блюда. */
export interface RawOptionChoice {
  name: string;
  delta: string;
  type: string;
  checked: boolean;
  /** Номер label среди всех label окна — по нему кликаем. */
  label: number;
}

export interface RawOptionGroup {
  title: string;
  hint: string;
  choices: RawOptionChoice[];
}

export interface RawDishDialog {
  name: string;
  weight: string;
  price: string;
  qty: string;
  groups: RawOptionGroup[];
}

/** «+ 150 ₽» → 150, пусто → 0; другое — не понимаем. */
export function optionDelta(raw: string): number | null {
  const s = raw.replace(/[\u00a0\u202f\u2009]/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return 0;
  const m = s.match(/^\+ ?(\d{1,3}(?: \d{3})*|\d+) ?₽$/);
  return m ? Number(m[1]!.replace(/ /g, "")) : null;
}

/** Сколько можно отметить в группе по подсказке «Выберите до 100», «Выберите 2», «от 1 до 3». */
function groupLimits(type: string, hint: string, count: number): { min: number; max: number } | null {
  const h = hint.replace(/\s+/g, " ").trim();
  if (type === "radio") {
    if (!h) return { min: 1, max: 1 };
    return /необязат/i.test(h) ? { min: 0, max: 1 } : null;
  }
  if (type !== "checkbox") return null;
  const clamp = (n: number) => Math.min(n, count);
  if (!h || /^необязат/i.test(h)) return { min: 0, max: count };
  let m = h.match(/^Выберите до (\d{1,3})$/i);
  if (m) return Number(m[1]) >= 1 ? { min: 0, max: clamp(Number(m[1])) } : null;
  m = h.match(/^Выберите от (\d{1,3}) до (\d{1,3})$/i);
  if (m) {
    const [min, max] = [Number(m[1]), clamp(Number(m[2]))];
    return min <= max && max >= 1 ? { min, max } : null;
  }
  m = h.match(/^Выберите (?:от )?(\d{1,3})$/i);
  if (m) {
    const n = Number(m[1]);
    if (n < 1 || n > count) return null;
    return /от/i.test(h) ? { min: n, max: count } : { min: n, max: n };
  }
  return null;
}

/**
 * Группы опций из окна блюда. Всё, что не понимаем (смешанные типы, чужая
 * подсказка, доплата не «+ N ₽», повтор названия), — null: блюдо в расчёт не
 * попадает, догадок нет.
 */
export function edaOptionGroups(raw: ReadonlyArray<RawOptionGroup>): ShopOptionGroup[] | null {
  if (raw.length > SHOP_OPTION_GROUPS_MAX) return null;
  const groups: ShopOptionGroup[] = [];
  for (const g of raw) {
    const name = normalizeShopOptionName(g.title);
    if (!name || !g.choices.length || g.choices.length > SHOP_OPTION_CHOICES_MAX) return null;
    const type = g.choices[0]!.type;
    if (g.choices.some((c) => c.type !== type)) return null;
    const limits = groupLimits(type, g.hint, g.choices.length);
    if (!limits) return null;
    const choices: ShopOptionGroup["choices"] = [];
    for (const c of g.choices) {
      const cname = normalizeShopOptionName(c.name);
      const delta = optionDelta(c.delta);
      if (!cname || delta === null) return null;
      choices.push({ name: cname, price_rub: delta });
    }
    if (new Set(choices.map((c) => c.name)).size !== choices.length) return null;
    groups.push({ name, ...limits, choices });
  }
  return new Set(groups.map((g) => g.name)).size === groups.length ? groups : null;
}

/** Цена блюда без доплат: цена в окне за qty штук минус отмеченные доплаты. */
export function edaBasePrice(dialog: RawDishDialog, groups: ReadonlyArray<ShopOptionGroup>): number | null {
  const total = parseShopRubles(dialog.price);
  const qty = /^\d{1,3}$/.test(dialog.qty.trim()) ? Number(dialog.qty.trim()) : 0;
  if (total === null || qty < 1 || total % qty !== 0) return null;
  let extra = 0;
  dialog.groups.forEach((g, gi) => g.choices.forEach((c, ci) => { if (c.checked) extra += groups[gi]!.choices[ci]!.price_rub; }));
  const base = total / qty - extra;
  return base > 0 ? base : null;
}

/** Отмеченные опции окна в порядке групп. */
const checkedPicks = (dialog: RawDishDialog, groups: ReadonlyArray<ShopOptionGroup>): ShopOptionPick[] =>
  dialog.groups.flatMap((g, gi) => g.choices.flatMap((c, ci) => (c.checked ? [{ group: groups[gi]!.name, name: groups[gi]!.choices[ci]!.name }] : [])));

/**
 * Строка корзины: первая строка — название, дальше опции до суммы строки,
 * потом «·385 г» и количество. Сумма — за все штуки, цена штуки округляется вверх.
 */
export function parseEdaCartRow(placeRef: string, row: { name: string; qty: string; text: string }): CartRow | null {
  const lines = row.text.split("\n").map((l) => l.replace(/[\u00a0\u202f\u2009]/g, " ").replace(/\s+/g, " ").trim()).filter(Boolean);
  const title = normalizeShopName(row.name);
  if (!title || normalizeShopName(lines[0]) !== title) return null;
  const priceAt = lines.findIndex((l, i) => i > 0 && parseShopRubles(l) !== null);
  if (priceAt < 0) return null;
  const options = lines.slice(1, priceAt).map((l) => normalizeShopOptionName(l));
  if (options.some((o) => o === null)) return null;
  const weight = lines[priceAt + 1]?.match(/^·\s?(.+)$/)?.[1] ?? "";
  const name = dishName(title, weight);
  const qtyRaw = row.qty.trim();
  const qty = /^\d{1,3}$/.test(qtyRaw) ? Number(qtyRaw) : -1;
  const lineRub = parseShopRubles(lines[priceAt]);
  if (!name) return null;
  return { id: edaVariantId(placeRef, name, options as string[]), qty, price_rub: lineRub !== null && qty > 0 ? Math.ceil(lineRub / qty) : null };
}

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

  const fullDialog = () => page.getByRole("dialog").filter({ has: page.locator(EDA_TESTID.fullName) }).first();

  const closeDialogs = async () => {
    for (let i = 0; i < 3 && (await dialogOpen()); i++) {
      const close = page.getByRole("dialog").first().getByRole("button", { name: EDA_TEXT.closeDialog }).first();
      if (await visible(close, 500)) await close.click().catch(() => {});
      else await page.keyboard.press("Escape").catch(() => {});
      await wait(400);
    }
  };

  /** Окно блюда по карточке: клик по фото (по заголовку окно не открывается). */
  const openDialog = async (index: number): Promise<boolean> => {
    await closeDialogs();
    const card = page.locator(EDA_TESTID.dishCard).nth(index);
    await card.scrollIntoViewIfNeeded({ timeout: UI_TIMEOUT_MS }).catch(() => {});
    await card.click({ position: { x: 40, y: 40 }, timeout: UI_TIMEOUT_MS }).catch(() => {});
    return visible(fullDialog(), UI_TIMEOUT_MS);
  };

  const readDialog = async (): Promise<RawDishDialog | null> => {
    const dialog = fullDialog();
    if (!(await visible(dialog, 1_000))) return null;
    return dialog.evaluate((root: any, sel: typeof EDA_TESTID) => {
      const txt = (el: any) => String(el?.innerText ?? "").trim();
      const labels = [...root.querySelectorAll("label")];
      const groups = [...root.querySelectorAll("h4")].map((h: any) => {
        const spans = [...h.querySelectorAll(":scope > span")];
        const box = h.parentElement;
        const choices = [...box.querySelectorAll("label")].map((label: any) => {
          const head = label.firstElementChild;
          const parts = head ? [...head.querySelectorAll(":scope > span")] : [];
          const input = label.querySelector(sel.optionInput);
          return {
            name: txt(parts[0]),
            delta: txt(parts[1]),
            type: String(input?.type ?? ""),
            checked: Boolean(input?.checked),
            label: labels.indexOf(label),
          };
        });
        return { title: txt(spans[0]), hint: txt(spans[1]), choices };
      });
      return {
        name: txt(root.querySelector(sel.fullName)),
        weight: txt(root.querySelector(sel.fullWeight)),
        price: txt(root.querySelector(sel.fullPrice)).replace(/\s+/g, " "),
        qty: txt(root.querySelector(sel.amountValue)),
        groups,
      };
    }, EDA_TESTID).catch(() => null);
  };

  /** Окно блюда разобрано: название, группы (или null — не понимаем) и цена без доплат. */
  const dishDialog = async (index: number) => {
    if (!(await openDialog(index))) return null;
    const raw = await readDialog();
    if (!raw) return null;
    const groups = edaOptionGroups(raw.groups);
    return { raw, name: dishName(raw.name, raw.weight), groups, base: groups ? edaBasePrice(raw, groups) : null };
  };

  const readCartRows = async (): Promise<Array<{ name: string; qty: string; text: string }>> =>
    page.evaluate((sel: typeof EDA_TESTID) => {
      const doc = (globalThis as any).document;
      return [...doc.querySelectorAll(sel.cartRow)].slice(0, 50).map((row: any) => {
        const q = [...row.querySelectorAll(sel.amountValue)].pop();
        return {
          name: String(row.querySelector(sel.cartRowName)?.innerText ?? ""),
          qty: String(q?.innerText ?? q?.value ?? ""),
          text: String(row.innerText ?? "").slice(0, 1_000),
        };
      });
    }, EDA_TESTID).catch(() => []);

  /** Панель корзины дорисовалась: есть строки, текст пустой корзины или заголовок «Корзина». */
  const cartReady = async (): Promise<"rows" | "empty" | "unknown"> => {
    let state: "rows" | "empty" | "unknown" = "unknown";
    await waitFor(async () => {
      if ((await page.locator(EDA_TESTID.cartRow).count().catch(() => 0)) > 0) state = "rows";
      else if (await visible(page.getByText(EDA_TEXT.cartEmpty).first(), 200)) state = "empty";
      return state !== "unknown";
    }, 20, 500);
    return state;
  };

  const counterIn = async (card: any): Promise<number> => {
    const counter = card.locator(EDA_TESTID.dishCounter).first();
    if (!(await visible(counter))) return 0;
    const raw = String((await counter.innerText().catch(() => "")) ?? "").trim();
    return /^\d{1,3}$/.test(raw) ? Number(raw) : -1;
  };

  const payLocator = () => page.getByRole("button", { name: EDA_TEXT.pay }).first();

  const oneLine = (v: string) => v.replace(/\s+/g, " ").replace(/ ,/g, ",").trim();

  /** Кнопка адреса в шапке: у неё нет testid, узнаём по подписи — не из известных. */
  const headerAddressButton = async () => {
    const buttons = page.getByRole("banner").first().getByRole("button");
    const texts: string[] = await buttons.allInnerTexts().catch(() => []);
    const i = texts.findIndex((v) => {
      const s = oneLine(v);
      return s.length > 0 && !EDA_TEXT.headerOther.test(s);
    });
    return i < 0 ? null : buttons.nth(i);
  };

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
      // Шапка сначала рисуется скелетом: ждём, пока появится кнопка с адресом.
      const buttons = page.getByRole("banner").first().getByRole("button");
      let label: string | undefined;
      await waitFor(async () => {
        const texts: string[] = await buttons.allInnerTexts().catch(() => []);
        label = texts.map(oneLine).find((t) => !EDA_TEXT.headerNotAddress.test(t));
        return label !== undefined || EDA_TEXT.addressUnset.test(texts.join("\n"));
      }, 20, 500);
      if (EDA_TEXT.addressModal.test(await bodyText())) return null;
      if (!label || EDA_TEXT.addressUnset.test(label)) return null;
      return label.length >= 3 && label.length <= 200 ? label : null;
    },
    async savedAddresses() {
      // Без адреса Еда сама открывает это окно; с адресом его открывает кнопка в шапке.
      const dialog = page.locator(EDA_TESTID.addressDialog).first();
      if (!(await visible(dialog))) {
        // Шапка оживает не сразу: пока каталог в заглушках, клик по адресу ничего не открывает.
        await waitFor(async () => {
          const button = await headerAddressButton();
          if (!button) return false;
          // Поверх шапки может висеть подсказка «Заказ на этот адрес?» — она перехватывает клик.
          await button.click({ timeout: UI_TIMEOUT_MS }).catch(async () => {
            await button.click({ timeout: UI_TIMEOUT_MS, force: true }).catch(() => {});
          });
          return await visible(dialog, 2_000);
        }, 5, 2_000);
      }
      if (!(await visible(dialog, UI_TIMEOUT_MS))) return [];
      // Список подтягивается позже окна: сперва в нём висят заглушки без подписей.
      const items = dialog.locator(EDA_TESTID.addressRadio);
      await waitFor(async () => {
        const raw: string[] = await items.allInnerTexts().catch(() => []);
        return raw.some((v) => v.trim().length >= 3);
      }, 10, 1_000);
      const texts: string[] = await items.allInnerTexts().catch(() => []);
      return texts.map(oneLine).filter((s) => s.length >= 3 && s.length <= 200).slice(0, SHOP_ADDRESSES_MAX);
    },
    async chooseAddress(index) {
      const dialog = page.locator(EDA_TESTID.addressDialog).first();
      await dialog.locator(EDA_TESTID.addressRadio).nth(index).click({ timeout: UI_TIMEOUT_MS });
      // Окно закрывается само; каталог перезагружается под новый адрес.
      await waitFor(async () => !(await visible(dialog)), 20, 500);
      await page.waitForLoadState("load", { timeout: NAV_TIMEOUT_MS }).catch(() => {});
      await wait(1_000);
    },
    async closeAddresses() {
      const dialog = page.locator(EDA_TESTID.addressDialog).first();
      if (!(await visible(dialog))) return;
      const close = dialog.getByRole("button", { name: EDA_TEXT.closeDialog }).first();
      if (await visible(close)) await close.click({ timeout: UI_TIMEOUT_MS }).catch(() => {});
      else await page.keyboard.press("Escape").catch(() => {});
    },
    async deliveryFee() {
      // Панель корзины — после длинного меню, за пределами обрезанного bodyText.
      const fee = page.getByText(EDA_TEXT.deliveryFee).first();
      const free = page.getByText(EDA_TEXT.freeDelivery).first();
      await visible(fee.or(free).first(), UI_TIMEOUT_MS);
      if (await visible(free)) return 0;
      const m = ((await text(fee)) ?? "").match(EDA_TEXT.deliveryFee);
      return m ? Number(m[1]) : null;
    },
    async searchCards() {
      if (!place || !query) return [];
      if (EDA_TEXT.placeClosed.test(await bodyText())) return [];
      const cards: SearchCard[] = [];
      const menu = await readMenu();
      for (const [i, d] of menu.entries()) {
        const name = dishName(d.title, d.meta);
        if (!name || !dishMatches(name, query) || !d.plus || EDA_TEXT.outOfStock.test(d.text)) continue;
        // Одинаковые названия в меню не различаем — такое блюдо не заказать.
        if (menu.filter((x) => dishName(x.title, x.meta) === name).length !== 1) continue;
        // Опции и цена без доплат — из окна блюда; окно не открылось или не понятно — блюда нет в расчёте.
        const dialog = await dishDialog(i);
        await closeDialogs();
        if (!dialog || dialog.name !== name || !dialog.groups || dialog.base === null) continue;
        cards.push({
          id: edaDishId(place, name), name, price_rub: dialog.base, available: true,
          ...(dialog.groups.length ? { options: dialog.groups } : {}),
        });
        if (cards.length === SHOP_CANDIDATES_MAX) break;
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
    async addWithOptions(qty: number, picks: ShopOptionPick[]): Promise<QtyResult> {
      const i = await cardIndex();
      if (i < 0) return "blocked";
      const dialog = await dishDialog(i);
      if (!dialog || dialog.name !== item || !dialog.groups) {
        await closeDialogs();
        return "options_mismatch";
      }
      const wanted = resolveShopOptions(dialog.groups, picks);
      if (!wanted.ok) {
        await closeDialogs();
        return dialog.groups.some((g) => g.min > 0) && !picks.length ? "options_required" : "options_mismatch";
      }
      const want = new Set(wanted.picks.map((p) => `${p.group}\n${p.name}`));
      const key = (gi: number, ci: number) => `${dialog.groups![gi]!.name}\n${dialog.groups![gi]!.choices[ci]!.name}`;
      const root = fullDialog();
      // Сначала снять лишние флажки, потом отметить нужное; radio снимается выбором соседа.
      for (const pass of ["off", "on"] as const) {
        const now = await readDialog();
        if (!now || now.groups.length !== dialog.raw.groups.length) break;
        for (const [gi, g] of now.groups.entries()) {
          for (const [ci, c] of g.choices.entries()) {
            const need = want.has(key(gi, ci));
            if (c.checked === need || (pass === "off" ? need || c.type !== "checkbox" : !need)) continue;
            await root.locator("label").nth(c.label).click({ timeout: UI_TIMEOUT_MS }).catch(() => {});
            await wait(250);
          }
        }
      }
      const after = await readDialog();
      const afterGroups = after ? edaOptionGroups(after.groups) : null;
      const same = after && afterGroups && JSON.stringify(afterGroups) === JSON.stringify(dialog.groups)
        && JSON.stringify(checkedPicks(after, afterGroups)) === JSON.stringify(wanted.picks);
      if (!same) {
        await closeDialogs();
        return "options_mismatch";
      }
      for (let n = 0; n < QTY_CLICKS_MAX; n++) {
        const current = Number(((await text(root.locator(EDA_TESTID.amountValue).first())) ?? "").trim());
        if (!Number.isSafeInteger(current) || current === qty) break;
        await root.locator(current < qty ? EDA_TESTID.amountInc : EDA_TESTID.amountDec).first().click({ timeout: UI_TIMEOUT_MS }).catch(() => {});
        await wait(250);
      }
      if (Number(((await text(root.locator(EDA_TESTID.amountValue).first())) ?? "").trim()) !== qty) {
        await closeDialogs();
        return "blocked";
      }
      const add = root.locator(EDA_TESTID.fullAdd).first();
      if (!(await visible(add, 1_000))) {
        await closeDialogs();
        return "options_required";
      }
      await add.click({ timeout: UI_TIMEOUT_MS });
      await wait(800);
      if (await dialogOpen()) {
        // Корзина другого ресторана или вопрос страницы: ничего не выбираем.
        await closeDialogs();
        return "blocked";
      }
      return "ok";
    },
    async cart() {
      if (!place) return [];
      const state = await cartReady();
      if (state === "empty") return [];
      const raw = await readCartRows();
      // Ни строк, ни пустой корзины — не знаем, что там: строка-заглушка, чтобы не решить «пусто».
      if (!raw.length) return [{ id: "unreadable-0", qty: -1, price_rub: null }];
      return raw.map((r, n) => parseEdaCartRow(place!, r) ?? { id: `unreadable-${n}`, qty: -1, price_rub: null });
    },
    async removeCartRows(ids: string[]) {
      if (!place) return;
      const wanted = new Set(ids);
      for (let n = 0; n < QTY_CLICKS_MAX * 2; n++) {
        if ((await cartReady()) !== "rows") return;
        const rows = (await readCartRows()).map((r) => parseEdaCartRow(place!, r));
        const at = rows.findIndex((r) => r !== null && wanted.has(r.id));
        if (at < 0) return;
        const minus = page.locator(EDA_TESTID.cartRow).nth(at).locator(EDA_TESTID.amountDec).first();
        if (!(await visible(minus, 1_000))) return;
        await minus.click({ timeout: UI_TIMEOUT_MS }).catch(() => {});
        await wait(700);
      }
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
