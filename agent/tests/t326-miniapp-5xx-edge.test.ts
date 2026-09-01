/**
 * T-326 (T-304 HIGH coverage gap) — miniapp-server.ts 5xx/auth-edge branches.
 *
 * c23-miniapp-actions.test.ts covers happy-path; this file covers the
 * error branches that were not previously hit:
 *   - missing / malformed initData (401)
 *   - valid initData from a user not in the allow-list (403)
 *   - malformed JSON body on a POST (400 via readJson() returning null)
 *   - admin-gated POST hit by a non-admin user (403)
 *   - origin allow-list enforcement on POST (403 when MINIAPP_ALLOWED_ORIGINS
 *     is set and Origin doesn't match; 201 when it does)
 *   - CORS preflight OPTIONS returns 204 with access-control-allow-* headers
 *   - unknown /api/ path returns 404
 *
 * Note: miniapp-server.ts as of T-326 does NOT expose /metrics nor enforce a
 * Content-Length cap, so the originally-listed metrics-Bearer and >1MB
 * payload edges are not exercised here (they belong to a different file).
 */
process.env.MINIAPP_BOT_TOKEN = "test_bot_token_for_t326";

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { buildInitData } from "../lib/miniapp-auth.ts";
import {
  startMiniappServer,
  _resetRateLimiter,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";

const BOT_TOKEN = "test_bot_token_for_t326";
const USER_ID = 73260;
const ADMIN_ID = 73261;
const OUTSIDER_ID = 99999; // valid HMAC but not on the allow-list

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function freshInitData(userId = USER_ID): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(nowSec()),
    query_id: "qedge",
    user: JSON.stringify({ id: userId, username: "edge", first_name: "E" }),
  });
}

let server: MiniappServerHandle;
let base: string;
const originalAllowedOrigins = process.env.MINIAPP_ALLOWED_ORIGINS;

beforeAll(() => {
  // Ensure we start with no origin allow-list; individual tests opt in/out.
  delete process.env.MINIAPP_ALLOWED_ORIGINS;
  server = startMiniappServer({
    port: 0,
    allowedUserIds: [USER_ID, ADMIN_ID],
    adminUserIds: [ADMIN_ID],
    botToken: BOT_TOKEN,
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop();
  // Restore env so other tests in the suite are not affected.
  if (originalAllowedOrigins === undefined) {
    delete process.env.MINIAPP_ALLOWED_ORIGINS;
  } else {
    process.env.MINIAPP_ALLOWED_ORIGINS = originalAllowedOrigins;
  }
});

beforeEach(() => {
  // Each test starts with a full bucket so 429s never leak in.
  _resetRateLimiter();
});

async function raw(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(`${base}${path}`, init);
  let body: any = null;
  try {
    body = await res.json();
  } catch {}
  return { status: res.status, body, headers: res.headers };
}

describe("T-326 — miniapp-server.ts auth/edge branches", () => {
  test("POST /api/tasks without initData → 401 (missing initData)", async () => {
    const r = await raw("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "x", chat_id: -1 }),
    });
    expect(r.status).toBe(401);
    expect(r.body?.error).toMatch(/missing initData/i);
  });

  test("POST /api/tasks with malformed initData → 401 (HMAC fail)", async () => {
    // Tamper with a valid initData to invalidate the HMAC.
    const good = freshInitData();
    const tampered = good + "&extra=evil";
    const r = await raw("/api/tasks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-init-data": tampered,
      },
      body: JSON.stringify({ title: "x", chat_id: -1 }),
    });
    expect(r.status).toBe(401);
    expect(r.body?.error).toMatch(/^auth:/);
  });

  test("POST /api/tasks with valid initData but not in allow-list → 403", async () => {
    const r = await raw("/api/tasks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-init-data": freshInitData(OUTSIDER_ID),
      },
      body: JSON.stringify({ title: "x", chat_id: -1 }),
    });
    expect(r.status).toBe(403);
    expect(r.body?.error).toMatch(/user not allowed/i);
  });

  test("POST /api/tasks with malformed JSON body → 400 (title required)", async () => {
    // readJson() swallows the SyntaxError and returns null, which routes to
    // the "title required" 400 branch — covers the catch in readJson().
    // POST /api/tasks is admin-gated (T-313), so authenticate as ADMIN_ID to
    // pass the admin wall and reach the body-parsing branch under test.
    const r = await raw("/api/tasks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-init-data": freshInitData(ADMIN_ID),
      },
      body: "{not json,",
    });
    expect(r.status).toBe(400);
    expect(r.body?.error).toMatch(/title required/i);
  });

  test("POST /api/permissions as non-admin → 403", async () => {
    // USER_ID is in allowedUserIds but NOT in adminUserIds, so admin-gated
    // routes must return 403.
    const r = await raw("/api/permissions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-init-data": freshInitData(USER_ID),
      },
      body: JSON.stringify({
        agentKey: "qa",
        actionType: "SEND_MESSAGE",
        allowed: true,
        requires_approval: false,
      }),
    });
    expect(r.status).toBe(403);
    expect(r.body?.error).toMatch(/admin only/i);
  });

  test("POST with Origin not in MINIAPP_ALLOWED_ORIGINS → 403", async () => {
    process.env.MINIAPP_ALLOWED_ORIGINS = "https://allowed.example";
    try {
      const r = await raw("/api/tasks", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-init-data": freshInitData(),
          origin: "https://evil.example",
        },
        body: JSON.stringify({ title: "x", chat_id: -1 }),
      });
      expect(r.status).toBe(403);
      expect(r.body?.error).toMatch(/origin not allowed/i);
    } finally {
      delete process.env.MINIAPP_ALLOWED_ORIGINS;
    }
  });

  test("POST with Origin in MINIAPP_ALLOWED_ORIGINS → passes origin check", async () => {
    process.env.MINIAPP_ALLOWED_ORIGINS = "https://allowed.example";
    try {
      const r = await raw("/api/tasks", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Admin-gated route (T-313): authenticate as admin so the request
          // reaches the origin check + task creation under test.
          "x-telegram-init-data": freshInitData(ADMIN_ID),
          origin: "https://allowed.example",
        },
        body: JSON.stringify({
          title: "t326 allowed origin",
          chat_id: -326,
          assignee: "qa",
        }),
      });
      expect(r.status).toBe(201);
      expect(r.body?.task?.title).toBe("t326 allowed origin");
    } finally {
      delete process.env.MINIAPP_ALLOWED_ORIGINS;
    }
  });

  test("OPTIONS preflight → 204; echoes allowed origin (T-311, no wildcard)", async () => {
    // T-311 hardening removed the wildcard ACAO: the preflight response echoes
    // the request Origin only when it is on the allow-list, otherwise omits the
    // header entirely. Configure an allow-list and assert the origin is echoed.
    process.env.MINIAPP_ALLOWED_ORIGINS = "https://allowed.example";
    try {
      const res = await fetch(`${base}/api/tasks`, {
        method: "OPTIONS",
        headers: {
          origin: "https://allowed.example",
          "access-control-request-method": "POST",
          "access-control-request-headers": "x-telegram-init-data, content-type",
        },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe(
        "https://allowed.example",
      );
      expect(res.headers.get("access-control-allow-methods")).toMatch(/POST/);
      expect(res.headers.get("access-control-allow-headers") ?? "").toMatch(
        /x-telegram-init-data/i,
      );
    } finally {
      delete process.env.MINIAPP_ALLOWED_ORIGINS;
    }
  });

  test("OPTIONS preflight from disallowed origin → 204 but no ACAO (T-311)", async () => {
    // A browser from an origin not on the allow-list gets a 204 preflight with
    // the method/header advertisements but NO access-control-allow-origin, so
    // the browser blocks the real cross-origin request.
    process.env.MINIAPP_ALLOWED_ORIGINS = "https://allowed.example";
    try {
      const res = await fetch(`${base}/api/tasks`, {
        method: "OPTIONS",
        headers: {
          origin: "https://evil.example",
          "access-control-request-method": "POST",
          "access-control-request-headers": "x-telegram-init-data, content-type",
        },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      delete process.env.MINIAPP_ALLOWED_ORIGINS;
    }
  });

  test("GET unknown /api/ path → 404 after auth", async () => {
    const r = await raw("/api/does-not-exist", {
      method: "GET",
      headers: { "x-telegram-init-data": freshInitData() },
    });
    expect(r.status).toBe(404);
    expect(r.body?.error).toMatch(/not found/i);
  });
});
