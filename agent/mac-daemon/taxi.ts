/**
 * Исполнитель такси на Mac владельца: браузер с отдельным профилем Яндекс Go.
 *
 * Сервер присылает только проверенные операции (lib/taxi.ts). Заказ — две
 * операции: `prepare` (маршрут, тариф, цена — ничего не нажимается) и
 * `confirm` (цена ещё раз, сверка с подписанным потолком, одно нажатие
 * «Заказать»). Сессия prepare одноразовая и живёт TAXI_SESSION_TTL_MS.
 * После нажатия исполнитель больше не отвечает отказом «до заказа»: любая
 * ошибка превращается в состояние `unknown`, чтобы сервер не решил, что
 * деньги не ушли, и не повторил заказ.
 *
 * Выключено, пока владелец не поставит TAXI_ENABLED=true. Вход в Яндекс —
 * только руками владельца: `bun mac-daemon/taxi.ts login`.
 *
 * CLI (для владельца, заказывать не умеет):
 *   bun mac-daemon/taxi.ts login               — открыть окно и войти вручную
 *   bun mac-daemon/taxi.ts probe               — дерево доступности страницы
 *   bun mac-daemon/taxi.ts quote "откуда" "куда"
 */
import {
  TAXI_SESSION_TTL_MS,
  normalizeTaxiAddress,
  parseEtaMinutes,
  parseRubles,
  parseTaxiRequest,
  type TaxiDriver,
  type TaxiFailCode,
  type TaxiOption,
  type TaxiOrderState,
  type TaxiOutcome,
  type TaxiRequest,
  type TaxiTariff,
} from "../lib/taxi.ts";
import { TAXI_ETA_TEXT, TAXI_PRICE_TEXT, TAXI_STATE_POLL } from "./taxi-selectors.ts";
import { ensureLoginProfileDir, printOutcome, profileDirProblem, runCli, runnerErrorCode, waitForEnter } from "./runner-kit.ts";

export interface TaxiEnv {
  TAXI_ENABLED?: string;
  TAXI_PROFILE_DIR?: string;
  TAXI_HEADLESS?: string;
  TAXI_BROWSER_CHANNEL?: string;
  [key: string]: string | undefined;
}

export interface TariffRow {
  tariff: TaxiTariff;
  price_rub: number | null;
  eta_min: number | null;
  selected: boolean;
}

export type TaxiGuard = "ok" | "captcha" | "login_required" | "unexpected_page";

/** Всё, что исполнитель делает со страницей. Тесты подставляют свою. */
export interface TaxiPage {
  open(): Promise<void>;
  url(): string;
  guard(): Promise<TaxiGuard>;
  setRoute(from: string, to: string): Promise<boolean>;
  tariffs(): Promise<TariffRow[]>;
  selectTariff(tariff: TaxiTariff): Promise<void>;
  orderButton(): Promise<{ label: string; price_rub: number | null } | null>;
  clickOrder(): Promise<void>;
  orderState(): Promise<{ state: TaxiOrderState; driver: TaxiDriver | null }>;
  cancelOrder(): Promise<"clicked" | "unavailable">;
  screenshot(): Promise<string | null>;
  probe(): Promise<string>;
}

export interface TaxiBrowser {
  page(): TaxiPage;
  close(): Promise<void>;
}

export type TaxiLauncher = (env: TaxiEnv, profileDir: string) => Promise<TaxiBrowser>;

/** Отказ с известным кодом; наружу уходит только код. */
export class TaxiError extends Error {
  constructor(readonly code: TaxiFailCode) {
    super(code);
  }
}

/** Текст карточки тарифа или кнопки → цена и время подачи. */
export function parseTariffCard(text: string): { price_rub: number | null; eta_min: number | null } {
  const price = text.match(TAXI_PRICE_TEXT)?.[0];
  const eta = text.match(TAXI_ETA_TEXT)?.[0];
  return { price_rub: price ? parseRubles(price) : null, eta_min: eta ? parseEtaMinutes(eta) : null };
}

/**
 * Профиль с cookie Яндекса — это доступ к привязанной карте. Только
 * абсолютный путь, каталог текущего пользователя и никаких прав для группы
 * и остальных.
 */
export function checkTaxiProfile(dir: string | undefined, uid: number | undefined = process.getuid?.()): string {
  const problem = profileDirProblem(dir, uid);
  if (problem) throw new TaxiError(problem);
  return dir!;
}

/** Отказы, к которым полезен скриншот: владелец видит, на чём встали. */
const SCREENSHOT_CODES: readonly TaxiFailCode[] = [
  "login_required", "captcha", "unexpected_page", "address_not_found", "tariff_unavailable",
  "price_unreadable", "price_changed", "order_button_missing",
];

const ENDED: readonly TaxiOrderState[] = ["none", "finished", "cancelled"];

interface Session {
  id: string;
  tariff: TaxiTariff;
  priceRub: number;
  expires: number;
}

export interface TaxiRunnerOptions {
  launch?: TaxiLauncher;
  checkProfile?: (dir: string | undefined) => string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  idleMs?: number;
}

export class TaxiRunner {
  private browser: TaxiBrowser | null = null;
  private busy = false;
  private session: Session | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly launch: TaxiLauncher;
  private readonly checkProfile: (dir: string | undefined) => string;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly idleMs: number;

  constructor(private readonly env: TaxiEnv, opts: TaxiRunnerOptions = {}) {
    this.launch = opts.launch ?? (async (e, dir) => (await import("./taxi-playwright.ts")).launchPlaywrightTaxi(e, dir));
    this.checkProfile = opts.checkProfile ?? ((dir) => checkTaxiProfile(dir));
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.idleMs = opts.idleMs ?? 5 * 60_000;
  }

  async run(request: TaxiRequest, signal?: AbortSignal): Promise<TaxiOutcome> {
    if (this.env.TAXI_ENABLED !== "true") return { ok: false, code: "taxi_disabled" };
    if (this.busy) return { ok: false, code: "taxi_busy" };
    this.busy = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    let page: TaxiPage | null = null;
    try {
      page = await this.page();
      return await this.dispatch(page, request, signal);
    } catch (e) {
      if (!(e instanceof TaxiError)) throw e;
      if (e.code === "session_unknown" || e.code === "taxi_busy") return { ok: false, code: e.code };
      const out: TaxiOutcome = { ok: false, code: e.code, ...(e instanceof PriceChanged ? { price_rub: e.priceRub } : {}) };
      if (page && SCREENSHOT_CODES.includes(e.code)) {
        const shot = await page.screenshot().catch(() => null);
        if (shot) out.screenshot = shot;
      }
      return out;
    } finally {
      this.busy = false;
      this.scheduleIdleClose();
    }
  }

  async close(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.session = null;
    const browser = this.browser;
    this.browser = null;
    await browser?.close().catch(() => {});
  }

  private scheduleIdleClose() {
    if (!this.browser) return;
    this.idleTimer = setTimeout(() => { if (!this.busy) void this.close(); }, this.idleMs);
    this.idleTimer.unref?.();
  }

  private async page(): Promise<TaxiPage> {
    if (!this.browser) {
      const dir = this.checkProfile(this.env.TAXI_PROFILE_DIR);
      try {
        this.browser = await this.launch(this.env, dir);
      } catch (e) {
        if (e instanceof TaxiError) throw e;
        throw new TaxiError("browser_unavailable");
      }
    }
    return this.browser.page();
  }

  private activeSession(): Session | null {
    if (this.session && this.now() > this.session.expires) this.session = null;
    return this.session;
  }

  private async dispatch(page: TaxiPage, request: TaxiRequest, signal?: AbortSignal): Promise<TaxiOutcome> {
    const checkAborted = () => { if (signal?.aborted) throw new Error("assistant_cancelled"); };
    checkAborted();
    switch (request.op) {
      case "quote": {
        if (this.activeSession()) throw new TaxiError("taxi_busy");
        await this.openRoute(page, request.from, request.to);
        const options: TaxiOption[] = (await page.tariffs())
          .filter((r) => r.price_rub !== null)
          .map((r) => ({ tariff: r.tariff, price_rub: r.price_rub!, eta_min: r.eta_min }));
        if (!options.length) throw new TaxiError("price_unreadable");
        return { ok: true, op: "quote", options };
      }
      case "prepare": {
        const active = this.activeSession();
        if (active && active.id !== request.session) throw new TaxiError("taxi_busy");
        this.session = null;
        await this.openRoute(page, request.from, request.to);
        checkAborted();
        let row = (await page.tariffs()).find((r) => r.tariff === request.tariff);
        if (!row) throw new TaxiError("tariff_unavailable");
        if (!row.selected) {
          await page.selectTariff(request.tariff);
          row = (await page.tariffs()).find((r) => r.tariff === request.tariff);
          if (!row?.selected) throw new TaxiError("tariff_unavailable");
        }
        const price = await this.currentPrice(page, request.tariff);
        this.session = { id: request.session, tariff: request.tariff, priceRub: price, expires: this.now() + TAXI_SESSION_TTL_MS };
        return { ok: true, op: "prepare", tariff: request.tariff, price_rub: price, eta_min: row.eta_min };
      }
      case "confirm": {
        const session = this.activeSession();
        if (!session || session.id !== request.session) throw new TaxiError("session_unknown");
        // Одноразовая: и успех, и любой отказ её гасят.
        this.session = null;
        await this.guard(page);
        const price = await this.currentPrice(page, session.tariff);
        if (price > request.maxRub) throw new PriceChanged(price);
        checkAborted();
        await page.clickOrder();
        // С этого места деньги могли уйти: отказов «до заказа» больше нет.
        return { ok: true, op: "confirm", state: await this.pollState(page, (s) => s !== "none" && s !== "unknown") };
      }
      case "abandon": {
        if (this.activeSession()?.id === request.session) this.session = null;
        return { ok: true, op: "abandon" };
      }
      case "status": {
        await page.open();
        await this.guard(page);
        const { state, driver } = await page.orderState();
        return { ok: true, op: "status", state, driver };
      }
      case "cancel": {
        if (this.activeSession()) throw new TaxiError("taxi_busy");
        await page.open();
        await this.guard(page);
        const { state } = await page.orderState();
        if (ENDED.includes(state)) throw new TaxiError("no_active_order");
        if ((await page.cancelOrder()) === "unavailable") throw new TaxiError("cancel_unavailable");
        return { ok: true, op: "cancel", state: await this.pollState(page, (s) => s === "cancelled" || s === "none") };
      }
    }
  }

  private async guard(page: TaxiPage) {
    const verdict = await page.guard();
    if (verdict !== "ok") throw new TaxiError(verdict);
  }

  private async openRoute(page: TaxiPage, from: string, to: string) {
    await page.open();
    await this.guard(page);
    if (!(await page.setRoute(from, to))) {
      // Адрес не нашёлся — или вместо подсказок выскочила капча.
      await this.guard(page);
      throw new TaxiError("address_not_found");
    }
    await this.guard(page);
  }

  /**
   * Цена выбранного тарифа: карточка и кнопка «Заказать». Если обе читаются и
   * расходятся — берётся большая: сверка с потолком должна быть строже.
   */
  private async currentPrice(page: TaxiPage, tariff: TaxiTariff): Promise<number> {
    const row = (await page.tariffs()).find((r) => r.tariff === tariff);
    if (!row?.selected) throw new TaxiError("tariff_unavailable");
    const button = await page.orderButton();
    if (!button) throw new TaxiError("order_button_missing");
    const prices = [row.price_rub, button.price_rub].filter((p): p is number => p !== null);
    if (!prices.length) throw new TaxiError("price_unreadable");
    return Math.max(...prices);
  }

  private async pollState(page: TaxiPage, done: (s: TaxiOrderState) => boolean): Promise<TaxiOrderState> {
    let state: TaxiOrderState = "unknown";
    for (let i = 0; i < TAXI_STATE_POLL.attempts; i++) {
      try {
        state = (await page.orderState()).state;
      } catch {
        state = "unknown";
      }
      if (done(state)) return state;
      await this.sleep(TAXI_STATE_POLL.intervalMs);
    }
    return state === "none" ? "unknown" : state;
  }
}

class PriceChanged extends TaxiError {
  constructor(readonly priceRub: number) {
    super("price_changed");
  }
}

export function taxiErrorCode(error: unknown): string {
  return runnerErrorCode(error, "invalid_taxi_request", "taxi_failed");
}

let runner: TaxiRunner | null = null;

/** Точка входа демона: кадр `taxi` → JSON для сервера. */
export async function runTaxiRequest(raw: unknown, signal?: AbortSignal): Promise<string> {
  const request = parseTaxiRequest(raw);
  if (!request) throw new Error("invalid_taxi_request");
  runner ??= new TaxiRunner(process.env);
  return JSON.stringify(await runner.run(request, signal));
}

export async function closeTaxiRunner(): Promise<void> {
  await runner?.close();
}

async function cli(args: string[]) {
  const env: TaxiEnv = process.env;
  const [command, ...rest] = args;
  if (command === "login" || command === "probe") {
    const dir = env.TAXI_PROFILE_DIR;
    ensureLoginProfileDir(command, dir);
    const profile = checkTaxiProfile(dir);
    const { launchPlaywrightTaxi } = await import("./taxi-playwright.ts");
    const browser = await launchPlaywrightTaxi(env, profile, { headless: false });
    const page = browser.page();
    await page.open();
    if (command === "login") {
      console.log("Войди в Яндекс Go в открывшемся окне сам. Когда закончишь — нажми Enter здесь.");
      await waitForEnter();
    } else {
      console.log(`guard: ${await page.guard()}`);
      console.log(await page.probe());
    }
    await browser.close();
    return;
  }
  if (command === "quote") {
    const [from, to] = rest.map(normalizeTaxiAddress);
    if (!from || !to) throw new Error("usage: bun mac-daemon/taxi.ts quote \"откуда\" \"куда\"");
    const local = new TaxiRunner({ ...env, TAXI_ENABLED: "true" }, { launch: async (e, d) => (await import("./taxi-playwright.ts")).launchPlaywrightTaxi(e, d, { headless: false }) });
    const out = await local.run({ op: "quote", from, to });
    await local.close();
    printOutcome(out);
    return;
  }
  throw new Error("usage: bun mac-daemon/taxi.ts login | probe | quote \"откуда\" \"куда\"");
}

if (import.meta.main) {
  runCli(() => cli(process.argv.slice(2)), (e) => (e instanceof TaxiError ? e.code : null));
}
