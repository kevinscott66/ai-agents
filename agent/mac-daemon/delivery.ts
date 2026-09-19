/**
 * Исполнитель Доставки (курьер Яндекс Go) на Mac владельца — шаг 10d.
 *
 * Устроен как mac-daemon/taxi.ts: сервер присылает только проверенные операции
 * (lib/delivery.ts), заказ — `prepare` (маршрут, тариф, комментарий, цена —
 * ничего не нажимается) и `confirm` (цена ещё раз, сверка с подписанным
 * потолком, одно нажатие). После нажатия отказов «до заказа» больше нет.
 *
 * Отличия от такси:
 *   - свой профиль Chrome (DELIVERY_PROFILE_DIR): Chrome запирает профиль, а
 *     совпадение с TAXI_PROFILE_DIR — отказ `profile_shared`;
 *   - телефон отправителя подставляет Яндекс Go, пустой телефон получателя
 *     заполняется им же; если страница требует ещё контакт — отказ
 *     `contact_required`;
 *   - способ оплаты агент не добавляет: кнопка «Заказать» без него
 *     неактивна — отказ `payment_needs_owner`;
 *   - комментарий курьеру вписывается только подписанный.
 *
 * Выключено, пока владелец не поставит DELIVERY_ENABLED=true. Вход — только
 * руками владельца: `bun mac-daemon/delivery.ts login`.
 *
 * CLI (для владельца, заказывать не умеет):
 *   bun mac-daemon/delivery.ts login
 *   bun mac-daemon/delivery.ts probe
 *   bun mac-daemon/delivery.ts quote "откуда" "куда"
 */
import { isAbsolute, resolve } from "node:path";
import {
  DELIVERY_SESSION_TTL_MS,
  normalizeDeliveryAddress,
  parseDeliveryRequest,
  type DeliveryFailCode,
  type DeliveryOption,
  type DeliveryOrderState,
  type DeliveryOutcome,
  type DeliveryRequest,
  type DeliveryTariff,
} from "../lib/delivery.ts";
import { DELIVERY_STATE_POLL } from "./delivery-selectors.ts";
import { ensureLoginProfileDir, printOutcome, profileDirProblem, runCli, runnerErrorCode, waitForEnter, settleOrRelease } from "./runner-kit.ts";

export interface DeliveryEnv {
  DELIVERY_ENABLED?: string;
  DELIVERY_PROFILE_DIR?: string;
  DELIVERY_HEADLESS?: string;
  DELIVERY_BROWSER_CHANNEL?: string;
  TAXI_PROFILE_DIR?: string;
  [key: string]: string | undefined;
}

export interface DeliveryTariffRow {
  tariff: DeliveryTariff;
  price_rub: number | null;
  eta_min: number | null;
  selected: boolean;
}

export type DeliveryGuard = "ok" | "captcha" | "login_required" | "unexpected_page";

/** Всё, что исполнитель делает со страницей. Тесты подставляют свою. */
export interface DeliveryPage {
  open(): Promise<void>;
  url(): string;
  guard(): Promise<DeliveryGuard>;
  setRoute(from: string, to: string): Promise<boolean>;
  tariffs(): Promise<DeliveryTariffRow[]>;
  selectTariff(tariff: DeliveryTariff): Promise<void>;
  /**
   * Пустой телефон получателя заполнить телефоном отправителя — это номер
   * аккаунта владельца, его подставляет сам Яндекс Go. Значение не читается
   * наружу: только из поля в поле.
   */
  fillRecipientFromSender?(): Promise<void>;
  /** Видно ли пустое обязательное поле контакта. */
  contactRequired(): Promise<boolean>;
  /** Вписать комментарий и прочитать обратно; false — поля нет или не вписалось. */
  setComment(comment: string): Promise<boolean>;
  /** blocked: «payment» — кнопка неактивна и просит способ оплаты, «disabled» — неактивна по другой причине. */
  orderButton(): Promise<{ label: string; price_rub: number | null; blocked?: "payment" | "disabled" | null } | null>;
  clickOrder(): Promise<void>;
  orderState(): Promise<{ state: DeliveryOrderState; eta_min: number | null }>;
  cancelOrder(): Promise<"clicked" | "unavailable">;
  screenshot(): Promise<string | null>;
  probe(): Promise<string>;
}

export interface DeliveryBrowser {
  page(): DeliveryPage;
  close(): Promise<void>;
}

export type DeliveryLauncher = (env: DeliveryEnv, profileDir: string) => Promise<DeliveryBrowser>;

export class DeliveryError extends Error {
  constructor(readonly code: DeliveryFailCode) {
    super(code);
  }
}

class PriceChanged extends DeliveryError {
  constructor(readonly priceRub: number) {
    super("price_changed");
  }
}

/**
 * Профиль доставки: те же требования, что у такси, и не тот же каталог —
 * два Chrome на одном профиле не живут, а вход в разные аккаунты смешается.
 */
export function checkDeliveryProfile(env: DeliveryEnv, uid: number | undefined = process.getuid?.()): string {
  const problem = profileDirProblem(env.DELIVERY_PROFILE_DIR, uid);
  if (problem) throw new DeliveryError(problem);
  const dir = env.DELIVERY_PROFILE_DIR!;
  const taxi = env.TAXI_PROFILE_DIR;
  if (taxi && isAbsolute(taxi) && resolve(taxi) === resolve(dir)) throw new DeliveryError("profile_shared");
  return dir;
}

const SCREENSHOT_CODES: readonly DeliveryFailCode[] = [
  "login_required", "captcha", "unexpected_page", "address_not_found", "tariff_unavailable",
  "contact_required", "comment_unavailable", "price_unreadable", "price_changed", "order_button_missing",
];

const ENDED: readonly DeliveryOrderState[] = ["none", "delivered", "cancelled"];

interface Session {
  id: string;
  tariff: DeliveryTariff;
  expires: number;
}

/**
 * Жёсткий срок одного запроса к исполнителю. Мост ждёт MAC_DELIVERY_TIMEOUT_MS (90 с) и
 * по таймауту шлёт отмену; срок нужен на случай, когда отмена не дошла
 * (сокет порвался). Больше мостового — чтобы сервер никогда не получил от демона
 * отказ раньше собственного таймаута.
 */
export const DELIVERY_RUN_DEADLINE_MS = 120_000;

export interface DeliveryRunnerOptions {
  launch?: DeliveryLauncher;
  checkProfile?: (env: DeliveryEnv) => string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  idleMs?: number;
  deadlineMs?: number;
  /** Только для тестов: сколько ждать, что зависший шаг закончится сам. */
  selfSettleMs?: number;
}

export class DeliveryRunner {
  private browser: DeliveryBrowser | null = null;
  private busy = false;
  private session: Session | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly launch: DeliveryLauncher;
  private readonly checkProfile: (env: DeliveryEnv) => string;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly idleMs: number;
  private readonly deadlineMs: number;
  private readonly selfSettleMs: number | undefined;
  /** Растёт на каждом close(): запуск, закончившийся после закрытия, — сирота. */
  private generation = 0;

  constructor(private readonly env: DeliveryEnv, opts: DeliveryRunnerOptions = {}) {
    this.launch = opts.launch ?? (async (e, dir) => (await import("./delivery-playwright.ts")).launchPlaywrightDelivery(e, dir));
    this.checkProfile = opts.checkProfile ?? ((e) => checkDeliveryProfile(e));
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.idleMs = opts.idleMs ?? 5 * 60_000;
    this.deadlineMs = opts.deadlineMs ?? DELIVERY_RUN_DEADLINE_MS;
    this.selfSettleMs = opts.selfSettleMs;
  }

  async run(request: DeliveryRequest, signal?: AbortSignal): Promise<DeliveryOutcome> {
    if (this.env.DELIVERY_ENABLED !== "true") return { ok: false, code: "delivery_disabled" };
    if (this.busy) return { ok: false, code: "delivery_busy" };
    this.busy = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    // Присваивается внутри work — без приведения TS сузил бы до null.
    let page = null as DeliveryPage | null;
    const work = (async () => {
      page = await this.page();
      return this.dispatch(page, request, signal);
    })();
    try {
      // Зависший шаг не держит замок вечно: см. settleOrRelease.
      return await settleOrRelease(work, { signal, deadlineMs: this.deadlineMs, selfSettleMs: this.selfSettleMs, release: () => this.close() });
    } catch (e) {
      if (!(e instanceof DeliveryError)) throw e;
      if (e.code === "session_unknown" || e.code === "delivery_busy") return { ok: false, code: e.code };
      const out: DeliveryOutcome = { ok: false, code: e.code, ...(e instanceof PriceChanged ? { price_rub: e.priceRub } : {}) };
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
    this.generation++;
    const browser = this.browser;
    this.browser = null;
    await browser?.close().catch(() => {});
  }

  private scheduleIdleClose() {
    if (!this.browser) return;
    this.idleTimer = setTimeout(() => { if (!this.busy) void this.close(); }, this.idleMs);
    this.idleTimer.unref?.();
  }

  private async page(): Promise<DeliveryPage> {
    if (!this.browser) {
      const dir = this.checkProfile(this.env);
      const generation = this.generation;
      let browser: DeliveryBrowser;
      try {
        browser = await this.launch(this.env, dir);
      } catch (e) {
        if (e instanceof DeliveryError) throw e;
        throw new DeliveryError("browser_unavailable");
      }
      // Запуск завис, исполнитель тем временем закрыли и отпустили замок —
      // поздний браузер никому не нужен, а профиль он держал бы.
      if (generation !== this.generation) {
        await browser.close().catch(() => {});
        throw new DeliveryError("browser_unavailable");
      }
      this.browser = browser;
    }
    return this.browser.page();
  }

  private activeSession(): Session | null {
    if (this.session && this.now() > this.session.expires) this.session = null;
    return this.session;
  }

  private async dispatch(page: DeliveryPage, request: DeliveryRequest, signal?: AbortSignal): Promise<DeliveryOutcome> {
    const checkAborted = () => { if (signal?.aborted) throw new Error("assistant_cancelled"); };
    checkAborted();
    switch (request.op) {
      case "quote": {
        if (this.activeSession()) throw new DeliveryError("delivery_busy");
        await this.openRoute(page, request.from, request.to);
        const options: DeliveryOption[] = (await page.tariffs())
          .filter((r) => r.price_rub !== null)
          .map((r) => ({ tariff: r.tariff, price_rub: r.price_rub!, eta_min: r.eta_min }));
        if (!options.length) throw new DeliveryError("price_unreadable");
        return { ok: true, op: "quote", options };
      }
      case "prepare": {
        const active = this.activeSession();
        if (active && active.id !== request.session) throw new DeliveryError("delivery_busy");
        this.session = null;
        await this.openRoute(page, request.from, request.to);
        checkAborted();
        let row = (await page.tariffs()).find((r) => r.tariff === request.tariff);
        if (!row) throw new DeliveryError("tariff_unavailable");
        if (!row.selected) {
          await page.selectTariff(request.tariff);
          row = (await page.tariffs()).find((r) => r.tariff === request.tariff);
          if (!row?.selected) throw new DeliveryError("tariff_unavailable");
        }
        await page.fillRecipientFromSender?.();
        if (await page.contactRequired()) throw new DeliveryError("contact_required");
        if (request.comment !== null && !(await page.setComment(request.comment))) throw new DeliveryError("comment_unavailable");
        await this.guard(page);
        const price = await this.currentPrice(page, request.tariff);
        this.session = { id: request.session, tariff: request.tariff, expires: this.now() + DELIVERY_SESSION_TTL_MS };
        return { ok: true, op: "prepare", tariff: request.tariff, price_rub: price, eta_min: row.eta_min };
      }
      case "confirm": {
        const session = this.activeSession();
        if (!session || session.id !== request.session) throw new DeliveryError("session_unknown");
        this.session = null;
        await this.guard(page);
        if (await page.contactRequired()) throw new DeliveryError("contact_required");
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
        const { state, eta_min } = await page.orderState();
        return { ok: true, op: "status", state, eta_min };
      }
      case "cancel": {
        if (this.activeSession()) throw new DeliveryError("delivery_busy");
        await page.open();
        await this.guard(page);
        const { state } = await page.orderState();
        if (ENDED.includes(state)) throw new DeliveryError("no_active_order");
        if ((await page.cancelOrder()) === "unavailable") throw new DeliveryError("cancel_unavailable");
        return { ok: true, op: "cancel", state: await this.pollState(page, (s) => s === "cancelled" || s === "none") };
      }
    }
  }

  private async guard(page: DeliveryPage) {
    const verdict = await page.guard();
    if (verdict !== "ok") throw new DeliveryError(verdict);
  }

  private async openRoute(page: DeliveryPage, from: string, to: string) {
    await page.open();
    await this.guard(page);
    if (!(await page.setRoute(from, to))) {
      await this.guard(page);
      throw new DeliveryError("address_not_found");
    }
    await this.guard(page);
  }

  /** Цена выбранного тарифа: карточка и кнопка; расходятся — берётся большая. */
  private async currentPrice(page: DeliveryPage, tariff: DeliveryTariff): Promise<number> {
    const row = (await page.tariffs()).find((r) => r.tariff === tariff);
    if (!row?.selected) throw new DeliveryError("tariff_unavailable");
    const button = await page.orderButton();
    if (!button) throw new DeliveryError("order_button_missing");
    if (button.blocked === "payment") throw new DeliveryError("payment_needs_owner");
    if (button.blocked) throw new DeliveryError("order_button_missing");
    const prices = [row.price_rub, button.price_rub].filter((p): p is number => p !== null);
    if (!prices.length) throw new DeliveryError("price_unreadable");
    return Math.max(...prices);
  }

  private async pollState(page: DeliveryPage, done: (s: DeliveryOrderState) => boolean): Promise<DeliveryOrderState> {
    let state: DeliveryOrderState = "unknown";
    for (let i = 0; i < DELIVERY_STATE_POLL.attempts; i++) {
      try {
        state = (await page.orderState()).state;
      } catch {
        state = "unknown";
      }
      if (done(state)) return state;
      await this.sleep(DELIVERY_STATE_POLL.intervalMs);
    }
    return state === "none" ? "unknown" : state;
  }
}

export function deliveryErrorCode(error: unknown): string {
  return runnerErrorCode(error, "invalid_delivery_request", "delivery_failed");
}

let runner: DeliveryRunner | null = null;

/** Точка входа демона: кадр `delivery` → JSON для сервера. */
export async function runDeliveryRequest(raw: unknown, signal?: AbortSignal): Promise<string> {
  const request = parseDeliveryRequest(raw);
  if (!request) throw new Error("invalid_delivery_request");
  runner ??= new DeliveryRunner(process.env);
  return JSON.stringify(await runner.run(request, signal));
}

export async function closeDeliveryRunner(): Promise<void> {
  await runner?.close();
}

async function cli(args: string[]) {
  const env: DeliveryEnv = process.env;
  const [command, ...rest] = args;
  if (command === "login" || command === "probe") {
    const dir = env.DELIVERY_PROFILE_DIR;
    ensureLoginProfileDir(command, dir);
    const profile = checkDeliveryProfile(env);
    const { launchPlaywrightDelivery } = await import("./delivery-playwright.ts");
    const browser = await launchPlaywrightDelivery(env, profile, { headless: false });
    const page = browser.page();
    await page.open();
    if (command === "login") {
      console.log("Войди в Яндекс Go в открывшемся окне сам. Когда закончишь — нажми Enter здесь.");
      await waitForEnter();
    } else {
      console.log(`guard: ${await page.guard()}`);
      console.log(`contact_required: ${await page.contactRequired()}`);
      console.log(await page.probe());
    }
    await browser.close();
    return;
  }
  if (command === "quote") {
    const [from, to] = rest.map(normalizeDeliveryAddress);
    if (!from || !to) throw new Error("usage: bun mac-daemon/delivery.ts quote \"откуда\" \"куда\"");
    const local = new DeliveryRunner({ ...env, DELIVERY_ENABLED: "true" }, { launch: async (e, d) => (await import("./delivery-playwright.ts")).launchPlaywrightDelivery(e, d, { headless: false }) });
    const out = await local.run({ op: "quote", from, to });
    await local.close();
    printOutcome(out);
    return;
  }
  throw new Error("usage: bun mac-daemon/delivery.ts login | probe | quote \"откуда\" \"куда\"");
}

if (import.meta.main) {
  runCli(() => cli(process.argv.slice(2)), (e) => (e instanceof DeliveryError ? e.code : null));
}
