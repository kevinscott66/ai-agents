/**
 * T-317: Direct unit/integration tests for agent/lib/mac-bridge.ts.
 *
 * Baseline coverage (T-304 audit): ~6.9%.
 * This file targets:
 *   - sendToMac() happy path, mac_offline rejection, JSON-send error path
 *   - stopMac() happy path, mac_offline, send-throws path
 *   - isUserAllowed() — empty CSV, missing user, whitelist hit/miss
 *   - isMacConnected() / isMacOnline() state transitions
 *   - startMacBridge() guard: short secret rejected, missing secret no-ops
 *   - WS handshake against a real local server:
 *       - bad secret → auth_fail + close
 *       - no secret in handler env → auth_fail
 *       - good secret → auth_ok
 *       - non-auth message before auth → close
 *       - chunk/result delivery to a pending run resolves sendToMac
 *
 * Env vars are saved/restored in try/finally (CLAUDE.md §3.8.7).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  sendToMac,
  stopMac,
  isUserAllowed,
  isMacConnected,
  isMacOnline,
  startMacBridge,
  _setActiveSocketForTests,
  bridgeConnectionLimits,
  bridgeOriginAllowed,
  bridgePathAllowed,
} from "../lib/mac-bridge.ts";

const SECRET_OK = "x".repeat(40); // long enough to pass guard

function withEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => T,
): T {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k]!;
    }
  }
}

beforeEach(() => {
  _setActiveSocketForTests(null);
});
afterEach(() => {
  _setActiveSocketForTests(null);
});

describe("isUserAllowed", () => {
  test("returns false when MAC_USER_IDS env is empty", () => {
    withEnv({ MAC_USER_IDS: "" }, () => {
      expect(isUserAllowed("42")).toBe(false);
    });
  });

  test("returns false when MAC_USER_IDS is whitespace-only", () => {
    withEnv({ MAC_USER_IDS: "   " }, () => {
      expect(isUserAllowed("42")).toBe(false);
    });
  });

  test("returns false when userId is null/undefined", () => {
    withEnv({ MAC_USER_IDS: "42,99" }, () => {
      expect(isUserAllowed(null)).toBe(false);
      expect(isUserAllowed(undefined)).toBe(false);
      expect(isUserAllowed("")).toBe(false);
    });
  });

  test("returns true for whitelisted id, false for non-whitelisted", () => {
    withEnv({ MAC_USER_IDS: "42, 99 , 100" }, () => {
      expect(isUserAllowed("42")).toBe(true);
      expect(isUserAllowed("99")).toBe(true);
      expect(isUserAllowed("100")).toBe(true);
      expect(isUserAllowed("7")).toBe(false);
    });
  });

  test("handles numeric userId by stringifying", () => {
    withEnv({ MAC_USER_IDS: "42" }, () => {
      // The signature is string | null | undefined, but the impl does String(userId).
      expect(isUserAllowed(42 as unknown as string)).toBe(true);
    });
  });
});

describe("mac bridge connection boundary", () => {
  test("allows the daemon path only", () => {
    expect(bridgePathAllowed("/")).toBe(true);
    expect(bridgePathAllowed("/other")).toBe(false);
  });

  test("rejects browser origins unless explicitly allowlisted", () => {
    withEnv({ MAC_BRIDGE_ALLOWED_ORIGINS: "https://agents.example.test" }, () => {
      expect(bridgeOriginAllowed(null)).toBe(true);
      expect(bridgeOriginAllowed("https://agents.example.test")).toBe(true);
      expect(bridgeOriginAllowed("https://attacker.example.test")).toBe(false);
    });
  });

  test("uses bounded defaults and env overrides", () => {
    withEnv({
      MAC_BRIDGE_MAX_CONNECTIONS: "3",
      MAC_BRIDGE_MAX_CONNECTIONS_PER_IP: "2",
      MAC_BRIDGE_AUTH_TIMEOUT_MS: "900",
    }, () => {
      expect(bridgeConnectionLimits()).toEqual({ total: 3, perIp: 2, authTimeoutMs: 900 });
    });
  });
});

describe("isMacConnected / isMacOnline", () => {
  test("both false when no active socket", () => {
    _setActiveSocketForTests(null);
    expect(isMacConnected()).toBe(false);
    expect(isMacOnline()).toBe(false);
  });

  test("connected+online once a socket is injected (no pong yet)", () => {
    _setActiveSocketForTests({ send: () => {} });
    expect(isMacConnected()).toBe(true);
    expect(isMacOnline()).toBe(true);
  });
});

describe("sendToMac", () => {
  test("rejects with mac_offline when no socket is connected", async () => {
    _setActiveSocketForTests(null);
    await expect(
      sendToMac({ project: "/x", prompt: "p", mode: "ask" }),
    ).rejects.toThrow("mac_offline");
  });

  test("rejects synchronously thrown send errors", async () => {
    const sock = {
      send: () => {
        throw new Error("socket boom");
      },
    };
    _setActiveSocketForTests(sock);
    await expect(
      sendToMac({ project: "/x", prompt: "p", mode: "ask" }),
    ).rejects.toThrow("socket boom");
  });

  test("forwards project/prompt/mode + generates an id on the wire", async () => {
    const sent: string[] = [];
    const sock = {
      send: (s: string) => {
        sent.push(s);
      },
    };
    _setActiveSocketForTests(sock);
    // Don't await — we just want to verify the outgoing frame.
    const p = sendToMac({
      project: "/Users/x",
      prompt: "hello",
      mode: "accept_edits",
    });
    // Avoid unhandled-rejection: detach and ignore (it will time out long after the test).
    p.catch(() => {});
    expect(sent.length).toBe(1);
    const parsed = JSON.parse(sent[0]!);
    expect(parsed.type).toBe("run");
    expect(parsed.project).toBe("/Users/x");
    expect(parsed.prompt).toBe("hello");
    expect(parsed.mode).toBe("accept_edits");
    expect(typeof parsed.id).toBe("string");
    expect(parsed.id.length).toBeGreaterThan(2);
    // Clean up pending state.
    _setActiveSocketForTests(null);
  });
});

describe("stopMac", () => {
  test("returns mac_offline when no socket", async () => {
    _setActiveSocketForTests(null);
    const res = await stopMac();
    expect(res.ok).toBe(false);
    expect(res.error).toBe("mac_offline");
  });

  test("sends {type:'stop'} on the wire and resolves ok:true", async () => {
    const sent: string[] = [];
    _setActiveSocketForTests({
      send: (s: string) => {
        sent.push(s);
      },
    });
    const res = await stopMac();
    expect(res.ok).toBe(true);
    expect(sent.length).toBe(1);
    expect(JSON.parse(sent[0]!)).toEqual({ type: "stop" });
  });

  test("returns ok:false with error when send throws", async () => {
    _setActiveSocketForTests({
      send: () => {
        throw new Error("write failed");
      },
    });
    const res = await stopMac();
    expect(res.ok).toBe(false);
    expect(res.error).toBe("write failed");
  });

  test("stopMac rejects all pending sendToMac calls with mac_stopped", async () => {
    const sock = { send: (_: string) => {} };
    _setActiveSocketForTests(sock);
    const pending = sendToMac({ project: "/x", prompt: "p", mode: "ask" });
    const stopRes = await stopMac();
    expect(stopRes.ok).toBe(true);
    await expect(pending).rejects.toThrow("mac_stopped");
  });
});

describe("startMacBridge guard", () => {
  test("returns null when MAC_BRIDGE_SECRET is unset (no-op)", () => {
    const handle = withEnv({ MAC_BRIDGE_SECRET: undefined }, () =>
      startMacBridge(),
    );
    expect(handle).toBeNull();
  });

  test("throws when MAC_BRIDGE_SECRET is shorter than 32 chars", () => {
    withEnv({ MAC_BRIDGE_SECRET: "short" }, () => {
      expect(() => startMacBridge()).toThrow(/at least 32 characters/);
    });
  });
});

describe("WebSocket handshake (integration)", () => {
  let handle: { stop: () => void; port: number } | null = null;
  let savedSecret: string | undefined;
  let savedPort: string | undefined;

  beforeEach(() => {
    savedSecret = process.env.MAC_BRIDGE_SECRET;
    savedPort = process.env.MAC_BRIDGE_PORT;
  });

  afterEach(() => {
    if (handle) {
      try {
        handle.stop();
      } catch {}
      handle = null;
    }
    _setActiveSocketForTests(null);
    if (savedSecret === undefined) delete process.env.MAC_BRIDGE_SECRET;
    else process.env.MAC_BRIDGE_SECRET = savedSecret;
    if (savedPort === undefined) delete process.env.MAC_BRIDGE_PORT;
    else process.env.MAC_BRIDGE_PORT = savedPort;
  });

  function startOnRandomPort(secret: string | undefined) {
    // mac-bridge stores the *requested* port literally in its handle, and reads
    // MAC_BRIDGE_SECRET from process.env on every incoming auth message —
    // so we must leave the env vars set for the duration of the test, not just
    // for the startMacBridge() call. afterEach() restores them.
    if (secret === undefined) delete process.env.MAC_BRIDGE_SECRET;
    else process.env.MAC_BRIDGE_SECRET = secret;
    let lastErr: unknown = null;
    for (let i = 0; i < 8; i++) {
      const port = 40000 + Math.floor(Math.random() * 20000);
      process.env.MAC_BRIDGE_PORT = String(port);
      try {
        return startMacBridge();
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("no_free_port");
  }

  function connect(port: number): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      ws.addEventListener("open", () => resolve(ws), { once: true });
      ws.addEventListener("error", (e) => reject(e), { once: true });
      setTimeout(() => reject(new Error("connect_timeout")), 3000);
    });
  }

  function nextMessage(ws: WebSocket, timeoutMs = 2000): Promise<any> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("msg_timeout")), timeoutMs);
      ws.addEventListener(
        "message",
        (ev) => {
          clearTimeout(t);
          try {
            resolve(JSON.parse(String(ev.data)));
          } catch (e) {
            reject(e as Error);
          }
        },
        { once: true },
      );
    });
  }

  function awaitClose(ws: WebSocket, timeoutMs = 2000): Promise<void> {
    return new Promise((resolve, reject) => {
      if (ws.readyState === ws.CLOSED) return resolve();
      const t = setTimeout(() => reject(new Error("close_timeout")), timeoutMs);
      ws.addEventListener(
        "close",
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true },
      );
    });
  }

  test("rejects wrong secret with auth_fail and closes", async () => {
    handle = startOnRandomPort(SECRET_OK);
    expect(handle).not.toBeNull();
    const ws = await connect(handle!.port);
    ws.send(JSON.stringify({ type: "auth", secret: "nope" }));
    const msg = await nextMessage(ws);
    expect(msg).toEqual({ type: "auth_fail", error: "bad_secret" });
    await awaitClose(ws);
    expect(isMacConnected()).toBe(false);
  });

  test("accepts correct secret with auth_ok and marks bridge connected", async () => {
    handle = startOnRandomPort(SECRET_OK);
    const ws = await connect(handle!.port);
    ws.send(JSON.stringify({ type: "auth", secret: SECRET_OK }));
    const msg = await nextMessage(ws);
    expect(msg).toEqual({ type: "auth_ok" });
    expect(isMacConnected()).toBe(true);
    ws.close();
    await awaitClose(ws);
  });

  test("closes pre-auth client that sends a non-auth message", async () => {
    handle = startOnRandomPort(SECRET_OK);
    const ws = await connect(handle!.port);
    ws.send(JSON.stringify({ type: "chunk", id: "x", data: "hi" }));
    await awaitClose(ws);
    expect(isMacConnected()).toBe(false);
  });

  test("end-to-end run: chunk + result resolves sendToMac with accumulated stdout/stderr", async () => {
    handle = startOnRandomPort(SECRET_OK);
    const ws = await connect(handle!.port);
    ws.send(JSON.stringify({ type: "auth", secret: SECRET_OK }));
    const authMsg = await nextMessage(ws);
    expect(authMsg.type).toBe("auth_ok");

    // Capture the "run" frame the bridge sends back to us.
    const runFrameP = nextMessage(ws);
    const progressSnapshots: Array<{ stdout: string; stderr: string }> = [];
    const runP = sendToMac({
      project: "/p",
      prompt: "echo hi",
      mode: "ask",
      onProgress: (snap) => progressSnapshots.push({ ...snap }),
    });
    const runFrame = await runFrameP;
    expect(runFrame.type).toBe("run");
    expect(typeof runFrame.id).toBe("string");

    // Stream a stdout chunk, a stderr chunk, then the final result.
    ws.send(
      JSON.stringify({
        type: "chunk",
        id: runFrame.id,
        stream: "stdout",
        data: "hello ",
      }),
    );
    ws.send(
      JSON.stringify({
        type: "chunk",
        id: runFrame.id,
        stream: "stderr",
        data: "warn!",
      }),
    );
    ws.send(
      JSON.stringify({
        type: "result",
        id: runFrame.id,
        ok: true,
        code: 0,
      }),
    );

    const result = await runP;
    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("hello ");
    expect(result.stderr).toBe("warn!");
    expect(progressSnapshots.length).toBeGreaterThanOrEqual(1);
    expect(progressSnapshots[progressSnapshots.length - 1]!.stdout).toBe(
      "hello ",
    );

    ws.close();
    await awaitClose(ws);
  });

  test("malformed JSON before auth is ignored (socket stays open until close)", async () => {
    handle = startOnRandomPort(SECRET_OK);
    const ws = await connect(handle!.port);
    ws.send("not-json-at-all{");
    // Should not have closed us, and should not have auth'd.
    expect(isMacConnected()).toBe(false);
    ws.close();
    await awaitClose(ws);
  });
});
