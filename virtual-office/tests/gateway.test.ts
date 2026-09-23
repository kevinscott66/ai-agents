import { test, expect } from "bun:test";
import { startGateway } from "../gateway/server";
const origin = "http://127.0.0.1:4317";
async function socket(
  port: number,
  cursor?: { streamId: string; lastAppliedSeq: number },
) {
  const base = `http://127.0.0.1:${port}`;
  const { ticket } = (await (
    await fetch(`${base}/office/v1/stream-ticket`, {
      method: "POST",
      headers: { Origin: origin },
    })
  ).json()) as { ticket: string };
  // Bun supports custom WebSocket headers; the DOM overload lacks that option.
  const BunSocket = WebSocket as unknown as {
    new (url: string, options: { headers: Record<string, string> }): WebSocket;
  };
  const ws = new BunSocket(
    `ws://127.0.0.1:${port}/office/v1/stream?ticket=${ticket}`,
    { headers: { Origin: origin } },
  );
  const frames: any[] = [];
  let wake: (() => void) | undefined;
  ws.onmessage = (e) => {
    frames.push(JSON.parse(String(e.data)));
    wake?.();
  };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => {
      ws.send(JSON.stringify({ kind: "hello", schemaVersion: 1, ...cursor }));
      resolve();
    };
    ws.onerror = () => reject(new Error("socket error"));
  });
  async function next() {
    if (frames.length) return frames.shift();
    await new Promise<void>((resolve, reject) => {
      const id = setTimeout(() => reject(new Error("frame timeout")), 2000);
      wake = () => {
        clearTimeout(id);
        wake = undefined;
        resolve();
      };
    });
    return frames.shift();
  }
  return { ws, next, ticket };
}
test("socket gets snapshot, committed events, replay on reconnect; ticket single-use", async () => {
  const app = startGateway({ port: 0 });
  try {
    const port = app.server.port!,
      base = `http://127.0.0.1:${port}`,
      s = await socket(port);
    const snapshot = await s.next();
    expect(snapshot.kind).toBe("snapshot");
    const cmd = {
      commandId: crypto.randomUUID(),
      agentId: "backend",
      kind: "scenario.set",
      state: "TESTING",
    };
    const result = await fetch(`${base}/office/v1/commands`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify(cmd),
    });
    expect(result.status).toBe(200);
    const event = await s.next();
    expect(event.event.payload.agent.state).toBe("TESTING");
    s.ws.close();
    const r = await socket(port, {
      streamId: snapshot.world.streamId,
      lastAppliedSeq: 0,
    });
    expect((await r.next()).kind).toBe("resumed");
    expect((await r.next()).event.seq).toBe(1);
    r.ws.close();
    const reuse = await fetch(`${base}/office/v1/stream?ticket=${s.ticket}`, {
      headers: { Origin: origin },
    });
    expect(reuse.status).toBe(401);
    const dup = await fetch(`${base}/office/v1/commands`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify(cmd),
    });
    expect(dup.status).toBe(200);
    expect(app.store.world.seq).toBe(1);
  } finally {
    app.stop();
    app.store.close();
  }
});
test("cross-origin, missing origin, invalid command and oversized requests rejected", async () => {
  const app = startGateway({ port: 0 });
  try {
    const base = `http://127.0.0.1:${app.server.port}`;
    for (const headers of [
      { Origin: "https://attacker.example" },
      {},
    ] as Record<string, string>[])
      expect(
        (
          await fetch(`${base}/office/v1/stream-ticket`, {
            method: "POST",
            headers,
          })
        ).status,
      ).toBe(403);
    expect(
      (
        await fetch(`${base}/office/v1/commands`, {
          method: "POST",
          headers: { Origin: origin },
          body: JSON.stringify({ kind: "restart-server" }),
        })
      ).status,
    ).toBe(400);
    const tooLarge = await fetch(`${base}/office/v1/commands`, {
      method: "POST",
      headers: { Origin: origin },
      body: "x".repeat(8192),
    });
    expect([400, 413]).toContain(tooLarge.status);
    expect(app.store.world.seq).toBe(0);
  } finally {
    app.stop();
    app.store.close();
  }
});
