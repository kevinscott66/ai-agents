/**
 * M2 — Server-Sent Events backend tests.
 *
 * Verifies:
 *  - GET /api/events returns proper SSE headers
 *  - in-process bus emit -> subscribe fan-out
 *  - SSE response delivers an emitted event
 *  - subscribe returns a working unsubscribe
 *  - POST /api/tasks triggers task.created on the bus
 */
process.env.MINIAPP_BOT_TOKEN = "test_bot_token_for_c24";

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { sseUrl } from "./_sse.ts";
import { buildInitData } from "../lib/miniapp-auth.ts";
import {
  startMiniappServer,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";
import {
  emit,
  subscribe,
  _listenerCount,
  type BusEvent,
} from "../lib/events-bus.ts";

const BOT_TOKEN = "test_bot_token_for_c24";
const USER_ID = 424242;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function freshInitData(): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(nowSec()),
    query_id: "q-sse",
    user: JSON.stringify({ id: USER_ID, username: "sse", first_name: "S" }),
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

describe("events-bus", () => {
  test("emit fan-out is synchronous", () => {
    const seen: BusEvent[] = [];
    const unsub = subscribe((e) => seen.push(e));
    emit("task.created", { id: "x1" });
    expect(seen.length).toBe(1);
    expect(seen[0].name).toBe("task.created");
    expect((seen[0].payload as any).id).toBe("x1");
    unsub();
  });

  test("unsubscribe removes the listener", () => {
    const before = _listenerCount();
    const fn = () => {};
    const unsub = subscribe(fn);
    expect(_listenerCount()).toBe(before + 1);
    unsub();
    expect(_listenerCount()).toBe(before);
  });
});

describe("GET /api/events", () => {
  test("requires initData", async () => {
    const r = await fetch(`${base}/api/events`);
    expect(r.status).toBe(401);
    try {
      r.body?.cancel();
    } catch {}
  });

  test("returns SSE headers when authed", async () => {
    const init = freshInitData();
    const ctrl = new AbortController();
    const r = await fetch(
      await sseUrl(base, init),
      { signal: ctrl.signal },
    );
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type") || "").toContain("text/event-stream");
    expect(r.headers.get("cache-control") || "").toContain("no-cache");
    ctrl.abort();
  });

  test("delivers an emitted event over the wire", async () => {
    const init = freshInitData();
    const ctrl = new AbortController();
    const r = await fetch(
      await sseUrl(base, init),
      { signal: ctrl.signal },
    );
    expect(r.status).toBe(200);
    const reader = r.body!.getReader();
    const dec = new TextDecoder();

    // Emit a tick after the connection is open. setTimeout gives the server
    // a chance to flush headers + initial :ok comment.
    setTimeout(() => emit("task.created", { id: "sse-1" }), 50);

    let buf = "";
    const deadline = Date.now() + 3000;
    let gotEvent = false;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (buf.includes("event: task.created") && buf.includes("sse-1")) {
        gotEvent = true;
        break;
      }
    }
    ctrl.abort();
    try {
      reader.releaseLock();
    } catch {}
    expect(gotEvent).toBe(true);
  });
});

describe("REST -> bus wiring", () => {
  test("POST /api/tasks emits task.created", async () => {
    const seen: BusEvent[] = [];
    const unsub = subscribe((e) => {
      if (e.name === "task.created") seen.push(e);
    });
    const init = freshInitData();
    const r = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: {
        "x-telegram-init-data": init,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "sse smoke",
        chat_id: -42,
      }),
    });
    expect(r.status).toBe(201);
    unsub();
    expect(seen.length).toBeGreaterThanOrEqual(1);
    const payload = seen[0].payload as any;
    expect(payload).toBeTruthy();
    expect(payload.chat_id).toBe(-42);
  });
});
