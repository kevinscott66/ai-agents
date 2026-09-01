/**
 * T-311 — strict CORS allowlist for Mini App (T-300 HIGH #3).
 *
 * Before the fix: `corsHeaders()` echoed `Access-Control-Allow-Origin: *` on
 * every JSON response, so GET endpoints (which leak agent state, tasks,
 * settings) were readable from any browser origin. Only POST was gated by
 * MINIAPP_ALLOWED_ORIGINS.
 *
 * After the fix: the allowlist gates ACAO on ALL methods. Disallowed origins
 * receive a response WITHOUT the ACAO header (no wildcard fallback).
 */
process.env.MINIAPP_BOT_TOKEN = "test_bot_token_for_t311";

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { buildInitData } from "../lib/miniapp-auth.ts";
import {
  startMiniappServer,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";
import {
  pickAllowedOrigin,
  parseAllowedOriginsEnv,
} from "../lib/http-utils.ts";

const BOT_TOKEN = "test_bot_token_for_t311";
const USER_ID = 4243;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function freshInitData(): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(nowSec()),
    query_id: "qcors",
    user: JSON.stringify({ id: USER_ID, username: "cors", first_name: "C" }),
  });
}

let server: MiniappServerHandle;
let base: string;
let savedEnv: string | undefined;

beforeAll(() => {
  savedEnv = process.env.MINIAPP_ALLOWED_ORIGINS;
  server = startMiniappServer({
    port: 0,
    allowedUserIds: [USER_ID],
    adminUserIds: [],
    botToken: BOT_TOKEN,
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop();
  if (savedEnv === undefined) {
    delete process.env.MINIAPP_ALLOWED_ORIGINS;
  } else {
    process.env.MINIAPP_ALLOWED_ORIGINS = savedEnv;
  }
});

beforeEach(() => {
  delete process.env.MINIAPP_ALLOWED_ORIGINS;
});

describe("T-311 strict CORS allowlist", () => {
  test("pickAllowedOrigin: env-set list excludes attacker origin", () => {
    const prev = process.env.MINIAPP_ALLOWED_ORIGINS;
    process.env.MINIAPP_ALLOWED_ORIGINS = "https://example.org";
    try {
      expect(pickAllowedOrigin("https://example.org")).toBe(
        "https://example.org",
      );
      expect(pickAllowedOrigin("https://attacker.org")).toBeNull();
      expect(pickAllowedOrigin(null)).toBeNull();
    } finally {
      if (prev === undefined) {
        delete process.env.MINIAPP_ALLOWED_ORIGINS;
      } else {
        process.env.MINIAPP_ALLOWED_ORIGINS = prev;
      }
    }
  });

  test("parseAllowedOriginsEnv: empty env defaults to localhost dev list", () => {
    const prev = process.env.MINIAPP_ALLOWED_ORIGINS;
    delete process.env.MINIAPP_ALLOWED_ORIGINS;
    try {
      const list = parseAllowedOriginsEnv();
      expect(list).toContain("http://localhost:5173");
      expect(list).toContain("http://127.0.0.1:5173");
      expect(list).not.toContain("*");
    } finally {
      if (prev !== undefined) process.env.MINIAPP_ALLOWED_ORIGINS = prev;
    }
  });

  test("GET /api/health from disallowed origin: no ACAO wildcard", async () => {
    process.env.MINIAPP_ALLOWED_ORIGINS = "https://example.org";
    try {
      const res = await fetch(`${base}/api/health`, {
        method: "GET",
        headers: { origin: "https://attacker.org" },
      });
      expect(res.status).toBe(200);
      const acao = res.headers.get("access-control-allow-origin");
      // Critical: must NOT echo the attacker origin AND must NOT be "*".
      expect(acao).not.toBe("*");
      expect(acao).not.toBe("https://attacker.org");
      expect(acao).toBeNull();
    } finally {
      delete process.env.MINIAPP_ALLOWED_ORIGINS;
    }
  });

  test("GET /api/health from allowed origin: ACAO echoes the origin", async () => {
    process.env.MINIAPP_ALLOWED_ORIGINS = "https://example.org";
    try {
      const res = await fetch(`${base}/api/health`, {
        method: "GET",
        headers: { origin: "https://example.org" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe(
        "https://example.org",
      );
    } finally {
      delete process.env.MINIAPP_ALLOWED_ORIGINS;
    }
  });

  test("GET /api/health without Origin header: no ACAO leak", async () => {
    // tgWebApp/curl/server-to-server case — no Origin sent, no ACAO needed.
    process.env.MINIAPP_ALLOWED_ORIGINS = "https://example.org";
    try {
      const res = await fetch(`${base}/api/health`, { method: "GET" });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      delete process.env.MINIAPP_ALLOWED_ORIGINS;
    }
  });

  test("OPTIONS preflight from disallowed origin: no ACAO", async () => {
    process.env.MINIAPP_ALLOWED_ORIGINS = "https://example.org";
    try {
      const res = await fetch(`${base}/api/tasks`, {
        method: "OPTIONS",
        headers: {
          origin: "https://attacker.org",
          "access-control-request-method": "POST",
        },
      });
      const acao = res.headers.get("access-control-allow-origin");
      expect(acao).not.toBe("*");
      expect(acao).not.toBe("https://attacker.org");
    } finally {
      delete process.env.MINIAPP_ALLOWED_ORIGINS;
    }
  });

  test("POST from attacker origin: rejected with 403", async () => {
    process.env.MINIAPP_ALLOWED_ORIGINS = "https://example.org";
    try {
      const res = await fetch(`${base}/api/tasks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-init-data": freshInitData(),
          origin: "https://attacker.org",
        },
        body: JSON.stringify({ assignee_role: "pm", title: "x" }),
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe("origin not allowed");
    } finally {
      delete process.env.MINIAPP_ALLOWED_ORIGINS;
    }
  });
});
