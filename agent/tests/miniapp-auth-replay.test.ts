import { describe, expect, test } from "bun:test";
import { authOr401 } from "../lib/auth-middleware.ts";
import { buildInitData } from "../lib/miniapp-auth.ts";
import { MiniAppSessionStore } from "../lib/miniapp-session.ts";

const BOT_TOKEN = "miniapp-replay-test-token";
const RAW = buildInitData(BOT_TOKEN, {
  auth_date: String(Math.floor(Date.now() / 1000)),
  query_id: "replay-query-1",
  user: JSON.stringify({ id: 4242, username: "replay-test" }),
});

function request(cookie?: string, raw = RAW): Request {
  const headers = new Headers({ "x-telegram-init-data": raw });
  if (cookie) headers.set("cookie", cookie);
  return new Request("https://miniapp.test/api/tasks", { method: "POST", headers });
}

describe("Mini App mutation replay protection", () => {
  test("one initData fingerprint bootstraps one short-lived session", () => {
    const store = new MiniAppSessionStore();
    const first = authOr401(request(), new URL(request().url), {
      botToken: BOT_TOKEN,
      allowedUserIds: [4242],
      mutation: true,
      sessionStore: store,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.sessionToken).toBeString();

    const replay = authOr401(request(), new URL(request().url), {
      botToken: BOT_TOKEN,
      allowedUserIds: [4242],
      mutation: true,
      sessionStore: store,
    });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.resp.status).toBe(401);

    const cookieName = MiniAppSessionStore.cookieName(
      MiniAppSessionStore.fingerprint(RAW),
    );
    const session = authOr401(request(`${cookieName}=${first.sessionToken}`), new URL(request().url), {
      botToken: BOT_TOKEN,
      allowedUserIds: [4242],
      mutation: true,
      sessionStore: store,
    });
    expect(session.ok).toBe(true);
  });

  test("non-mutation auth keeps existing repeated-initData behavior", () => {
    const store = new MiniAppSessionStore();
    const opts = { botToken: BOT_TOKEN, allowedUserIds: [4242], sessionStore: store };
    expect(authOr401(request(), new URL(request().url), opts).ok).toBe(true);
    expect(authOr401(request(), new URL(request().url), opts).ok).toBe(true);
  });

  test("mutation auth fails closed when replay storage is unavailable", async () => {
    const result = authOr401(request(), new URL(request().url), {
      botToken: BOT_TOKEN,
      allowedUserIds: [4242],
      mutation: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.resp.status).toBe(503);
      expect(await result.resp.json()).toEqual({
        error: "replay protection unavailable",
      });
    }
  });

  test("expired sessions and fingerprints can be used only after TTL", () => {
    let now = Date.now();
    const store = new MiniAppSessionStore({ now: () => now, ttlMs: 1000 });
    const opts = {
      botToken: BOT_TOKEN,
      allowedUserIds: [4242],
      mutation: true,
      sessionStore: store,
    };
    const first = authOr401(request(), new URL(request().url), opts);
    expect(first.ok).toBe(true);
    now += 1001;
    const second = authOr401(request(), new URL(request().url), opts);
    expect(second.ok).toBe(true);
  });
});
