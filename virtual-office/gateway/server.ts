import type { ServerWebSocket } from "bun";
import { CommandSchema, HelloSchema } from "../contracts/protocol";
import { OfficeStore } from "./store";
type SocketData = { ready: boolean; lastPong: number; opened: number };
export function startGateway({
  port = 4318,
  store = new OfficeStore(),
  origins = ["http://127.0.0.1:4317", "http://localhost:4317"],
  staticDir,
}: {
  port?: number;
  store?: OfficeStore;
  origins?: string[];
  staticDir?: string;
} = {}) {
  const tickets = new Map<string, number>();
  const sockets = new Set<ServerWebSocket<SocketData>>();
  const json = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  const server = Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port,
    maxRequestBodySize: 4096,
    async fetch(req, srv) {
      const url = new URL(req.url),
        origin = req.headers.get("origin");
      const own = `http://127.0.0.1:${srv.port}`,
        permitted = origin !== null && [...origins, own].includes(origin);
      if (!["127.0.0.1", "localhost"].includes(url.hostname))
        return json({ error: "host_forbidden" }, 403);
      if (origin && !permitted) return json({ error: "origin_forbidden" }, 403);
      if (url.pathname === "/office/v1/capabilities" && req.method === "GET")
        return json({
          mode: "mock",
          agents: ["backend"],
          directChat: "mock",
          productionReady: false,
        });
      if (
        url.pathname === "/office/v1/stream-ticket" &&
        req.method === "POST"
      ) {
        if (!permitted) return json({ error: "origin_required" }, 403);
        for (const [id, expires] of tickets)
          if (expires < Date.now()) tickets.delete(id);
        if (tickets.size >= 64) return json({ error: "too_many_tickets" }, 429);
        const ticket = crypto.randomUUID();
        tickets.set(ticket, Date.now() + 15_000);
        return json({ ticket });
      }
      if (url.pathname === "/office/v1/stream") {
        if (!permitted) return json({ error: "origin_required" }, 403);
        const id = url.searchParams.get("ticket") ?? "",
          expires = tickets.get(id);
        tickets.delete(id);
        if (!expires || expires < Date.now())
          return json({ error: "invalid_ticket" }, 401);
        if (sockets.size >= 8)
          return json({ error: "too_many_connections" }, 429);
        return srv.upgrade(req, {
          data: { ready: false, lastPong: Date.now(), opened: Date.now() },
        })
          ? undefined
          : json({ error: "upgrade_required" }, 400);
      }
      if (url.pathname === "/office/v1/commands" && req.method === "POST") {
        if (!permitted) return json({ error: "origin_required" }, 403);
        try {
          const cmd = CommandSchema.parse(await req.json());
          return json(store.execute(cmd));
        } catch (e) {
          return json(
            {
              error:
                e instanceof Error && e.message === "idempotency_conflict"
                  ? "idempotency_conflict"
                  : "invalid_command",
            },
            e instanceof Error && e.message === "idempotency_conflict"
              ? 409
              : 400,
          );
        }
      }
      if (
        url.pathname.startsWith("/office/v1/commands/") &&
        req.method === "GET"
      ) {
        const id = url.pathname.split("/").at(-1)!;
        return json(
          store.result(id) ?? { error: "not_found" },
          store.result(id) ? 200 : 404,
        );
      }
      if (
        staticDir &&
        req.method === "GET" &&
        !url.pathname.startsWith("/office/")
      ) {
        const path =
          url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        if (!/^[a-zA-Z0-9_./-]+$/.test(path) || path.split("/").includes(".."))
          return new Response("Not found", { status: 404 });
        const file = Bun.file(`${staticDir}/${path}`);
        if (await file.exists())
          return new Response(file, {
            headers: {
              "X-Content-Type-Options": "nosniff",
              "Content-Security-Policy":
                "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; worker-src 'self' blob:",
            },
          });
      }
      return json({ error: "not_found" }, 404);
    },
    websocket: {
      maxPayloadLength: 4096,
      backpressureLimit: 1024 * 1024,
      closeOnBackpressureLimit: true,
      open(ws) {
        sockets.add(ws);
      },
      message(ws, raw) {
        try {
          const input = JSON.parse(String(raw));
          if (input.kind === "pong") {
            ws.data.lastPong = Date.now();
            return;
          }
          const hello = HelloSchema.parse(input);
          ws.data.ready = false;
          const replay = store.replay(hello.streamId, hello.lastAppliedSeq);
          // Synchronous snapshot/replay + subscription: no await window for a missed event.
          if (replay === null)
            ws.send(
              JSON.stringify({ kind: "snapshot", world: store.snapshot() }),
            );
          else {
            ws.send(
              JSON.stringify({
                kind: "resumed",
                streamId: store.world.streamId,
                seq: hello.lastAppliedSeq,
              }),
            );
            for (const event of replay)
              ws.send(JSON.stringify({ kind: "event", event }));
          }
          ws.data.ready = true;
        } catch {
          ws.close(1008, "invalid protocol");
        }
      },
      close(ws) {
        sockets.delete(ws);
      },
    },
  });
  const listener = (event: unknown) => {
    for (const ws of sockets)
      if (ws.data.ready) ws.send(JSON.stringify({ kind: "event", event }));
  };
  store.listeners.add(listener);
  const heartbeat = setInterval(() => {
    for (const ws of sockets) {
      if (
        Date.now() - ws.data.lastPong > 45_000 ||
        (!ws.data.ready && Date.now() - ws.data.opened > 10_000)
      )
        ws.close(1001, "heartbeat expired");
      else ws.send(JSON.stringify({ kind: "heartbeat", at: Date.now() }));
    }
  }, 15_000);
  return {
    server,
    store,
    stop() {
      clearInterval(heartbeat);
      store.listeners.delete(listener);
      server.stop(true);
    },
  };
}
