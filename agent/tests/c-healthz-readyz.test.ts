/**
 * T-411 — /healthz (liveness) + /readyz (readiness with deep checks).
 *
 * Closes T-303 HIGH #3: the prior single-line /api/health endpoint mixed
 * liveness with mac-bridge state. Now:
 *   - /healthz  — never touches deps, only proves the event loop responds.
 *   - /readyz   — db ping, mac_bridge info, scheduler freshness, env keys.
 *
 * NOTE on env vars: any test that mutates process.env wraps in try/finally so
 * the next test (and the rest of the suite) sees the original value
 * (CLAUDE.md §3.8 pre-push gate item 7).
 */
process.env.MINIAPP_BOT_TOKEN = "test_bot_token_healthz";


import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startMiniappServer,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";
import {
  getSchedulerLastRun,
  setSchedulerLastRunForTests,
} from "../lib/db-maint.ts";
import { db } from "../lib/db.ts";

let server: MiniappServerHandle;
let baseUrl: string;
let originalLastRun: number | null;

// Аудит 2026-08-08: подробности /readyz теперь отдаются только предъявителю
// METRICS_TOKEN — эндпоинт публичный, а `checks` рассказывал, какие ключи
// заведены и когда в последний раз шевелился планировщик.
const METRICS_TOKEN = "test_metrics_token_healthz";
const AUTH = { authorization: `Bearer ${METRICS_TOKEN}` };
let prevMetricsToken: string | undefined;

beforeAll(async () => {
  server = await startMiniappServer();
  baseUrl = `http://localhost:${server.port}`;
  prevMetricsToken = process.env.METRICS_TOKEN;
  process.env.METRICS_TOKEN = METRICS_TOKEN;
  originalLastRun = getSchedulerLastRun();
  // Default to a fresh scheduler tick so readyz baseline is healthy.
  setSchedulerLastRunForTests(Date.now());
});

afterAll(async () => {
  if (prevMetricsToken === undefined) delete process.env.METRICS_TOKEN;
  else process.env.METRICS_TOKEN = prevMetricsToken;
  setSchedulerLastRunForTests(originalLastRun);
  await server.stop();
});

describe("T-411 /healthz liveness", () => {
  test("GET /healthz returns 200 with ok=true", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.ts).toBe("number");
    // Liveness must NOT include deep-check data.
    expect(body.checks).toBeUndefined();
  });

  test("GET /api/health is preserved as alias for /healthz", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});

describe("T-411 /readyz readiness", () => {
  test("GET /readyz returns 200 + all expected check keys when healthy", async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-test-anthropic";
    setSchedulerLastRunForTests(Date.now());
    try {
      const res = await fetch(`${baseUrl}/readyz`, { headers: AUTH });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.checks).toBeDefined();
      expect(body.checks.db).toBe("ok");
      expect(body.checks.scheduler).toBe("ok");
      expect(body.checks.anthropic_key).toBe("present");
      expect(body.checks).toHaveProperty("mac_bridge");
      expect(body.checks).toHaveProperty("openai_key");
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  test("GET /readyz returns 503 when DB ping throws", async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-test-anthropic";
    setSchedulerLastRunForTests(Date.now());
    // Simulate DB-down by monkey-patching db.prepare to throw for SELECT 1.
    const originalPrepare = db.prepare.bind(db);
    (db as any).prepare = (sql: string) => {
      if (sql.includes("SELECT 1")) {
        throw new Error("db unreachable (simulated)");
      }
      return originalPrepare(sql);
    };
    try {
      const res = await fetch(`${baseUrl}/readyz`, { headers: AUTH });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.checks.db).toContain("fail");
    } finally {
      (db as any).prepare = originalPrepare;
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  test("GET /readyz returns 503 + stale-Ns when scheduler timestamp is > 2h old", async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-test-anthropic";
    const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000;
    setSchedulerLastRunForTests(threeHoursAgo);
    try {
      const res = await fetch(`${baseUrl}/readyz`, { headers: AUTH });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.checks.scheduler).toMatch(/^stale-\d+s$/);
    } finally {
      setSchedulerLastRunForTests(Date.now());
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  test("GET /readyz returns 503 when ANTHROPIC_API_KEY is missing", async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    setSchedulerLastRunForTests(Date.now());
    try {
      const res = await fetch(`${baseUrl}/readyz`, { headers: AUTH });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.checks.anthropic_key).toBe("missing");
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  test("без Bearer отдаётся только ok — тот же код, без деталей", async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-test-anthropic";
    setSchedulerLastRunForTests(Date.now());
    try {
      const res = await fetch(`${baseUrl}/readyz`);
      // Код ответа — прежний: на нём построены рестарты systemd/nginx.
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.checks).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  test("код 503 виден и анониму — деградацию скрывать нельзя", async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    setSchedulerLastRunForTests(Date.now());
    try {
      const res = await fetch(`${baseUrl}/readyz`);
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.ok).toBe(false);
      // …но КАКАЯ подсистема легла — не его дело.
      expect(body.checks).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  test("чужой Bearer деталей не открывает", async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-test-anthropic";
    setSchedulerLastRunForTests(Date.now());
    try {
      const res = await fetch(`${baseUrl}/readyz`, {
        headers: { authorization: "Bearer wrong_token" },
      });
      expect(res.status).toBe(200);
      expect((await res.json()).checks).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  test("GET /readyz returns 503 when scheduler has never run (null)", async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-test-anthropic";
    setSchedulerLastRunForTests(null);
    try {
      const res = await fetch(`${baseUrl}/readyz`, { headers: AUTH });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.checks.scheduler).toBe("never");
    } finally {
      setSchedulerLastRunForTests(Date.now());
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});
