/**
 * Шаг 9: такси через Яндекс Go. Всё на заглушках: страница, мост и Telegram
 * подменены, настоящий браузер не запускается и заказ не делается.
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
  configureTaxi,
  executeSignedTaxi,
  handleOrderTaxi,
  handleTaxiCancel,
  hasPendingTaxiOrder,
  quoteTaxi,
  resetTaxiState,
  taxiStatus,
} from "../lib/dispatch/taxi.ts";
import { signingApi } from "../lib/native-signing.ts";
import { SignedActionRefusal, SignedActions } from "../lib/signed-actions.ts";
import {
  describeTaxiPayload,
  normalizeTaxiTariff,
  parseEtaMinutes,
  parseRubles,
  parseTaxiOutcome,
  parseTaxiRequest,
  type TaxiOrderState,
  type TaxiOutcome,
  type TaxiRequest,
  type TaxiTariff,
} from "../lib/taxi.ts";
import { checkTaxiProfile, TaxiRunner, type TaxiGuard, type TaxiPage, type TariffRow } from "../mac-daemon/taxi.ts";

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

async function refusal(action: () => unknown): Promise<string> {
  try { await action(); } catch (error) { if (error instanceof SignedActionRefusal) return error.code; throw error; }
  return "passed";
}

describe("parsing", () => {
  test("rubles, eta and tariffs", () => {
    expect(parseRubles("349 ₽")).toBe(349);
    expect(parseRubles("1\u00a0234 ₽")).toBe(1234);
    expect(parseRubles("от 349 ₽")).toBe(349);
    expect(parseRubles("349–420 ₽")).toBe(420);
    expect(parseRubles("349")).toBeNull();
    expect(parseRubles("1 2 3 ₽")).toBeNull();
    expect(parseEtaMinutes("5 мин")).toBe(5);
    expect(parseEtaMinutes("1 ч 10 мин")).toBe(70);
    expect(parseEtaMinutes("скоро")).toBeNull();
    expect(normalizeTaxiTariff("Комфорт+")).toBe("comfortplus");
    expect(normalizeTaxiTariff("эконом")).toBe("econom");
    expect(normalizeTaxiTariff("vip")).toBeNull();
  });

  test("daemon frame is strict", () => {
    expect(parseTaxiRequest({ op: "quote", from: "Красная 1", to: "Аэропорт" })).toEqual({ op: "quote", from: "Красная 1", to: "Аэропорт" });
    expect(parseTaxiRequest({ op: "quote", from: " Красная 1", to: "Аэропорт" })).toBeNull();
    expect(parseTaxiRequest({ op: "quote", from: "Красная\u200b 1", to: "Аэропорт" })).toBeNull();
    expect(parseTaxiRequest({ op: "confirm", session: SESSION, maxRub: 500, extra: 1 })).toBeNull();
    expect(parseTaxiRequest({ op: "confirm", session: "short", maxRub: 500 })).toBeNull();
    expect(parseTaxiRequest({ op: "confirm", session: SESSION, maxRub: 1.5 })).toBeNull();
    expect(parseTaxiRequest({ op: "prepare", session: SESSION, from: "Красная 1", to: "Аэропорт", tariff: "vip" })).toBeNull();
    expect(parseTaxiRequest({ op: "cancel" })).toEqual({ op: "cancel" });
  });

  test("daemon answer is checked, junk throws", () => {
    expect(parseTaxiOutcome('{"ok":false,"code":"captcha","screenshot":"QUJD"}', "quote")).toEqual({ ok: false, code: "captcha", screenshot: "QUJD" });
    expect(() => parseTaxiOutcome('{"ok":false,"code":"whatever"}', "quote")).toThrow("invalid_taxi_result");
    expect(() => parseTaxiOutcome('{"ok":true,"op":"confirm","state":"searching"}', "prepare")).toThrow("invalid_taxi_result");
    expect(() => parseTaxiOutcome('{"ok":true,"op":"prepare","tariff":"econom","price_rub":-1,"eta_min":3}', "prepare")).toThrow();
    expect(() => parseTaxiOutcome('{"ok":true,"op":"quote","options":[{"tariff":"econom","price_rub":300,"eta_min":3},{"tariff":"econom","price_rub":310,"eta_min":3}]}', "quote")).toThrow();
  });

  test("approval card matches what the phone signs", () => {
    expect(describeTaxiPayload({ from: "Красная 1", to: "Аэропорт", tariff: "comfort", price_rub: 400 }, 15))
      .toBe("такси Комфорт: Красная 1 → Аэропорт, 400 ₽ (списание не больше 460 ₽), дальше — подпись на телефоне");
    expect(describeTaxiPayload({ from: "Красная 1", to: "Аэропорт", tariff: "comfort", price_rub: "400" }, 15)).toBe("некорректный заказ такси");
  });
});

/** Страница-заглушка: ведёт журнал нажатий, цену и состояние можно менять по ходу. */
function fakePage(init: Partial<{ guard: TaxiGuard; rows: TariffRow[]; button: number | null; state: TaxiOrderState; route: boolean }> = {}) {
  const s = {
    guard: init.guard ?? ("ok" as TaxiGuard),
    rows: init.rows ?? [
      { tariff: "econom" as TaxiTariff, price_rub: 350, eta_min: 4, selected: true },
      { tariff: "comfort" as TaxiTariff, price_rub: 480, eta_min: 6, selected: false },
    ],
    button: init.button === undefined ? 350 : init.button,
    state: init.state ?? ("none" as TaxiOrderState),
    route: init.route ?? true,
    stateAfterClick: "searching" as TaxiOrderState,
    clicks: [] as string[],
  };
  const page: TaxiPage = {
    open: async () => {},
    url: () => "https://taxi.example.com/",
    guard: async () => s.guard,
    setRoute: async () => s.route,
    tariffs: async () => s.rows.map((r) => ({ ...r })),
    selectTariff: async (t) => {
      s.clicks.push(`tariff:${t}`);
      s.rows = s.rows.map((r) => ({ ...r, selected: r.tariff === t }));
    },
    orderButton: async () => (s.button === null ? null : { label: `Заказать ${s.button} ₽`, price_rub: s.button }),
    clickOrder: async () => { s.clicks.push("order"); s.state = s.stateAfterClick; },
    orderState: async () => ({ state: s.state, driver: null }),
    cancelOrder: async () => { s.clicks.push("cancel"); s.state = "cancelled"; return "clicked"; },
    screenshot: async () => "U0NSRUVO",
    probe: async () => "",
  };
  return { s, page };
}

function runner(page: TaxiPage, env: Record<string, string> = { TAXI_ENABLED: "true", TAXI_PROFILE_DIR: "/profile" }, now = () => T0) {
  return new TaxiRunner(env, {
    launch: async () => ({ page: () => page, close: async () => {} }),
    checkProfile: (dir) => dir ?? "",
    now,
    sleep: async () => {},
    idleMs: 60_000,
  });
}

describe("mac runner", () => {
  const prepare: TaxiRequest = { op: "prepare", session: SESSION, from: "Красная 1", to: "Аэропорт", tariff: "comfort" };

  test("disabled by default, nothing is launched", async () => {
    let launched = false;
    const r = new TaxiRunner({}, { launch: async () => { launched = true; throw new Error("no"); } });
    expect(await r.run({ op: "status" })).toEqual({ ok: false, code: "taxi_disabled" });
    expect(launched).toBe(false);
  });

  test("quote lists readable prices and never clicks", async () => {
    const { s, page } = fakePage();
    const r = runner(page);
    expect(await r.run({ op: "quote", from: "Красная 1", to: "Аэропорт" })).toEqual({
      ok: true, op: "quote", options: [{ tariff: "econom", price_rub: 350, eta_min: 4 }, { tariff: "comfort", price_rub: 480, eta_min: 6 }],
    });
    expect(s.clicks).toEqual([]);
    await r.close();
  });

  test("captcha and login stop with a screenshot, nothing is touched", async () => {
    for (const guard of ["captcha", "login_required"] as const) {
      const { s, page } = fakePage({ guard });
      const r = runner(page);
      expect(await r.run(prepare)).toEqual({ ok: false, code: guard, screenshot: "U0NSRUVO" });
      expect(s.clicks).toEqual([]);
      await r.close();
    }
  });

  test("a captcha that replaces address suggestions is still a captcha", async () => {
    const { s, page } = fakePage({ route: false });
    const guards: TaxiGuard[] = ["ok", "captcha"];
    page.guard = async () => guards.shift() ?? "captcha";
    const r = runner(page);
    expect((await r.run(prepare) as { code: string }).code).toBe("captcha");
    expect(s.clicks).toEqual([]);
    await r.close();
  });

  test("prepare selects the tariff; confirm clicks once when the price holds", async () => {
    const { s, page } = fakePage();
    const r = runner(page);
    s.button = 480;
    expect(await r.run(prepare)).toEqual({ ok: true, op: "prepare", tariff: "comfort", price_rub: 480, eta_min: 6 });
    expect(await r.run({ op: "confirm", session: SESSION, maxRub: 552 })).toEqual({ ok: true, op: "confirm", state: "searching" });
    expect(s.clicks).toEqual(["tariff:comfort", "order"]);
    // Сессия одноразовая.
    expect(await r.run({ op: "confirm", session: SESSION, maxRub: 552 })).toEqual({ ok: false, code: "session_unknown" });
    expect(s.clicks.filter((c) => c === "order")).toHaveLength(1);
    await r.close();
  });

  test("price above the signed ceiling: no click, session is gone", async () => {
    const { s, page } = fakePage();
    const r = runner(page);
    s.button = 480;
    await r.run(prepare);
    s.button = 600; // кнопка дороже карточки — берётся большая цена
    expect(await r.run({ op: "confirm", session: SESSION, maxRub: 552 })).toEqual({ ok: false, code: "price_changed", price_rub: 600, screenshot: "U0NSRUVO" });
    expect(s.clicks).not.toContain("order");
    s.button = 480;
    expect(await r.run({ op: "confirm", session: SESSION, maxRub: 552 })).toEqual({ ok: false, code: "session_unknown" });
    expect(s.clicks).not.toContain("order");
    await r.close();
  });

  test("session expires and a foreign session cannot confirm", async () => {
    let now = T0;
    const { s, page } = fakePage();
    const r = runner(page, undefined, () => now);
    await r.run({ ...prepare, tariff: "econom" });
    expect(await r.run({ op: "confirm", session: "other_0123456789abcd", maxRub: 500 })).toEqual({ ok: false, code: "session_unknown" });
    await r.run({ ...prepare, tariff: "econom" });
    now += 3 * 60_000 + 1;
    expect(await r.run({ op: "confirm", session: SESSION, maxRub: 500 })).toEqual({ ok: false, code: "session_unknown" });
    expect(s.clicks).not.toContain("order");
    await r.close();
  });

  test("an unreadable price or missing button never becomes a click", async () => {
    const { s, page } = fakePage({ button: null });
    const r = runner(page);
    expect((await r.run({ ...prepare, tariff: "econom" }) as { code: string }).code).toBe("order_button_missing");
    s.button = 350;
    s.rows = [{ tariff: "econom", price_rub: null, eta_min: null, selected: true }];
    page.orderButton = async () => ({ label: "Заказать", price_rub: null });
    expect((await r.run({ ...prepare, tariff: "econom" }) as { code: string }).code).toBe("price_unreadable");
    expect(s.clicks).toEqual([]);
    await r.close();
  });

  test("after the click the page state decides, not an error code", async () => {
    const { s, page } = fakePage();
    const r = runner(page);
    s.stateAfterClick = "none";
    await r.run({ ...prepare, tariff: "econom" });
    expect(await r.run({ op: "confirm", session: SESSION, maxRub: 400 })).toEqual({ ok: true, op: "confirm", state: "unknown" });
    await r.close();
  });

  test("cancel needs an active order", async () => {
    const { s, page } = fakePage();
    const r = runner(page);
    expect((await r.run({ op: "cancel" }) as { code: string }).code).toBe("no_active_order");
    s.state = "driver_assigned";
    expect(await r.run({ op: "cancel" })).toEqual({ ok: true, op: "cancel", state: "cancelled" });
    await r.close();
  });

  test("profile must be private", () => {
    const dir = mkdtempSync(join(tmpdir(), "taxi-profile-"));
    try {
      chmodSync(dir, 0o755);
      expect(() => checkTaxiProfile(dir)).toThrow("profile_insecure");
      chmodSync(dir, 0o700);
      expect(checkTaxiProfile(dir)).toBe(dir);
      expect(() => checkTaxiProfile("relative/dir")).toThrow("profile_missing");
      expect(() => checkTaxiProfile(join(dir, "missing"))).toThrow("profile_missing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("gate abort", () => {
  test("aborted action frees the daily slot and cannot be reused", async () => {
    const gate = new SignedActions(new Database(":memory:"), { maxRub: 1000, dailyMax: 1, deviationPct: 15 });
    const owner = await phone();
    const { keyId, code } = await gate.registerKey("iphone", owner.spki, T0);
    gate.activateKey(keyId, code, T0);
    const first = gate.issue({ service: "yandex_go", action: "order_taxi", params: { from: "A", to: "B", tariff: "Эконом" }, amountRub: 300 }, T0);
    expect(await refusal(() => gate.abort(first.nonce, T0))).toBe("nonce_used");
    expect(await refusal(() => gate.abort("x".repeat(43), T0))).toBe("nonce_unknown");
    await gate.approve(first.nonce, await owner.sign(first.payload), T0);
    gate.claim(first.nonce, first.payload, T0);
    gate.abort(first.nonce, T0);
    expect(await refusal(() => gate.abort(first.nonce, T0))).toBe("nonce_used");
    expect(await refusal(() => gate.claim(first.nonce, first.payload, T0))).toBe("nonce_used");
    const second = gate.issue({ service: "yandex_go", action: "order_taxi", params: { from: "A", to: "B", tariff: "Эконом" }, amountRub: 300 }, T0);
    await gate.approve(second.nonce, await owner.sign(second.payload), T0);
  });
});

describe("signing hook", () => {
  test("executor starts only after a valid signature", async () => {
    const names = ["NATIVE_APP_ENABLED", "MAC_USER_IDS", "TELEGRAM_ALLOWED_GROUP_IDS", "MINIAPP_ADMIN_USER_IDS"];
    const saved = Object.fromEntries(names.map((k) => [k, process.env[k]]));
    for (const k of names) process.env[k] = String(OWNER);
    try {
    const gate = new SignedActions(new Database(":memory:"), { maxRub: 1000, dailyMax: 5, deviationPct: 15 });
    const owner = await phone();
    const { keyId, code } = await gate.registerKey("iphone", owner.spki, T0);
    gate.activateKey(keyId, code, T0);
    const started: string[] = [];
    const call = (path: string, body: unknown) => signingApi(
      new Request(`https://agent.test/api/native/signing/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      String(OWNER),
      () => true,
      { gate, now: () => T0, send: async () => {}, execute: async (nonce) => { started.push(nonce); } },
    );
    const a = gate.issue({ service: "yandex_go", action: "order_taxi", params: { from: "A", to: "B", tariff: "Эконом" }, amountRub: 300 }, T0);
    const b = gate.issue({ service: "yandex_go", action: "order_taxi", params: { from: "A", to: "C", tariff: "Эконом" }, amountRub: 300 }, T0);
    expect((await call(`actions/${a.nonce}/approve`, { signature: await owner.sign(b.payload) })).status).toBe(400);
    expect((await call(`actions/${b.nonce}/reject`, {})).status).toBe(200);
    expect(started).toEqual([]);
    const c = gate.issue({ service: "yandex_go", action: "order_taxi", params: { from: "A", to: "D", tariff: "Эконом" }, amountRub: 300 }, T0);
    expect((await call(`actions/${c.nonce}/approve`, { signature: await owner.sign(c.payload) })).status).toBe(200);
    expect(started).toEqual([c.nonce]);
    } finally {
      for (const k of names) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
  });
});

const ENV_KEYS = ["TAXI_ENABLED", "MINIAPP_ADMIN_USER_IDS"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

type Script = Partial<Record<TaxiRequest["op"], TaxiOutcome | Error>>;

async function harness(script: Script) {
  const gate = new SignedActions(new Database(":memory:"), { maxRub: 1000, dailyMax: 5, deviationPct: 15 });
  const owner = await phone();
  const { keyId, code } = await gate.registerKey("iphone", owner.spki, T0);
  gate.activateKey(keyId, code, T0);
  const requests: TaxiRequest[] = [];
  const texts: string[] = [];
  const photos: string[] = [];
  const restore = configureTaxi({
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
  const quote = () => quoteTaxi({ from: "Красная 1", to: "Аэропорт" }, ctx);
  const order = (price = 480, tariff: TaxiTariff = "comfort") =>
    handleOrderTaxi({ from: "Красная 1", to: "Аэропорт", tariff, price_rub: price, _userId: String(OWNER) }, { agentKey: "orchestrator", chatId: OWNER });
  const nonceOf = () => gate.pending(T0).at(-1)!;
  const sign = async () => {
    const { nonce, payload } = nonceOf();
    await gate.approve(nonce, await owner.sign(payload), T0);
    return nonce;
  };
  const status = (nonce: string) => (gate.db.query("SELECT status FROM signed_actions WHERE nonce=?").get(nonce) as { status: string }).status;
  return { gate, requests, texts, photos, restore, ctx, quote, order, sign, status, nonceOf };
}

const QUOTE: TaxiOutcome = { ok: true, op: "quote", options: [{ tariff: "econom", price_rub: 350, eta_min: 4 }, { tariff: "comfort", price_rub: 480, eta_min: 6 }] };
const PREPARED: TaxiOutcome = { ok: true, op: "prepare", tariff: "comfort", price_rub: 500, eta_min: 6 };

describe("server flow", () => {
  let h: Awaited<ReturnType<typeof harness>> | null = null;
  beforeEach(() => {
    resetTaxiState();
    process.env.TAXI_ENABLED = "true";
    process.env.MINIAPP_ADMIN_USER_IDS = `123,${OWNER}`;
  });
  afterEach(() => {
    h?.restore();
    h = null;
    resetTaxiState();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
    }
  });

  test("owner only, own chat, not delegated, orchestrator only", async () => {
    h = await harness({ quote: QUOTE, status: { ok: true, op: "status", state: "none", driver: null } });
    expect((await quoteTaxi({ from: "Красная 1", to: "Аэропорт" }, { ...h.ctx, chatId: -100 })).ok).toBe(false);
    expect((await quoteTaxi({ from: "Красная 1", to: "Аэропорт" }, { ...h.ctx, triggerUserId: "123", chatId: 123, agentKey: "qa" })).ok).toBe(false);
    expect((await quoteTaxi({ from: "Красная 1", to: "Аэропорт" }, { ...h.ctx, triggerUserId: "555", chatId: 555 })).ok).toBe(false);
    expect((await quoteTaxi({ from: "Красная 1", to: "Аэропорт" }, { ...h.ctx, delegationChain: ["orchestrator", "devops"] })).ok).toBe(false);
    expect((await handleTaxiCancel({ _userId: String(OWNER), _delegated: true }, { agentKey: "orchestrator", chatId: OWNER })).ok).toBe(false);
    expect(h.requests).toEqual([]);
    expect((await taxiStatus(h.ctx)).ok).toBe(true);
    process.env.TAXI_ENABLED = "false";
    expect((await taxiStatus(h.ctx)).ok).toBe(false);
  });

  test("order requires a fresh matching quote and issues a nonce, nothing is ordered yet", async () => {
    h = await harness({ quote: QUOTE });
    expect((await h.order()).ok).toBe(false);
    expect((await h.quote()).ok).toBe(true);
    expect((await h.order(470)).ok).toBe(false);
    expect((await h.order(480, "business")).ok).toBe(false);
    const res = await h.order();
    expect(res).toMatchObject({ ok: true, result: { status: "awaiting_signature", price_rub: 480, max_final_rub: 552 } });
    const { nonce, payload } = h.nonceOf();
    expect(JSON.parse(payload)).toMatchObject({ service: "yandex_go", action: "order_taxi", params: { from: "Красная 1", to: "Аэропорт", tariff: "Комфорт" }, amount_rub: 480 });
    expect(hasPendingTaxiOrder(nonce)).toBe(true);
    expect(h.requests.map((r) => r.op)).toEqual(["quote"]);
  });

  test("gate refusals come back readable", async () => {
    h = await harness({ quote: { ok: true, op: "quote", options: [{ tariff: "business", price_rub: 1500, eta_min: 9 }] } });
    await h.quote();
    const res = await h.order(1500, "business");
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain("лимита");
  });

  test("signed order: prepare, price check, one confirm, success message", async () => {
    h = await harness({ quote: QUOTE, prepare: PREPARED, confirm: { ok: true, op: "confirm", state: "searching" } });
    await h.quote();
    await h.order();
    const nonce = await h.sign();
    await executeSignedTaxi(nonce);
    expect(h.requests.map((r) => r.op)).toEqual(["quote", "prepare", "confirm"]);
    expect(h.requests[1]).toEqual({ op: "prepare", session: SESSION, from: "Красная 1", to: "Аэропорт", tariff: "comfort" });
    expect(h.requests[2]).toEqual({ op: "confirm", session: SESSION, maxRub: 552 });
    expect(h.status(nonce)).toBe("executed");
    expect(h.texts).toHaveLength(1);
    expect(h.texts[0]).toContain("заказано");
    // Повторный вызов исполнителя ничего не делает.
    await executeSignedTaxi(nonce);
    expect(h.requests).toHaveLength(3);
  });

  test("price above the ceiling: abandon, no confirm, aborted", async () => {
    h = await harness({ quote: QUOTE, prepare: { ...PREPARED, price_rub: 600 }, abandon: { ok: true, op: "abandon" } });
    await h.quote();
    await h.order();
    const nonce = await h.sign();
    await executeSignedTaxi(nonce);
    expect(h.requests.map((r) => r.op)).toEqual(["quote", "prepare", "abandon"]);
    expect(h.status(nonce)).toBe("aborted");
    expect(h.texts[0]).toContain("600");
  });

  test("captcha before the click: aborted, owner gets the screenshot", async () => {
    h = await harness({ quote: QUOTE, prepare: { ok: false, code: "captcha", screenshot: "U0NSRUVO" } });
    await h.quote();
    await h.order();
    const nonce = await h.sign();
    await executeSignedTaxi(nonce);
    expect(h.requests.map((r) => r.op)).toEqual(["quote", "prepare"]);
    expect(h.status(nonce)).toBe("aborted");
    expect(h.photos).toHaveLength(1);
    expect(h.photos[0]).toContain("капч");
  });

  test("bridge failure on confirm: failed, counted, never retried", async () => {
    h = await harness({ quote: QUOTE, prepare: PREPARED, confirm: new Error("mac_timeout") });
    await h.quote();
    await h.order();
    const nonce = await h.sign();
    await executeSignedTaxi(nonce);
    expect(h.requests.map((r) => r.op)).toEqual(["quote", "prepare", "confirm"]);
    expect(h.status(nonce)).toBe("failed");
    expect(h.texts[0]).toContain("Не знаю");
  });

  test("pre-click refusal on confirm aborts; unclear state after click fails", async () => {
    h = await harness({ quote: QUOTE, prepare: PREPARED, confirm: { ok: false, code: "price_changed", price_rub: 700 } });
    await h.quote();
    await h.order();
    let nonce = await h.sign();
    await executeSignedTaxi(nonce);
    expect(h.status(nonce)).toBe("aborted");
    h.restore();

    h = await harness({ quote: QUOTE, prepare: PREPARED, confirm: { ok: true, op: "confirm", state: "unknown" } });
    resetTaxiState();
    await h.quote();
    await h.order();
    nonce = await h.sign();
    await executeSignedTaxi(nonce);
    expect(h.status(nonce)).toBe("failed");
    expect(h.texts[0]).toContain("Не знаю");
  });

  test("unknown nonce is ignored", async () => {
    h = await harness({});
    await executeSignedTaxi("x".repeat(43));
    expect(h.requests).toEqual([]);
    expect(h.texts).toEqual([]);
  });
});

describe("chat approval", () => {
  test("order and cancel are money; preview shows the ceiling", () => {
    const payload = { from: "Красная 1", to: "Аэропорт", tariff: "econom", price_rub: 350 };
    expect(approvalCategories("ORDER_TAXI", payload)).toEqual(["money"]);
    expect(approvalCategories("TAXI_CANCEL", {})).toEqual(["money"]);
    expect(approvalPreview("ORDER_TAXI", payload)).toContain("не больше 402 ₽");
    expect(approvalPreview("TAXI_CANCEL", {})).toContain("отменить");
  });

  test("buildPayload normalizes and rejects junk", () => {
    expect(buildPayload("ORDER_TAXI", { from: "  Красная   1 ", to: "Аэропорт", tariff: "Комфорт+", price_rub: 500 }, { agentKey: "orchestrator" }))
      .toEqual({ ok: true, payload: { from: "Красная 1", to: "Аэропорт", tariff: "comfortplus", price_rub: 500 } });
    expect(buildPayload("ORDER_TAXI", { from: "Красная 1", to: "Аэропорт", tariff: "econom", price_rub: "500" }, { agentKey: "orchestrator" }).ok).toBe(false);
    expect(buildPayload("ORDER_TAXI", { from: "Кр", to: "Аэропорт", tariff: "econom", price_rub: 500 }, { agentKey: "orchestrator" }).ok).toBe(false);
    expect(buildPayload("ORDER_TAXI", { from: "Красная 1", to: "Аэропорт", tariff: "vip", price_rub: 500 }, { agentKey: "orchestrator" }).ok).toBe(false);
  });
});
