/**
 * C26 — Mini App e2e / security (M4).
 *
 * Backend integration. Exercises:
 *  - per-user POST rate limit (429 on burst, refill after window),
 *  - stale auth_date rejection,
 *  - Origin allowlist enforcement when MINIAPP_ALLOWED_ORIGINS is set,
 *  - happy-path POST /api/tasks with valid initData.
 */
process.env.MINIAPP_BOT_TOKEN = "test_bot_token_for_c26_placeholder";

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { buildInitData, verifyInitData } from "../lib/miniapp-auth.ts";
import {
  startMiniappServer,
  consumeRateToken,
  _resetRateLimiter,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";

const BOT_TOKEN = "test_bot_token_for_c26_placeholder";
const USER_ID = 4242;
const CHAT_ID = -100100;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function freshInitData(userId = USER_ID, ageSec = 0): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(nowSec() - ageSec),
    query_id: "qe2e",
    user: JSON.stringify({ id: userId, username: "e2e", first_name: "E" }),
  });
}

let server: MiniappServerHandle;
let base: string;
let sessionCookie: string | undefined;

beforeAll(() => {
  server = startMiniappServer({
    port: 0,
    allowedUserIds: [USER_ID],
    // T-313 fix (finding #6): POST /api/tasks is now admin-gated.
    // E2E happy-path needs this user as admin.
    adminUserIds: [USER_ID],
    botToken: BOT_TOKEN,
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop();
  delete process.env.MINIAPP_ALLOWED_ORIGINS;
});

beforeEach(() => {
  _resetRateLimiter();
  delete process.env.MINIAPP_ALLOWED_ORIGINS;
});

async function postJson(
  path: string,
  body: any,
  initData: string,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-init-data": initData,
      ...(sessionCookie ? { cookie: sessionCookie } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) sessionCookie = setCookie.split(";", 1)[0];
  return response;
}

describe("C26 mini app e2e", () => {
  test("happy path: POST /api/tasks with valid initData → 201", async () => {
    const initData = freshInitData();
    const res = await postJson(
      "/api/tasks",
      { title: "hello e2e", chat_id: CHAT_ID },
      initData,
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.task?.title).toBe("hello e2e");
    expect(body.task?.created_by).toBe(`miniapp:${USER_ID}`);
  });

  test("rate limit: burst of 25 POSTs produces some 429s", async () => {
    const initData = freshInitData();
    let ok = 0;
    let limited = 0;
    let retryAfterSeen = 0;
    for (let i = 0; i < 25; i++) {
      const res = await postJson(
        "/api/tasks",
        { title: `t${i}`, chat_id: CHAT_ID },
        initData,
      );
      if (res.status === 429) {
        limited++;
        const ra = res.headers.get("retry-after");
        if (ra) retryAfterSeen++;
        const body = await res.json();
        expect(body.error).toBe("rate_limited");
        expect(typeof body.retryAfter).toBe("number");
      } else {
        // any non-429 still drains a token; consume the body.
        await res.text();
        if (res.status === 201) ok++;
      }
    }
    expect(ok).toBeGreaterThanOrEqual(1);
    expect(limited).toBeGreaterThan(0);
    expect(retryAfterSeen).toBe(limited);
  });

  test("rate limiter refills tokens over time (clock injection)", () => {
    let t = 1_000_000;
    const now = () => t;
    // Drain the bucket: default capacity 20.
    for (let i = 0; i < 20; i++) {
      const r = consumeRateToken("u-refill", { now });
      expect(r.ok).toBe(true);
    }
    const blocked = consumeRateToken("u-refill", { now });
    expect(blocked.ok).toBe(false);
    // Advance 1 minute → bucket refills by 60 tokens (capped at capacity 20).
    t += 60_000;
    const after = consumeRateToken("u-refill", { now });
    expect(after.ok).toBe(true);
  });

  test("stale auth_date (older than 24h) is rejected", async () => {
    // verify unit-level rejection.
    const stale = buildInitData(BOT_TOKEN, {
      auth_date: String(nowSec() - 86400 - 60),
      query_id: "q",
      user: JSON.stringify({ id: USER_ID, username: "e2e" }),
    });
    const v = verifyInitData(stale, BOT_TOKEN);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/stale/);

    // and the server returns 401.
    const res = await postJson(
      "/api/tasks",
      { title: "stale", chat_id: CHAT_ID },
      stale,
    );
    expect(res.status).toBe(401);
  });

  test("origin mismatch rejected when MINIAPP_ALLOWED_ORIGINS set", async () => {
    process.env.MINIAPP_ALLOWED_ORIGINS = "https://allowed.example";
    const initData = freshInitData();
    const bad = await postJson(
      "/api/tasks",
      { title: "x", chat_id: CHAT_ID },
      initData,
      { origin: "https://evil.example" },
    );
    expect(bad.status).toBe(403);
    const body = await bad.json();
    expect(body.error).toMatch(/origin/);

    const good = await postJson(
      "/api/tasks",
      { title: "ok", chat_id: CHAT_ID },
      initData,
      { origin: "https://allowed.example" },
    );
    expect(good.status).toBe(201);
  });
});
