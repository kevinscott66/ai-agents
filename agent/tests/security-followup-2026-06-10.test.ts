/**
 * Security follow-up (audit 2026-06-10):
 * T-724 — executeApproved re-checks CALLER_RESTRICTED at execution.
 * T-725 — GET_LOGS / listActions scoped by chatId (no cross-chat leak).
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { executeApproved } from "../lib/commands.ts";
import { listActions, logAction } from "../lib/audit.ts";
import { db } from "../lib/db.ts";

describe("T-724 — executeApproved caller re-gate", () => {
  test("approved row for MAC_RUN_CLAUDE from non-orchestrator → rejected", async () => {
    const approval = {
      id: "a1",
      action_type: "MAC_RUN_CLAUDE",
      requested_by: "backend", // NOT orchestrator
      payload: { project: "/x", prompt: "y" },
      chat_id: -1,
      status: "approved",
    } as never;
    await expect(executeApproved(approval)).rejects.toThrow(/caller not allowed at execution/);
  });
});

describe("T-725 — listActions chatId scope", () => {
  beforeEach(() => {
    db.prepare("DELETE FROM agent_actions WHERE agent_key='scope-test'").run();
    logAction({ agentKey: "scope-test", actionType: "SEND_MESSAGE", status: "ok", chatId: -111 });
    logAction({ agentKey: "scope-test", actionType: "SEND_MESSAGE", status: "ok", chatId: -222 });
  });

  test("filter chatId returns only that chat's rows", () => {
    const rows = listActions({ agentKey: "scope-test", chatId: -111 });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.chat_id === -111)).toBe(true);
  });

  test("no chatId filter → both chats visible (unchanged default)", () => {
    const rows = listActions({ agentKey: "scope-test" });
    const chats = new Set(rows.map((r) => r.chat_id));
    expect(chats.has(-111) && chats.has(-222)).toBe(true);
  });
});

import { executeTool } from "../lib/tools-schema.ts";

describe("T-722 — scheduled-post chat isolation", () => {
  test("CANCEL from a different chat → forbidden-by-scope (no change)", async () => {
    db.prepare("DELETE FROM content_calendar WHERE id='t722-x'").run();
    db.prepare(
      `INSERT INTO content_calendar(id,channel,scheduled_at,payload,status,created_at,chat_id)
       VALUES ('t722-x','@c',9999999999000,'{}','scheduled',1,-100)`,
    ).run();
    // smm in a DIFFERENT chat tries to cancel chat -100's post
    const out = JSON.parse(
      await executeTool("CANCEL_SCHEDULED_POST", { id: "t722-x" }, { agentKey: "smm", chatId: -999 }),
    );
    expect(out.ok).toBe(false);
    const row = db.prepare("SELECT status FROM content_calendar WHERE id='t722-x'").get() as { status: string };
    expect(row.status).toBe("scheduled"); // unchanged
  });
});
