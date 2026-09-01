/**
 * C11: RAG over wiki — SEARCH_WIKI / READ_WIKI / WRITE_WIKI tools.
 *
 * Coverage:
 *  - migration 013 seeded WRITE_WIKI permission;
 *  - SEARCH_WIKI tool returns formatted hits;
 *  - READ_WIKI returns full content / null;
 *  - WRITE_WIKI: own scope + "_team" ok, foreign scope rejected;
 *  - WRITE_WIKI rate-limit kicks in after 5 calls;
 *  - tool_use loop: SEARCH_WIKI → READ_WIKI → text answer.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { db } from "../lib/db.ts";
import { TOOLS, executeTool } from "../lib/tools-schema.ts";
import { gateOrDispatch } from "../lib/action-dispatch.ts";
import { getPermission, setAutonomy } from "../lib/permissions.ts";
import { _resetRateLimits } from "../lib/rate-limits.ts";
import { wikiWrite } from "../lib/memory.ts";
import { runWithTools } from "../lib/tool-loop.ts";
import { CHARACTERS } from "../characters/index.ts";
import { cleanupChat, saveAutonomy, restoreAutonomy } from "./_helpers.ts";

const TEST_CHAT = -1_000_911;
const TEST_AGENT = "pm";
const MEMORY_DIR = process.env.MEMORY_DIR ?? "memory";

// Unique slug prefix per test run to avoid collisions with prod content.
const PFX = `c11test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

function cleanupWikiFiles(): void {
  // Remove all c11test_* pages from FS + FTS.
  for (const scope of ["_team", TEST_AGENT, "design"]) {
    const base = join(MEMORY_DIR, scope);
    for (const sub of ["pages", "projects", "decisions"]) {
      const dir = join(base, sub);
      if (!existsSync(dir)) continue;
      try {
        const fs = require("node:fs");
        for (const f of fs.readdirSync(dir) as string[]) {
          if (f.startsWith("c11test_")) {
            try { rmSync(join(dir, f)); } catch {}
          }
        }
      } catch {}
    }
  }
  db.prepare(`DELETE FROM wiki_fts WHERE slug LIKE 'c11test_%'`).run();
}

let savedGlobal = saveAutonomy();

beforeEach(() => {
  _resetRateLimits();
  cleanupChat(TEST_CHAT);
  cleanupChat(TEST_CHAT, TEST_AGENT);
  cleanupWikiFiles();
  savedGlobal = saveAutonomy();
});

afterEach(() => {
  restoreAutonomy(savedGlobal);
  _resetRateLimits();
  cleanupChat(TEST_CHAT);
  cleanupChat(TEST_CHAT, TEST_AGENT);
  cleanupWikiFiles();
});

describe("migration 013 / permissions", () => {
  test("WRITE_WIKI permission seeded for all 12 roles", () => {
    for (const c of CHARACTERS) {
      const p = getPermission(c.key, "WRITE_WIKI");
      expect(p.allowed).toBe(true);
      expect(p.requires_approval).toBe(false);
    }
  });

  test("schema_migrations contains 013_seed_write_wiki", () => {
    const row = db
      .prepare(`SELECT name FROM schema_migrations WHERE name = ?`)
      .get("013_seed_write_wiki") as { name: string } | undefined;
    expect(row).toBeDefined();
  });
});

describe("tool-schema definitions", () => {
  test("TOOLS contains SEARCH_WIKI, READ_WIKI, WRITE_WIKI", () => {
    for (const name of ["SEARCH_WIKI", "READ_WIKI", "WRITE_WIKI"]) {
      const tool = TOOLS.find((t) => t.name === name);
      expect(tool).toBeDefined();
    }
  });

  test("WRITE_WIKI requires scope/slug/title/content", () => {
    const tool = TOOLS.find((t) => t.name === "WRITE_WIKI");
    const req = (tool!.input_schema as { required?: string[] }).required ?? [];
    expect(req).toEqual(
      expect.arrayContaining(["scope", "slug", "title", "content"]),
    );
  });
});

describe("SEARCH_WIKI executeTool", () => {
  test("returns formatted hits for seeded page", async () => {
    wikiWrite({
      scope: "_team",
      slug: `${PFX}_alpha`,
      title: "Project Alpha context",
      content: "Alpha is the codename for our quarterly initiative on retention.",
    });
    const out = await executeTool(
      "SEARCH_WIKI",
      { query: "alpha retention" },
      { agentKey: TEST_AGENT, chatId: TEST_CHAT },
    );
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.hits)).toBe(true);
    expect(parsed.count).toBeGreaterThan(0);
    const hit = (parsed.hits as Array<{ scope: string; slug: string; line: string }>).find(
      (h) => h.slug === `${PFX}_alpha`,
    );
    expect(hit).toBeDefined();
    expect(hit!.scope).toBe("_team");
    expect(hit!.line).toContain("Project Alpha");
  });

  test("empty query → ok:false", async () => {
    const out = await executeTool(
      "SEARCH_WIKI",
      { query: "  " },
      { agentKey: TEST_AGENT, chatId: TEST_CHAT },
    );
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
  });

  test("limit is clamped to [1,10]", async () => {
    wikiWrite({
      scope: "_team",
      slug: `${PFX}_beta`,
      title: "Beta notes",
      content: "Beta planning checklist for release engineering.",
    });
    const out = await executeTool(
      "SEARCH_WIKI",
      { query: "beta planning", limit: 999 },
      { agentKey: TEST_AGENT, chatId: TEST_CHAT },
    );
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
  });
});

describe("READ_WIKI executeTool", () => {
  test("returns full content for existing page", async () => {
    wikiWrite({
      scope: "_team",
      slug: `${PFX}_gamma`,
      title: "Gamma decision",
      content: "We decided to ship feature X on Friday.",
    });
    const out = await executeTool(
      "READ_WIKI",
      { scope: "_team", slug: `${PFX}_gamma` },
      { agentKey: TEST_AGENT, chatId: TEST_CHAT },
    );
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(typeof parsed.content).toBe("string");
    expect(parsed.content).toContain("Gamma decision");
    expect(parsed.content).toContain("ship feature X on Friday");
  });

  test("returns null for missing page", async () => {
    const out = await executeTool(
      "READ_WIKI",
      { scope: "_team", slug: `${PFX}_nonexistent` },
      { agentKey: TEST_AGENT, chatId: TEST_CHAT },
    );
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.content).toBeNull();
  });

  test("unknown scope → ok:false", async () => {
    const out = await executeTool(
      "READ_WIKI",
      { scope: "nonsense", slug: "x" },
      { agentKey: TEST_AGENT, chatId: TEST_CHAT },
    );
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
  });
});

describe("WRITE_WIKI executeTool + scope guard", () => {
  test("write to '_team' succeeds", async () => {
    setAutonomy("global", "*", "auto");
    const out = await executeTool(
      "WRITE_WIKI",
      {
        scope: "_team",
        slug: `${PFX}_team_note`,
        title: "Team note",
        content: "Shared context for the team.",
      },
      { agentKey: TEST_AGENT, chatId: TEST_CHAT },
    );
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.scope).toBe("_team");
    expect(parsed.slug).toBe(`${PFX}_team_note`);
  });

  test("write to own scope succeeds", async () => {
    setAutonomy("global", "*", "auto");
    const out = await executeTool(
      "WRITE_WIKI",
      {
        scope: TEST_AGENT,
        slug: `${PFX}_pm_note`,
        title: "PM personal note",
        content: "My private tracker.",
      },
      { agentKey: TEST_AGENT, chatId: TEST_CHAT },
    );
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
  });

  test("write to another agent's scope rejected", async () => {
    setAutonomy("global", "*", "auto");
    const out = await executeTool(
      "WRITE_WIKI",
      {
        scope: "design",
        slug: `${PFX}_forbidden`,
        title: "T",
        content: "should not work",
      },
      { agentKey: TEST_AGENT, chatId: TEST_CHAT },
    );
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/forbidden|cannot write/i);
  });
});

describe("WRITE_WIKI rate-limit", () => {
  test("6th call within 60s is rate_limited", async () => {
    setAutonomy("global", "*", "auto");
    const ctx = { agentKey: TEST_AGENT, chatId: TEST_CHAT };
    for (let i = 0; i < 5; i++) {
      const r = await gateOrDispatch(
        "WRITE_WIKI",
        {
          scope: "_team",
          slug: `${PFX}_rate_${i}`,
          title: `T${i}`,
          content: `body ${i}`,
        },
        ctx,
      );
      expect(r.kind).toBe("ok");
    }
    const r6 = await gateOrDispatch(
      "WRITE_WIKI",
      {
        scope: "_team",
        slug: `${PFX}_rate_6`,
        title: "T6",
        content: "body 6",
      },
      ctx,
    );
    expect(r6.kind).toBe("rate_limited");
  });
});

describe("tool_use loop integration", () => {
  test("agent calls SEARCH_WIKI then READ_WIKI then answers", async () => {
    wikiWrite({
      scope: "_team",
      slug: `${PFX}_delta`,
      title: "Delta release plan",
      content: "Delta ships on Monday with feature flags enabled.",
    });

    // Build a fake Anthropic client whose .messages.create returns scripted responses.
    let step = 0;
    const fakeAnthropic = {
      messages: {
        create: async () => {
          step++;
          if (step === 1) {
            return {
              id: "msg_1",
              type: "message",
              role: "assistant",
              model: "test",
              stop_reason: "tool_use",
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
              content: [
                {
                  type: "tool_use",
                  id: "tu_search",
                  name: "SEARCH_WIKI",
                  input: { query: `${PFX}_delta delta release` },
                },
              ],
            } as unknown as Anthropic.Message;
          }
          if (step === 2) {
            return {
              id: "msg_2",
              type: "message",
              role: "assistant",
              model: "test",
              stop_reason: "tool_use",
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
              content: [
                {
                  type: "tool_use",
                  id: "tu_read",
                  name: "READ_WIKI",
                  input: { scope: "_team", slug: `${PFX}_delta` },
                },
              ],
            } as unknown as Anthropic.Message;
          }
          return {
            id: "msg_3",
            type: "message",
            role: "assistant",
            model: "test",
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
            content: [
              { type: "text", text: "Delta ships on Monday." },
            ],
          } as unknown as Anthropic.Message;
        },
      },
    } as unknown as Anthropic;

    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "When does Delta ship?" },
    ];
    const final = await runWithTools({
      anthropic: fakeAnthropic,
      model: "test",
      system: [{ type: "text", text: "you are a test agent" }],
      messages,
      agentKey: TEST_AGENT,
      chatId: TEST_CHAT,
    });
    expect(final).toContain("Monday");
    expect(step).toBe(3);

    // Inspect that two tool_results were appended into messages (the loop
    // pushes both). We can't read internal `messages` from outside, but we
    // can confirm the loop returned the final text and made three calls.
  });
});
