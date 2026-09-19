/**
 * Самопроверка вёрстки для починщика селекторов (этап 4 автономии):
 * `bun mac-daemon/shop.ts selfcheck [eda|market]`.
 *
 * Открывает публичную страницу поиска сервиса в профиле покупок и печатает
 * JSON: сколько элементов находит каждый селектор из *_TESTID и какие
 * data-testid / data-auto / data-zone-name вообще есть на странице.
 *
 * Только чтение: ни одного клика, корзина, оформление и окно адресов не
 * открываются. Текста страницы в выводе нет — только имена атрибутов, и те
 * пропущены через SAFE_ATTR: в шапке залогиненного профиля видны адрес и имя
 * владельца, а вывод уходит починщику и дальше в чат.
 */
import type { ShopService } from "../lib/shop.ts";
import { LAVKA_CAPTCHA_FRAME, LAVKA_CAPTCHA_URL, LAVKA_HOSTS, LAVKA_LOGIN_HOSTS, LAVKA_TESTID, lavkaSearchUrl } from "./shop-selectors.ts";
import { EDA_CAPTCHA_URL, EDA_HOSTS, EDA_LOGIN_HOSTS, EDA_TESTID, edaSearchUrl } from "./eda-selectors.ts";
import { MARKET_CAPTCHA_URL, MARKET_HOSTS, MARKET_LOGIN_HOSTS, MARKET_TESTID, marketSearchUrl } from "./market-selectors.ts";
import { hostMatches, launchProfileChrome, wait } from "./playwright-kit.ts";

/** Нейтральные запросы: у каждого сервиса гарантированно есть выдача. */
export const SELFCHECK_PLAN: Record<ShopService, { url: string; selectors: Record<string, string>; hosts: RegExp[]; login: RegExp[]; captcha: RegExp }> = {
  lavka: { url: lavkaSearchUrl("молоко"), selectors: LAVKA_TESTID, hosts: LAVKA_HOSTS, login: LAVKA_LOGIN_HOSTS, captcha: LAVKA_CAPTCHA_URL },
  eda: { url: edaSearchUrl("пицца"), selectors: EDA_TESTID, hosts: EDA_HOSTS, login: EDA_LOGIN_HOSTS, captcha: EDA_CAPTCHA_URL },
  market: { url: marketSearchUrl("зарядка usb-c"), selectors: MARKET_TESTID, hosts: MARKET_HOSTS, login: MARKET_LOGIN_HOSTS, captcha: MARKET_CAPTCHA_URL },
};

export const INVENTORY_ATTRS = ["data-testid", "data-auto", "data-zone-name"] as const;
/** Значение похоже на идентификатор, а не на текст: латиница в начале, без пробелов и кириллицы, до 60 символов. */
export const SAFE_ATTR = /^[A-Za-z][\w:.#-]{0,59}$/;
export const INVENTORY_MAX = 300;

export type SelfcheckStatus = "ok" | "captcha" | "login_required" | "unexpected_page" | "browser_unavailable";

export interface SelfcheckReport {
  service: ShopService;
  status: SelfcheckStatus;
  selectors: Record<string, number>;
  inventory: Record<string, string[]>;
}

/**
 * Имена атрибутов → без дублей, без похожего на данные, с потолком. Длинные
 * числа (id товаров и заказов) сворачиваются в `#`: `cartItem-1789672288320` →
 * `cartItem-#`, чтобы инвентарь показывал форму, а не номера.
 */
export function sanitizeInventory(raw: Record<string, unknown>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const attr of INVENTORY_ATTRS) {
    const values = Array.isArray(raw[attr]) ? (raw[attr] as unknown[]) : [];
    const seen = new Set<string>();
    for (const v of values) {
      if (typeof v !== "string") continue;
      const shape = v.replace(/\d{4,}/g, "#");
      if (!SAFE_ATTR.test(shape)) continue;
      seen.add(shape);
      if (seen.size >= INVENTORY_MAX) break;
    }
    out[attr] = [...seen].sort();
  }
  return out;
}

export function classifyUrl(service: ShopService, url: string, frameUrls: readonly string[]): SelfcheckStatus {
  const plan = SELFCHECK_PLAN[service];
  if (plan.captcha.test(url) || frameUrls.some((f) => LAVKA_CAPTCHA_FRAME.test(f))) return "captcha";
  if (hostMatches(url, plan.login)) return "login_required";
  if (!hostMatches(url, plan.hosts)) return "unexpected_page";
  return "ok";
}

/** Страница уже открыта: посчитать селекторы и собрать инвентарь. */
export async function inspectPage(page: any, service: ShopService): Promise<SelfcheckReport> {
  const plan = SELFCHECK_PLAN[service];
  const status = classifyUrl(service, String(page.url()), page.frames().map((f: any) => String(f.url())));
  const selectors: Record<string, number> = {};
  if (status !== "ok") return { service, status, selectors, inventory: sanitizeInventory({}) };
  for (const [key, sel] of Object.entries(plan.selectors)) {
    selectors[key] = await page.locator(sel).count().catch(() => -1);
  }
  const raw = await page.evaluate((attrs: readonly string[]) => {
    const out: Record<string, string[]> = {};
    for (const a of attrs) out[a] = Array.from(document.querySelectorAll(`[${a}]`), (el) => el.getAttribute(a) ?? "");
    return out;
  }, INVENTORY_ATTRS).catch(() => ({}));
  return { service, status, selectors, inventory: sanitizeInventory(raw) };
}

export async function runSelfcheck(service: ShopService, env: { SHOP_BROWSER_CHANNEL?: string; SHOP_HEADLESS?: string }, profileDir: string): Promise<SelfcheckReport> {
  let launched: { context: any; page: any };
  try {
    launched = await launchProfileChrome(profileDir, {
      channel: env.SHOP_BROWSER_CHANNEL || "chrome",
      headless: env.SHOP_HEADLESS === "true",
      viewport: { width: 1280, height: 800 },
    });
  } catch {
    return { service, status: "browser_unavailable", selectors: {}, inventory: sanitizeInventory({}) };
  }
  try {
    await launched.page.goto(SELFCHECK_PLAN[service].url, { waitUntil: "domcontentloaded" }).catch(() => {});
    // Выдача дорисовывается после загрузки документа.
    await wait(4_000);
    return await inspectPage(launched.page, service);
  } finally {
    await launched.context.close().catch(() => {});
  }
}
