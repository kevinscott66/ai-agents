/**
 * TaxiPage поверх Playwright: настоящий Chrome владельца с отдельным профилем.
 *
 * playwright-core лежит только в mac-daemon/node_modules — на сервере его нет,
 * поэтому модуль грузится динамически по имени из переменной и без импорта
 * типов. Никаких «стелс»-приёмов: обычный Chrome, обычный профиль; капча — это
 * остановка и скриншот, а не повод прятаться.
 */
import { TAXI_SCREENSHOT_B64_MAX, TAXI_TARIFF_KEYS, type TaxiTariff } from "../lib/taxi.ts";
import {
  TAXI_CAPTCHA_FRAME,
  TAXI_CAPTCHA_TEXT,
  TAXI_CAPTCHA_URL,
  TAXI_ETA_TEXT,
  TAXI_LOGIN_HOSTS,
  TAXI_ORDER_HOSTS,
  TAXI_PAGE_TARIFFS,
  TAXI_PLATE,
  TAXI_PRICE_FROM,
  TAXI_PRICE_POLL,
  TAXI_START_URL,
  TAXI_STATE_TEXT,
  TAXI_TEXT,
} from "./taxi-selectors.ts";
import { parseTariffCard, type TaxiBrowser, type TaxiEnv, type TaxiPage, type TariffRow } from "./taxi.ts";
import { parseEtaMinutes } from "../lib/taxi.ts";
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

export async function launchPlaywrightTaxi(env: TaxiEnv, profileDir: string, opts: { headless?: boolean } = {}): Promise<TaxiBrowser> {
  const { context, page: raw } = await launchProfileChrome(profileDir, {
    channel: env.TAXI_BROWSER_CHANNEL || "chrome",
    headless: opts.headless ?? env.TAXI_HEADLESS === "true",
    viewport: { width: 1024, height: 720 },
  });
  const page = playwrightTaxiPage(raw);
  const fronted = { ...page, front: () => raw.bringToFront() };
  return { page: () => fronted, close: () => context.close() };
}

export function playwrightTaxiPage(page: any): TaxiPage {
  const bodyText = () => pageBodyText(page);
  const field = (name: RegExp) =>
    page.getByRole("textbox", { name }).or(page.getByPlaceholder(name)).first();
  const orderLocator = () => page.getByRole("button", { name: TAXI_TEXT.order }).first();
  const radios = () => page.getByRole("radiogroup", { name: TAXI_TEXT.tariffGroup }).first().getByRole("radio");
  // «Élite» может прийти и составным символом, и буквой с отдельным акцентом.
  const lines = (text: string) => text.normalize("NFC").split("\n").map((l) => l.trim());
  const cardTariff = (text: string) => TAXI_TARIFF_KEYS.find((k) => lines(text).includes(TAXI_PAGE_TARIFFS[k].normalize("NFC"))) ?? null;
  /** Radio тарифа — по тому же разбору строк, что и расчёт: что посчитали, то и нажимаем. */
  const tariffRadio = async (tariff: TaxiTariff) => {
    for (const radio of await radios().all()) {
      if (cardTariff(String(await radio.innerText().catch(() => ""))) === tariff) return radio;
    }
    return null;
  };
  /** Карточка тарифа: radio, в тексте которого есть строка с точным названием. */
  type Card = { tariff: TaxiTariff | null; text: string; selected: boolean };
  const readCards = async (): Promise<Card[]> => {
    const out: Card[] = [];
    for (const radio of await radios().all()) {
      const text = String(await radio.innerText().catch(() => ""));
      const tariff = cardTariff(text);
      const selected = (await radio.getAttribute("aria-checked").catch(() => null)) === "true";
      out.push({ tariff, text: text.replace(/\s+/g, " ").slice(0, 200), selected });
    }
    return out;
  };

  return {
    async open() {
      // Фоновое окно Chrome тормозит таймеры, и цена так и остаётся «от …».
      await page.bringToFront().catch(() => {});
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
        if (!(await fillAddress(page, input, address))) return false;
        if (TAXI_TEXT.addressNotFound.test(await bodyText())) return false;
      }
      // Пока маршрут считается, карточки показывают «Цена от …».
      await waitFor(async () => (await readCards()).some((c) => /₽/.test(c.text) && !TAXI_PRICE_FROM.test(c.text)),
        TAXI_PRICE_POLL.attempts, TAXI_PRICE_POLL.intervalMs);
      return true;
    },
    async tariffs() {
      return (await readCards())
        .filter((c) => c.tariff !== null)
        .map((c): TariffRow => {
          const parsed = parseTariffCard(c.text);
          return { tariff: c.tariff!, selected: c.selected, eta_min: parsed.eta_min, price_rub: TAXI_PRICE_FROM.test(c.text) ? null : parsed.price_rub };
        });
    },
    async selectTariff(tariff) {
      // Нет radio — выбор не меняется, и runner увидит это при сверке selected.
      await (await tariffRadio(tariff))?.click();
      await wait(700);
    },
    async orderButton() {
      const button = orderLocator();
      if (!(await visible(button, UI_TIMEOUT_MS))) return null;
      const label = String(await button.innerText()).replace(/\s+/g, " ").trim().slice(0, 80);
      return { label, ...parseTariffCard(label) };
    },
    async choiceRequired() {
      return await visible(page.getByRole("button", { name: TAXI_TEXT.choice }).first(), 2_000);
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
