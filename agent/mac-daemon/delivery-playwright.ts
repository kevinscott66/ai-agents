/**
 * DeliveryPage поверх Playwright: настоящий Chrome владельца с отдельным
 * профилем доставки. Устроен как taxi-playwright.ts: playwright-core грузится
 * динамически, никаких «стелс»-приёмов, капча — остановка и скриншот.
 *
 * Локаторы НЕ сверены (см. delivery-selectors.ts).
 */
import { parseEtaMinutes, TAXI_SCREENSHOT_B64_MAX } from "../lib/taxi.ts";
import { DELIVERY_TARIFFS, DELIVERY_TARIFF_KEYS, type DeliveryTariff } from "../lib/delivery.ts";
import {
  DELIVERY_CAPTCHA_FRAME,
  DELIVERY_CAPTCHA_TEXT,
  DELIVERY_CAPTCHA_URL,
  DELIVERY_ETA_TEXT,
  DELIVERY_LOGIN_HOSTS,
  DELIVERY_ORDER_HOSTS,
  DELIVERY_START_URL,
  DELIVERY_STATE_TEXT,
  DELIVERY_SUGGESTION_ROLES,
  DELIVERY_TEXT,
} from "./delivery-selectors.ts";
import type { DeliveryBrowser, DeliveryEnv, DeliveryPage, DeliveryTariffRow } from "./delivery.ts";
import { parseTariffCard } from "./taxi.ts";

const PLAYWRIGHT = "playwright-core";
const NAV_TIMEOUT_MS = 30_000;
const UI_TIMEOUT_MS = 8_000;
const BODY_TEXT_MAX = 20_000;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function launchPlaywrightDelivery(env: DeliveryEnv, profileDir: string, opts: { headless?: boolean } = {}): Promise<DeliveryBrowser> {
  let pw: any;
  try {
    pw = await import(PLAYWRIGHT);
  } catch {
    throw new Error("browser_unavailable");
  }
  let context: any;
  try {
    context = await pw.chromium.launchPersistentContext(profileDir, {
      channel: env.DELIVERY_BROWSER_CHANNEL || "chrome",
      headless: opts.headless ?? env.DELIVERY_HEADLESS === "true",
      viewport: { width: 1024, height: 720 },
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
  const page = playwrightDeliveryPage(raw);
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

export function playwrightDeliveryPage(page: any): DeliveryPage {
  const bodyText = async (): Promise<string> => {
    try {
      return String(await page.locator("body").innerText({ timeout: UI_TIMEOUT_MS })).slice(0, BODY_TEXT_MAX);
    } catch {
      return "";
    }
  };
  const field = (name: RegExp) =>
    page.getByRole("textbox", { name }).or(page.getByPlaceholder(name)).first();
  const orderLocator = () => page.getByRole("button", { name: DELIVERY_TEXT.order }).first();

  return {
    async open() {
      await page.goto(DELIVERY_START_URL, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("load", { timeout: NAV_TIMEOUT_MS }).catch(() => {});
      const tab = page.getByRole("tab", { name: DELIVERY_TEXT.tab })
        .or(page.getByRole("button", { name: DELIVERY_TEXT.tab }))
        .or(page.getByRole("link", { name: DELIVERY_TEXT.tab })).first();
      if (await visible(tab, 3_000)) {
        await tab.click();
        await wait(700);
      }
    },
    url: () => String(page.url()),
    async guard() {
      const url = String(page.url());
      if (DELIVERY_CAPTCHA_URL.test(url)) return "captcha";
      if (page.frames().some((f: any) => DELIVERY_CAPTCHA_FRAME.test(String(f.url())))) return "captcha";
      if (hostMatches(url, DELIVERY_LOGIN_HOSTS)) return "login_required";
      if (!hostMatches(url, DELIVERY_ORDER_HOSTS)) return "unexpected_page";
      if (DELIVERY_CAPTCHA_TEXT.test(await bodyText())) return "captcha";
      const login = page.getByRole("button", { name: DELIVERY_TEXT.login }).or(page.getByRole("link", { name: DELIVERY_TEXT.login })).first();
      if (await visible(login)) return "login_required";
      return "ok";
    },
    async setRoute(from, to) {
      for (const [name, address] of [[DELIVERY_TEXT.from, from], [DELIVERY_TEXT.to, to]] as const) {
        const input = field(name);
        if (!(await visible(input, UI_TIMEOUT_MS))) return false;
        await input.click();
        await input.fill("");
        await input.fill(address);
        if (DELIVERY_TEXT.addressNotFound.test(await bodyText())) return false;
        let picked = false;
        for (const role of DELIVERY_SUGGESTION_ROLES) {
          const option = page.getByRole(role).first();
          if (await visible(option, role === DELIVERY_SUGGESTION_ROLES[0] ? UI_TIMEOUT_MS : 1_000)) {
            await option.click();
            picked = true;
            break;
          }
        }
        if (!picked) return false;
        await wait(700);
      }
      await page.waitForLoadState("networkidle", { timeout: UI_TIMEOUT_MS }).catch(() => {});
      return true;
    },
    async tariffs() {
      const labels = DELIVERY_TARIFF_KEYS.map((k) => [k, DELIVERY_TARIFFS[k]]);
      const cards: Array<{ tariff: string; text: string; selected: boolean }> = await page.evaluate((pairs: string[][]) => {
        const doc = (globalThis as any).document;
        const out: Array<{ tariff: string; text: string; selected: boolean }> = [];
        const isSelected = (el: any) =>
          el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-checked") === "true" ||
          el.getAttribute("aria-pressed") === "true" || /(?:^|[\s_-])(?:selected|active|checked)(?:$|[\s_-])/i.test(String(el.className ?? ""));
        for (const [tariff, label] of pairs) {
          const leaf = [...doc.querySelectorAll("body *")].find((el: any) =>
            el.children.length === 0 && String(el.textContent ?? "").trim() === label && el.getClientRects().length > 0);
          if (!leaf) continue;
          let card: any = leaf;
          for (let i = 0; i < 4 && card && !String(card.innerText ?? "").includes("₽"); i++) card = card.parentElement;
          if (!card || !String(card.innerText ?? "").includes("₽")) continue;
          let selected = false;
          for (let el: any = leaf, i = 0; el && i < 6; el = el.parentElement, i++) selected ||= isSelected(el);
          out.push({ tariff, text: String(card.innerText).slice(0, 200), selected });
        }
        return out;
      }, labels);
      return cards
        .filter((c) => (DELIVERY_TARIFF_KEYS as string[]).includes(c.tariff))
        .map((c): DeliveryTariffRow => ({ tariff: c.tariff as DeliveryTariff, selected: c.selected === true, ...parseTariffCard(c.text) }));
    },
    async selectTariff(tariff) {
      await page.getByText(DELIVERY_TARIFFS[tariff], { exact: true }).first().click();
      await wait(700);
    },
    async contactRequired() {
      const input = field(DELIVERY_TEXT.contact);
      if (!(await visible(input, 1_000))) return false;
      try {
        return String(await input.inputValue()).trim() === "";
      } catch {
        return true;
      }
    },
    async setComment(comment) {
      const input = field(DELIVERY_TEXT.comment);
      if (!(await visible(input, UI_TIMEOUT_MS))) return false;
      await input.click();
      await input.fill("");
      await input.fill(comment);
      try {
        return String(await input.inputValue()) === comment;
      } catch {
        return false;
      }
    },
    async orderButton() {
      const button = orderLocator();
      if (!(await visible(button, UI_TIMEOUT_MS))) return null;
      const label = String(await button.innerText()).replace(/\s+/g, " ").trim().slice(0, 80);
      return { label, ...parseTariffCard(label) };
    },
    async clickOrder() {
      await orderLocator().click();
    },
    async orderState() {
      const text = await bodyText();
      const hit = DELIVERY_STATE_TEXT.find(([, re]) => re.test(text));
      const state = hit ? hit[0] : (await visible(orderLocator())) ? "none" : "unknown";
      const eta_min = state === "courier_assigned" || state === "picked_up" ? parseEtaMinutes(text.match(DELIVERY_ETA_TEXT)?.[0]) : null;
      return { state, eta_min };
    },
    async cancelOrder() {
      const button = page.getByRole("button", { name: DELIVERY_TEXT.cancel }).first();
      if (!(await visible(button, 3_000))) return "unavailable";
      await button.click();
      const confirm = page.getByRole("button", { name: DELIVERY_TEXT.cancelConfirm }).last();
      if (await visible(confirm, 3_000)) await confirm.click();
      return "clicked";
    },
    async screenshot() {
      for (const quality of [45, 30, 18]) {
        try {
          const buf: Uint8Array = await page.screenshot({ type: "jpeg", quality, scale: "css", timeout: UI_TIMEOUT_MS });
          const b64 = Buffer.from(buf).toString("base64");
          if (b64.length <= TAXI_SCREENSHOT_B64_MAX) return b64;
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
