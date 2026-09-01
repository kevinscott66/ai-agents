import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildSubscriptionEnv,
  SUBSCRIPTION_RUNTIME_ENV_KEYS,
  shouldUseSubscription,
} from "../lib/subscription-env.ts";

const ROOT = join(import.meta.dir, "..", "..");

describe("Claude subscription child environment", () => {
  test("passes only the explicit non-secret runtime allowlist", () => {
    const out = buildSubscriptionEnv({
      PATH: "/usr/bin",
      HOME: "/var/lib/agent-autonomous",
      LANG: "C",
      LC_ALL: "C.UTF-8",
      TERM: "dumb",
      TMPDIR: "/tmp",
      TZ: "UTC",
      XDG_CONFIG_HOME: "/tmp/config",
      ANTHROPIC_API_KEY: "secret",
      ANTHROPIC_AUTH_TOKEN: "secret",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret",
      GH_TOKEN: "secret",
      TELEGRAM_BOT_TOKEN: "secret",
      NODE_OPTIONS: "--require ./malicious-hook.js",
      BASH_ENV: "/tmp/malicious.bashrc",
    });

    expect(out).toEqual({
      PATH: "/usr/bin",
      HOME: "/var/lib/agent-autonomous",
      LANG: "C",
      LC_ALL: "C.UTF-8",
      TERM: "dumb",
      TMPDIR: "/tmp",
      TZ: "UTC",
      XDG_CONFIG_HOME: "/tmp/config",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret",
    });
    expect(Object.keys(out).every((key) =>
      (SUBSCRIPTION_RUNTIME_ENV_KEYS as readonly string[]).includes(key),
    )).toBe(true);
  });

  test("selects subscription by OAuth presence, with explicit overrides", () => {
    expect(shouldUseSubscription({ CLAUDE_CODE_OAUTH_TOKEN: "oauth" })).toBe(true);
    expect(shouldUseSubscription({ CLAUDE_CODE_OAUTH_TOKEN: "oauth", USE_AGENT_SDK: "false" })).toBe(false);
    expect(shouldUseSubscription({ ANTHROPIC_API_KEY: "api" })).toBe(false);
    expect(shouldUseSubscription({ USE_AGENT_SDK: "true" })).toBe(true);
  });

  test("both SDK query call sites use the allowlisted environment", () => {
    const runtime = readFileSync(
      join(ROOT, "agent", "lib", "agent-sdk-runtime.ts"),
      "utf8",
    );
    expect([...runtime.matchAll(/env: buildSubscriptionEnv\(\)/g)]).toHaveLength(2);
    expect(runtime).not.toContain("const cleanEnv = buildSubscriptionEnv()");
  });
});
