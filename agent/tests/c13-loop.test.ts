/**
 * C13 anti-pingpong: DELEGATE_TO_ROLE must reject delegation cycles using the
 * full ordered delegationChain, not just direct parent↔child swaps.
 *
 * Bug scenario (from production Telegram screenshot):
 *   orchestrator → perm → tgdev → perm → tgdev → ...
 * The legacy _depth counter let this past because it didn't track WHICH
 * agents had already participated. We now thread an explicit ordered chain
 * through DispatchCtx → respondAs → runWithTools → ExecCtx, and reject any
 * DELEGATE_TO_ROLE whose target is already in the chain.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  dispatchAction,
} from "../lib/action-dispatch.ts";
import { _resetRateLimits } from "../lib/rate-limits.ts";
import type { HandoffDeps, RespondAsOpts } from "../lib/handoff.ts";
import type { RunningBot } from "../lib/types.ts";
import { cleanupChat, saveAutonomy, restoreAutonomy } from "./_helpers.ts";

const TEST_CHAT = -1_000_913;

let savedGlobal = saveAutonomy();

beforeEach(() => {
  _resetRateLimits();
  cleanupChat(TEST_CHAT);
  savedGlobal = saveAutonomy();
});

afterEach(() => {
  restoreAutonomy(savedGlobal);
  _resetRateLimits();
  cleanupChat(TEST_CHAT);
});

function fakeBot(key: string): RunningBot {
  return {
    def: { key: key as never, name: key, envToken: "", system: "" } as never,
    bot: { telegram: {} } as never,
    username: `${key}_bot`,
    id: 100,
  };
}

function fakeDeps(): HandoffDeps {
  return {
    anthropic: {} as never,
    model: "test",
    historyLimit: 10,
    bots: [],
  };
}

describe("C13 delegation cycle detection", () => {
  test("A→B→A: B's DELEGATE_TO_ROLE(A) is rejected with 'cycle' error", async () => {
    // Simulate B (perm) calling DELEGATE_TO_ROLE(role=A) where A is already
    // in the chain — the production perm→tgdev→perm scenario.
    const stub = mock(async (_o: RespondAsOpts, _d: HandoffDeps) => "");
    const res = await dispatchAction(
      "DELEGATE_TO_ROLE",
      { role: "tgdev", task: "delete service messages" },
      {
        agentKey: "perm",
        chatId: TEST_CHAT,
        resolveAgent: (k) => fakeBot(k),
        handoffDeps: fakeDeps(),
        respondAsImpl: stub as never,
        delegationChain: ["orchestrator", "perm", "tgdev", "perm"],
      },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/cycle/);
      expect(res.error).toMatch(/tgdev/);
    }
    expect(stub).not.toHaveBeenCalled();
  });

  test("Direct parent↔child swap: perm→tgdev→perm is rejected", async () => {
    const stub = mock(async (_o: RespondAsOpts, _d: HandoffDeps) => "");
    const res = await dispatchAction(
      "DELEGATE_TO_ROLE",
      { role: "perm", task: "approve" },
      {
        agentKey: "tgdev",
        chatId: TEST_CHAT,
        resolveAgent: (k) => fakeBot(k),
        handoffDeps: fakeDeps(),
        respondAsImpl: stub as never,
        delegationChain: ["orchestrator", "perm", "tgdev"],
      },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/cycle.*perm/);
    expect(stub).not.toHaveBeenCalled();
  });

  test("A→B→C: no cycle, dispatch proceeds and propagates extended chain", async () => {
    const captured: RespondAsOpts[] = [];
    const stub = mock(async (o: RespondAsOpts, _d: HandoffDeps) => {
      captured.push(o);
      return "";
    });
    const res = await dispatchAction(
      "DELEGATE_TO_ROLE",
      { role: "design", task: "make banner" },
      {
        agentKey: "pm",
        chatId: TEST_CHAT,
        resolveAgent: (k) => fakeBot(k),
        handoffDeps: fakeDeps(),
        respondAsImpl: stub as never,
        delegationChain: ["orchestrator", "pm"],
      },
    );
    expect(res.ok).toBe(true);
    expect(captured.length).toBe(1);
    // Chain is extended with the new target, root-first ordering preserved.
    expect(captured[0].delegationChain).toEqual([
      "orchestrator",
      "pm",
      "design",
    ]);
  });

  test("Fallback chain (no delegationChain in ctx) is derived from agentKey", async () => {
    // Backward-compat path: caller (e.g. legacy test) didn't pass a chain.
    // Dispatcher must still detect self-loops via the derived [agentKey] chain
    // — and propagate a sensible chain to respondAs for downstream hops.
    const captured: RespondAsOpts[] = [];
    const stub = mock(async (o: RespondAsOpts, _d: HandoffDeps) => {
      captured.push(o);
      return "";
    });
    const res = await dispatchAction(
      "DELEGATE_TO_ROLE",
      { role: "design", task: "x" },
      {
        agentKey: "pm",
        chatId: TEST_CHAT,
        resolveAgent: (k) => fakeBot(k),
        handoffDeps: fakeDeps(),
        respondAsImpl: stub as never,
      },
    );
    expect(res.ok).toBe(true);
    expect(captured[0].delegationChain).toEqual(["pm", "design"]);
  });
});
