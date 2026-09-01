// SEC-5 / T-603: allow-lists fail CLOSED — an empty/missing list denies
// everyone instead of silently allowing all (the old fail-open default).
import { test, expect, describe, afterEach } from "bun:test";
import {
  isAllowlisted,
  warnIfEmptyAllowlist,
  _resetAllowlistWarnings,
} from "../lib/allowlist.ts";

afterEach(() => _resetAllowlistWarnings());

describe("isAllowlisted (T-603 / SEC-5)", () => {
  test("empty list denies everyone (fail-closed)", () => {
    expect(isAllowlisted(42, [])).toBe(false);
  });
  test("undefined/null list denies everyone", () => {
    expect(isAllowlisted(42, undefined)).toBe(false);
    expect(isAllowlisted(42, null)).toBe(false);
  });
  test("allows an id explicitly present", () => {
    expect(isAllowlisted(42, [1, 42, 7])).toBe(true);
  });
  test("denies an id not present", () => {
    expect(isAllowlisted(99, [1, 42, 7])).toBe(false);
  });
  test("works for string ids (chat allowlists)", () => {
    expect(isAllowlisted("-100", ["-100", "-200"])).toBe(true);
    expect(isAllowlisted("-300", ["-100", "-200"])).toBe(false);
    expect(isAllowlisted("-300", [])).toBe(false);
  });
});

describe("warnIfEmptyAllowlist", () => {
  test("returns true for empty, false for non-empty", () => {
    expect(warnIfEmptyAllowlist("L1", [])).toBe(true);
    expect(warnIfEmptyAllowlist("L2", undefined)).toBe(true);
    expect(warnIfEmptyAllowlist("L3", [1])).toBe(false);
  });
});
