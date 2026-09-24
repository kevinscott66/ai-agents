/**
 * Исполнитель покупок на Mac владельца: браузер с отдельным профилем Яндекса
 * (Лавка, Еда и Маркет — один профиль, один вход).
 *
 * Сервер присылает только проверенные операции (lib/shop.ts). Заказ — две
 * операции: `prepare` (подписанные позиции кладутся в пустую корзину, итог
 * читается со страницы оформления — ничего не оплачивается) и `confirm`
 * (корзина и итог ещё раз, сверка с подписанным потолком, одно нажатие
 * «Оплатить»). Сессия prepare одноразовая и живёт SHOP_SESSION_TTL_MS.
 *
 * В Еде заказ собирается в одном ресторане: сервер присылает его ref, у блюд
 * нет своих страниц, и блюдо находится в меню ресторана по точному названию.
 * Опции блюда (размер, соус, состав) отмечаются ровно по подписи; в корзине
 * вариант блюда узнаётся по названию и опциям (edaVariantId).
 *
 * В Маркете товар — номер карточки `/card/<slug>/<номер>`: заказывается ровно
 * подписанная карточка, сниппеты без неё в расчёт не попадают. Доставка Маркета видна только на
 * оформлении, поэтому расчёт возвращает её как null, а потолок итога
 * подписывается с доставкой, которую владелец готов заплатить.
 *
 * Корзина владельца не трогается: если в ней что-то лежит — отказ. Всё, что
 * исполнитель положил сам, он сам и убирает при любом отказе до оплаты. После
 * нажатия «Оплатить» отказов «до заказа» нет: любая ошибка — состояние
 * `unknown`, чтобы сервер не решил, что деньги не ушли, и не повторил заказ.
 *
 * Выключено, пока владелец не поставит SHOP_ENABLED=true. Вход в Яндекс, адрес
 * доставки и карта — только руками владельца: `bun mac-daemon/shop.ts login`.
 *
 * CLI (для владельца, заказывать не умеет):
 *   bun mac-daemon/shop.ts login [eda|market]  — открыть окно, войти и выбрать адрес вручную
 *   bun mac-daemon/shop.ts probe [eda|market]  — дерево доступности страницы
 *   bun mac-daemon/shop.ts quote "молоко" "хлеб"
 *   bun mac-daemon/shop.ts eda-quote "ресторан" "блюдо" …
 *   bun mac-daemon/shop.ts eda-places "шаверма" [45]  — рестораны и время доставки
 *   bun mac-daemon/shop.ts market-quote "зарядка usb-c" …
 *   bun mac-daemon/shop.ts selfcheck [eda|market]  — селекторы на публичном поиске, JSON без текста страницы
 */
import {
  MARKET_PRODUCT_ID,
  SHOP_CANDIDATES_MAX,
  SHOP_PLACED_STATES,
  SHOP_PLACE_REF,
  SHOP_QUOTE_CHOICES_MAX,
  SHOP_SESSION_TTL_MS,
  edaDishId,
  edaVariantId,
  matchSavedAddress,
  normalizeShopName,
  normalizeShopPlaceName,
  normalizeShopQuery,
  parseShopRequest,
  isShopMaxEta,
  pickShopPlace,
  rankShopPlaces,
  shopAddressHas,
  shopNeedsPlace,
  type ShopCandidate,
  type ShopQuoteResult,
  type ShopFailCode,
  type ShopLine,
  type ShopOptionGroup,
  type ShopOptionPick,
  type ShopOrderState,
  type ShopOutcome,
  type ShopPlace,
  type ShopPreparedLine,
  type ShopRequest,
  type ShopService,
} from "../lib/shop.ts";
import { CAPTCHA_HOLD_MS, ensureLoginProfileDir, printOutcome, profileDirProblem, runCli, runnerErrorCode, waitForEnter, settleOrRelease } from "./runner-kit.ts";
import { SHOP_STATE_POLL } from "./shop-selectors.ts";

export interface ShopEnv {
  SHOP_ENABLED?: string;
  SHOP_PROFILE_DIR?: string;
  SHOP_HEADLESS?: string;
  SHOP_BROWSER_CHANNEL?: string;
  /** Как подписывать заказ, если страница спрашивает. Значения живут в пускаче, не в репозитории. */
  SHOP_CONTACT_NAME?: string;
  SHOP_CONTACT_EMAIL?: string;
  [key: string]: string | undefined;
}

export type ShopGuard = "ok" | "captcha" | "login_required" | "unexpected_page";

export interface SearchCard {
  id: string;
  name: string;
  price_rub: number | null;
  available: boolean;
  /** Еда: группы опций блюда; price_rub — без доплат. */
  options?: ShopOptionGroup[];
}

export interface ProductInfo {
  name: string | null;
  price_rub: number | null;
  available: boolean;
}

export interface CartRow {
  id: string;
  qty: number;
  price_rub: number | null;
}

export interface CheckoutInfo {
  total_rub: number | null;
  blocked: boolean;
  saved_card: boolean;
  pay_button: boolean;
}

/** Где работаем: сервис и, для Еды, ref ресторана. */
export interface ShopTarget {
  service: ShopService;
  place?: string;
}

/** Позиция, которую открывают: id и точное название (в Еде ищется по нему). */
export interface ShopItemRef {
  id: string;
  name: string;
}

/** Итог нажатия «в корзину»: блюдо просит выбрать опции или страница спросила что-то своё. */
export type QtyResult = "ok" | "options_required" | "options_mismatch" | "blocked";

/** Всё, что исполнитель делает со страницей. Тесты подставляют свою. */
export interface ShopPage {
  /** Лавка — главная; Еда без place — главная, с place — страница ресторана. */
  openHome(target: ShopTarget): Promise<void>;
  /**
   * Еда: рестораны из поиска по запросу (null — с главной) с временем
   * доставки с карточки. Без навигации в них.
   */
  places(query: string | null): Promise<ShopPlace[]>;
  openSearch(target: ShopTarget, query: string): Promise<void>;
  openProduct(target: ShopTarget, item: ShopItemRef): Promise<void>;
  openCart(target: ShopTarget): Promise<void>;
  openOrders(service: ShopService): Promise<void>;
  guard(): Promise<ShopGuard>;
  /** Адрес доставки из шапки; null — не выбран. */
  address(): Promise<string | null>;
  deliveryFee(): Promise<number | null>;
  searchCards(): Promise<SearchCard[]>;
  product(): Promise<ProductInfo>;
  /** На странице товара: довести количество в корзине до qty (0 — убрать). */
  setProductQty(qty: number): Promise<QtyResult>;
  /** Еда: окно блюда, отметить ровно picks, qty штук, «Добавить». */
  addWithOptions?(qty: number, picks: ShopOptionPick[]): Promise<QtyResult>;
  /** Еда: убрать из корзины строки этих вариантов. */
  removeCartRows?(ids: string[]): Promise<void>;
  /** Лавка и Еда: подписи сохранённых адресов из окна выбора (окно остаётся открытым). */
  savedAddresses?(): Promise<string[]>;
  /** Выбрать сохранённый адрес по номеру из savedAddresses. */
  chooseAddress?(index: number): Promise<void>;
  /** Закрыть окно выбора адреса, ничего не меняя. */
  closeAddresses?(): Promise<void>;
  cart(): Promise<CartRow[]>;
  /** Открыть оформление из корзины; false — кнопки нет. */
  openCheckout(): Promise<boolean>;
  /**
   * На оформлении: подписать заказ, если поле пустое. Заполненное не трогаем —
   * своё владелец вводил руками. Значения приходят из окружения и никуда не пишутся.
   */
  fillContacts?(contacts: { name?: string; email?: string }): Promise<void>;
  checkout(): Promise<CheckoutInfo>;
  clickPay(): Promise<void>;
  /** Состояние заказа и, если страница его пишет, сколько ждать в минутах. */
  orderState(): Promise<{ state: ShopOrderState; eta_min: number | null }>;
  screenshot(): Promise<string | null>;
  probe(): Promise<string>;
  /** Вывести окно наверх: на капче его ждёт владелец. */
  front?(): Promise<void>;
}

export interface ShopBrowser {
  page(): ShopPage;
  close(): Promise<void>;
}

export type ShopLauncher = (env: ShopEnv, profileDir: string) => Promise<ShopBrowser>;

/** Отказ с известным кодом; наружу уходит только код. */
export class ShopError extends Error {
  /** Снимок до уборки корзины: владелец видит страницу, на которой встали. */
  screenshot?: string | null;
  constructor(readonly code: ShopFailCode) {
    super(code);
  }
}

class PriceChanged extends ShopError {
  constructor(readonly priceRub: number) {
    super("price_changed");
  }
}

/**
 * Профиль с cookie Яндекса — это доступ к привязанной карте. Только
 * абсолютный путь, каталог текущего пользователя и никаких прав для группы
 * и остальных.
 */
export function checkShopProfile(dir: string | undefined, uid: number | undefined = process.getuid?.()): string {
  const problem = profileDirProblem(dir, uid);
  if (problem) throw new ShopError(problem);
  return dir!;
}

/** Отказы, к которым полезен скриншот: владелец видит, на чём встали. */
const SCREENSHOT_CODES: readonly ShopFailCode[] = [
  "login_required", "address_required", "captcha", "unexpected_page", "search_incomplete", "place_not_found", "place_too_slow", "product_not_found", "product_mismatch",
  "out_of_stock", "options_required", "options_mismatch", "cart_not_empty", "cart_mismatch", "price_unreadable", "price_changed", "checkout_unavailable",
  "payment_needs_owner", "pay_button_missing",
];

interface Session {
  id: string;
  target: ShopTarget;
  items: ShopLine[];
  lines: ShopPreparedLine[];
  expires: number;
}

/**
 * Жёсткий срок одного запроса к исполнителю. Мост ждёт MAC_SHOP_TIMEOUT_MS (180 с) и
 * по таймауту шлёт отмену; срок нужен на случай, когда отмена не дошла
 * (сокет порвался). Больше мостового — чтобы сервер никогда не получил от демона
 * отказ раньше собственного таймаута.
 */
export const SHOP_RUN_DEADLINE_MS = 210_000;

export interface ShopRunnerOptions {
  launch?: ShopLauncher;
  checkProfile?: (dir: string | undefined) => string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  idleMs?: number;
  /** Сколько окно с капчей ждёт владельца, прежде чем закрыться по простою. */
  captchaHoldMs?: number;
  deadlineMs?: number;
  /** Только для тестов: сколько ждать, что зависший шаг закончится сам. */
  selfSettleMs?: number;
}

/** Что исполнитель положил в корзину и не смог убрать: капча не пустила. */
interface Stranded {
  target: ShopTarget;
  lines: ShopLine[];
}

export class ShopRunner {
  private browser: ShopBrowser | null = null;
  private busy = false;
  private closing: Promise<void> | null = null;
  /** Что держит замок и с какого момента — для ответа shop_busy и для reset. */
  private current: { op: ShopRequest["op"]; since: number } | null = null;
  private session: Session | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly launch: ShopLauncher;
  private readonly checkProfile: (dir: string | undefined) => string;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly idleMs: number;
  private readonly captchaHoldMs: number;
  /** Последний запуск встал на капче: окно держим открытым дольше обычного. */
  private captchaHold = false;
  /** Свои позиции, оставшиеся в корзине после капчи; убираются первым делом в следующем prepare. */
  private stranded: Stranded | null = null;
  private readonly deadlineMs: number;
  private readonly selfSettleMs: number | undefined;
  /** Растёт на каждом close(): запуск, закончившийся после закрытия, — сирота. */
  private generation = 0;

  constructor(private readonly env: ShopEnv, opts: ShopRunnerOptions = {}) {
    this.launch = opts.launch ?? (async (e, d) => (await import("./shop-playwright.ts")).launchPlaywrightShop(e, d));
    this.checkProfile = opts.checkProfile ?? ((d) => checkShopProfile(d));
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.idleMs = opts.idleMs ?? 5 * 60_000;
    this.captchaHoldMs = opts.captchaHoldMs ?? CAPTCHA_HOLD_MS;
    this.deadlineMs = opts.deadlineMs ?? SHOP_RUN_DEADLINE_MS;
    this.selfSettleMs = opts.selfSettleMs;
  }

  async run(request: ShopRequest, signal?: AbortSignal): Promise<ShopOutcome> {
    if (this.env.SHOP_ENABLED !== "true") return { ok: false, code: "shop_disabled" };
    if (request.op === "reset") return this.reset();
    if (this.busy) {
      const held = this.current;
      return { ok: false, code: "shop_busy", ...(held ? { busy_op: held.op, busy_ms: Math.max(0, this.now() - held.since) } : {}) };
    }
    this.busy = true;
    this.current = { op: request.op, since: this.now() };
    this.captchaHold = false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    // Присваивается внутри work — без приведения TS сузил бы до null.
    let page = null as ShopPage | null;
    const work = (async () => {
      page = await this.page();
      return this.dispatch(page, request, signal);
    })();
    try {
      // Зависший шаг не держит замок вечно: см. settleOrRelease.
      return await settleOrRelease(work, { signal, deadlineMs: this.deadlineMs, selfSettleMs: this.selfSettleMs, release: () => this.close(), ...(["quote", "places", "status"].includes(request.op) ? { releaseTimeoutMs: 5000 } : {}) });
    } catch (e) {
      if (!(e instanceof ShopError)) throw e;
      if (e.code === "session_unknown" || e.code === "shop_busy") return { ok: false, code: e.code };
      const out: ShopOutcome = { ok: false, code: e.code, ...(e instanceof PriceChanged ? { price_rub: e.priceRub } : {}) };
      if (page && SCREENSHOT_CODES.includes(e.code)) {
        const shot = e.screenshot !== undefined ? e.screenshot : await boundedShopDiagnostic(() => page!.screenshot(), null);
        if (shot) out.screenshot = shot;
      }
      if (page && e.code === "captcha") {
        // Капчу проходит владелец в этом же окне: оно остаётся на капче, наверху
        // и открытым CAPTCHA_HOLD_MS. Сам исполнитель капчу не трогает.
        this.captchaHold = true;
        await boundedShopDiagnostic(() => page!.front?.() ?? Promise.resolve(), undefined);
      }
      return out;
    } finally {
      this.busy = false;
      this.current = null;
      this.scheduleIdleClose();
    }
  }

  /**
   * Брошенный запуск держит замок до своего дедлайна (до ~4 минут), и всё это
   * время любой запрос получает shop_busy. Сервер шлёт запросы по одному, так что
   * занятость, которую он видит, — чужой хвост: браузер закрывается, запуск падает
   * на закрытой странице и отпускает замок. Оформление с «Оплатить» не рвётся —
   * деньги могли уже уйти, и его итог нужен.
   */
  private async reset(): Promise<ShopOutcome> {
    const held = this.current;
    if (!this.busy || !held) return { ok: true, op: "reset", reset: false };
    if (held.op === "confirm") return { ok: false, code: "shop_paying", busy_op: held.op, busy_ms: Math.max(0, this.now() - held.since) };
    const closed = await boundedShopDiagnostic(async () => { await this.close(); return this.closing === null; }, false, 5000);
    return closed ? { ok: true, op: "reset", reset: true } : { ok: false, code: "browser_unavailable" };
  }

  /**
   * Замок на время починки селекторов: починщик открывает тот же профиль своим
   * Chrome, и два браузера на одном профиле не живут. Браузер исполнителя
   * закрывается, покупки до release получают shop_busy (без busy_op — это не
   * операция покупки, и reset её не рвёт). Подготовленный заказ ждёт подписи —
   * его не теряем: отказ.
   */
  async hold(): Promise<(() => void) | null> {
    if (this.busy || this.activeSession()) return null;
    this.busy = true;
    await this.close();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.busy = false;
    };
  }

  async close(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.session = null;
    this.generation++;
    const browser = this.browser;
    this.browser = null;
    if (browser) {
      const closing = Promise.resolve().then(() => browser.close());
      this.closing = closing;
      try { await closing; if (this.closing === closing) this.closing = null; }
      catch { /* Keep quarantine: browser termination was not confirmed. */ }
    } else if (this.closing) await this.closing.catch(() => {});
  }

  private scheduleIdleClose() {
    if (!this.browser) return;
    this.idleTimer = setTimeout(() => { if (!this.busy) void this.close(); }, this.captchaHold ? this.captchaHoldMs : this.idleMs);
    this.idleTimer.unref?.();
  }

  private async page(): Promise<ShopPage> {
    if (this.closing) throw new ShopError("browser_unavailable");
    if (!this.browser) {
      const dir = this.checkProfile(this.env.SHOP_PROFILE_DIR);
      const generation = this.generation;
      let browser: ShopBrowser;
      try {
        browser = await this.launch(this.env, dir);
      } catch (e) {
        if (e instanceof ShopError) throw e;
        throw new ShopError("browser_unavailable");
      }
      // Запуск завис, исполнитель тем временем закрыли и отпустили замок —
      // поздний браузер никому не нужен, а профиль он держал бы.
      if (generation !== this.generation) {
        await browser.close().catch(() => {});
        throw new ShopError("browser_unavailable");
      }
      this.browser = browser;
    }
    return this.browser.page();
  }

  /** Рестораны со страницы, проверенные: чужие ссылки и пустые названия отбрасываются. */
  private async readPlaces(page: ShopPage, query: string | null): Promise<ShopPlace[]> {
    const raw = await page.places(query);
    await this.guard(page);
    const out: ShopPlace[] = [];
    for (const p of raw) {
      const name = normalizeShopPlaceName(p.name);
      if (!name || !SHOP_PLACE_REF.test(p.ref)) continue;
      out.push({ ref: p.ref, name, ...(p.eta ? { eta: { from_min: p.eta.from_min, to_min: p.eta.to_min } } : {}) });
    }
    return out;
  }

  private activeSession(): Session | null {
    if (this.session && this.now() > this.session.expires) this.session = null;
    return this.session;
  }

  private async dispatch(page: ShopPage, request: ShopRequest, signal?: AbortSignal): Promise<ShopOutcome> {
    const checkAborted = () => { if (signal?.aborted) throw new Error("assistant_cancelled"); };
    checkAborted();
    switch (request.op) {
      case "quote": {
        if (this.activeSession()) throw new ShopError("shop_busy");
        let target: ShopTarget = { service: request.service };
        const address = await this.openAt(page, () => page.openHome(target));
        let place: ShopPlace | undefined;
        if (shopNeedsPlace(request.service)) {
          if (!request.place) throw new ShopError("place_not_found");
          const query = request.place;
          // Поиск, а если в нём ресторана с таким названием нет — главная.
          let pick = pickShopPlace(query, await this.readPlaces(page, query), request.max_eta_min);
          if (!pick) pick = pickShopPlace(query, await this.readPlaces(page, null), request.max_eta_min);
          if (!pick) throw new ShopError("search_incomplete");
          if ("too_slow" in pick) throw new ShopError("place_too_slow");
          place = pick.place;
          target = { service: request.service, place: place.ref };
          await page.openHome(target);
          await this.guard(page);
        }
        const delivery = await page.deliveryFee();
        const results: ShopQuoteResult[] = [];
        let optionBudget = 0;
        for (const query of request.queries) {
          checkAborted();
          await page.openSearch(target, query);
          await this.guard(page);
          const candidates: ShopCandidate[] = [];
          for (const card of await page.searchCards()) {
            const choices = (card.options ?? []).reduce((n, g) => n + g.choices.length, 0);
            // Опции — только у блюд Еды, и ответ должен уместиться в хвост потока.
            if (card.options && (!place || choices === 0 || optionBudget + choices > SHOP_QUOTE_CHOICES_MAX)) continue;
            const name = normalizeShopName(card.name);
            if (!card.available || card.price_rub === null || !name) continue;
            // id блюда Еды — производная ресторана и названия: другое — чужая карточка.
            if (place && card.id !== edaDishId(place.ref, name)) continue;
            // Сниппет Маркета без номера карточки — заказывать нечем.
            if (request.service === "market" && !MARKET_PRODUCT_ID.test(card.id)) continue;
            if (candidates.some((c) => c.id === card.id)) continue;
            candidates.push({ id: card.id, name, price_rub: card.price_rub, ...(card.options ? { options: card.options } : {}) });
            optionBudget += choices;
            if (candidates.length === SHOP_CANDIDATES_MAX) break;
          }
          results.push({ query, candidates });
        }
        return { ok: true, op: "quote", address, ...(place ? { place } : {}), delivery_rub: delivery, results };
      }
      case "places": {
        if (this.activeSession()) throw new ShopError("shop_busy");
        const address = await this.openAt(page, () => page.openHome({ service: request.service }));
        const places = rankShopPlaces(await this.readPlaces(page, request.query), request.max_eta_min);
        return { ok: true, op: "places", address, places };
      }
      case "prepare": {
        if (request.service === "eda" && request.place?.startsWith("retail@")) throw new ShopError("retail_checkout_unverified");
        const active = this.activeSession();
        if (active && active.id !== request.session) throw new ShopError("shop_busy");
        if (active) this.strand(active.target, await this.clearLines(page, active.target, active.items));
        this.session = null;
        // Хвост прошлой капчи: свои позиции убираем до проверки «корзина пуста».
        const stranded = this.stranded;
        if (stranded) {
          this.stranded = null;
          this.strand(stranded.target, await this.clearLines(page, stranded.target, stranded.lines));
        }
        if (shopNeedsPlace(request.service) !== (request.place !== undefined)) throw new ShopError("place_not_found");
        const target: ShopTarget = { service: request.service, ...(request.place ? { place: request.place } : {}) };
        const address = await this.openAt(page, () => page.openCart(target));
        if ((await page.cart()).length) throw new ShopError("cart_not_empty");
        const added: ShopLine[] = [];
        try {
          const lines = await this.fillCart(page, target, request.lines, added, checkAborted);
          const total = await this.checkoutTotal(page, lines);
          this.session = { id: request.session, target, items: request.lines, lines, expires: this.now() + SHOP_SESSION_TTL_MS };
          return { ok: true, op: "prepare", address, lines, total_rub: total };
        } catch (e) {
          await this.snapshot(page, e);
          await this.cleanupAfter(page, e, target, added);
          throw e;
        }
      }
      case "confirm": {
        const session = this.activeSession();
        if (!session || session.id !== request.session) throw new ShopError("session_unknown");
        // Одноразовая: и успех, и любой отказ её гасят.
        this.session = null;
        try {
          await page.openCart(session.target);
          await this.guard(page);
          const total = await this.checkoutTotal(page, session.lines);
          if (total > request.maxRub) throw new PriceChanged(total);
          checkAborted();
        } catch (e) {
          await this.snapshot(page, e);
          await this.cleanupAfter(page, e, session.target, session.items);
          throw e;
        }
        await page.clickPay();
        // С этого места деньги могли уйти: отказов «до заказа» больше нет.
        return { ok: true, op: "confirm", state: await this.pollState(page) };
      }
      case "reset":
        // run() обслуживает reset до замка; сюда он не доходит.
        return { ok: true, op: "reset", reset: false };
      case "abandon": {
        const session = this.activeSession();
        if (session?.id === request.session) {
          this.session = null;
          this.strand(session.target, await this.clearLines(page, session.target, session.items));
        }
        return { ok: true, op: "abandon" };
      }
      case "status": {
        await page.openOrders(request.service);
        await this.guard(page);
        const { state, eta_min } = await page.orderState();
        return { ok: true, op: "status", state, eta_min };
      }
      case "set_address": {
        // Пока идёт заказ, адрес не трогаем: подписан старый.
        if (this.activeSession()) throw new ShopError("shop_busy");
        if (!page.savedAddresses || !page.chooseAddress) throw new ShopError("address_required");
        const target: ShopTarget = { service: request.service };
        await page.openHome(target);
        await this.guard(page);
        const saved = await page.savedAddresses();
        const index = matchSavedAddress(request.address, saved);
        if (index === null) {
          await page.closeAddresses?.();
          return { ok: true, op: "set_address", matched: false, address: await page.address(), saved_count: saved.length };
        }
        await page.chooseAddress(index);
        await this.guard(page);
        const now = await page.address();
        // Сверяем шапку: выбралось не то или не выбралось — говорим об этом, а не молчим.
        const matched = now !== null && shopAddressHas(now, request.address);
        return { ok: true, op: "set_address", matched, address: now, saved_count: saved.length };
      }
    }
  }

  private async guard(page: ShopPage) {
    const verdict = await page.guard();
    if (verdict !== "ok") throw new ShopError(verdict);
  }

  /** Открыть страницу, проверить её и адрес доставки. Адрес агент не выбирает. */
  private async openAt(page: ShopPage, open: () => Promise<void>): Promise<string> {
    await open();
    await this.guard(page);
    const address = await page.address();
    if (!address) throw new ShopError("address_required");
    return address;
  }

  /** Каждая подписанная позиция: страница товара, то же название, в наличии, цена читается. */
  private async fillCart(page: ShopPage, target: ShopTarget, lines: ShopLine[], added: ShopLine[], checkAborted: () => void): Promise<ShopPreparedLine[]> {
    for (const line of lines) {
      checkAborted();
      // Подписанный id блюда должен выводиться из подписанного ресторана и названия.
      if (target.place && line.id !== edaDishId(target.place, line.name)) throw new ShopError("product_mismatch");
      if (target.service === "market" && !MARKET_PRODUCT_ID.test(line.id)) throw new ShopError("product_mismatch");
      await page.openProduct(target, line);
      await this.guard(page);
      const info = await page.product();
      if (!info.name) throw new ShopError("product_not_found");
      if (normalizeShopName(info.name) !== line.name) throw new ShopError("product_mismatch");
      if (!info.available) throw new ShopError("out_of_stock");
      // У блюда с опциями на карточке «от N ₽»: цену сверит корзина и итог.
      if (info.price_rub === null && !target.place) throw new ShopError("price_unreadable");
      if (line.options && !target.place) throw new ShopError("product_mismatch");
      added.push(line);
      // В Еде всегда через окно блюда: оно же скажет, что у блюда обязательный выбор.
      const result = target.place ? await page.addWithOptions!(line.qty, line.options ?? []) : await page.setProductQty(line.qty);
      if (result === "options_required" || result === "options_mismatch") throw new ShopError(result);
      if (result === "blocked") throw new ShopError("unexpected_page");
    }
    await page.openCart(target);
    await this.guard(page);
    const rows = await page.cart();
    const prepared: ShopPreparedLine[] = [];
    for (const line of lines) {
      const id = cartId(target, line);
      const row = rows.find((r) => r.id === id);
      if (!row || row.qty !== line.qty) throw new ShopError("cart_mismatch");
      if (row.price_rub === null) throw new ShopError("price_unreadable");
      prepared.push({ id, qty: line.qty, price_rub: row.price_rub });
    }
    if (rows.length !== lines.length) throw new ShopError("cart_mismatch");
    return prepared;
  }

  /**
   * Корзина совпадает с позициями сессии, оформление открыто, есть сохранённая
   * карта и кнопка оплаты — тогда итог со страницы. Стоим на странице оформления.
   */
  private async checkoutTotal(page: ShopPage, lines: ShopPreparedLine[]): Promise<number> {
    const rows = await page.cart();
    const same = rows.length === lines.length && lines.every((l) => rows.some((r) => r.id === l.id && r.qty === l.qty));
    if (!same) throw new ShopError("cart_mismatch");
    if (!(await page.openCheckout())) throw new ShopError("checkout_unavailable");
    await this.guard(page);
    // Еда спрашивает имя и почту «для уточнения по заказу». Пустые поля
    // заполняем из окружения; ошибка здесь не повод ронять заказ.
    await page.fillContacts?.({ name: this.env.SHOP_CONTACT_NAME, email: this.env.SHOP_CONTACT_EMAIL }).catch(() => {});
    const info = await page.checkout();
    if (info.blocked) throw new ShopError("checkout_unavailable");
    if (info.total_rub === null) throw new ShopError("price_unreadable");
    if (!info.saved_card) throw new ShopError("payment_needs_owner");
    if (!info.pay_button) throw new ShopError("pay_button_missing");
    return info.total_rub;
  }

  private async snapshot(page: ShopPage, e: unknown) {
    if (e instanceof ShopError && SCREENSHOT_CODES.includes(e.code) && e.screenshot === undefined) {
      e.screenshot = await boundedShopDiagnostic(() => page!.screenshot(), null);
    }
  }

  /**
   * Уборка после отказа. На капче страницу не уводим — её проходит владелец
   * в этом окне, — а свои позиции запоминаем до следующего prepare.
   */
  private async cleanupAfter(page: ShopPage, e: unknown, target: ShopTarget, lines: ShopLine[]) {
    if (e instanceof ShopError && e.code === "captcha") {
      this.strand(target, lines);
      return;
    }
    this.strand(target, await this.clearLines(page, target, lines));
  }

  private strand(target: ShopTarget, lines: ShopLine[]) {
    if (!lines.length) return;
    const same = this.stranded && this.stranded.target.service === target.service && this.stranded.target.place === target.place;
    this.stranded = { target, lines: same ? [...this.stranded!.lines, ...lines] : lines };
  }

  /**
   * Убрать то, что положил сам. Лучшее усилие: ошибки не перекрывают исходный
   * отказ. Возвращает позиции, до которых не дошли из-за капчи или входа.
   */
  private async clearLines(page: ShopPage, target: ShopTarget, lines: ReadonlyArray<ShopLine>): Promise<ShopLine[]> {
    if (target.place && lines.length) {
      // В Еде блюдо с разными опциями — разные строки корзины: убираем строки своих вариантов.
      try {
        await page.openCart(target);
        if ((await page.guard()) !== "ok") return [...lines];
        await page.removeCartRows?.(lines.map((l) => cartId(target, l)));
      } catch {
        // лучшее усилие
      }
      return [];
    }
    for (const [i, line] of lines.entries()) {
      try {
        await page.openProduct(target, line);
        if ((await page.guard()) !== "ok") return lines.slice(i);
        await page.setProductQty(0);
      } catch {
        // следующая позиция
      }
    }
    return [];
  }

  private async pollState(page: ShopPage): Promise<ShopOrderState> {
    let state: ShopOrderState = "unknown";
    for (let i = 0; i < SHOP_STATE_POLL.attempts; i++) {
      try {
        state = (await page.orderState()).state;
      } catch {
        state = "unknown";
      }
      if (SHOP_PLACED_STATES.includes(state) || state === "cancelled") return state;
      await this.sleep(SHOP_STATE_POLL.intervalMs);
    }
    return state === "none" ? "unknown" : state;
  }
}

/** id строки корзины: в Еде — вариант блюда с опциями, иначе id товара. */
export const cartId = (target: ShopTarget, line: ShopLine): string =>
  target.place ? edaVariantId(target.place, line.name, (line.options ?? []).map((o) => o.name)) : line.id;

export function shopErrorCode(error: unknown): string {
  return runnerErrorCode(error, "invalid_shop_request", "shop_failed");
}

let runner: ShopRunner | null = null;

/** Точка входа демона: кадр `shop` → JSON для сервера. */
export async function runShopRequest(raw: unknown, signal?: AbortSignal): Promise<string> {
  const request = parseShopRequest(raw);
  if (!request) throw new Error("invalid_shop_request");
  runner ??= new ShopRunner(process.env);
  // Журнал демона без времени, а покупки без записей вовсе: shop_busy 2026-09-18
  // было не с чем сверить. Здесь только операция и код — без адресов и товаров.
  const started = Date.now();
  const stamp = () => new Date().toISOString();
  console.log(`[shop] ${stamp()} ${request.op} start`);
  try {
    const out = await runner.run(request, signal);
    const busy = !out.ok && out.busy_op ? ` busy_op=${out.busy_op} busy_ms=${out.busy_ms ?? "?"}` : "";
    console.log(`[shop] ${stamp()} ${request.op} ${out.ok ? "ok" : out.code}${busy} ${Date.now() - started}ms`);
    return JSON.stringify(out);
  } catch (e) {
    console.log(`[shop] ${stamp()} ${request.op} error=${shopErrorCode(e)} ${Date.now() - started}ms`);
    throw e;
  }
}

/** Замок покупок для починки селекторов (mac-daemon/selector-repair.ts); null — занято. */
export function holdShopRunner(): Promise<(() => void) | null> {
  runner ??= new ShopRunner(process.env);
  return runner.hold();
}

export async function closeShopRunner(): Promise<void> {
  await runner?.close();
}

async function cli(args: string[]) {
  const env: ShopEnv = process.env;
  const [command, ...rest] = args;
  if (command === "login" || command === "probe") {
    const dir = env.SHOP_PROFILE_DIR;
    ensureLoginProfileDir(command, dir);
    const profile = checkShopProfile(dir);
    const { launchPlaywrightShop } = await import("./shop-playwright.ts");
    const browser = await launchPlaywrightShop(env, profile, { headless: false });
    const page = browser.page();
    await page.openHome({ service: rest[0] === "eda" || rest[0] === "market" ? rest[0] : "lavka" });
    if (command === "login") {
      console.log("Войди в Яндекс, выбери адрес доставки и проверь карту в открывшемся окне сам. Когда закончишь — нажми Enter здесь.");
      await waitForEnter();
    } else {
      console.log("Открой в окне нужную страницу (корзина, оформление, заказ) и нажми Enter здесь.");
      await waitForEnter();
      console.log(`guard: ${await page.guard()}`);
      console.log(await page.probe());
    }
    await browser.close();
    return;
  }
  if (command === "selfcheck") {
    // Для починщика селекторов: только чтение, без окна и без ожидания Enter.
    const service = rest[0] === "eda" || rest[0] === "market" ? rest[0] : "lavka";
    const profile = checkShopProfile(env.SHOP_PROFILE_DIR);
    const { runSelfcheck } = await import("./shop-selfcheck.ts");
    console.log(JSON.stringify(await runSelfcheck(service, env, profile)));
    return;
  }
  if (command === "eda-places") {
    const query = normalizeShopQuery(rest[0]);
    const max = rest[1] === undefined ? undefined : Number(rest[1]);
    if (!query || (max !== undefined && !isShopMaxEta(max))) throw new Error("usage: bun mac-daemon/shop.ts eda-places \"шаверма\" [45]");
    const local = new ShopRunner({ ...env, SHOP_ENABLED: "true" }, { launch: async (e, d) => (await import("./shop-playwright.ts")).launchPlaywrightShop(e, d, { headless: false }) });
    const out = await local.run({ op: "places", service: "eda", query, ...(max !== undefined ? { max_eta_min: max } : {}) });
    await local.close();
    printOutcome(out);
    return;
  }
  if (command === "quote" || command === "eda-quote" || command === "market-quote") {
    const eda = command === "eda-quote";
    const place = eda ? normalizeShopQuery(rest.shift()) : null;
    const queries = rest.map(normalizeShopQuery);
    if ((eda && !place) || !queries.length || queries.some((q) => !q)) {
      throw new Error("usage: bun mac-daemon/shop.ts quote \"молоко\" \"хлеб\" | eda-quote \"ресторан\" \"блюдо\" | market-quote \"товар\"");
    }
    const local = new ShopRunner({ ...env, SHOP_ENABLED: "true" }, { launch: async (e, d) => (await import("./shop-playwright.ts")).launchPlaywrightShop(e, d, { headless: false }) });
    const out = await local.run(eda
      ? { op: "quote", service: "eda", place: place!, queries: queries as string[] }
      : { op: "quote", service: command === "market-quote" ? "market" : "lavka", queries: queries as string[] });
    await local.close();
    printOutcome(out);
    return;
  }
  throw new Error("usage: bun mac-daemon/shop.ts login [eda|market] | probe [eda|market] | quote \"молоко\" | eda-quote \"ресторан\" \"блюдо\" | eda-places \"шаверма\" [45] | market-quote \"товар\" | selfcheck [eda|market]");
}

if (import.meta.main) {
  runCli(() => cli(process.argv.slice(2)), (e) => (e instanceof ShopError ? e.code : null));
}

/** Optional diagnostics must never retain the purchase lock after a failure. */
export async function boundedShopDiagnostic<T>(work: () => Promise<T>, fallback: T, timeoutMs = 3000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(work).catch(() => fallback), new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), timeoutMs); })]);
  } finally { clearTimeout(timer); }
}
