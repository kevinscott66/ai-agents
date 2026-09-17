import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { canonicalJson, limitsFromEnv, SignedActionRefusal, SignedActions } from "../lib/signed-actions.ts";

const T0 = Date.UTC(2026, 8, 17, 9, 0, 0); // 12:00 по Москве

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

async function setup(limits = { maxRub: 1000, dailyMax: 5, deviationPct: 15 }) {
  const gate = new SignedActions(new Database(":memory:"), limits);
  const owner = await phone();
  const { keyId, code } = await gate.registerKey("iphone", owner.spki, T0);
  gate.activateKey(keyId, code, T0);
  const order = (amountRub = 450, now = T0) =>
    gate.issue({ service: "yandex_go", action: "order_taxi", params: { from: "A", to: "B", tariff: "econom" }, amountRub }, now);
  return { gate, owner, keyId, order };
}

describe("canonical payload", () => {
  test("sorts keys, has no spaces and rejects non-integers", () => {
    expect(canonicalJson({ b: 1, a: [true, null, "ё"], c: { z: 0, y: -2 } })).toBe('{"a":[true,null,"ё"],"b":1,"c":{"y":-2,"z":0}}');
    for (const bad of [1.5, NaN, Infinity, undefined, new Date(0), "\uD800"]) {
      expect(() => canonicalJson({ x: bad })).toThrow("payload_invalid");
    }
  });
  test("limits default to the owner decision and reject junk", () => {
    expect(limitsFromEnv({})).toEqual({ maxRub: 1000, dailyMax: 5, deviationPct: 15 });
    expect(() => limitsFromEnv({ PAID_ACTION_MAX_RUB: "1e3" })).toThrow();
    expect(() => limitsFromEnv({ PAID_ACTION_DAILY_MAX: "0" })).toThrow();
  });
});

describe("key registration", () => {
  test("pending key cannot sign until the out-of-band code is entered", async () => {
    const gate = new SignedActions(new Database(":memory:"), { maxRub: 1000, dailyMax: 5, deviationPct: 15 });
    const owner = await phone();
    expect(await refusal(() => gate.registerKey("iphone", "not-a-key", T0))).toBe("key_invalid");
    expect(await refusal(() => gate.registerKey("iphone", Buffer.from("x".repeat(91)).toString("base64"), T0))).toBe("key_invalid");
    const { keyId, code } = await gate.registerKey("iphone", owner.spki, T0);
    expect(code).toMatch(/^\d{6}$/);
    expect(await refusal(() => gate.issue({ service: "s", action: "a", params: {}, amountRub: 1 }, T0))).toBe("no_active_key");
    const wrong = code === "000000" ? "000001" : "000000";
    expect(await refusal(() => gate.activateKey(keyId, wrong, T0))).toBe("code_invalid");
    gate.activateKey(keyId, code, T0);
    expect(await refusal(() => gate.activateKey(keyId, code, T0))).toBe("key_not_pending");
  });

  test("code expires and locks after five wrong attempts", async () => {
    const gate = new SignedActions(new Database(":memory:"), { maxRub: 1000, dailyMax: 5, deviationPct: 15 });
    const owner = await phone();
    const late = await gate.registerKey("iphone", owner.spki, T0);
    expect(await refusal(() => gate.activateKey(late.keyId, late.code, T0 + 11 * 60_000))).toBe("code_expired");
    const guessed = await gate.registerKey("iphone", owner.spki, T0);
    const wrong = guessed.code === "000000" ? "000001" : "000000";
    for (let i = 0; i < 5; i++) expect(await refusal(() => gate.activateKey(guessed.keyId, wrong, T0))).toBe("code_invalid");
    expect(await refusal(() => gate.activateKey(guessed.keyId, guessed.code, T0))).toBe("code_attempts");
  });

  test("new phone revokes the old key, including for already issued actions", async () => {
    const { gate, owner, order } = await setup();
    const { nonce, payload } = order();
    const next = await phone();
    const { keyId, code } = await gate.registerKey("new-iphone", next.spki, T0);
    gate.activateKey(keyId, code, T0);
    expect(await refusal(() => gate.approve(nonce, "", T0))).toBe("key_revoked");
    expect(await refusal(async () => gate.approve(nonce, await owner.sign(payload), T0))).toBe("key_revoked");
    const fresh = order();
    expect(JSON.parse(fresh.payload).key_id).toBe(keyId);
    await gate.approve(fresh.nonce, await next.sign(fresh.payload), T0);
  });
});

describe("paid action attacks", () => {
  test("happy path executes exactly the signed parameters once", async () => {
    const { gate, owner, order } = await setup();
    const { nonce, payload } = order(450);
    expect(JSON.parse(payload)).toMatchObject({ v: 1, amount_rub: 450, max_final_rub: 517, nonce, expires_at: T0 / 1000 + 120 });
    await gate.approve(nonce, await owner.sign(payload), T0 + 10_000);
    expect(gate.claim(nonce, payload, T0 + 20_000)).toEqual({ service: "yandex_go", action: "order_taxi", params: { from: "A", tariff: "econom", to: "B" }, amountRub: 450, maxFinalRub: 517 });
    gate.checkFinal(nonce, 517, T0 + 30_000);
    gate.complete(nonce, true, T0 + 40_000);
    expect(await refusal(() => gate.claim(nonce, payload, T0 + 50_000))).toBe("nonce_used");
    expect(await refusal(() => gate.complete(nonce, true, T0 + 50_000))).toBe("nonce_used");
  });

  test("replayed signature, double claim and unknown nonce are refused", async () => {
    const { gate, owner, order } = await setup();
    const { nonce, payload } = order();
    const signature = await owner.sign(payload);
    await gate.approve(nonce, signature, T0);
    expect(await refusal(() => gate.approve(nonce, signature, T0))).toBe("nonce_used");
    gate.claim(nonce, payload, T0);
    expect(await refusal(() => gate.claim(nonce, payload, T0))).toBe("nonce_used");
    expect(await refusal(() => gate.approve("nope", signature, T0))).toBe("nonce_unknown");
    const other = order();
    expect(await refusal(() => gate.approve(other.nonce, signature, T0))).toBe("signature_invalid");
    expect(await refusal(async () => gate.approve(other.nonce, await owner.sign(other.payload), T0))).toBe("nonce_used");
  });

  test("substituted amount, tariff or route after signing never executes", async () => {
    const { gate, owner, order } = await setup();
    const { nonce, payload } = order(450);
    await gate.approve(nonce, await owner.sign(payload), T0);
    for (const forged of [
      payload.replace('"amount_rub":450', '"amount_rub":950'),
      payload.replace('"econom"', '"comfortplus"'),
      payload.replace('"to":"B"', '"to":"C"'),
      payload + " ",
    ]) expect(await refusal(() => gate.claim(nonce, forged, T0))).toBe("payload_mismatch");
    gate.claim(nonce, payload, T0);
  });

  test("signature over a forged payload or from a foreign key is rejected and burns the nonce", async () => {
    const { gate, owner, order } = await setup();
    const forged = order();
    const tampered = forged.payload.replace('"amount_rub":450', '"amount_rub":45');
    expect(await refusal(async () => gate.approve(forged.nonce, await owner.sign(tampered), T0))).toBe("signature_invalid");
    expect(await refusal(async () => gate.approve(forged.nonce, await owner.sign(forged.payload), T0))).toBe("nonce_used");
    const stranger = await phone();
    const foreign = order();
    expect(await refusal(async () => gate.approve(foreign.nonce, await stranger.sign(foreign.payload), T0))).toBe("signature_invalid");
    const malformed = order();
    for (const junk of ["", "AAAA", Buffer.alloc(65).toString("base64"), "!".repeat(88)]) {
      const fresh = order();
      expect(await refusal(() => gate.approve(fresh.nonce, junk, T0))).toBe("signature_invalid");
    }
    expect(await refusal(async () => gate.approve(malformed.nonce, (await owner.sign(malformed.payload)).replace(/=*$/, ""), T0))).toBe("signature_invalid");
  });

  test("expired approval and stale claim are refused", async () => {
    const { gate, owner, order } = await setup();
    const late = order();
    expect(await refusal(async () => gate.approve(late.nonce, await owner.sign(late.payload), T0 + 121_000))).toBe("expired");
    const slow = order();
    await gate.approve(slow.nonce, await owner.sign(slow.payload), T0 + 60_000);
    expect(await refusal(() => gate.claim(slow.nonce, slow.payload, T0 + 60_000 + 301_000))).toBe("expired");
  });

  test("amount ceiling and daily limit hold, including across concurrent approvals", async () => {
    const { gate, owner, order } = await setup({ maxRub: 1000, dailyMax: 2, deviationPct: 15 });
    expect(await refusal(() => order(1001))).toBe("limit_amount");
    expect(await refusal(() => order(0))).toBe("payload_invalid");
    expect(await refusal(() => order(10.5))).toBe("payload_invalid");
    const issued = [order(), order(), order()];
    const results = await Promise.all(issued.map(async ({ nonce, payload }) => refusal(async () => gate.approve(nonce, await owner.sign(payload), T0))));
    expect(results.filter((r) => r === "passed").length).toBe(2);
    expect(results.filter((r) => r === "limit_daily").length).toBe(1);
    expect(await refusal(() => order())).toBe("limit_daily");
    // Новые сутки по Москве начинаются в 21:00 UTC.
    const tomorrow = Date.UTC(2026, 8, 17, 21, 0, 1);
    const next = order(450, tomorrow);
    await gate.approve(next.nonce, await owner.sign(next.payload), tomorrow);
  });

  test("price above the signed threshold aborts and still counts nothing extra", async () => {
    const { gate, owner, order } = await setup();
    const { nonce, payload } = order(450);
    await gate.approve(nonce, await owner.sign(payload), T0);
    gate.claim(nonce, payload, T0);
    expect(await refusal(() => gate.checkFinal(nonce, 518, T0))).toBe("price_deviation");
    expect(await refusal(() => gate.complete(nonce, true, T0))).toBe("nonce_used");
    expect(await refusal(() => gate.checkFinal(nonce, 400, T0))).toBe("nonce_used");
  });

  test("restart turns an in-flight execution into failed instead of replaying it", async () => {
    const db = new Database(":memory:");
    const gate = new SignedActions(db, { maxRub: 1000, dailyMax: 5, deviationPct: 15 });
    const owner = await phone();
    const { keyId, code } = await gate.registerKey("iphone", owner.spki, T0);
    gate.activateKey(keyId, code, T0);
    const { nonce, payload } = gate.issue({ service: "yandex_go", action: "order_taxi", params: {}, amountRub: 300 }, T0);
    await gate.approve(nonce, await owner.sign(payload), T0);
    gate.claim(nonce, payload, T0);
    const restarted = new SignedActions(db, { maxRub: 1000, dailyMax: 5, deviationPct: 15 });
    expect(await refusal(() => restarted.complete(nonce, true, T0))).toBe("nonce_used");
    expect((db.query("SELECT status FROM signed_actions WHERE nonce=?").get(nonce) as { status: string }).status).toBe("failed");
  });
});
