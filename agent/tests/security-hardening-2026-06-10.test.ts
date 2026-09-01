/**
 * SEC-audit 2026-06-10 (5 agents) — fixes verification.
 * F1: CANCEL_SCHEDULED_POST caller-restricted (was approval-bypass mutation).
 * F3: GET_PROMPT_HISTORY caller-restricted (system-prompt IP leak).
 * MED-2: MAC_RUN_CLAUDE always-approve (MAC_STOP NOT — kill switch).
 * log scrubber: secrets in log data/msg are masked.
 */
import { describe, test, expect } from "bun:test";
import { executeTool } from "../lib/tools-schema.ts";
import { ALWAYS_APPROVE_ACTIONS } from "../lib/permissions.ts";

const fmtParse = (s: string) => JSON.parse(s);

describe("F1 — CANCEL_SCHEDULED_POST caller restriction", () => {
  test("non-smm/non-orchestrator → forbidden", async () => {
    const out = fmtParse(
      await executeTool("CANCEL_SCHEDULED_POST", { id: "x" }, { agentKey: "backend", chatId: -1 }),
    );
    expect(out.ok).toBe(false);
    expect(out.error).toContain("forbidden");
  });
  test("smm passes caller check (reaches id validation)", async () => {
    const out = fmtParse(
      await executeTool("CANCEL_SCHEDULED_POST", { id: "" }, { agentKey: "smm", chatId: -1 }),
    );
    // caller ok → falls through to "id is required" (not "forbidden")
    expect(out.error).not.toContain("forbidden");
  });
});

describe("F3 — GET_PROMPT_HISTORY caller restriction", () => {
  test("non-aieng/non-orchestrator → forbidden", async () => {
    const out = fmtParse(
      await executeTool("GET_PROMPT_HISTORY", { agentKey: "backend" }, { agentKey: "smm", chatId: -1 }),
    );
    expect(out.ok).toBe(false);
    expect(out.error).toContain("forbidden");
  });
  test("aieng allowed (reaches agentKey validation)", async () => {
    const out = fmtParse(
      await executeTool("GET_PROMPT_HISTORY", { agentKey: "bogus" }, { agentKey: "aieng", chatId: -1 }),
    );
    expect(out.error).not.toContain("forbidden");
  });
});

describe("MED-2 — MAC approval policy", () => {
  test("MAC_RUN_CLAUDE is always-approve", () => {
    expect(ALWAYS_APPROVE_ACTIONS.has("MAC_RUN_CLAUDE")).toBe(true);
  });
  test("MAC_STOP is NOT always-approve (kill switch must fire fast)", () => {
    expect(ALWAYS_APPROVE_ACTIONS.has("MAC_STOP")).toBe(false);
  });
});

describe("log scrubber masks secrets", () => {
  test("sensitive keys and inline secrets are masked", () => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => logs.push(a.join(" "));
    try {
      // dynamic import already loaded; use the singleton
      const { log } = require("../lib/log.ts");
      log.error("auth failed url=https://api.tgstat.ru/x?token=SUPERSECRET123", {
        token: "SUPERSECRET123",
        nested: { api_key: "AKIAABC", ok: 1 },
        safe: "visible",
      });
    } finally {
      console.log = orig;
    }
    const joined = logs.join("\n");
    expect(joined).not.toContain("SUPERSECRET123");
    expect(joined).not.toContain("AKIAABC");
    expect(joined).toContain("***");
    expect(joined).toContain("visible");
  });
});
