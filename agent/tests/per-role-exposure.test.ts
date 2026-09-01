/**
 * T-723 (SEC-audit F5): per-role tool exposure helper.
 */
import { describe, test, expect } from "bun:test";
import { isToolExposedToRole } from "../lib/permissions.ts";

describe("isToolExposedToRole", () => {
  test("CALLER_RESTRICTED single-role: only that role", () => {
    expect(isToolExposedToRole("MAC_RUN_CLAUDE", "orchestrator")).toBe(true);
    expect(isToolExposedToRole("MAC_RUN_CLAUDE", "backend")).toBe(false);
    expect(isToolExposedToRole("GRANT_PERMISSION", "perm")).toBe(true);
    expect(isToolExposedToRole("GRANT_PERMISSION", "orchestrator")).toBe(false);
  });
  test("multi-role sensitive tools", () => {
    expect(isToolExposedToRole("GET_PROMPT_HISTORY", "aieng")).toBe(true);
    expect(isToolExposedToRole("GET_PROMPT_HISTORY", "orchestrator")).toBe(true);
    expect(isToolExposedToRole("GET_PROMPT_HISTORY", "smm")).toBe(false);
    expect(isToolExposedToRole("CANCEL_SCHEDULED_POST", "smm")).toBe(true);
    expect(isToolExposedToRole("CANCEL_SCHEDULED_POST", "backend")).toBe(false);
    expect(isToolExposedToRole("QUERY_DB", "backend")).toBe(true);
    expect(isToolExposedToRole("QUERY_DB", "design")).toBe(false);
  });
  test("common tools exposed to everyone", () => {
    expect(isToolExposedToRole("SEND_MESSAGE", "design")).toBe(true);
    expect(isToolExposedToRole("GET_GITHUB_STATUS", "qa")).toBe(true);
    expect(isToolExposedToRole("WRITE_WIKI", "copy")).toBe(true);
  });
});

describe("image gen restricted to design (роли/дубли фикс)", () => {
  test("GENERATE_SVG_IMAGE/IMAGE — только design+orchestrator", () => {
    for (const t of ["GENERATE_SVG_IMAGE", "GENERATE_IMAGE"]) {
      expect(isToolExposedToRole(t, "design")).toBe(true);
      expect(isToolExposedToRole(t, "orchestrator")).toBe(true);
      expect(isToolExposedToRole(t, "frontend")).toBe(false);
      expect(isToolExposedToRole(t, "smm")).toBe(false);
    }
  });
});
