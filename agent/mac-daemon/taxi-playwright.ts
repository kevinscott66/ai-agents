/**
 * TaxiPage поверх Playwright: настоящий Chrome владельца с отдельным профилем.
 *
 * playwright-core лежит только в mac-daemon/node_modules — на сервере его нет,
 * поэтому модуль грузится динамически по имени из переменной и без импорта
 * типов. Никаких «стелс»-приёмов: обычный Chrome, обычный профиль; капча — это
 * остановка и скриншот, а не повод прятаться.
 */
import { TAXI_SCREENSHOT_B64_MAX, TAXI_TARIFFS, TAXI_TARIFF_KEYS, type TaxiTariff } from "../lib/taxi.ts";
import {
  TAXI_CAPTCHA_FRAME,
  TAXI_CAPTCHA_TEXT,
  TAXI_CAPTCHA_URL,
  TAXI_ETA_TEXT,
  TAXI_LOGIN_HOSTS,
  TAXI_ORDER_HOSTS,
  TAXI_PLATE,
  TAXI_START_URL,
  TAXI_STATE_TEXT,
  TAXI_SUGGESTION_ROLES,
  TAXI_TEXT,
} from "./taxi-selectors.ts";
import { parseTariffCard, type TaxiBrowser, type TaxiEnv, type TaxiPage, type TariffRow } from "./taxi.ts";
import { parseEtaMinutes } from "../lib/taxi.ts";
import {
  ariaProbe,
  bodyText as pageBodyText,
  hostMatches,
  jpegScreenshot,
  launchProfileChrome,
  NAV_TIMEOUT_MS,
  readTariffCards,
  UI_TIMEOUT_MS,
  visible,
  wait,
} from "./playwright-kit.ts";

export async function launchPlaywrightTaxi(env: TaxiEnv, profileDir: string, opts: { headless?: boolean } = {}): Promise<TaxiBrowser> {
  const { context, page: raw } = await launchProfileChrome(profileDir, {
    channel: env.TAXI_BROWSER_CHANNEL || "chrome",
    headless: opts.headless ?? env.TAXI_HEADLESS === "true",
    viewport: { width: 1024, height: 720 },
  });
  const page = playwrightTaxiPage(raw);
  return { page: () => page, close: () => context.close() };
}

export function playwrightTaxiPage(page: any): TaxiPage {
  const bodyText = () => pageBodyText(page);
  const field = (name: RegExp) =>
    page.getByRole("textbox", { name }).or(page.getByPlaceholder(name)).first();
  const orderLocator = () => page.getByRole("button", { name: TAXI_TEXT.order }).first();

  return {
    async open() {
      await page.goto(TAXI_START_URL, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("load", { timeout: NAV_TIMEOUT_MS }).catch(() => {});
    },
    url: () => String(page.url()),
    async guard() {
      const url = String(page.url());
      if (TAXI_CAPTCHA_URL.test(url)) return "captcha";
      if (page.frames().some((f: any) => TAXI_CAPTCHA_FRAME.test(String(f.url())))) return "captcha";
      if (hostMatches(url, TAXI_LOGIN_HOSTS)) return "login_required";
      if (!hostMatches(url, TAXI_ORDER_HOSTS)) return "unexpected_page";
      if (TAXI_CAPTCHA_TEXT.test(await bodyText())) return "captcha";
      const login = page.getByRole("button", { name: TAXI_TEXT.login }).or(page.getByRole("link", { name: TAXI_TEXT.login })).first();
      if (await visible(login)) return "login_required";
      return "ok";
    },
    async setRoute(from, to) {
      for (const [name, address] of [[TAXI_TEXT.from, from], [TAXI_TEXT.to, to]] as const) {
        const input = field(name);
        if (!(await visible(input, UI_TIMEOUT_MS))) return false;
        await input.click();
        await input.fill("");
        await input.fill(address);
        if (TAXI_TEXT.addressNotFound.test(await bodyText())) return false;
        let picked = false;
        for (const role of TAXI_SUGGESTION_ROLES) {
          const option = page.getByRole(role).first();
          if (await visible(option, role === TAXI_SUGGESTION_ROLES[0] ? UI_TIMEOUT_MS : 1_000)) {
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
      const labels = TAXI_TARIFF_KEYS.map((k) => [k, TAXI_TARIFFS[k]]);
      // Карточка тарифа: элемент с точным названием и ближайший предок, где есть цена.
      const cards = await readTariffCards(page, labels);
      return cards
        .filter((c) => (TAXI_TARIFF_KEYS as string[]).includes(c.tariff))
        .map((c): TariffRow => ({ tariff: c.tariff as TaxiTariff, selected: c.selected === true, ...parseTariffCard(c.text) }));
    },
    async selectTariff(tariff) {
      await page.getByText(TAXI_TARIFFS[tariff], { exact: true }).first().click();
      await wait(700);
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
      const hit = TAXI_STATE_TEXT.find(([, re]) => re.test(text));
      const state = hit ? hit[0] : (await visible(orderLocator())) ? "none" : "unknown";
      const driver = state === "driver_assigned" || state === "driver_arrived" || state === "riding"
        ? { car: null, plate: text.match(TAXI_PLATE)?.[0]?.replace(/\s+/g, " ") ?? null, eta_min: parseEtaMinutes(text.match(TAXI_ETA_TEXT)?.[0]) }
        : null;
      return { state, driver };
    },
    async cancelOrder() {
      const button = page.getByRole("button", { name: TAXI_TEXT.cancel }).first();
      if (!(await visible(button, 3_000))) return "unavailable";
      await button.click();
      const confirm = page.getByRole("button", { name: TAXI_TEXT.cancelConfirm }).last();
      if (await visible(confirm, 3_000)) await confirm.click();
      return "clicked";
    },
    screenshot: () => jpegScreenshot(page, TAXI_SCREENSHOT_B64_MAX),
    probe: () => ariaProbe(page),
  };
}
