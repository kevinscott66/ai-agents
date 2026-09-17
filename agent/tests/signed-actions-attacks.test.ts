/**
 * QA-атаки на гейт платных действий (задача 1c7252da): ни одно платное действие
 * не проходит без подписи, сверки и одноразового nonce. Базовые сценарии —
 * signed-actions.test.ts и native-signing.test.ts, здесь — то, что они не ловили.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { signingApi } from "../lib/native-signing.ts";
import { SignedActionRefusal, SignedActions, type SignedParams } from "../lib/signed-actions.ts";

const T0 = Date.UTC(2026, 8, 17, 9, 0, 0);
const HOUR = 3_600_000;
const LIMITS = { maxRub: 1000, dailyMax: 5, deviationPct: 15 };
const char = (code: number) => String.fromCodePoint(code);

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

async function setup(db = new Database(":memory:")) {
  const gate = new SignedActions(db, LIMITS);
  const owner = await phone();
  const { keyId, code } = await gate.registerKey("iphone", owner.spki, T0);
  gate.activateKey(keyId, code, T0);
  const order = (params: SignedParams = { from: "A", to: "B" }, amountRub = 450) =>
    gate.issue({ service: "yandex_go", action: "order_taxi", params, amountRub }, T0);
  const approved = async () => {
    const issued = order();
    await gate.approve(issued.nonce, await owner.sign(issued.payload), T0);
    return issued;
  };
  return { gate, owner, order, approved };
}

const status = (gate: SignedActions, nonce: string) =>
  (gate.db.query("SELECT status FROM signed_actions WHERE nonce=?").get(nonce) as { status: string }).status;

describe("executor cannot skip the checks", () => {
  test("success is not recorded without a passed price check", async () => {
    const { gate, approved } = await setup();
    const { nonce, payload } = await approved();
    gate.claim(nonce, payload, T0);
    expect(await refusal(() => gate.complete(nonce, true, T0))).toBe("price_unchecked");
    expect(status(gate, nonce)).toBe("executing");
    gate.checkFinal(nonce, 517, T0);
    gate.complete(nonce, true, T0);
    expect(status(gate, nonce)).toBe("executed");
  });

  test("failure can be recorded without a price, and still spends the daily limit", async () => {
    const { gate, approved } = await setup();
    const { nonce, payload } = await approved();
    gate.claim(nonce, payload, T0);
    gate.complete(nonce, false, T0);
    expect(status(gate, nonce)).toBe("failed");
    expect(await refusal(() => gate.complete(nonce, true, T0))).toBe("nonce_used");
  });

  test("junk final price aborts instead of passing", async () => {
    for (const junk of [Number.NaN, -1, 0, 450.5, Infinity]) {
      const { gate: fresh, approved } = await setup();
      const { nonce, payload } = await approved();
      fresh.claim(nonce, payload, T0);
      expect(await refusal(() => fresh.checkFinal(nonce, junk, T0))).toBe("price_deviation");
      expect(status(fresh, nonce)).toBe("aborted");
    }
  });

  test("claim is refused before approval and after rejection", async () => {
    const { gate, owner, order } = await setup();
    const issued = order();
    expect(await refusal(() => gate.claim(issued.nonce, issued.payload, T0))).toBe("nonce_used");
    gate.reject(issued.nonce, T0);
    expect(await refusal(async () => gate.approve(issued.nonce, await owner.sign(issued.payload), T0))).toBe("nonce_used");
    expect(await refusal(() => gate.claim(issued.nonce, issued.payload, T0))).toBe("nonce_used");
  });
});

describe("card shows exactly what is signed", () => {
  test("parameters the phone cannot show in full are refused at issue", async () => {
    const { order } = await setup();
    const hidden = [0x202e, 0x200b, 0x2066, 0xfeff, 0x0a, 0x0d, 0x00, 0x2028, 0x2029, 0x1b];
    for (const code of hidden) expect(await refusal(() => order({ to: `Аэропорт${char(code)}Вокзал` }))).toBe("payload_invalid");
    const bad: unknown[] = [
      { to: { street: "Красная" } },
      { to: ["Красная"] },
      { to: true },
      { to: null },
      { to: 1.5 },
      { comment: "я".repeat(301) },
      { To: "B" },
      { "to-address": "B" },
      Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`p${i}`, "x"])),
    ];
    for (const params of bad) expect(await refusal(() => order(params as SignedParams))).toBe("payload_invalid");
  });

  test("ordinary Russian addresses, emoji and numbers pass", async () => {
    const { order } = await setup();
    const { payload } = order({ from: "ул. «Красная», 1/2 — подъезд 3", to: "Аэропорт 😀", entrance: 3, comment: "я".repeat(300) });
    expect(JSON.parse(payload).params.entrance).toBe(3);
  });
});

describe("replay and races", () => {
  test("a malleated (high-S) signature cannot reuse a spent nonce", async () => {
    const { gate, owner, order } = await setup();
    const { nonce, payload } = order();
    const raw = Buffer.from(await owner.sign(payload), "base64");
    const n = BigInt("0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551");
    const s = BigInt(`0x${raw.subarray(32).toString("hex")}`);
    const flipped = Buffer.concat([raw.subarray(0, 32), Buffer.from((n - s).toString(16).padStart(64, "0"), "hex")]).toString("base64");
    await gate.approve(nonce, raw.toString("base64"), T0);
    expect(await refusal(() => gate.approve(nonce, flipped, T0))).toBe("nonce_used");
  });

  test("one valid signature raced many times approves once and claims once", async () => {
    const { gate, owner, order } = await setup();
    const { nonce, payload } = order();
    const signature = await owner.sign(payload);
    const approvals = await Promise.all(Array.from({ length: 8 }, () => refusal(() => gate.approve(nonce, signature, T0))));
    expect(approvals.filter((r) => r === "passed")).toHaveLength(1);
    expect(approvals.filter((r) => r === "nonce_used")).toHaveLength(7);
    const claims = await Promise.all(Array.from({ length: 8 }, () => refusal(() => gate.claim(nonce, payload, T0))));
    expect(claims.filter((r) => r === "passed")).toHaveLength(1);
  });

  test("approve exactly at expiry passes, one millisecond later does not", async () => {
    const { gate, owner, order } = await setup();
    const onTime = order(), late = order();
    await gate.approve(onTime.nonce, await owner.sign(onTime.payload), T0 + 120_000);
    expect(await refusal(async () => gate.approve(late.nonce, await owner.sign(late.payload), T0 + 120_001))).toBe("expired");
    expect(gate.pending(T0 + 120_001)).toEqual([]);
  });
});

describe("key substitution", () => {
  test("code sent for one key does not activate another", async () => {
    const gate = new SignedActions(new Database(":memory:"), LIMITS);
    const owner = await phone(), attacker = await phone();
    const mine = await gate.registerKey("iphone", owner.spki, T0);
    const theirs = await gate.registerKey("attacker", attacker.spki, T0);
    expect(await refusal(() => gate.activateKey(theirs.keyId, mine.code, T0))).toBe(mine.code === theirs.code ? "passed" : "code_invalid");
  });

  test("registrations are capped per day, not only per hour", async () => {
    const gate = new SignedActions(new Database(":memory:"), LIMITS);
    const { spki } = await phone();
    // Каждые 21 минуту — часовой лимит не мешает, упирается суточный.
    let accepted = 0;
    for (let i = 0; i < 60; i++) if (await refusal(() => gate.registerKey("iphone", spki, T0 + i * 21 * 60_000)) === "passed") accepted++;
    expect(accepted).toBe(10);
    expect(await refusal(() => gate.registerKey("iphone", spki, T0 + 24 * HOUR + 1))).toBe("passed");
  });

  test("actions issued for a replaced key are hidden and cannot be approved by either key", async () => {
    const { gate, owner, order } = await setup();
    const stale = order();
    const next = await phone();
    const { keyId, code } = await gate.registerKey("new", next.spki, T0);
    gate.activateKey(keyId, code, T0);
    expect(gate.pending(T0)).toEqual([]);
    expect(await refusal(async () => gate.approve(stale.nonce, await owner.sign(stale.payload), T0))).toBe("key_revoked");
    expect(await refusal(async () => gate.approve(stale.nonce, await next.sign(stale.payload), T0))).toBe("key_revoked");
    const fresh = order();
    expect(gate.pending(T0)).toEqual([fresh]);
  });

  test("gate created on an older table gains the price-check column", async () => {
    const db = new Database(":memory:");
    db.run(`CREATE TABLE signed_actions(nonce TEXT PRIMARY KEY, key_id TEXT NOT NULL, payload TEXT NOT NULL,
      status TEXT NOT NULL, amount_rub INTEGER NOT NULL, max_final_rub INTEGER NOT NULL, day TEXT,
      issued INTEGER NOT NULL, expires INTEGER NOT NULL, approved INTEGER, finished INTEGER)`);
    const { gate, approved } = await setup(db);
    const { nonce, payload } = await approved();
    gate.claim(nonce, payload, T0);
    gate.checkFinal(nonce, 450, T0);
    gate.complete(nonce, true, T0);
    expect(status(gate, nonce)).toBe("executed");
  });
});

describe("HTTP surface", () => {
  const OWNER = "999323908";
  let saved: string | undefined;
  beforeEach(() => { saved = process.env.MINIAPP_ADMIN_USER_IDS; process.env.MINIAPP_ADMIN_USER_IDS = OWNER; });
  afterEach(() => { if (saved === undefined) delete process.env.MINIAPP_ADMIN_USER_IDS; else process.env.MINIAPP_ADMIN_USER_IDS = saved; });

  test("malformed nonces, oversized and non-JSON bodies never reach the gate", async () => {
    const { gate } = await setup();
    const call = (path: string, init: RequestInit) =>
      signingApi(new Request(`https://agent.test/api/native/signing/${path}`, init), OWNER, () => true, { gate, now: () => T0, send: async () => {} });
    const post = (body: string, type = "application/json") => ({ method: "POST", headers: { "content-type": type }, body });
    for (const nonce of ["x".repeat(42), "x".repeat(44), `${"x".repeat(40)}%2F..`, `${"x".repeat(42)}=`]) {
      expect((await call(`actions/${nonce}/approve`, post("{}"))).status).toBe(404);
    }
    expect((await call(`actions/${"x".repeat(43)}/approve`, post(JSON.stringify({ signature: "A".repeat(5000) })))).status).toBe(413);
    expect((await call(`actions/${"x".repeat(43)}/approve`, post("signature=AAAA", "application/x-www-form-urlencoded"))).status).toBe(415);
    expect((await call(`actions/${"x".repeat(43)}/approve`, post(JSON.stringify({ signature: 42 })))).status).toBe(400);
    expect((await call(`actions/${"x".repeat(43)}/approve`, { method: "GET" })).status).toBe(404);
  });
});
