// T-600 security fix: Lead-bot admin commands must be gated on a numeric
// admin user-id (fail-closed), not run for anyone in an allowlisted chat.
import { test, expect, describe, afterEach } from "bun:test";
import type { Context } from "telegraf";
import { isAuthorizedAdmin, parseAdminUserIds } from "../lib/admin-commands.ts";

const ENV_KEYS = ["TELEGRAM_ADMIN_USER_IDS", "MINIAPP_ADMIN_USER_IDS"] as const;
const saved: Record<string, string | undefined> = {};

function setEnv(k: string, v: string | undefined) {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

afterEach(() => {
  // Restore env so it never leaks into other test files.
  for (const k of ENV_KEYS) setEnv(k, saved[k]);
  for (const k of ENV_KEYS) delete saved[k];
});

function snapshot() {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
}

const ctx = (id: number | undefined): Context =>
  ({ from: id === undefined ? undefined : { id } }) as unknown as Context;

describe("admin command authorization (T-600)", () => {
  test("parseAdminUserIds parses TELEGRAM_ADMIN_USER_IDS (preferred)", () => {
    snapshot();
    setEnv("TELEGRAM_ADMIN_USER_IDS", "111, 222 ,333");
    setEnv("MINIAPP_ADMIN_USER_IDS", "999");
    expect(parseAdminUserIds()).toEqual([111, 222, 333]);
  });

  test("falls back to MINIAPP_ADMIN_USER_IDS when TELEGRAM_ADMIN_USER_IDS unset", () => {
    snapshot();
    setEnv("TELEGRAM_ADMIN_USER_IDS", undefined);
    setEnv("MINIAPP_ADMIN_USER_IDS", "100000001");
    expect(parseAdminUserIds()).toEqual([100000001]);
  });

  test("authorizes a sender whose id is in the admin list", () => {
    snapshot();
    setEnv("TELEGRAM_ADMIN_USER_IDS", "100000001");
    expect(isAuthorizedAdmin(ctx(100000001))).toBe(true);
  });

  test("denies a non-admin sender", () => {
    snapshot();
    setEnv("TELEGRAM_ADMIN_USER_IDS", "100000001");
    expect(isAuthorizedAdmin(ctx(123456))).toBe(false);
  });

  test("fail-closed: empty admin list denies everyone", () => {
    snapshot();
    setEnv("TELEGRAM_ADMIN_USER_IDS", undefined);
    setEnv("MINIAPP_ADMIN_USER_IDS", undefined);
    expect(isAuthorizedAdmin(ctx(100000001))).toBe(false);
  });

  test("denies when sender has no id", () => {
    snapshot();
    setEnv("TELEGRAM_ADMIN_USER_IDS", "100000001");
    expect(isAuthorizedAdmin(ctx(undefined))).toBe(false);
  });
});
