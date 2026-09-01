/**
 * C27 — perf optimizations for Mini App data loading.
 *
 * Covers: WAL pragma, hot-path indexes, gzip compression, ETag/304 on
 * GET list endpoints, aggregated /api/dashboard shape.
 */
process.env.MINIAPP_BOT_TOKEN = "test_bot_token_for_c27";

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { sseUrl } from "./_sse.ts";
import { db } from "../lib/db.ts";
import {
  startMiniappServer,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";
import { buildInitData } from "../lib/miniapp-auth.ts";
import { logAction } from "../lib/audit.ts";

const BOT_TOKEN = "test_bot_token_for_c27";
const USER_ID = 27001;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
function freshInitData(userId = USER_ID): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(nowSec()),
    query_id: "q-c27",
    user: JSON.stringify({ id: userId, username: "perf", first_name: "P" }),
  });
}

let server: MiniappServerHandle;
let base: string;

beforeAll(() => {
  server = startMiniappServer({
    port: 0,
    allowedUserIds: [USER_ID],
    adminUserIds: [USER_ID],
    botToken: BOT_TOKEN,
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop();
});

describe("C27: DB pragmas + indexes", () => {
  test("WAL journal mode is enabled", () => {
    const row = db.prepare("PRAGMA journal_mode").get() as {
      journal_mode: string;
    };
    expect(row.journal_mode.toLowerCase()).toBe("wal");
  });

  test("hot-path indexes exist", () => {
    const names = (
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'`,
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).toContain("idx_tasks_status_created");
    expect(names).toContain("idx_tasks_assigned_to");
    expect(names).toContain("idx_approvals_created");
    expect(names).toContain("idx_agent_actions_agent_created");
    expect(names).toContain("idx_agent_actions_status");
  });
});

describe("C27: HTTP gzip + ETag", () => {
  test("/api/agents returns ETag and 304 on If-None-Match", async () => {
    const init = freshInitData();
    const r1 = await fetch(`${base}/api/agents`, {
      headers: { "x-telegram-init-data": init },
    });
    expect(r1.status).toBe(200);
    const etag = r1.headers.get("etag");
    expect(etag).toBeTruthy();
    await r1.arrayBuffer();

    const r2 = await fetch(`${base}/api/agents`, {
      headers: {
        "x-telegram-init-data": init,
        "if-none-match": etag!,
      },
    });
    expect(r2.status).toBe(304);
    expect(r2.headers.get("etag")).toBe(etag);
  });

  test("gzip applied when Accept-Encoding: gzip and body > 1KB", async () => {
    // Generate enough agent_actions so /api/actions returns a >1KB payload.
    for (let i = 0; i < 30; i++) {
      logAction({
        agentKey: "perf-bot",
        actionType: "SEND_MESSAGE",
        chatId: 9999000 + i,
        payload: { text: "x".repeat(80), idx: i },
        status: "ok",
      } as any);
    }
    const init = freshInitData();
    const r = await fetch(`${base}/api/actions?limit=200`, {
      headers: {
        "x-telegram-init-data": init,
        "accept-encoding": "gzip",
      },
      // Bun fetch will auto-decompress by default — manually inspect headers.
    });
    expect(r.status).toBe(200);
    // The server set content-encoding before returning; Bun's fetch may
    // strip it after decoding, but our server sets `vary: Accept-Encoding`
    // unconditionally when it gzips.
    const ce = r.headers.get("content-encoding");
    const vary = r.headers.get("vary");
    expect(ce === "gzip" || (vary && vary.toLowerCase().includes("accept-encoding")))
      .toBeTruthy();
    await r.arrayBuffer();
  });

  test("SSE endpoint is not gzipped", async () => {
    const init = freshInitData();
    const r = await fetch(await sseUrl(base, init), {
      headers: { "accept-encoding": "gzip" },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type") ?? "").toContain("text/event-stream");
    expect(r.headers.get("content-encoding")).toBeNull();
    // Drain a tiny bit and close.
    try {
      const reader = r.body?.getReader();
      if (reader) {
        await reader.read();
        await reader.cancel();
      }
    } catch {}
  });
});

describe("C27: /api/dashboard aggregated endpoint", () => {
  test("returns expected shape", async () => {
    const init = freshInitData();
    const r = await fetch(`${base}/api/dashboard`, {
      headers: { "x-telegram-init-data": init },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(Array.isArray(body.agents)).toBe(true);
    expect(Array.isArray(body.recentTasks)).toBe(true);
    expect(Array.isArray(body.pendingApprovals)).toBe(true);
    expect(Array.isArray(body.recentActions)).toBe(true);
    expect(Array.isArray(body.budgets)).toBe(true);
    // Sanity: budgets and agents have the same number of entries (one per character).
    expect(body.budgets.length).toBe(body.agents.length);
  });
});
