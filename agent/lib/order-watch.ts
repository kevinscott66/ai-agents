/**
 * Слежение за оформленным заказом: сам сообщает владельцу, когда приедет такси
 * или курьер и когда посылка доехала до пункта выдачи.
 *
 * Зачем отдельный модуль. TAXI_STATUS / SHOP_STATUS / DELIVERY_STATUS отвечают
 * на вопрос «где заказ?» — но их надо задать. Владелец просил обратное: чтобы
 * агент сам сказал, через сколько машина у подъезда и что товар в ПВЗ. Значит
 * нужен тот, кто спрашивает Mac сам, и он здесь.
 *
 * Устройство — ровно как у напоминаний (lib/reminders.ts), и по тем же
 * причинам:
 *  - свой `setInterval`, потому что соседние таймеры живут своей частотой и
 *    своим выключателем;
 *  - строка захватывается атомарно (`UPDATE … SET status='polling' WHERE id=?
 *    AND status='watching'`), и опрашивает только тот, у кого `changes === 1`;
 *  - адресат — только чат, в котором заказ оформляли; из ответа Mac чат не
 *    берётся никогда; публичный канал DeLabs отвергается перед каждой
 *    отправкой;
 *  - рестарт посреди опроса оставляет строку в 'polling' — такие старше
 *    POLLING_STALE_MS возвращаются в 'watching'. Здесь это безопасно, в
 *    отличие от напоминаний: повторный опрос ничего не испортит, а повторное
 *    сообщение отсекается сравнением с последним показанным состоянием.
 *
 * Что уходит в чат. Состояние, обещанное время и — у такси — машина с номером,
 * то есть ровно то, что TAXI_STATUS и так печатает по запросу. Адресов в
 * сообщении нет: ни откуда, ни куда, ни какой это пункт выдачи.
 *
 * Денег модуль не двигает и кнопок не нажимает: единственная операция, которую
 * он просит у Mac, — `status`.
 */
import { db } from "./db.ts";
import { log } from "./log.ts";
import { safeTick } from "./safe-timer.ts";
import { getErrorMessage } from "./errors.ts";
import { HOUR_MS, MINUTE_MS, SECOND_MS } from "./time-constants.ts";
import { isBlockedReminderChat } from "./reminders.ts";
import { TAXI_STATE_LABEL, type TaxiDriver, type TaxiOrderState } from "./taxi.ts";
import { DELIVERY_STATE_LABEL, type DeliveryOrderState } from "./delivery.ts";
import { SHOP_SERVICES, SHOP_STATE_LABEL, type ShopOrderState, type ShopService } from "./shop.ts";

/** За чем умеем следить. Ключ = как спрашивать Mac, значение = как звать в чате. */
export const ORDER_WATCH_KINDS = {
  taxi: "Такси",
  delivery: "Доставка",
  lavka: SHOP_SERVICES.lavka,
  eda: SHOP_SERVICES.eda,
  market: SHOP_SERVICES.market,
} as const;
export type OrderWatchKind = keyof typeof ORDER_WATCH_KINDS;
export const ORDER_WATCH_KIND_KEYS = Object.keys(ORDER_WATCH_KINDS) as OrderWatchKind[];

/** Состояние заказа — своё у каждого сервиса, но хранится одной строкой. */
export type OrderWatchState = TaxiOrderState | DeliveryOrderState | ShopOrderState;

export type OrderWatchStatus = "watching" | "polling" | "done" | "failed" | "cancelled";

/** Сколько ждать между опросами — тем чаще, чем ближе развязка. */
export const POLL_NEAR_MS = 60 * SECOND_MS;
export const POLL_NORMAL_MS = 2 * MINUTE_MS;
export const POLL_EARLY_MS = 3 * MINUTE_MS;
/** Дольше этого не следим: заказ или доехал, или мы его потеряли. */
export const MAX_WATCH_MS = 4 * HOUR_MS;
/** Столько неудачных опросов подряд — и слежение сдаётся с внятной причиной. */
export const MAX_MISSES = 5;
/** Строка в 'polling' дольше этого — процесс умер посреди опроса. */
export const POLLING_STALE_MS = 10 * MINUTE_MS;
export const DEFAULT_TICK_MS = 30 * SECOND_MS;
/** Рубежи обещанного времени: пересекли сверху вниз — сказали владельцу. */
export const ETA_STEPS_MIN = [30, 15, 10, 5] as const;
/** Больше активных слежений на чат не держим — защита от зацикленного агента. */
export const MAX_ACTIVE_WATCHES_PER_CHAT = 10;

/** Дальше следить не за чем: заказ закрыт (или, у ПВЗ, доехал и ждёт). */
const TERMINAL: Record<OrderWatchKind, readonly OrderWatchState[]> = {
  taxi: ["finished", "cancelled"],
  delivery: ["delivered", "cancelled"],
  lavka: ["delivered", "cancelled"],
  eda: ["delivered", "cancelled"],
  // ПВЗ — это и есть то событие, ради которого следили. Посылка там ждёт
  // сутками, и караулить её выдачу значит опрашивать Маркет впустую.
  market: ["pickup_ready", "delivered", "cancelled"],
};

/** Состояния «заказа не видно». Их терпим MAX_MISSES раз подряд. */
const BLIND: readonly OrderWatchState[] = ["none", "unknown"];

export interface OrderWatchRow {
  id: string;
  kind: OrderWatchKind;
  chat_id: number;
  user_id: string;
  agent_key: string;
  status: OrderWatchStatus;
  state: OrderWatchState;
  eta_min: number | null;
  /** Последний объявленный рубеж из ETA_STEPS_MIN: ниже него уже говорили. */
  eta_step: number | null;
  driver: string | null;
  started_at: number;
  next_poll_at: number;
  polled_at: number | null;
  notified_at: number | null;
  misses: number;
  error: string | null;
}

// ─── Хранилище ──────────────────────────────────────────────────────────────

const isKind = (v: unknown): v is OrderWatchKind =>
  typeof v === "string" && Object.hasOwn(ORDER_WATCH_KINDS, v);

export function orderWatchKindOf(v: unknown): OrderWatchKind | null {
  if (!isKind(v)) return null;
  return v;
}

/** Такси и Доставка — один сервис, Лавка/Еда/Маркет — три под одним мостом. */
export const shopServiceOfKind = (kind: OrderWatchKind): ShopService | null =>
  kind === "lavka" || kind === "eda" || kind === "market" ? kind : null;

const row = (r: unknown): OrderWatchRow => r as OrderWatchRow;

export function getOrderWatch(id: string): OrderWatchRow | null {
  const r = db.prepare(`SELECT * FROM order_watch WHERE id = ?`).get(id);
  return r ? row(r) : null;
}

export function listOrderWatches(chatId: number): OrderWatchRow[] {
  return (
    db
      .prepare(
        `SELECT * FROM order_watch WHERE chat_id = ? AND status IN ('watching','polling')
         ORDER BY started_at ASC`,
      )
      .all(chatId) as unknown[]
  ).map(row);
}

/**
 * Завести слежение. Активное слежение за сервисом ровно одно: у Mac на сервис
 * одна вкладка и один текущий заказ, второе следило бы за тем же самым и
 * писало бы владельцу дважды. Повторный вызов возвращает уже заведённое.
 */
export function startOrderWatch(opts: {
  kind: OrderWatchKind;
  chatId: number;
  userId: string;
  agentKey: string;
  state?: OrderWatchState;
  now?: number;
}): { ok: true; row: OrderWatchRow; created: boolean } | { ok: false; error: string } {
  if (isBlockedReminderChat(opts.chatId)) return { ok: false, error: "blocked_chat" };
  const t = opts.now ?? Date.now();
  const existing = db
    .prepare(`SELECT * FROM order_watch WHERE kind = ? AND status IN ('watching','polling')`)
    .get(opts.kind);
  if (existing) return { ok: true, row: row(existing), created: false };
  const active = db
    .prepare(
      `SELECT COUNT(*) AS n FROM order_watch WHERE chat_id = ? AND status IN ('watching','polling')`,
    )
    .get(opts.chatId) as { n: number };
  if (active.n >= MAX_ACTIVE_WATCHES_PER_CHAT) return { ok: false, error: "too_many_watches" };

  const id = `ow_${t.toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(
    `INSERT INTO order_watch
       (id, kind, chat_id, user_id, agent_key, status, state, eta_min, eta_step, driver,
        started_at, next_poll_at, polled_at, notified_at, misses, error)
     VALUES (?, ?, ?, ?, ?, 'watching', ?, NULL, NULL, NULL, ?, ?, NULL, NULL, 0, NULL)`,
  ).run(id, opts.kind, opts.chatId, opts.userId, opts.agentKey, opts.state ?? "unknown", t, t);
  return { ok: true, row: getOrderWatch(id)!, created: true };
}

export function cancelOrderWatch(id: string, chatId: number): boolean {
  return (
    db
      .prepare(
        `UPDATE order_watch SET status = 'cancelled' WHERE id = ? AND chat_id = ?
         AND status IN ('watching','polling')`,
      )
      .run(id, chatId).changes === 1
  );
}

// ─── Что показывать ─────────────────────────────────────────────────────────

const stateLabel = (kind: OrderWatchKind, state: OrderWatchState): string => {
  const shop = shopServiceOfKind(kind);
  const map: Record<string, string> = shop
    ? SHOP_STATE_LABEL
    : kind === "taxi"
      ? TAXI_STATE_LABEL
      : DELIVERY_STATE_LABEL;
  return map[state] ?? "состояние не распознано";
};

/** «через 5 мин» / «меньше минуты». Ноль — это «вот-вот», а не «неизвестно». */
export function etaText(eta: number | null): string | null {
  if (eta === null) return null;
  if (eta <= 0) return "меньше минуты";
  return `через ${eta} мин`;
}

/** Машина и номер — как их печатает TAXI_STATUS; пусто — строки не будет. */
export function driverText(driver: TaxiDriver | null): string | null {
  if (!driver) return null;
  const parts = [driver.car, driver.plate].filter((p): p is string => !!p);
  return parts.length ? parts.join(", ") : null;
}

export function renderOrderWatchMessage(r: OrderWatchRow, done: boolean): string {
  const head = `${ORDER_WATCH_KINDS[r.kind]}: ${stateLabel(r.kind, r.state)}`;
  const eta = etaText(r.eta_min);
  const tail = [eta, r.driver].filter((p): p is string => !!p);
  const body = tail.length ? `${head} — ${tail.join("; ")}` : head;
  return done ? `${body}.\nСлежение за заказом закончено.` : `${body}.`;
}

// ─── Опрос ──────────────────────────────────────────────────────────────────

export type OrderWatchProbe =
  | { ok: true; state: OrderWatchState; eta_min: number | null; driver: TaxiDriver | null }
  /** Спросить не вышло: Mac офлайн, занят, отказ. `retry` — это не промах. */
  | { ok: false; error: string; retry?: boolean };

export type OrderWatchPoller = (r: OrderWatchRow) => Promise<OrderWatchProbe>;
export type OrderWatchSender = (chatId: number, text: string, agentKey: string) => Promise<unknown>;

/** Насколько скоро спрашивать снова. Чем ближе развязка, тем чаще. */
export function nextPollDelayMs(state: OrderWatchState, eta: number | null): number {
  if (state === "driver_arrived" || state === "pickup_ready") return POLL_NEAR_MS;
  if (eta !== null && eta <= 15) return POLL_NEAR_MS;
  if (state === "delivering" || state === "riding" || state === "driver_assigned" || state === "picked_up") {
    return POLL_NORMAL_MS;
  }
  return POLL_EARLY_MS;
}

/**
 * Надо ли говорить. Говорим на смене состояния, на пересечении рубежа
 * обещанного времени сверху вниз и на закрытии заказа. Молчим, когда ничего не
 * изменилось: «ещё едет» раз в минуту — это не забота, а спам.
 */
export function shouldNotify(
  prev: Pick<OrderWatchRow, "state" | "eta_min" | "eta_step" | "notified_at">,
  next: { state: OrderWatchState; eta_min: number | null },
): { notify: boolean; step: number | null } {
  // Рубеж берём самый тесный из пройденных: на 12 минутах это «15», а не «30»
  // (ETA_STEPS_MIN идёт по убыванию, значит подходящий последний). Возьми
  // первый — и рубеж навсегда остался бы «30», а про 15, 10 и 5 минут владелец
  // не услышал бы ни разу.
  const step =
    next.eta_min === null
      ? prev.eta_step
      : (ETA_STEPS_MIN.filter((s) => next.eta_min! <= s).at(-1) ?? null);
  if (prev.notified_at === null) return { notify: true, step };
  if (next.state !== prev.state) return { notify: true, step };
  // Рубеж считается пройденным только вниз: пробка, отодвинувшая время назад,
  // не должна снова печатать «через 15 мин».
  if (step !== null && (prev.eta_step === null || step < prev.eta_step)) return { notify: true, step };
  // Пройденный рубеж не отпускаем: время отодвинулось назад — значит про «через
  // 15 мин» уже говорили, и сказать это второй раз нечестно. Сюда попадают
  // только случаи step === null или step >= prev.eta_step, так что прежний и
  // есть самый тесный.
  return { notify: false, step: prev.eta_step ?? step };
}

export interface WatchStats {
  polled: number;
  notified: number;
  finished: number;
  failed: number;
  skipped: number;
  stale: number;
}

/** Один проход. Экспортирован ради тестов: `now`, `poll` и `send` подменяемы. */
export async function pollOrderWatches(opts: {
  poll: OrderWatchPoller;
  send: OrderWatchSender;
  now?: () => number;
  batch?: number;
}): Promise<WatchStats> {
  const clock = opts.now ?? (() => Date.now());
  const stats: WatchStats = { polled: 0, notified: 0, finished: 0, failed: 0, skipped: 0, stale: 0 };

  // Строки, застрявшие в 'polling': процесс умер между захватом и итогом.
  // Повторить опрос безопасно — он ничего не меняет на стороне Яндекса.
  const stale = db
    .prepare(
      `UPDATE order_watch SET status = 'watching', error = 'interrupted while polling; retried'
       WHERE status = 'polling' AND polled_at < ?`,
    )
    .run(clock() - POLLING_STALE_MS);
  if (stale.changes > 0) {
    stats.stale = stale.changes;
    log.warn("[order-watch] слежения застряли в опросе — возвращены в очередь", { count: stale.changes });
  }

  const due = (
    db
      .prepare(
        `SELECT id FROM order_watch WHERE status = 'watching' AND next_poll_at <= ?
         ORDER BY next_poll_at ASC, id ASC LIMIT ?`,
      )
      .all(clock(), opts.batch ?? 20) as Array<{ id: string }>
  ).map((r) => r.id);

  const claim = db.prepare(
    `UPDATE order_watch SET status = 'polling', polled_at = ? WHERE id = ? AND status = 'watching'`,
  );
  const release = db.prepare(
    `UPDATE order_watch SET status = 'watching', next_poll_at = ?, misses = ?, error = ?
     WHERE id = ? AND status = 'polling'`,
  );
  const advance = db.prepare(
    `UPDATE order_watch SET status = ?, state = ?, eta_min = ?, eta_step = ?, driver = ?,
       next_poll_at = ?, notified_at = ?, misses = 0, error = NULL
     WHERE id = ? AND status = 'polling'`,
  );
  const close = db.prepare(
    `UPDATE order_watch SET status = ?, error = ? WHERE id = ? AND status = 'polling'`,
  );

  for (const id of due) {
    const t = clock();
    // Забрал другой тик/процесс или слежение успели отменить.
    if (claim.run(t, id).changes !== 1) continue;
    const r = getOrderWatch(id)!;

    if (t - r.started_at > MAX_WATCH_MS) {
      close.run("failed", "watch expired: order did not reach a final state in time", id);
      stats.failed++;
      log.info("[order-watch] срок слежения вышел", { id, kind: r.kind });
      continue;
    }

    let probe: OrderWatchProbe;
    try {
      probe = await opts.poll(r);
    } catch (e) {
      probe = { ok: false, error: getErrorMessage(e) };
    }
    stats.polled++;

    if (!probe.ok) {
      // Mac офлайн или занят — это не промах: ждём и спрашиваем снова.
      const misses = probe.retry ? r.misses : r.misses + 1;
      if (misses >= MAX_MISSES) {
        close.run("failed", `polling failed ${misses} times: ${probe.error}`, id);
        stats.failed++;
        log.warn("[order-watch] опрос не удался, слежение прекращено", { id, kind: r.kind, error: probe.error });
        continue;
      }
      release.run(clock() + POLL_NORMAL_MS, misses, probe.error, id);
      stats.skipped++;
      continue;
    }

    // Заказа не видно — терпим до MAX_MISSES: страница могла не прогрузиться.
    if (BLIND.includes(probe.state)) {
      const misses = r.misses + 1;
      if (misses >= MAX_MISSES) {
        close.run("failed", `order is not visible after ${misses} polls (state ${probe.state})`, id);
        stats.failed++;
        log.info("[order-watch] заказ перестал быть виден", { id, kind: r.kind, state: probe.state });
        continue;
      }
      release.run(clock() + POLL_NORMAL_MS, misses, `state ${probe.state}`, id);
      stats.skipped++;
      continue;
    }

    const done = TERMINAL[r.kind].includes(probe.state);
    const { notify, step } = shouldNotify(r, probe);
    const driver = driverText(probe.driver);
    const next: OrderWatchRow = { ...r, state: probe.state, eta_min: probe.eta_min, eta_step: step, driver };
    let notifiedAt = r.notified_at;

    if (notify || done) {
      if (isBlockedReminderChat(r.chat_id)) {
        close.run("failed", "blocked: public channel is not an order-watch target", id);
        stats.failed++;
        log.warn("[order-watch] адресат — публичный канал, слежение прекращено", { id });
        continue;
      }
      try {
        await opts.send(r.chat_id, renderOrderWatchMessage(next, done), r.agent_key);
        notifiedAt = clock();
        stats.notified++;
      } catch (e) {
        // Сообщение не ушло — состояние не запоминаем, иначе смену состояния
        // никто уже не увидит: на следующем проходе оно будет «прежним».
        release.run(clock() + POLL_NEAR_MS, r.misses, `send failed: ${getErrorMessage(e)}`, id);
        stats.skipped++;
        continue;
      }
    }

    advance.run(
      done ? "done" : "watching",
      next.state,
      next.eta_min,
      next.eta_step,
      next.driver,
      clock() + nextPollDelayMs(next.state, next.eta_min),
      notifiedAt,
      id,
    );
    if (done) stats.finished++;
  }
  return stats;
}

export interface OrderWatchHandle {
  stop(): void;
  /** Один проход прямо сейчас (для тестов). `null` — проход уже идёт. */
  tickNow(): Promise<WatchStats | null>;
}

export function startOrderWatcher(opts: {
  poll: OrderWatchPoller;
  send: OrderWatchSender;
  intervalMs?: number;
  now?: () => number;
}): OrderWatchHandle {
  let running = false;
  const tick = async (): Promise<WatchStats | null> => {
    if (running) return null;
    running = true;
    try {
      return await pollOrderWatches({ poll: opts.poll, send: opts.send, now: opts.now });
    } finally {
      running = false;
    }
  };
  const interval = setInterval(safeTick("order-watch", tick), opts.intervalMs ?? DEFAULT_TICK_MS);
  (interval as unknown as { unref?: () => void }).unref?.();
  safeTick("order-watch", tick)();
  return { stop: () => clearInterval(interval), tickNow: tick };
}

/**
 * Завести слежение сразу после подтверждённого заказа.
 *
 * Ничего не возвращает и не бросает: заказ уже сделан, и упасть на заведении
 * слежения — значит соврать владельцу про сам заказ. Отказ (чужой чат, предел
 * на чат) уходит в лог, а состояние заказа всегда можно спросить руками.
 */
export function watchPlacedOrder(o: {
  kind: OrderWatchKind;
  chatId: number;
  userId: string;
  agentKey: string;
  state: OrderWatchState;
}): void {
  try {
    const res = startOrderWatch(o);
    if (!res.ok) log.warn("[order-watch] слежение не заведено", { kind: o.kind, error: res.error });
  } catch (e) {
    log.error("[order-watch] слежение не заведено", { kind: o.kind, error: String(e) });
  }
}
