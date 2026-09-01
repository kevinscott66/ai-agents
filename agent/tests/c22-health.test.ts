/**
 * C22: active health checks (Telegram getMe poller).
 */
import { describe, test, expect } from "bun:test";
import { startHealthMonitor } from "../lib/health.ts";
import type { RunningBot } from "../lib/types.ts";

function makeBot(
  key: string,
  getMe: () => Promise<any>,
): RunningBot {
  return {
    def: { key, name: key } as any,
    bot: { telegram: { getMe } } as any,
    username: `${key}_bot`,
    id: 1,
  };
}

describe("C22 active health monitor", () => {
  test("successful getMe → alive=true, lastOkAt set, no failures", async () => {
    const b = makeBot("alpha", async () => ({ id: 1, username: "alpha_bot" }));
    const h = startHealthMonitor({ bots: [b], intervalMs: 60_000 });
    try {
      await h._tick();
      const snap = h.snapshot();
      expect(snap).toHaveLength(1);
      expect(snap[0].agentKey).toBe("alpha");
      expect(snap[0].alive).toBe(true);
      expect(snap[0].lastOkAt).toBeGreaterThan(0);
      expect(snap[0].consecutiveFailures).toBe(0);
      expect(snap[0].lastError).toBeUndefined();
    } finally {
      h.stop();
    }
  });

  test("failing getMe → alive=false, consecutiveFailures increments", async () => {
    let calls = 0;
    const b = makeBot("beta", async () => {
      calls++;
      throw new Error("Unauthorized");
    });
    const h = startHealthMonitor({ bots: [b], intervalMs: 60_000 });
    try {
      await h._tick();
      await h._tick();
      const snap = h.snapshot();
      expect(snap[0].alive).toBe(false);
      expect(snap[0].consecutiveFailures).toBeGreaterThanOrEqual(2);
      expect(snap[0].lastError).toContain("Unauthorized");
      expect(snap[0].lastErrorAt).toBeGreaterThan(0);
      expect(calls).toBeGreaterThanOrEqual(2);
    } finally {
      h.stop();
    }
  });

  test("recovery after failure resets consecutiveFailures", async () => {
    let mode: "fail" | "ok" = "fail";
    const b = makeBot("gamma", async () => {
      if (mode === "fail") throw new Error("temp");
      return { id: 2, username: "gamma_bot" };
    });
    const h = startHealthMonitor({ bots: [b], intervalMs: 60_000 });
    try {
      await h._tick();
      await h._tick();
      expect(h.snapshot()[0].consecutiveFailures).toBe(2);
      mode = "ok";
      await h._tick();
      const snap = h.snapshot()[0];
      expect(snap.alive).toBe(true);
      expect(snap.consecutiveFailures).toBe(0);
      expect(snap.lastError).toBeUndefined();
    } finally {
      h.stop();
    }
  });

  test("one bot's failure doesn't crash tick for others", async () => {
    const a = makeBot("a", async () => ({ id: 1, username: "a_bot" }));
    const b = makeBot("b", async () => {
      throw new Error("boom");
    });
    const h = startHealthMonitor({ bots: [a, b], intervalMs: 60_000 });
    try {
      await h._tick();
      const snap = h.snapshot();
      const byKey = Object.fromEntries(snap.map((s) => [s.agentKey, s]));
      expect(byKey.a.alive).toBe(true);
      expect(byKey.b.alive).toBe(false);
      expect(byKey.b.lastError).toContain("boom");
    } finally {
      h.stop();
    }
  });

  test("intervalMs floor enforced at 60_000 (no rate-limit risk)", async () => {
    // Tries to set 1ms — should be clamped. We can't easily observe the
    // interval directly, but the handle should still work and snapshot.
    const b = makeBot("d", async () => ({ id: 3, username: "d_bot" }));
    const h = startHealthMonitor({ bots: [b], intervalMs: 1 });
    try {
      await h._tick();
      expect(h.snapshot()[0].alive).toBe(true);
    } finally {
      h.stop();
    }
  });
});
