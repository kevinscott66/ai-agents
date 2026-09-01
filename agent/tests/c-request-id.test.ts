/**
 * T-410 (T-303 HIGH #2): request-id propagation through dispatch + audit.
 *
 * Asserts:
 *   1. A dispatch with an explicit `requestId` in DispatchCtx writes that id
 *      to the agent_actions row.
 *   2. dispatchAndAudit lazy-generates a non-null request_id when caller
 *      omits it, and that id is observable on ctx after the call (mutated
 *      in place so siblings inside the same turn share it).
 *   3. Two concurrent dispatches produce distinct request_ids.
 *   4. `log.info` output for the dispatch line contains the request_id.
 *   5. genRequestId() returns the documented 12-char URL-safe id.
 */
import { describe, test, expect, afterEach } from "bun:test";
import {
  dispatchAndAudit,
  type DispatchCtx,
} from "../lib/action-dispatch.ts";
import { getAction } from "../lib/audit.ts";
import { genRequestId } from "../lib/request-id.ts";
import { cleanupChat } from "./_helpers.ts";
import { db } from "../lib/db.ts";

const TEST_CHAT = 999_410_001;
const TEST_AGENT = "__t410_test__";
// Исполнитель обязан быть настоящим ключом роли (CREATE_TASK его сверяет с
// CHARACTERS): здесь важен только request_id, а не кто именно назначен.
const TEST_ASSIGNEE = "backend";

function makeCtx(overrides: Partial<DispatchCtx> = {}): DispatchCtx {
  return {
    agentKey: TEST_AGENT,
    chatId: TEST_CHAT,
    // CREATE_TASK doesn't need telegram, and skips the self-diag retry path.
    ...overrides,
  };
}

afterEach(() => {
  cleanupChat(TEST_CHAT, TEST_AGENT);
});

describe("T-410: genRequestId()", () => {
  test("returns 12-char URL-safe id", () => {
    const id = genRequestId();
    expect(id).toHaveLength(12);
    // Alphabet: 0-9 A-Z a-z _ - (URL-safe).
    expect(id).toMatch(/^[0-9A-Za-z_-]{12}$/);
  });

  test("two calls produce distinct ids", () => {
    const a = genRequestId();
    const b = genRequestId();
    expect(a).not.toBe(b);
  });
});

describe("T-410: dispatch threads request_id into agent_actions", () => {
  test("explicit requestId in ctx is persisted on the audit row", async () => {
    const requestId = "REQID_EXPL01";
    const ctx = makeCtx({ requestId });
    const res = await dispatchAndAudit(
      "CREATE_TASK",
      { title: "t-410 explicit", description: "x", assignedTo: TEST_ASSIGNEE },
      ctx,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = getAction(res.actionId);
    expect(row).not.toBeNull();
    expect(row!.request_id).toBe(requestId);
  });

  test("dispatchAndAudit lazy-generates a request_id when ctx omits it", async () => {
    const ctx = makeCtx();
    expect(ctx.requestId).toBeUndefined();
    const res = await dispatchAndAudit(
      "CREATE_TASK",
      { title: "t-410 lazy", description: "x", assignedTo: TEST_ASSIGNEE },
      ctx,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Generated id is mutated onto ctx so other handlers in the same turn
    // share it.
    expect(typeof ctx.requestId).toBe("string");
    expect(ctx.requestId).toMatch(/^[0-9A-Za-z_-]{12}$/);
    const row = getAction(res.actionId);
    expect(row!.request_id).toBe(ctx.requestId!);
  });

  test("two concurrent dispatches without explicit id get distinct request_ids", async () => {
    const ctxA = makeCtx();
    const ctxB = makeCtx();
    const [resA, resB] = await Promise.all([
      dispatchAndAudit(
        "CREATE_TASK",
        { title: "concurrent A", description: "x", assignedTo: TEST_ASSIGNEE },
        ctxA,
      ),
      dispatchAndAudit(
        "CREATE_TASK",
        { title: "concurrent B", description: "x", assignedTo: TEST_ASSIGNEE },
        ctxB,
      ),
    ]);
    expect(resA.ok).toBe(true);
    expect(resB.ok).toBe(true);
    if (!resA.ok || !resB.ok) return;
    const rowA = getAction(resA.actionId)!;
    const rowB = getAction(resB.actionId)!;
    expect(rowA.request_id).toBeString();
    expect(rowB.request_id).toBeString();
    expect(rowA.request_id).not.toBe(rowB.request_id);
  });

  test("request_id column exists and is selectable by id", () => {
    // Smoke check: the migration added the column. SELECT must not throw.
    const row = db
      .prepare(
        `SELECT request_id FROM agent_actions WHERE chat_id = ? LIMIT 1`,
      )
      .get(TEST_CHAT);
    // Either null (no rows yet for this chat, fine) or a string.
    if (row && typeof row === "object" && "request_id" in row) {
      const v = (row as { request_id: unknown }).request_id;
      expect(v === null || typeof v === "string").toBe(true);
    }
  });
});

describe("T-410: structured log includes request_id", () => {
  test("dispatch log line carries request_id in data", async () => {
    // Capture console.log (log.ts uses console.log under the hood for both
    // human-readable dev format and prod JSON format).
    const originalLog = console.log;
    const captured: string[] = [];
    console.log = (...args: unknown[]) => {
      captured.push(
        args
          .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
          .join(" "),
      );
    };
    try {
      const requestId = "REQID_LOG002";
      const ctx = makeCtx({ requestId });
      const res = await dispatchAndAudit(
        "CREATE_TASK",
        { title: "t-410 log", description: "x", assignedTo: TEST_ASSIGNEE },
        ctx,
      );
      expect(res.ok).toBe(true);
    } finally {
      console.log = originalLog;
    }
    const joined = captured.join("\n");
    // Either dev format (` {..., "requestId":"REQID_LOG002", ...}`) or prod
    // JSON (`{"level":"info",...,"data":{"requestId":"REQID_LOG002"...}}`)
    // — both contain the id verbatim.
    expect(joined).toContain("REQID_LOG002");
    expect(joined).toContain("dispatch ok");
  });
});
