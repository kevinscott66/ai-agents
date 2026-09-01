/**
 * T-322: coverage for agent/orchestrator-team.ts.
 *
 * The module top-level has `process.exit(1)` if ANTHROPIC_API_KEY is missing,
 * and `new Anthropic({...})` runs at import time. We set env vars BEFORE any
 * imports so module load is benign. The `main()` entry is guarded behind
 * `import.meta.main`, so importing as a test does not start any bots.
 *
 * We test pure helpers: tailLines, isMentioned, getHealthSnapshot.
 */
import "./t322-env-setup.ts";
import { describe, test, expect } from "bun:test";
import type { Context } from "telegraf";
import {
  tailLines,
  isMentioned,
  getHealthSnapshot,
  buildBot,
} from "../orchestrator-team.ts";
import type { CharacterDef } from "../characters/index.ts";

function makeCtx(opts: {
  text?: string;
  caption?: string;
  entities?: Array<{ type: string; offset: number; length: number }>;
  caption_entities?: Array<{ type: string; offset: number; length: number }>;
}): Context {
  return {
    message: {
      text: opts.text,
      caption: opts.caption,
      entities: opts.entities,
      caption_entities: opts.caption_entities,
    },
  } as unknown as Context;
}

describe("tailLines", () => {
  test("returns the last N lines of a multi-line string", () => {
    const input = "a\nb\nc\nd\ne";
    expect(tailLines(input, 2)).toBe("d\ne");
  });

  test("returns full string when n exceeds line count", () => {
    expect(tailLines("a\nb", 10)).toBe("a\nb");
  });

  test("returns empty string for empty input", () => {
    expect(tailLines("", 3)).toBe("");
  });

  test("single-line input returned as-is", () => {
    expect(tailLines("only-line", 3)).toBe("only-line");
  });

  test("preserves blank trailing lines as empty entries", () => {
    expect(tailLines("a\nb\n", 2)).toBe("b\n");
  });
});

describe("isMentioned", () => {
  test("returns false for empty username", () => {
    const ctx = makeCtx({
      text: "@somebot hi",
      entities: [{ type: "mention", offset: 0, length: 8 }],
    });
    expect(isMentioned(ctx, "")).toBe(false);
  });

  test("returns true when text mention matches username (case-insensitive)", () => {
    const ctx = makeCtx({
      text: "@MyBot hello",
      entities: [{ type: "mention", offset: 0, length: 6 }],
    });
    expect(isMentioned(ctx, "mybot")).toBe(true);
  });

  test("returns false when mention is for a different bot", () => {
    const ctx = makeCtx({
      text: "@otherbot hi",
      entities: [{ type: "mention", offset: 0, length: 9 }],
    });
    expect(isMentioned(ctx, "mybot")).toBe(false);
  });

  test("ignores non-mention entities", () => {
    const ctx = makeCtx({
      text: "@mybot",
      entities: [{ type: "hashtag", offset: 0, length: 6 }],
    });
    expect(isMentioned(ctx, "mybot")).toBe(false);
  });

  test("returns false when there is no message at all", () => {
    const ctx = { message: undefined } as unknown as Context;
    expect(isMentioned(ctx, "mybot")).toBe(false);
  });

  test("uses caption + caption_entities when text is absent", () => {
    const ctx = makeCtx({
      caption: "@mybot look",
      caption_entities: [{ type: "mention", offset: 0, length: 6 }],
    });
    expect(isMentioned(ctx, "mybot")).toBe(true);
  });

  test("returns false when entities list is empty", () => {
    const ctx = makeCtx({ text: "no mentions here", entities: [] });
    expect(isMentioned(ctx, "mybot")).toBe(false);
  });
});

describe("buildBot (no-token early return)", () => {
  test("returns null when envToken variable is unset", async () => {
    const fakeEnvKey = "T322_NONEXISTENT_TOKEN_VAR";
    delete process.env[fakeEnvKey];
    const def = {
      key: "test-no-token",
      envToken: fakeEnvKey,
      system: "test",
    } as unknown as CharacterDef;
    const result = await buildBot(def);
    expect(result).toBeNull();
  });
});

describe("getHealthSnapshot", () => {
  test("returns null when health monitor is not running", () => {
    // main() is gated by import.meta.main, so no monitor is started in tests.
    expect(getHealthSnapshot()).toBeNull();
  });
});
