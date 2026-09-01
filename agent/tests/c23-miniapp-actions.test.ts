/**
 * C23 (M1) — Mini App actions: create task, pause/resume agent, per-agent autonomy.
 *
 * Hits the HTTP endpoints directly using buildInitData (no browser).
 */
process.env.MINIAPP_BOT_TOKEN = "test_bot_token_for_c23";

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { buildInitData } from "../lib/miniapp-auth.ts";
import {
  startMiniappServer,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";
import { getTask } from "../lib/tasks.ts";
import { getAutonomy } from "../lib/permissions.ts";
import { db } from "../lib/db.ts";
import { CHARACTERS } from "../characters/index.ts";

const BOT_TOKEN = "test_bot_token_for_c23";
const USER_ID = 22222;
const ADMIN_ID = 88888;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function freshInitData(userId = USER_ID): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(nowSec()),
    query_id: "q1",
    user: JSON.stringify({ id: userId, username: "tester", first_name: "T" }),
  });
}

let server: MiniappServerHandle;
let base: string;

beforeAll(() => {
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
});

async function api(
  path: string,
  init: RequestInit = {},
  initData?: string,
): Promise<{ status: number; body: any }> {
  const headers = new Headers(init.headers);
  if (initData !== undefined && initData !== null) {
    headers.set("x-telegram-init-data", initData);
  }
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const res = await fetch(`${base}${path}`, { ...init, headers });
  let body: any = null;
  try {
    body = await res.json();
  } catch {}
  return { status: res.status, body };
}

describe("C23 — POST /api/tasks", () => {
  // T-313 fix (finding #6): POST /api/tasks is now admin-gated, so all
  // these tests must authenticate as the admin user.
  test("creates a pending task with minimal fields", async () => {
    const r = await api(
      "/api/tasks",
      {
        method: "POST",
        body: JSON.stringify({
          title: "c23 new task",
          chat_id: -555,
          assignee: "qa",
          type: "feature",
          input: { foo: "bar" },
        }),
      },
      freshInitData(ADMIN_ID),
    );
    expect(r.status).toBe(201);
    expect(r.body.task.title).toBe("c23 new task");
    expect(r.body.task.status).toBe("pending");
    expect(r.body.task.assigned_to).toBe("qa");
    expect(r.body.task.created_by).toBe(`miniapp:${ADMIN_ID}`);
    expect(getTask(r.body.task.id)?.title).toBe("c23 new task");
  });

  test("rejects without title", async () => {
    const r = await api(
      "/api/tasks",
      { method: "POST", body: JSON.stringify({ chat_id: -1 }) },
      freshInitData(ADMIN_ID),
    );
    expect(r.status).toBe(400);
  });

  test("rejects without chat_id", async () => {
    const r = await api(
      "/api/tasks",
      { method: "POST", body: JSON.stringify({ title: "no chat" }) },
      freshInitData(ADMIN_ID),
    );
    expect(r.status).toBe(400);
  });

  test("non-admin POST /api/tasks → 403 (T-313 admin gate)", async () => {
    const r = await api(
      "/api/tasks",
      {
        method: "POST",
        body: JSON.stringify({ title: "non-admin", chat_id: -555 }),
      },
      freshInitData(USER_ID),
    );
    expect(r.status).toBe(403);
  });
});

describe("C23 — agent pause/resume", () => {
  const agentKey = CHARACTERS[0].key;

  test("non-admin cannot pause", async () => {
    const r = await api(
      `/api/agents/${agentKey}/pause`,
      { method: "POST" },
      freshInitData(),
    );
    expect(r.status).toBe(403);
  });

  test("admin can pause and resume, reflected in /api/agents", async () => {
    const p = await api(
      `/api/agents/${agentKey}/pause`,
      { method: "POST" },
      freshInitData(ADMIN_ID),
    );
    expect(p.status).toBe(200);
    expect(p.body.paused).toBe(true);

    const list = await api("/api/agents", {}, freshInitData(ADMIN_ID));
    const found = list.body.agents.find((a: any) => a.key === agentKey);
    expect(found.paused).toBe(true);
    expect(found.status).toBe("paused");

    const r = await api(
      `/api/agents/${agentKey}/resume`,
      { method: "POST" },
      freshInitData(ADMIN_ID),
    );
    expect(r.status).toBe(200);
    expect(r.body.paused).toBe(false);

    // DB row exists.
    const row = db
      .prepare(`SELECT paused FROM agent_states WHERE agent_key = ?`)
      .get(agentKey) as { paused: number } | undefined;
    expect(row?.paused).toBe(0);
  });

  test("unknown agent → 404", async () => {
    const r = await api(
      `/api/agents/no-such-agent/pause`,
      { method: "POST" },
      freshInitData(ADMIN_ID),
    );
    expect(r.status).toBe(404);
  });
});

describe("C23 — per-agent autonomy", () => {
  test("admin can set per-agent autonomy and read it back", async () => {
    const agent = CHARACTERS[1].key;
    const post = await api(
      "/api/autonomy",
      {
        method: "POST",
        body: JSON.stringify({ mode: "manual", agent }),
      },
      freshInitData(ADMIN_ID),
    );
    expect(post.status).toBe(200);
    expect(post.body.mode).toBe("manual");
    expect(post.body.agent).toBe(agent);

    const get = await api(
      `/api/autonomy?agent=${agent}`,
      {},
      freshInitData(ADMIN_ID),
    );
    expect(get.status).toBe(200);
    expect(get.body.mode).toBe("manual");
    expect(getAutonomy(undefined, agent)).toBe("manual");
  });
});
