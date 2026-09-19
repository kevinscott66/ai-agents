/**
 * DeliveryPage поверх Playwright: настоящий Chrome владельца с отдельным
 * профилем доставки. Устроен как taxi-playwright.ts: playwright-core грузится
 * динамически, никаких «стелс»-приёмов, капча — остановка и скриншот.
 *
 * Что сверено, а что нет — в delivery-selectors.ts.
 */
import { parseEtaMinutes, TAXI_SCREENSHOT_B64_MAX } from "../lib/taxi.ts";
import { DELIVERY_TARIFF_KEYS, type DeliveryTariff } from "../lib/delivery.ts";
import {
  DELIVERY_CAPTCHA_FRAME,
  DELIVERY_CAPTCHA_TEXT,
  DELIVERY_CAPTCHA_URL,
  DELIVERY_ETA_TEXT,
  DELIVERY_LOGIN_HOSTS,
  DELIVERY_OFFER_ETA,
  DELIVERY_OFFER_INPUT,
  DELIVERY_OFFERS,
  DELIVERY_ORDER_HOSTS,
  DELIVERY_PRICE_POLL,
  DELIVERY_START_URL,
  DELIVERY_STATE_TEXT,
  DELIVERY_TEXT,
} from "./delivery-selectors.ts";
import type { DeliveryBrowser, DeliveryEnv, DeliveryPage, DeliveryTariffRow } from "./delivery.ts";
import { parseTariffCard } from "./taxi.ts";
import {
  ariaProbe,
  bodyText as pageBodyText,
  fillAddress,
  hostMatches,
  jpegScreenshot,
  launchProfileChrome,
  NAV_TIMEOUT_MS,
  UI_TIMEOUT_MS,
  visible,
  wait,
  waitFor,
} from "./playwright-kit.ts";

export async function launchPlaywrightDelivery(env: DeliveryEnv, profileDir: string, opts: { headless?: boolean } = {}): Promise<DeliveryBrowser> {
  const { context, page: raw } = await launchProfileChrome(profileDir, {
    channel: env.DELIVERY_BROWSER_CHANNEL || "chrome",
    headless: opts.headless ?? env.DELIVERY_HEADLESS === "true",
    viewport: { width: 1024, height: 720 },
  });
  const page = playwrightDeliveryPage(raw);
  return { page: () => page, close: () => context.close() };
}

export function playwrightDeliveryPage(page: any): DeliveryPage {
  const bodyText = () => pageBodyText(page);
  const field = (name: RegExp) =>
    page.getByRole("textbox", { name }).or(page.getByPlaceholder(name)).first();
  const orderLocator = () => page.getByRole("button", { name: DELIVERY_TEXT.order }).first();
  /** Варианты срока: значение radio и текст ближайшего предка, где этот radio единственный. */
  const readOffers = (): Promise<Array<{ value: string; checked: boolean; text: string }>> =>
    page.evaluate((selector: string) => {
      const doc = (globalThis as any).document;
      return [...doc.querySelectorAll(selector)].map((input: any) => {
        let box: any = input;
        while (box.parentElement && box.parentElement.querySelectorAll(selector).length === 1) box = box.parentElement;
        return { value: String(input.value), checked: input.checked === true, text: String(box.innerText ?? "").replace(/\s+/g, " ").slice(0, 200) };
      });
    }, DELIVERY_OFFER_INPUT).catch(() => []);
  const offerEta = (text: string): number | null => {
    const m = text.match(DELIVERY_OFFER_ETA);
    if (!m || (!m[1] && !m[2])) return null;
    return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
  };

  return {
    async open() {
      await page.goto(DELIVERY_START_URL, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("load", { timeout: NAV_TIMEOUT_MS }).catch(() => {});
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
      const boxes = page.getByRole("textbox", { name: DELIVERY_TEXT.address });
      for (const [i, address] of [[0, from], [1, to]] as const) {
        const input = boxes.nth(i);
        if (!(await visible(input, UI_TIMEOUT_MS))) return false;
        if (!(await fillAddress(page, input, address))) return false;
        if (DELIVERY_TEXT.addressNotFound.test(await bodyText())) return false;
      }
      await waitFor(async () => (await readOffers()).some((o) => /₽/.test(o.text)), DELIVERY_PRICE_POLL.attempts, DELIVERY_PRICE_POLL.intervalMs);
      return true;
    },
    async tariffs() {
      const offers = await readOffers();
      return DELIVERY_TARIFF_KEYS.flatMap((tariff): DeliveryTariffRow[] => {
        const offer = offers.find((o) => o.value === DELIVERY_OFFERS[tariff]);
        if (!offer || !/₽/.test(offer.text)) return [];
        return [{ tariff, selected: offer.checked, price_rub: parseTariffCard(offer.text).price_rub, eta_min: offerEta(offer.text) }];
      });
    },
    async selectTariff(tariff) {
      const value = DELIVERY_OFFERS[tariff];
      if (!value) return;
      await page.locator(`${DELIVERY_OFFER_INPUT}[value="${value}"]`).first().check({ force: true }).catch(() => {});
      await wait(700);
    },
    async fillRecipientFromSender() {
      const sender = page.getByRole("textbox", { name: DELIVERY_TEXT.senderPhone }).first();
      const recipient = page.getByRole("textbox", { name: DELIVERY_TEXT.recipientPhone }).first();
      if (!(await visible(sender))) return;
      const phone = String(await sender.inputValue().catch(() => "")).trim();
      if (!phone) return;
      await recipient.scrollIntoViewIfNeeded({ timeout: UI_TIMEOUT_MS }).catch(() => {});
      if (!(await visible(recipient, UI_TIMEOUT_MS))) return;
      if (String(await recipient.inputValue().catch(() => "x")).trim()) return;
      await recipient.click({ timeout: UI_TIMEOUT_MS }).catch(() => {});
      await recipient.fill(phone, { timeout: UI_TIMEOUT_MS }).catch(() => {});
      await wait(700);
    },
    async contactRequired() {
      // Телефонов два — отправителя и получателя; пустой любой из них — стоп.
      for (const input of await page.getByRole("textbox", { name: DELIVERY_TEXT.contact }).all()) {
        if (!(await visible(input))) continue;
        try {
          if (String(await input.inputValue()).trim() === "") return true;
        } catch {
          return true;
        }
      }
      return false;
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
      const disabled = await button.isDisabled().catch(() => false);
      const blocked = !disabled ? null : DELIVERY_TEXT.addPayment.test(label) ? "payment" as const : "disabled" as const;
      return { label, ...parseTariffCard(label), blocked };
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
    screenshot: () => jpegScreenshot(page, TAXI_SCREENSHOT_B64_MAX),
    probe: () => ariaProbe(page),
  };
}
