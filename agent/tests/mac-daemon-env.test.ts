import { describe, expect, test } from "bun:test";
import { sanitizeChildEnv } from "../mac-daemon/child-env.ts";

describe("Mac daemon child environment", () => {
  test("passes only explicit non-secret runtime variables", () => {
    const out = sanitizeChildEnv({
      PATH: "/usr/bin",
      HOME: "/Users/tester",
      LANG: "en_US.UTF-8",
      LC_ALL: "ru_RU.UTF-8",
      ANTHROPIC_API_KEY: "credential-not-forwarded",
      ANTHROPIC_MODEL: "credential-adjacent-not-forwarded",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_SESSION_TOKEN: "credential-not-forwarded",
      MAC_BRIDGE_SECRET: "credential-not-forwarded",
      TELEGRAM_BOT_TOKEN: "credential-not-forwarded",
      OPENAI_API_KEY: "credential-not-forwarded",
    });

    expect(out).toEqual({
      PATH: "/usr/bin",
      HOME: "/Users/tester",
      LANG: "en_US.UTF-8",
    });
    expect(Object.keys(out).some((key) =>
      key.startsWith("ANTHROPIC_") || key.startsWith("CLAUDE_")
    )).toBe(false);
  });
});
