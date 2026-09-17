/**
 * Шаг 8: CLOUDFLARE_DNS — записи A/AAAA/CNAME/TXT в разрешённых зонах.
 * Каждое изменение с подтверждением, только владелец из своей лички,
 * update/delete — только если запись всё ещё такая, как в карточке.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { approvalCategories } from "../lib/approval-policy.ts";
import { approvalPreview } from "../lib/approvals.ts";
import { dispatchAction } from "../lib/action-dispatch.ts";
import { buildDnsChange, describeDnsChange, parseDnsChange, parseDnsProtected, parseDnsZones } from "../lib/cloudflare-dns.ts";
import { listCloudflareDns } from "../lib/dispatch/cloudflare.ts";
import { buildPayload } from "../lib/dispatch/build-payload.ts";
import { evaluateGate, payloadForcesApproval, setAutonomy, setPermission } from "../lib/permissions.ts";
import { _resetRateLimits } from "../lib/rate-limits.ts";
import { savePermissions } from "./_helpers.ts";

const OWNER = 777_000_222;
const ZONE_ID = "0123456789abcdef0123456789abcdef";
const SUB_ID = "fedcba9876543210fedcba9876543210";
const ZONES_ENV = `example.com=${ZONE_ID}, lab.example.com=${SUB_ID}, bad=zz`;
const zones = parseDnsZones(ZONES_ENV);
const protectedNames = parseDnsProtected("agents.example.com, mail.example.com.");

const ENV_KEYS = ["CLOUDFLARE_DNS_ENABLED", "CLOUDFLARE_DNS_API_TOKEN", "CLOUDFLARE_DNS_ZONES", "CLOUDFLARE_DNS_PROTECTED", "MINIAPP_ADMIN_USER_IDS"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
function setEnv() {
  process.env.CLOUDFLARE_DNS_ENABLED = "true";
  process.env.CLOUDFLARE_DNS_API_TOKEN = "test-token-not-real";
  process.env.CLOUDFLARE_DNS_ZONES = ZONES_ENV;
  process.env.CLOUDFLARE_DNS_PROTECTED = "agents.example.com,mail.example.com";
  process.env.MINIAPP_ADMIN_USER_IDS = `123,${OWNER}`;
}
function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
}

describe("parsing", () => {
  test("zones and protected names", () => {
    expect([...zones.entries()]).toEqual([["example.com", ZONE_ID], ["lab.example.com", SUB_ID]]);
    expect([...protectedNames]).toEqual(["agents.example.com", "mail.example.com"]);
  });

  test("build derives the zone and normalizes", () => {
    const r = buildDnsChange({ op: "create", name: "API.Example.com.", type: "a", content: "203.0.113.7" }, zones, protectedNames);
    expect(r).toEqual({ ok: true, change: { op: "create", zone: "example.com", name: "api.example.com", type: "A", content: "203.0.113.7", ttl: 1, proxied: false } });
    const sub = buildDnsChange({ op: "create", name: "x.lab.example.com", type: "CNAME", content: "Target.Example.net.", ttl: 300, proxied: true }, zones, protectedNames);
    expect(sub).toMatchObject({ ok: true, change: { zone: "lab.example.com", content: "target.example.net", ttl: 300, proxied: true } });
    const txt = buildDnsChange({ op: "create", name: "_dmarc.example.com", type: "TXT", content: "v=DMARC1; p=none" }, zones, protectedNames);
    expect(txt.ok).toBe(true);
  });

  test("refusals", () => {
    const bad: Array<Record<string, unknown>> = [
      { op: "create", name: "example.com", type: "A", content: "203.0.113.7" },
      { op: "create", name: "agents.example.com", type: "A", content: "203.0.113.7" },
      { op: "create", name: "*.example.com", type: "A", content: "203.0.113.7" },
      { op: "create", name: "api.example.org", type: "A", content: "203.0.113.7" },
      { op: "create", name: "api.example.com", type: "MX", content: "mx.example.com" },
      { op: "create", name: "api.example.com", type: "NS", content: "ns.example.net" },
      { op: "create", name: "api.example.com", type: "A", content: "2001:db8::1" },
      { op: "create", name: "api.example.com", type: "AAAA", content: "203.0.113.7" },
      { op: "create", name: "api.example.com", type: "CNAME", content: "api.example.com" },
      { op: "create", name: "api.example.com", type: "TXT", content: "привет" },
      { op: "create", name: "api.example.com", type: "TXT", content: "x".repeat(2049) },
      { op: "create", name: "api.example.com", type: "TXT", content: "ok", proxied: true },
      { op: "create", name: "api.example.com", type: "A", content: "203.0.113.7", ttl: 30 },
      { op: "create", name: "api.example.com", type: "A", content: "203.0.113.7", proxied: "yes" },
      { op: "update", name: "api.example.com", type: "A", content: "203.0.113.7" },
      { op: "update", name: "api.example.com", type: "A", content: "203.0.113.7", previous: "203.0.113.7" },
      { op: "delete", name: "api.example.com", type: "A" },
      { op: "purge", name: "api.example.com", type: "A" },
    ];
    for (const input of bad) expect(buildDnsChange(input, zones, protectedNames).ok).toBe(false);
    expect(buildDnsChange({ op: "create", name: "api.example.com", type: "A", content: "203.0.113.7" }, new Map(), protectedNames).ok).toBe(false);
  });

  test("strict parse accepts only what build produces", () => {
    const built = buildDnsChange({ op: "update", name: "api.example.com", type: "A", content: "203.0.113.8", previous: "203.0.113.7" }, zones, protectedNames);
    if (!built.ok) throw new Error(built.error);
    expect(parseDnsChange({ ...built.change, _userId: "1", _delegated: false })).toEqual({ ...built.change, _userId: "1", _delegated: false } as never);
    expect(parseDnsChange({ ...built.change, id: "x" })).toBeNull();
    expect(parseDnsChange({ ...built.change, name: "API.example.com" })).toBeNull();
    expect(parseDnsChange({ ...built.change, zone: "example.org" })).toBeNull();
    const { previous: _p, ...noPrev } = built.change;
    expect(parseDnsChange(noPrev)).toBeNull();
    const del = buildDnsChange({ op: "delete", name: "api.example.com", type: "A", previous: "203.0.113.7" }, zones, protectedNames);
    if (!del.ok) throw new Error(del.error);
    expect(parseDnsChange(del.change)).toEqual(del.change);
    expect(parseDnsChange({ ...del.change, proxied: true })).toBeNull();
  });

  test("the card says what, where and before → after", () => {
    const ch = (input: Record<string, unknown>) => {
      const r = buildDnsChange(input, zones, protectedNames);
      if (!r.ok) throw new Error(r.error);
      return r.change;
    };
    expect(describeDnsChange(ch({ op: "create", name: "api.example.com", type: "A", content: "203.0.113.7" })))
      .toBe("DNS example.com: создать A api.example.com → 203.0.113.7 (ttl auto, proxy off)");
    expect(describeDnsChange(ch({ op: "update", name: "api.example.com", type: "A", content: "203.0.113.8", previous: "203.0.113.7", ttl: 300 })))
      .toBe("DNS example.com: изменить A api.example.com: 203.0.113.7 → 203.0.113.8 (ttl 300s, proxy off)");
    expect(describeDnsChange(ch({ op: "delete", name: "_acme-challenge.example.com", type: "TXT", previous: "token" })))
      .toBe("DNS example.com: УДАЛИТЬ TXT _acme-challenge.example.com (сейчас token)");
  });

  test("buildPayload uses env zones", () => {
    setEnv();
    try {
      expect(buildPayload("CLOUDFLARE_DNS", { op: "create", name: "api.example.com", type: "A", content: "203.0.113.7" }, { agentKey: "orchestrator" }).ok).toBe(true);
      expect(buildPayload("CLOUDFLARE_DNS", { op: "create", name: "mail.example.com", type: "A", content: "203.0.113.7" }, { agentKey: "orchestrator" }).ok).toBe(false);
    } finally {
      restoreEnv();
    }
  });
});

describe("approval", () => {
  let restorePerms: () => void;
  beforeAll(() => { restorePerms = savePermissions([["orchestrator", "CLOUDFLARE_DNS"]]); });
  beforeEach(() => {
    setAutonomy("chat", String(OWNER), "auto");
    setPermission("orchestrator", "CLOUDFLARE_DNS", { allowed: true, requires_approval: false });
  });
  afterAll(() => restorePerms());

  test("every change needs approval in auto mode; other roles are denied", () => {
    const payload = { op: "create", zone: "example.com", name: "api.example.com", type: "A", content: "203.0.113.7", ttl: 1, proxied: false };
    expect(approvalCategories("CLOUDFLARE_DNS", payload)).toEqual(["dns"]);
    const reason = payloadForcesApproval("CLOUDFLARE_DNS", payload);
    expect(reason).toBeTruthy();
    expect(evaluateGate({ agentKey: "orchestrator", actionType: "CLOUDFLARE_DNS", chatId: OWNER, forceApproval: true, forceApprovalReason: reason! }).decision).toBe("approval");
    expect(evaluateGate({ agentKey: "qa", actionType: "CLOUDFLARE_DNS", chatId: OWNER, forceApproval: true }).decision).toBe("deny");
  });

  test("the preview is the full description, TXT is not truncated", () => {
    const content = `v=spf1 ${"include:_spf.example.net ".repeat(20)}-all`;
    const payload = { op: "create", zone: "example.com", name: "api.example.com", type: "TXT", content, ttl: 1, proxied: false };
    expect(approvalPreview("CLOUDFLARE_DNS", payload)).toBe(`DNS example.com: создать TXT api.example.com → ${content} (ttl auto)`);
    expect(approvalPreview("CLOUDFLARE_DNS", { ...payload, extra: 1 })).toBe("некорректное изменение DNS");
  });
});

type Call = { method: string; url: string; body?: unknown; auth?: string };
const record = (id: string, type: string, name: string, content: string) => ({ id, type, name, content, ttl: 1, proxied: false });

function mockFetch(existing: unknown[], mutate: (call: Call) => Response | Promise<Response> = (c) => ok(c.body ? { id: "new", ...(c.body as object) } : { id: "gone" })) {
  const calls: Call[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: (init?.headers as Record<string, string>)?.Authorization,
    };
    calls.push(call);
    if (call.method === "GET") return ok(existing);
    return mutate(call);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}
function ok(result: unknown) {
  return new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200 });
}

describe("handler", () => {
  let mock: ReturnType<typeof mockFetch> | null = null;
  const base = (input: Record<string, unknown>) => {
    const r = buildDnsChange(input, zones, protectedNames);
    if (!r.ok) throw new Error(r.error);
    return { ...r.change, _userId: String(OWNER) };
  };
  const run = (p: Record<string, unknown>, chatId = OWNER, agentKey = "orchestrator") =>
    dispatchAction("CLOUDFLARE_DNS", p as never, { agentKey, chatId, telegram: undefined as never });

  beforeEach(() => { _resetRateLimits(); setEnv(); });
  afterEach(() => { mock?.restore(); mock = null; _resetRateLimits(); restoreEnv(); });

  test("create posts to the derived zone with the token", async () => {
    mock = mockFetch([]);
    const res = await run(base({ op: "create", name: "api.example.com", type: "A", content: "203.0.113.7" }));
    expect(res.ok).toBe(true);
    expect(mock.calls.map((c) => c.method)).toEqual(["GET", "POST"]);
    expect(mock.calls[0].url).toContain(`/zones/${ZONE_ID}/dns_records?`);
    expect(mock.calls[0].url).toContain("name=api.example.com");
    expect(mock.calls[1].body).toEqual({ type: "A", name: "api.example.com", content: "203.0.113.7", ttl: 1, proxied: false });
    expect(mock.calls[1].auth).toBe("Bearer test-token-not-real");
    expect(JSON.stringify(res)).not.toContain("test-token-not-real");
  });

  test("create refuses existing and conflicting records", async () => {
    mock = mockFetch([record("r1", "A", "api.example.com", "203.0.113.1")]);
    expect((await run(base({ op: "create", name: "api.example.com", type: "A", content: "203.0.113.7" }))).ok).toBe(false);
    expect((await run(base({ op: "create", name: "api.example.com", type: "CNAME", content: "t.example.net" }))).ok).toBe(false);
    mock.restore();
    mock = mockFetch([record("r1", "CNAME", "api.example.com", "t.example.net")]);
    expect((await run(base({ op: "create", name: "api.example.com", type: "TXT", content: "hello" }))).ok).toBe(false);
    expect(mock.calls.every((c) => c.method === "GET")).toBe(true);
  });

  test("update and delete only touch the record that still matches previous", async () => {
    mock = mockFetch([record("r1", "A", "api.example.com", "203.0.113.1"), record("r2", "TXT", "api.example.com", "203.0.113.7")]);
    const upd = await run(base({ op: "update", name: "api.example.com", type: "A", content: "203.0.113.8", previous: "203.0.113.1" }));
    expect(upd.ok).toBe(true);
    expect(mock.calls[1]).toMatchObject({ method: "PATCH", url: expect.stringContaining("/dns_records/r1") });
    const stale = await run(base({ op: "update", name: "api.example.com", type: "A", content: "203.0.113.8", previous: "203.0.113.99" }));
    expect(stale).toMatchObject({ ok: false, error: expect.stringContaining("record changed") });
    const del = await run(base({ op: "delete", name: "api.example.com", type: "A", previous: "203.0.113.1" }));
    expect(del.ok).toBe(true);
    expect(mock.calls.at(-1)).toMatchObject({ method: "DELETE", url: expect.stringContaining("/dns_records/r1") });
    expect(mock.calls.filter((c) => c.method !== "GET")).toHaveLength(2);
  });

  test("gate checks: off, caller, chat, owner, delegation, env drift", async () => {
    mock = mockFetch([]);
    const p = base({ op: "create", name: "api.example.com", type: "A", content: "203.0.113.7" });
    process.env.CLOUDFLARE_DNS_ENABLED = "false";
    expect((await run(p)).ok).toBe(false);
    process.env.CLOUDFLARE_DNS_ENABLED = "true";
    expect((await run(p, OWNER, "qa")).ok).toBe(false);
    expect((await run(p, -1_001_234)).ok).toBe(false);
    expect((await run({ ...p, _userId: "999" }, 999)).ok).toBe(false);
    expect((await run({ ...p, _userId: undefined })).ok).toBe(false);
    expect((await run({ ...p, _delegated: true })).ok).toBe(false);
    expect((await run({ ...p, extra: 1 })).ok).toBe(false);
    process.env.CLOUDFLARE_DNS_PROTECTED = "api.example.com";
    expect((await run(p)).ok).toBe(false);
    process.env.CLOUDFLARE_DNS_PROTECTED = "";
    process.env.CLOUDFLARE_DNS_ZONES = `example.org=${ZONE_ID}`;
    expect((await run(p)).ok).toBe(false);
    process.env.CLOUDFLARE_DNS_ZONES = ZONES_ENV;
    delete process.env.CLOUDFLARE_DNS_API_TOKEN;
    expect((await run(p)).ok).toBe(false);
    expect(mock.calls).toEqual([]);
  });

  test("4xx is a plain refusal, 5xx or timeout may have applied", async () => {
    const p = base({ op: "create", name: "api.example.com", type: "A", content: "203.0.113.7" });
    mock = mockFetch([], () => new Response(JSON.stringify({ success: false, errors: [{ code: 81057, message: "secret body" }] }), { status: 400 }));
    const refused = await run(p);
    expect(refused).toMatchObject({ ok: false, error: "cloudflare_400 (codes 81057)" });
    expect((refused as { sideEffect?: boolean }).sideEffect).toBeUndefined();
    mock.restore();
    mock = mockFetch([], () => { throw new Error("The operation timed out."); });
    const timeout = await run(p);
    expect(timeout).toMatchObject({ ok: false, sideEffect: true });
    expect((timeout as { error: string }).error).toContain("не повторяй");
    mock.restore();
    mock = mockFetch([], () => new Response("<html>bad gateway</html>", { status: 502 }));
    expect(await run(p)).toMatchObject({ ok: false, sideEffect: true });
  });
});

describe("list", () => {
  let mock: ReturnType<typeof mockFetch> | null = null;
  beforeEach(setEnv);
  afterEach(() => { mock?.restore(); mock = null; restoreEnv(); });

  test("reads allowed zones, filters types and names", async () => {
    mock = mockFetch([record("r1", "A", "api.example.com", "203.0.113.1"), record("r2", "MX", "example.com", "mx.example.com")]);
    const all = await listCloudflareDns({}, { agentKey: "orchestrator", chatId: OWNER });
    expect(all).toMatchObject({ ok: true, count: 2, truncated: false });
    expect(mock.calls).toHaveLength(2);
    const one = await listCloudflareDns({ name: "x.lab.example.com", type: "a" }, { agentKey: "orchestrator", chatId: OWNER });
    expect(one).toMatchObject({ ok: true, records: [{ zone: "lab.example.com", name: "api.example.com", type: "A" }] });
    expect(mock.calls[2].url).toContain(`/zones/${SUB_ID}/`);
    expect(mock.calls[2].url).toContain("type=A");
    expect(JSON.stringify(one)).not.toContain("r1");
  });

  test("refusals", async () => {
    mock = mockFetch([]);
    const ctx = { agentKey: "orchestrator", chatId: OWNER };
    expect((await listCloudflareDns({ name: "example.org" }, ctx)).ok).toBe(false);
    expect((await listCloudflareDns({ type: "MX" }, ctx)).ok).toBe(false);
    expect((await listCloudflareDns({}, { ...ctx, agentKey: "qa" })).ok).toBe(false);
    process.env.CLOUDFLARE_DNS_ENABLED = "false";
    expect((await listCloudflareDns({}, ctx)).ok).toBe(false);
    expect(mock.calls).toEqual([]);
  });
});
