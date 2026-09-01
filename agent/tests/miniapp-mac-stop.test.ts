/** Focused HTTP coverage for the fixed Mini App MAC_STOP route. */
process.env.MINIAPP_BOT_TOKEN = "miniapp-mac-stop-token";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildInitData } from "../lib/miniapp-auth.ts";
import { startMiniappServer, type MiniappServerHandle } from "../lib/miniapp-server.ts";

const BOT_TOKEN = "miniapp-mac-stop-token";
const ADMIN_ID = 74001;
const OTHER_ID = 74002;
// Bun 1.3.14 in this workspace cannot bind ephemeral port 0. Keep the
// focused HTTP test isolated from the default Mini App port instead.
const TEST_PORT = Number(process.env.MINIAPP_MAC_STOP_TEST_PORT ?? "28887");

function initData(userId: number): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: `mac-stop-${userId}`,
    user: JSON.stringify({ id: userId, username: "macstop", first_name: "Mac" }),
  });
}

async function call(
  server: MiniappServerHandle,
  userId?: number,
): Promise<{ status: number; body: any }> {
  const headers = new Headers();
  if (userId !== undefined) headers.set("X-Telegram-Init-Data", initData(userId));
  const response = await fetch(`http://127.0.0.1:${server.port}/api/mac/stop`, {
    method: "POST",
    headers,
  });
  let body: any = null;
  try {
    body = await response.json();
  } catch {
    // Keep the helper useful for auth failures with an empty response body.
  }
  return { status: response.status, body };
}

describe("POST /api/mac/stop", () => {
  let server: MiniappServerHandle;

  beforeAll(() => {
    server = startMiniappServer({
      port: TEST_PORT,
      botToken: BOT_TOKEN,
      allowedUserIds: [ADMIN_ID, OTHER_ID],
      adminUserIds: [ADMIN_ID],
      macBridge: {
        isMacConnected: () => true,
        isUserAllowed: (userId) => userId === String(ADMIN_ID),
        sendToMac: async () => ({ ok: true, stdout: "", stderr: "" }),
        stopMac: async () => ({ ok: true }),
      },
    });
  });

  afterAll(() => server.stop());

  test("returns 401 without Telegram initData", async () => {
    const result = await call(server);
    expect(result.status).toBe(401);
  });

  test("returns 403 for an authenticated non-admin", async () => {
    const result = await call(server, OTHER_ID);
    expect(result.status).toBe(403);
  });

  test("returns 503 when the Mac bridge is offline", async () => {
    const offline = startMiniappServer({
      port: TEST_PORT + 2,
      botToken: BOT_TOKEN,
      allowedUserIds: [ADMIN_ID],
      adminUserIds: [ADMIN_ID],
      macBridge: {
        isMacConnected: () => false,
        isUserAllowed: () => true,
        sendToMac: async () => ({ ok: true, stdout: "", stderr: "" }),
        stopMac: async () => ({ ok: false, error: "mac_offline" }),
      },
    });
    try {
      const result = await call(offline, ADMIN_ID);
      expect(result.status).toBe(503);
      expect(result.body).toEqual({ ok: false, error: "mac_offline" });
    } finally {
      offline.stop();
    }
  });

  test("dispatches only MAC_STOP for an authorized admin", async () => {
    const result = await call(server, ADMIN_ID);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true, result: { stopped: true } });
  });
});
