/**
 * T-705b: anti-loop circuit breaker on the diagnostic-fix chain.
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { db } from "../lib/db.ts";
import {
  dispatchAndAudit,
  type DispatchAndAuditResult,
} from "../lib/action-dispatch.ts";
import {
  getFixChain,
  appendFixChain,
  getFixChainMaxDepth,
} from "../lib/fix-chain.ts";
import { cleanupChat } from "./_helpers.ts";

const TEST_CHAT = -1_000_7705;

let savedEnv: string | undefined;
beforeEach(() => {
  savedEnv = process.env.INTER_AGENT_FIX_CHAIN_MAX_DEPTH;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.INTER_AGENT_FIX_CHAIN_MAX_DEPTH;
  else process.env.INTER_AGENT_FIX_CHAIN_MAX_DEPTH = savedEnv;
  cleanupChat(TEST_CHAT, "orchestrator");
  cleanupChat(TEST_CHAT, "aieng");
});

/**
 * Поле `error` есть только в ветке `ok: false` union'а DispatchAndAuditResult,
 * а expect(res.ok).toBe(false) строкой выше TS не сужает. Сужаем явно, чтобы
 * несовпадение ветки было видно как провал теста, а не как undefined в toContain.
 */
function errorOf(res: DispatchAndAuditResult): string {
  if (res.ok) throw new Error("ожидали провал действия, получили ok");
  return res.error;
}

function pendingDiagFor(chatId: number) {
  return db
    .prepare(
      `SELECT id, input FROM tasks
       WHERE chat_id = ? AND assigned_to = 'aieng' AND status = 'pending'
         AND input LIKE '%"_diag":true%'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(chatId) as { id: string; input: string } | undefined;
}

describe("fix-chain helpers (T-705b)", () => {
  test("getFixChain — missing field → []", () => {
    expect(getFixChain({})).toEqual([]);
    expect(getFixChain(null)).toEqual([]);
    expect(getFixChain({ _fix_chain: "not-array" })).toEqual([]);
  });

  test("getFixChain — strings only", () => {
    expect(getFixChain({ _fix_chain: ["a", 1, "b", null] })).toEqual(["a", "b"]);
  });

  test("appendFixChain — pure", () => {
    const a: string[] = ["x"];
    const b = appendFixChain(a, "y");
    expect(b).toEqual(["x", "y"]);
    expect(a).toEqual(["x"]); // unchanged
  });

  test("getFixChainMaxDepth — default 3, env override", () => {
    delete process.env.INTER_AGENT_FIX_CHAIN_MAX_DEPTH;
    expect(getFixChainMaxDepth()).toBe(3);
    process.env.INTER_AGENT_FIX_CHAIN_MAX_DEPTH = "5";
    expect(getFixChainMaxDepth()).toBe(5);
    process.env.INTER_AGENT_FIX_CHAIN_MAX_DEPTH = "garbage";
    expect(getFixChainMaxDepth()).toBe(3);
  });
});

describe("circuit breaker on diag-task creation (T-705b)", () => {
  test("chain length 0 → 1: new diag task created, chain captured", async () => {
    const res = await dispatchAndAudit(
      "SEND_MESSAGE",
      { text: "hi" } as any,
      { agentKey: "orchestrator", chatId: TEST_CHAT },
    );
    expect(res.ok).toBe(false);
    const found = pendingDiagFor(TEST_CHAT);
    expect(found).toBeDefined();
    const parsed = JSON.parse(found!.input);
    expect(Array.isArray(parsed._fix_chain)).toBe(true);
    expect(parsed._fix_chain.length).toBe(1);
  });

  test("chain length 2 → 3: boundary, diag still created (depth == max not yet tripped at parent)", async () => {
    const parentChain = ["a", "b"];
    const res = await dispatchAndAudit(
      "SEND_MESSAGE",
      { text: "hi", _fix_chain: parentChain } as any,
      { agentKey: "orchestrator", chatId: TEST_CHAT },
    );
    expect(res.ok).toBe(false);
    expect(errorOf(res)).not.toContain("circuit breaker");
    const found = pendingDiagFor(TEST_CHAT);
    expect(found).toBeDefined();
    const parsed = JSON.parse(found!.input);
    expect(parsed._fix_chain.length).toBe(3);
  });

  test("chain length 3 (== max): NO new diag, error mentions circuit breaker", async () => {
    const parentChain = ["a", "b", "c"];
    const res = await dispatchAndAudit(
      "SEND_MESSAGE",
      { text: "hi", _fix_chain: parentChain } as any,
      { agentKey: "orchestrator", chatId: TEST_CHAT },
    );
    expect(res.ok).toBe(false);
    expect(errorOf(res)).toContain("circuit breaker");
    const found = pendingDiagFor(TEST_CHAT);
    expect(found ?? undefined).toBeUndefined();
  });

  test("env override INTER_AGENT_FIX_CHAIN_MAX_DEPTH=1 trips at length 1", async () => {
    process.env.INTER_AGENT_FIX_CHAIN_MAX_DEPTH = "1";
    const res = await dispatchAndAudit(
      "SEND_MESSAGE",
      { text: "hi", _fix_chain: ["only-one"] } as any,
      { agentKey: "orchestrator", chatId: TEST_CHAT },
    );
    expect(res.ok).toBe(false);
    expect(errorOf(res)).toContain("circuit breaker");
    const found = pendingDiagFor(TEST_CHAT);
    expect(found ?? undefined).toBeUndefined();
  });
});
