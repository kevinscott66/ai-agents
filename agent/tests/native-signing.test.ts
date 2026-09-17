import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { NativeAccess } from "../lib/native-access.ts";
import { nativeApi } from "../lib/native-api.ts";
import { deviceLabel, signingApi } from "../lib/native-signing.ts";
import { SignedActions } from "../lib/signed-actions.ts";

const OWNER = "999323908";
const T0 = Date.UTC(2026, 8, 17, 9, 0, 0);
const names = ["NATIVE_APP_ENABLED", "MAC_USER_IDS", "TELEGRAM_ALLOWED_GROUP_IDS", "MINIAPP_ADMIN_USER_IDS"];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(names.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { NATIVE_APP_ENABLED: "true", MAC_USER_IDS: OWNER, TELEGRAM_ALLOWED_GROUP_IDS: OWNER, MINIAPP_ADMIN_USER_IDS: OWNER });
});
afterEach(() => { for (const k of names) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

async function phone() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const spki = Buffer.from(await crypto.subtle.exportKey("spki", pair.publicKey)).toString("base64");
  const sign = async (payload: string) =>
    Buffer.from(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(payload))).toString("base64");
  return { spki, sign };
}

function harness() {
  const gate = new SignedActions(new Database(":memory:"), { maxRub: 1000, dailyMax: 5, deviationPct: 15 });
  const sent: { userId: string; text: string }[] = [];
  let authorized = true;
  let failDelivery = false;
  const call = (path: string, body?: unknown) => signingApi(
    new Request(`https://agent.test/api/native/signing/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    OWNER,
    () => authorized,
    { gate, now: () => T0, send: async (userId, text) => { if (failDelivery) throw new Error("telegram down"); sent.push({ userId, text }); } },
  );
  return { gate, sent, call, revoke: () => { authorized = false; }, breakDelivery: () => { failDelivery = true; } };
}

describe("native signing endpoints", () => {
  test("key is registered, code goes only to the owner's Telegram and activates the key", async () => {
    const { call, sent } = harness();
    const owner = await phone();
    expect(await (await call("key")).json()).toEqual({ key: null });
    const registered = await call("keys", { device: "iPhone <b>Пети</b>", spki: owner.spki });
    expect(registered.status).toBe(201);
    const { keyId, code } = await registered.json() as { keyId: string; code?: string };
    expect(code).toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0].userId).toBe(OWNER);
    expect(sent[0].text).toContain("«iPhone bПетиb»");
    const delivered = sent[0].text.match(/: (\d{6})\n/)![1];
    expect((await call(`keys/${keyId}/activate`, { code: "12345" })).status).toBe(400);
    const activated = await call(`keys/${keyId}/activate`, { code: delivered });
    expect(activated.status).toBe(200);
    expect(((await (await call("key")).json()) as { key: { id: string } }).key.id).toBe(keyId);
  });

  test("failed code delivery leaves no pending key behind", async () => {
    const { call, gate, breakDelivery } = harness();
    breakDelivery();
    const response = await call("keys", { device: "iPhone", spki: (await phone()).spki });
    expect(response.status).toBe(502);
    expect(gate.db.query("SELECT status FROM signed_action_keys").all()).toEqual([{ status: "revoked" }]);
  });

  test("registration spam is capped", async () => {
    const { call } = harness();
    const owner = await phone();
    for (let i = 0; i < 3; i++) expect((await call("keys", { device: "iPhone", spki: owner.spki })).status).toBe(201);
    expect(await (await call("keys", { device: "iPhone", spki: owner.spki })).json()).toEqual({ error: "registration_limit" });
  });

  test("pending action is signed or rejected through the API", async () => {
    const { call, gate, sent } = harness();
    const owner = await phone();
    const { keyId } = await (await call("keys", { device: "iPhone", spki: owner.spki })).json() as { keyId: string };
    await call(`keys/${keyId}/activate`, { code: sent[0].text.match(/: (\d{6})\n/)![1] });
    const first = gate.issue({ service: "yandex_go", action: "order_taxi", params: { from: "A", to: "B" }, amountRub: 450 }, T0);
    const second = gate.issue({ service: "yandex_go", action: "order_taxi", params: { from: "A", to: "C" }, amountRub: 300 }, T0);
    expect(await (await call("actions")).json()).toEqual({ actions: [first, second] });
    expect((await call(`actions/${first.nonce}/approve`, { signature: await owner.sign(second.payload) })).status).toBe(400);
    expect((await call(`actions/${second.nonce}/approve`, { signature: await owner.sign(second.payload) })).status).toBe(200);
    expect((await call(`actions/${second.nonce}/reject`, {})).status).toBe(409);
    const third = gate.issue({ service: "yandex_go", action: "order_taxi", params: {}, amountRub: 200 }, T0);
    expect((await call(`actions/${third.nonce}/reject`, {})).status).toBe(200);
    expect(await (await call("actions")).json()).toEqual({ actions: [] });
    expect((await call(`actions/${"x".repeat(43)}/reject`, {})).status).toBe(404);
  });

  test("non-admin, revoked device mid-body and malformed bodies are refused", async () => {
    const { call, revoke } = harness();
    process.env.MINIAPP_ADMIN_USER_IDS = "1";
    expect((await call("key")).status).toBe(403);
    process.env.MINIAPP_ADMIN_USER_IDS = OWNER;
    expect((await call("keys", { device: "", spki: "AAAA" })).status).toBe(400);
    revoke();
    expect((await call("keys", { device: "iPhone", spki: (await phone()).spki })).status).toBe(401);
  });

  test("nativeApi routes signing behind the device token", async () => {
    const store = new NativeAccess(":memory:");
    const pair = store.redeem(store.pair(OWNER))!;
    const anonymous = await nativeApi(new Request("https://agent.test/api/native/signing/key"), store);
    expect(anonymous.status).toBe(401);
    const authed = await nativeApi(new Request("https://agent.test/api/native/signing/actions", { headers: { authorization: `Bearer ${pair.token}` } }), store);
    expect(authed.status).toBe(200);
  });

  test("device label keeps letters and drops markup and control characters", () => {
    expect(deviceLabel("iPhone 15 Pro\u0000\n<script>")).toBe("iPhone 15 Proscript");
    expect(deviceLabel("   ")).toBeNull();
    expect(deviceLabel(42)).toBeNull();
  });
});
