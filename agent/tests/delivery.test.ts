/**
 * Шаг 10d: курьер через Яндекс Go («Доставка»). Всё на заглушках: страница,
 * мост и Telegram подменены, настоящий браузер не запускается и заказ не делается.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvalCategories } from "../lib/approval-policy.ts";
import { approvalPreview } from "../lib/approvals.ts";
import { buildPayload } from "../lib/dispatch/build-payload.ts";
import {
  configureDelivery,
  deliveryStatus,
  executeSignedDelivery,
  handleDeliveryCancel,
  handleOrderDelivery,
  hasPendingDeliveryOrder,
  quoteDelivery,
  resetDeliveryState,
} from "../lib/dispatch/delivery.ts";
import {
  describeDeliveryPayload,
  normalizeDeliveryComment,
  normalizeDeliveryTariff,
  parseDeliveryOutcome,
  parseDeliveryRequest,
  type DeliveryOrderState,
  type DeliveryOutcome,
  type DeliveryRequest,
  type DeliveryTariff,
} from "../lib/delivery.ts";
import { SignedActions } from "../lib/signed-actions.ts";
import {
  checkDeliveryProfile,
  DeliveryRunner,
  type DeliveryEnv,
  type DeliveryGuard,
  type DeliveryPage,
  type DeliveryTariffRow,
} from "../mac-daemon/delivery.ts";

const T0 = Date.UTC(2026, 8, 17, 9, 0, 0);
const OWNER = 777_000_333;
const SESSION = "sess_0123456789abcdef";

async function phone() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const spki = Buffer.from(await crypto.subtle.exportKey("spki", pair.publicKey)).toString("base64");
  const sign = async (payload: string) =>
    Buffer.from(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(payload))).toString("base64");
  return { spki, sign };
}

describe("parsing", () => {
  test("tariffs and comments", () => {
    expect(normalizeDeliveryTariff("Экспресс")).toBe("express");
    expect(normalizeDeliveryTariff("courier")).toBe("courier");
    expect(normalizeDeliveryTariff("vip")).toBeNull();
    expect(normalizeDeliveryComment(undefined)).toBeNull();
    expect(normalizeDeliveryComment("   ")).toBeNull();
    expect(normalizeDeliveryComment("  забрать   пакет ")).toBe("забрать пакет");
    expect(normalizeDeliveryComment("x".repeat(201))).toBeUndefined();
    expect(normalizeDeliveryComment("код\u200b 12")).toBeUndefined();
    expect(normalizeDeliveryComment("строка\nдве")).toBeUndefined();
    expect(normalizeDeliveryComment(12)).toBeUndefined();
  });

  test("daemon frame is strict", () => {
    const prepare = { op: "prepare", session: SESSION, from: "Красная 1", to: "Северная 5", tariff: "courier", comment: null };
    expect(parseDeliveryRequest(prepare)).toEqual(prepare as DeliveryRequest);
    expect(parseDeliveryRequest({ ...prepare, comment: "подъезд 2" })).toMatchObject({ comment: "подъезд 2" });
    expect(parseDeliveryRequest({ ...prepare, comment: " подъезд 2" })).toBeNull();
    const { comment: _c, ...noComment } = prepare;
    expect(parseDeliveryRequest(noComment)).toBeNull();
    expect(parseDeliveryRequest({ ...prepare, tariff: "vip" })).toBeNull();
    expect(parseDeliveryRequest({ ...prepare, phone: "+7" })).toBeNull();
    expect(parseDeliveryRequest({ op: "confirm", session: SESSION, maxRub: 1.5 })).toBeNull();
    expect(parseDeliveryRequest({ op: "quote", from: "Красная 1", to: "Северная 5" })).toEqual({ op: "quote", from: "Красная 1", to: "Северная 5" });
    expect(parseDeliveryRequest({ op: "cancel" })).toEqual({ op: "cancel" });
  });

  test("daemon answer is checked, junk throws", () => {
    expect(parseDeliveryOutcome('{"ok":false,"code":"contact_required","screenshot":"QUJD"}', "prepare")).toEqual({ ok: false, code: "contact_required", screenshot: "QUJD" });
    expect(() => parseDeliveryOutcome('{"ok":false,"code":"whatever"}', "quote")).toThrow("invalid_delivery_result");
    expect(() => parseDeliveryOutcome('{"ok":true,"op":"confirm","state":"searching"}', "prepare")).toThrow("invalid_delivery_result");
    expect(() => parseDeliveryOutcome('{"ok":true,"op":"status","state":"picked_up"}', "status")).toThrow();
    expect(parseDeliveryOutcome('{"ok":true,"op":"status","state":"picked_up","eta_min":12}', "status")).toEqual({ ok: true, op: "status", state: "picked_up", eta_min: 12 });
  });

  test("approval card matches what the phone signs", () => {
    expect(describeDeliveryPayload({ from: "Красная 1", to: "Северная 5", tariff: "express", price_rub: 400 }, 15))
      .toBe("курьер Экспресс: Красная 1 → Северная 5, 400 ₽ (списание не больше 460 ₽), дальше — подпись на телефоне");
    expect(describeDeliveryPayload({ from: "Красная 1", to: "Северная 5", tariff: "courier", price_rub: 300, comment: "ключи у охраны" }, 15))
      .toContain("комментарий курьеру: «ключи у охраны»");
    expect(describeDeliveryPayload({ from: "Красная 1", to: "Северная 5", tariff: "courier", price_rub: 300, comment: "a\u0000b" }, 15)).toBe("некорректный заказ доставки");
  });
});

/** Страница-заглушка: журнал нажатий и ввода, цена и состояние меняются по ходу. */
function fakePage(init: Partial<{ guard: DeliveryGuard; rows: DeliveryTariffRow[]; button: number | null; blocked: "payment" | "confirm_data" | "disabled" | null; contact: boolean; commentField: boolean }> = {}) {
  const s = {
    guard: init.guard ?? ("ok" as DeliveryGuard),
    rows: init.rows ?? [
      { tariff: "courier" as DeliveryTariff, price_rub: 320, eta_min: 15, selected: true },
      { tariff: "express" as DeliveryTariff, price_rub: 450, eta_min: 10, selected: false },
    ],
    button: init.button === undefined ? 320 : init.button,
    blocked: init.blocked ?? null,
    contact: init.contact ?? false,
    commentField: init.commentField ?? true,
    state: "none" as DeliveryOrderState,
    stateAfterClick: "searching" as DeliveryOrderState,
    clicks: [] as string[],
  };
  const page: DeliveryPage = {
    open: async () => {},
    url: () => "https://delivery.example.com/",
    guard: async () => s.guard,
    setRoute: async () => true,
    tariffs: async () => s.rows.map((r) => ({ ...r })),
    selectTariff: async (t) => {
      s.clicks.push(`tariff:${t}`);
      s.rows = s.rows.map((r) => ({ ...r, selected: r.tariff === t }));
    },
    contactRequired: async () => s.contact,
    setComment: async (c) => { s.clicks.push(`comment:${c}`); return s.commentField; },
    orderButton: async () => (s.button === null ? null : { label: `Заказать ${s.button} ₽`, price_rub: s.button, blocked: s.blocked }),
    clickOrder: async () => { s.clicks.push("order"); s.state = s.stateAfterClick; },
    orderState: async () => ({ state: s.state, eta_min: null }),
    cancelOrder: async () => { s.clicks.push("cancel"); s.state = "cancelled"; return "clicked"; },
    screenshot: async () => "U0NSRUVO",
    probe: async () => "",
  };
  return { s, page };
}

function runner(page: DeliveryPage, env: DeliveryEnv = { DELIVERY_ENABLED: "true", DELIVERY_PROFILE_DIR: "/profile" }, now = () => T0) {
  return new DeliveryRunner(env, {
    launch: async () => ({ page: () => page, close: async () => {} }),
    checkProfile: (e) => e.DELIVERY_PROFILE_DIR ?? "",
    now,
    sleep: async () => {},
    idleMs: 60_000,
  });
}

describe("mac runner", () => {
  const prepare: DeliveryRequest = { op: "prepare", session: SESSION, from: "Красная 1", to: "Северная 5", tariff: "express", comment: null };

  test("disabled by default, nothing is launched", async () => {
    let launched = false;
    const r = new DeliveryRunner({}, { launch: async () => { launched = true; throw new Error("no"); } });
    expect(await r.run({ op: "status" })).toEqual({ ok: false, code: "delivery_disabled" });
    expect(launched).toBe(false);
  });

  test("quote lists prices and never clicks", async () => {
    const { s, page } = fakePage();
    const r = runner(page);
    expect(await r.run({ op: "quote", from: "Красная 1", to: "Северная 5" })).toEqual({
      ok: true, op: "quote", options: [{ tariff: "courier", price_rub: 320, eta_min: 15 }, { tariff: "express", price_rub: 450, eta_min: 10 }],
    });
    expect(s.clicks).toEqual([]);
    await r.close();
  });

  test("captcha stops with a screenshot, nothing is touched", async () => {
    const { s, page } = fakePage({ guard: "captcha" });
    const r = runner(page);
    expect(await r.run(prepare)).toEqual({ ok: false, code: "captcha", screenshot: "U0NSRUVO" });
    expect(s.clicks).toEqual([]);
    await r.close();
  });

  test("required contact is never filled: refusal before and after prepare", async () => {
    const { s, page } = fakePage({ contact: true, button: 450 });
    const r = runner(page);
    expect(await r.run(prepare)).toEqual({ ok: false, code: "contact_required", screenshot: "U0NSRUVO" });
    s.contact = false;
    await r.run(prepare);
    s.contact = true;
    expect((await r.run({ op: "confirm", session: SESSION, maxRub: 517 }) as { code: string }).code).toBe("contact_required");
    expect(s.clicks).not.toContain("order");
    await r.close();
  });

  test("recipient phone is copied from the sender before the contact check", async () => {
    const { s, page } = fakePage({ contact: true, button: 450 });
    page.fillRecipientFromSender = async () => { s.clicks.push("recipient"); s.contact = false; };
    const r = runner(page);
    expect(await r.run(prepare)).toMatchObject({ ok: true, op: "prepare", price_rub: 450 });
    expect(s.clicks).toContain("recipient");
    expect(s.clicks).not.toContain("order");
    await r.close();
  });

  test("inactive order button: no payment method is the owner's, other reasons refuse too", async () => {
    const { s, page } = fakePage({ button: 450, blocked: "payment" });
    const r = runner(page);
    expect(await r.run(prepare)).toEqual({ ok: false, code: "payment_needs_owner" });
    s.blocked = "disabled";
    expect((await r.run(prepare) as { code: string }).code).toBe("order_button_missing");
    expect(s.clicks).not.toContain("order");
    await r.close();
  });

  test("«Подтвердите данные» instead of the order button is the owner's, with no click", async () => {
    const { s, page } = fakePage({ button: 450, blocked: "confirm_data" });
    const r = runner(page);
    expect(await r.run(prepare)).toMatchObject({ ok: false, code: "data_confirm_needs_owner", screenshot: expect.any(String) });
    expect(s.clicks).not.toContain("order");
    await r.close();
  });

  test("order button that is late or silently inactive is re-read before refusing", async () => {
    const { s, page } = fakePage({ button: 450, blocked: "disabled" });
    const read = page.orderButton;
    let calls = 0;
    page.orderButton = async () => {
      calls++;
      if (calls === 1) return null;
      if (calls === 3) s.blocked = "payment";
      return read();
    };
    const r = runner(page);
    expect(await r.run(prepare)).toEqual({ ok: false, code: "payment_needs_owner" });
    expect(calls).toBe(3);
    calls = 10;
    s.blocked = "disabled";
    expect((await r.run(prepare) as { code: string }).code).toBe("order_button_missing");
    expect(s.clicks).not.toContain("order");
    await r.close();
  });

  test("comment is typed only when signed; a missing field refuses", async () => {
    const { s, page } = fakePage({ button: 450, commentField: false });
    const r = runner(page);
    expect((await r.run({ ...prepare, comment: "подъезд 2" }) as { code: string }).code).toBe("comment_unavailable");
    s.clicks = [];
    expect((await r.run(prepare)).ok).toBe(true);
    expect(s.clicks.some((c) => c.startsWith("comment:"))).toBe(false);
    await r.close();
  });

  test("prepare selects tariff and comment; confirm clicks once when the price holds", async () => {
    const { s, page } = fakePage({ button: 450 });
    const r = runner(page);
    expect(await r.run({ ...prepare, comment: "подъезд 2" })).toEqual({ ok: true, op: "prepare", tariff: "express", price_rub: 450, eta_min: 10 });
    expect(await r.run({ op: "confirm", session: SESSION, maxRub: 517 })).toEqual({ ok: true, op: "confirm", state: "searching" });
    expect(s.clicks).toEqual(["tariff:express", "comment:подъезд 2", "order"]);
    expect(await r.run({ op: "confirm", session: SESSION, maxRub: 517 })).toEqual({ ok: false, code: "session_unknown" });
    await r.close();
  });

  test("price above the signed ceiling: no click, session is gone", async () => {
    const { s, page } = fakePage({ button: 450 });
    const r = runner(page);
    await r.run(prepare);
    s.button = 600;
    expect(await r.run({ op: "confirm", session: SESSION, maxRub: 517 })).toEqual({ ok: false, code: "price_changed", price_rub: 600, screenshot: "U0NSRUVO" });
    s.button = 450;
    expect(await r.run({ op: "confirm", session: SESSION, maxRub: 517 })).toEqual({ ok: false, code: "session_unknown" });
    expect(s.clicks).not.toContain("order");
    await r.close();
  });

  test("session expires", async () => {
    let now = T0;
    const { s, page } = fakePage();
    const r = runner(page, undefined, () => now);
    await r.run({ ...prepare, tariff: "courier" });
    now += 3 * 60_000 + 1;
    expect(await r.run({ op: "confirm", session: SESSION, maxRub: 400 })).toEqual({ ok: false, code: "session_unknown" });
    expect(s.clicks).not.toContain("order");
    await r.close();
  });

  test("cancel needs an active order", async () => {
    const { s, page } = fakePage();
    const r = runner(page);
    expect((await r.run({ op: "cancel" }) as { code: string }).code).toBe("no_active_order");
    s.state = "courier_assigned";
    expect(await r.run({ op: "cancel" })).toEqual({ ok: true, op: "cancel", state: "cancelled" });
    await r.close();
  });

  test("profile must be private and not the taxi one", () => {
    const dir = mkdtempSync(join(tmpdir(), "delivery-profile-"));
    try {
      chmodSync(dir, 0o755);
      expect(() => checkDeliveryProfile({ DELIVERY_PROFILE_DIR: dir })).toThrow("profile_insecure");
      chmodSync(dir, 0o700);
      expect(checkDeliveryProfile({ DELIVERY_PROFILE_DIR: dir })).toBe(dir);
      expect(checkDeliveryProfile({ DELIVERY_PROFILE_DIR: dir, TAXI_PROFILE_DIR: join(dir, "other") })).toBe(dir);
      expect(() => checkDeliveryProfile({ DELIVERY_PROFILE_DIR: dir, TAXI_PROFILE_DIR: `${dir}/` })).toThrow("profile_shared");
      expect(() => checkDeliveryProfile({})).toThrow("profile_missing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const ENV_KEYS = ["DELIVERY_ENABLED", "MINIAPP_ADMIN_USER_IDS"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

type Script = Partial<Record<DeliveryRequest["op"], DeliveryOutcome | Error>>;

async function harness(script: Script) {
  const gate = new SignedActions(new Database(":memory:"), { maxRub: 5000, maxRubByService: { yandex_delivery: 1000 }, dailyMax: 5, deviationPct: 15 });
  const owner = await phone();
  const { keyId, code } = await gate.registerKey("iphone", owner.spki, T0);
  gate.activateKey(keyId, code, T0);
  const requests: DeliveryRequest[] = [];
  const texts: string[] = [];
  const photos: string[] = [];
  const restore = configureDelivery({
    gate: () => gate,
    now: () => T0,
    session: () => SESSION,
    send: async (request) => {
      requests.push(request);
      const out = script[request.op];
      if (out instanceof Error) return { ok: false, stdout: "", error: out.message };
      if (!out) return { ok: false, stdout: "", error: "unexpected_op" };
      return { ok: true, stdout: JSON.stringify(out) };
    },
    notify: {
      text: async (_u, text) => { texts.push(text); },
      photo: async (_u, _jpeg, caption) => { photos.push(caption); },
    },
  });
  const ctx = { agentKey: "orchestrator", chatId: OWNER, triggerUserId: String(OWNER) };
  const quote = () => quoteDelivery({ from: "Красная 1", to: "Северная 5" }, ctx);
  const order = (price = 450, tariff: DeliveryTariff = "express", comment?: string) =>
    handleOrderDelivery({ from: "Красная 1", to: "Северная 5", tariff, price_rub: price, ...(comment ? { comment } : {}), _userId: String(OWNER) }, { agentKey: "orchestrator", chatId: OWNER });
  const nonceOf = () => gate.pending(T0).at(-1)!;
  const sign = async () => {
    const { nonce, payload } = nonceOf();
    await gate.approve(nonce, await owner.sign(payload), T0);
    return nonce;
  };
  const status = (nonce: string) => (gate.db.query("SELECT status FROM signed_actions WHERE nonce=?").get(nonce) as { status: string }).status;
  return { gate, requests, texts, photos, restore, ctx, quote, order, sign, status, nonceOf };
}

const QUOTE: DeliveryOutcome = { ok: true, op: "quote", options: [{ tariff: "courier", price_rub: 320, eta_min: 15 }, { tariff: "express", price_rub: 450, eta_min: 10 }, { tariff: "cargo", price_rub: 1400, eta_min: 25 }] };
const PREPARED: DeliveryOutcome = { ok: true, op: "prepare", tariff: "express", price_rub: 470, eta_min: 10 };

describe("server flow", () => {
  let h: Awaited<ReturnType<typeof harness>> | null = null;
  beforeEach(() => {
    resetDeliveryState();
    process.env.DELIVERY_ENABLED = "true";
    process.env.MINIAPP_ADMIN_USER_IDS = `123,${OWNER}`;
  });
  afterEach(() => {
    h?.restore();
    h = null;
    resetDeliveryState();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
    }
  });

  test("owner only, own chat, not delegated, orchestrator only", async () => {
    h = await harness({ quote: QUOTE, status: { ok: true, op: "status", state: "none", eta_min: null } });
    expect((await quoteDelivery({ from: "Красная 1", to: "Северная 5" }, { ...h.ctx, chatId: -100 })).ok).toBe(false);
    expect((await quoteDelivery({ from: "Красная 1", to: "Северная 5" }, { ...h.ctx, agentKey: "qa" })).ok).toBe(false);
    expect((await quoteDelivery({ from: "Красная 1", to: "Северная 5" }, { ...h.ctx, triggerUserId: "555", chatId: 555 })).ok).toBe(false);
    expect((await quoteDelivery({ from: "Красная 1", to: "Северная 5" }, { ...h.ctx, delegationChain: ["orchestrator", "devops"] })).ok).toBe(false);
    expect((await handleDeliveryCancel({ _userId: String(OWNER), _delegated: true }, { agentKey: "orchestrator", chatId: OWNER })).ok).toBe(false);
    expect(h.requests).toEqual([]);
    expect((await deliveryStatus(h.ctx)).ok).toBe(true);
    process.env.DELIVERY_ENABLED = "false";
    expect((await deliveryStatus(h.ctx)).ok).toBe(false);
  });

  test("order requires a fresh matching quote; comment is signed only when present", async () => {
    h = await harness({ quote: QUOTE });
    expect((await h.order()).ok).toBe(false);
    expect((await h.quote()).ok).toBe(true);
    expect((await h.order(440)).ok).toBe(false);
    const res = await h.order();
    expect(res).toMatchObject({ ok: true, result: { status: "awaiting_signature", price_rub: 450, max_final_rub: 517 } });
    const first = h.nonceOf();
    expect(JSON.parse(first.payload).params).toEqual({ from: "Красная 1", to: "Северная 5", tariff: "Экспресс" });
    expect(hasPendingDeliveryOrder(first.nonce)).toBe(true);
    await h.order(320, "courier", "ключи у охраны");
    expect(JSON.parse(h.nonceOf().payload)).toMatchObject({
      service: "yandex_delivery", action: "order_delivery",
      params: { from: "Красная 1", to: "Северная 5", tariff: "Курьер", comment: "ключи у охраны" }, amount_rub: 320,
    });
    expect(h.requests.map((r) => r.op)).toEqual(["quote"]);
  });

  test("delivery ceiling is 1000 ₽ even though the default is higher", async () => {
    h = await harness({ quote: QUOTE });
    await h.quote();
    const res = await h.order(1400, "cargo");
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain("PAID_ACTION_MAX_RUB_YANDEX_DELIVERY");
  });

  test("signed order: prepare with comment, price check, one confirm, success", async () => {
    h = await harness({ quote: QUOTE, prepare: PREPARED, confirm: { ok: true, op: "confirm", state: "searching" } });
    await h.quote();
    await h.order(450, "express", "подъезд 2");
    const nonce = await h.sign();
    await executeSignedDelivery(nonce);
    expect(h.requests.map((r) => r.op)).toEqual(["quote", "prepare", "confirm"]);
    expect(h.requests[1]).toEqual({ op: "prepare", session: SESSION, from: "Красная 1", to: "Северная 5", tariff: "express", comment: "подъезд 2" });
    expect(h.requests[2]).toEqual({ op: "confirm", session: SESSION, maxRub: 517 });
    expect(h.status(nonce)).toBe("executed");
    expect(h.texts).toHaveLength(1);
    expect(h.texts[0]).toContain("заказан");
    await executeSignedDelivery(nonce);
    expect(h.requests).toHaveLength(3);
  });

  test("price above the ceiling: abandon, no confirm, aborted", async () => {
    h = await harness({ quote: QUOTE, prepare: { ...PREPARED, price_rub: 600 }, abandon: { ok: true, op: "abandon" } });
    await h.quote();
    await h.order();
    const nonce = await h.sign();
    await executeSignedDelivery(nonce);
    expect(h.requests.map((r) => r.op)).toEqual(["quote", "prepare", "abandon"]);
    expect(h.status(nonce)).toBe("aborted");
    expect(h.texts[0]).toContain("600");
  });

  test("contact required before the click: aborted, owner gets the screenshot", async () => {
    h = await harness({ quote: QUOTE, prepare: { ok: false, code: "contact_required", screenshot: "U0NSRUVO" } });
    await h.quote();
    await h.order();
    const nonce = await h.sign();
    await executeSignedDelivery(nonce);
    expect(h.requests.map((r) => r.op)).toEqual(["quote", "prepare"]);
    expect(h.status(nonce)).toBe("aborted");
    expect(h.photos).toHaveLength(1);
    expect(h.photos[0]).toContain("контакт");
  });

  test("bridge failure on confirm: failed, never retried", async () => {
    h = await harness({ quote: QUOTE, prepare: PREPARED, confirm: new Error("mac_timeout") });
    await h.quote();
    await h.order();
    const nonce = await h.sign();
    await executeSignedDelivery(nonce);
    expect(h.requests.map((r) => r.op)).toEqual(["quote", "prepare", "confirm"]);
    expect(h.status(nonce)).toBe("failed");
    expect(h.texts[0]).toContain("Не знаю");
  });

  test("cancel bridge error is flagged as a possible side effect", async () => {
    h = await harness({ cancel: new Error("mac_timeout") });
    const res = await handleDeliveryCancel({ _userId: String(OWNER) }, { agentKey: "orchestrator", chatId: OWNER });
    expect(res).toMatchObject({ ok: false, sideEffect: true });
  });
});

describe("chat approval", () => {
  test("order and cancel are money; preview shows the ceiling and comment", () => {
    const payload = { from: "Красная 1", to: "Северная 5", tariff: "courier", price_rub: 300, comment: "подъезд 2" };
    expect(approvalCategories("ORDER_DELIVERY", payload)).toEqual(["money"]);
    expect(approvalCategories("DELIVERY_CANCEL", {})).toEqual(["money"]);
    expect(approvalPreview("ORDER_DELIVERY", payload)).toContain("не больше 345 ₽");
    expect(approvalPreview("ORDER_DELIVERY", payload)).toContain("подъезд 2");
    expect(approvalPreview("DELIVERY_CANCEL", {})).toContain("отменить");
  });

  test("buildPayload normalizes, drops an empty comment and rejects junk", () => {
    const ctx = { agentKey: "orchestrator" };
    expect(buildPayload("ORDER_DELIVERY", { from: "  Красная   1 ", to: "Северная 5", tariff: "Экспресс", price_rub: 450, comment: "  " }, ctx))
      .toEqual({ ok: true, payload: { from: "Красная 1", to: "Северная 5", tariff: "express", price_rub: 450 } });
    expect(buildPayload("ORDER_DELIVERY", { from: "Красная 1", to: "Северная 5", tariff: "courier", price_rub: 300, comment: "подъезд 2" }, ctx))
      .toEqual({ ok: true, payload: { from: "Красная 1", to: "Северная 5", tariff: "courier", price_rub: 300, comment: "подъезд 2" } });
    expect(buildPayload("ORDER_DELIVERY", { from: "Красная 1", to: "Северная 5", tariff: "courier", price_rub: "300" }, ctx).ok).toBe(false);
    expect(buildPayload("ORDER_DELIVERY", { from: "Красная 1", to: "Северная 5", tariff: "vip", price_rub: 300 }, ctx).ok).toBe(false);
    expect(buildPayload("ORDER_DELIVERY", { from: "Красная 1", to: "Северная 5", tariff: "courier", price_rub: 300, comment: "x".repeat(201) }, ctx).ok).toBe(false);
  });
});
