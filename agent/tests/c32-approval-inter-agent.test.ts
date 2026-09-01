/**
 * C32 / T-706 — Inter-agent approval cards.
 *
 * The Mini App renders a structured `<InterAgentCard>` (instead of a raw JSON
 * dump) for the three *mutating* inter-agent actions: GRANT_PERMISSION,
 * UPDATE_AGENT_PROMPT, CHANGE_AGENT_STATUS. This test locks two things:
 *
 *  1. The routing helper `isInterAgentAction` / `INTER_AGENT_ACTION_TYPES`
 *     correctly gates which approvals get the special card.
 *  2. A cross-layer invariant: every inter-agent card type MUST be both
 *     always-approval-gated (ALWAYS_APPROVE_ACTIONS) and caller-restricted
 *     (CALLER_RESTRICTED) on the backend — that is precisely *why* it needs a
 *     bespoke, human-readable approval card. If someone adds a new mutating
 *     inter-agent action backend-side they're reminded to add its card here.
 *
 * (The component's *rendered output* is exercised by the Mini App build smoke
 * + manual QA; it can't be unit-rendered here because `InterAgentCard` relies
 * on vite's `react → preact/compat` alias, which isn't active under bun:test.)
 */
import { describe, test, expect } from "bun:test";
import {
  INTER_AGENT_ACTION_TYPES,
  isInterAgentAction,
} from "../miniapp/src/components/InterAgentCard.tsx";
import {
  ALWAYS_APPROVE_ACTIONS,
  CALLER_RESTRICTED,
} from "../lib/permissions.ts";

describe("C32 inter-agent approval cards", () => {
  test("isInterAgentAction gates exactly the three mutating types", () => {
    expect(isInterAgentAction("GRANT_PERMISSION")).toBe(true);
    expect(isInterAgentAction("UPDATE_AGENT_PROMPT")).toBe(true);
    expect(isInterAgentAction("CHANGE_AGENT_STATUS")).toBe(true);

    // Non-inter-agent actions must NOT get the special card.
    expect(isInterAgentAction("SEND_MESSAGE")).toBe(false);
    expect(isInterAgentAction("DELETE_MESSAGE")).toBe(false);
    expect(isInterAgentAction("REVIEW_AND_MERGE_PR")).toBe(false);
    expect(isInterAgentAction("")).toBe(false);
  });

  test("the card type list is exactly the three known types", () => {
    expect([...INTER_AGENT_ACTION_TYPES].sort()).toEqual(
      ["CHANGE_AGENT_STATUS", "GRANT_PERMISSION", "UPDATE_AGENT_PROMPT"],
    );
  });

  test("cross-layer invariant: every card type is always-approve + caller-restricted", () => {
    for (const at of INTER_AGENT_ACTION_TYPES) {
      // Mutating inter-agent actions must never auto-execute.
      expect(ALWAYS_APPROVE_ACTIONS.has(at as never)).toBe(true);
      // ...and must be restricted to a single privileged caller role.
      expect(typeof CALLER_RESTRICTED[at]).toBe("string");
      expect(CALLER_RESTRICTED[at]!.length).toBeGreaterThan(0);
    }
  });

  test("REVIEW_AND_MERGE_PR is always-approve but NOT an inter-agent card type", () => {
    // It's irreversible (always-approve) and caller-restricted, but it's not a
    // *mutating inter-agent* action that needs the target/before-after card —
    // guards against accidentally widening the card set to merge actions.
    expect(ALWAYS_APPROVE_ACTIONS.has("REVIEW_AND_MERGE_PR" as never)).toBe(true);
    expect(isInterAgentAction("REVIEW_AND_MERGE_PR")).toBe(false);
  });
});
