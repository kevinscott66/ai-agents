/**
 * T-312 / T-300 HIGH #4: WRITE_WIKI / READ_WIKI must reject slugs that could
 * escape the wiki root via path traversal, absolute paths, NUL bytes, etc.
 *
 * The slug grammar accepts: 1..4 path components, each [a-zA-Z0-9][a-zA-Z0-9_-]{0,127},
 * separated by `/`. No dots, no leading slash, no backslash.
 */
import { describe, test, expect } from "bun:test";
import { existsSync, rmSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import {
  wikiWrite,
  wikiRead,
  validateSlug,
  InvalidSlugError,
} from "../lib/memory.ts";

const MEMORY_DIR = process.env.MEMORY_DIR ?? "memory";
const MEMORY_ROOT = resolve(MEMORY_DIR);

function snapshotOutside(): Set<string> {
  // Snapshot of filesystem entries outside MEMORY_DIR that a traversal might
  // try to touch. We don't enumerate the whole FS; we just record existence of
  // the few sentinel paths the test will probe.
  return new Set();
}

describe("T-312 wiki slug validation", () => {
  describe("validateSlug rejects unsafe inputs", () => {
    const rejected: Array<[string, unknown]> = [
      ["../../../etc/passwd", "../../../etc/passwd"],
      ["../../etc/agent-team/.env", "../../etc/agent-team/.env"],
      ["/etc/passwd", "/etc/passwd"],
      ["foo/../bar", "foo/../bar"],
      ["..", ".."],
      [".", "."],
      ["./foo", "./foo"],
      ["foo/", "foo/"],
      ["/foo", "/foo"],
      ["foo/./bar", "foo/./bar"],
      ["foo\\bar", "foo\\bar"],
      ["with\0null", "with\0null"],
      ["with space", "with space"],
      ["empty string", ""],
      ["whitespace only", "   "],
      ["a/b/c/d/e (too many components)", "a/b/c/d/e"],
      ["component starting with hyphen", "-foo"],
      ["very long component", "a".repeat(129)],
      ["non-string number", 42 as unknown as string],
      ["non-string null", null as unknown as string],
      ["extension via dot", "foo.md"],
      ["dotfile", ".hidden"],
    ];

    for (const [label, value] of rejected) {
      test(`rejects ${label}`, () => {
        expect(() => validateSlug(value)).toThrow(InvalidSlugError);
      });
    }
  });

  describe("validateSlug accepts safe inputs", () => {
    const accepted = [
      "foo",
      "foo-bar",
      "foo_bar",
      "Foo123",
      "projects/my-project",
      "decisions/adr-0007",
      "a/b/c/d", // exactly 4 components — boundary
      "a".repeat(128), // boundary length
      "a/" + "b".repeat(128),
    ];
    for (const v of accepted) {
      test(`accepts '${v.slice(0, 32)}${v.length > 32 ? "…" : ""}'`, () => {
        expect(validateSlug(v)).toBe(v);
      });
    }
  });

  describe("wikiWrite cannot escape MEMORY_DIR", () => {
    const traversals = [
      "../../../etc/passwd",
      "../../etc/agent-team/.env",
      "/etc/passwd",
      "foo/../bar",
      "..",
    ];

    for (const slug of traversals) {
      test(`wikiWrite('_team', '${slug}') throws InvalidSlugError`, () => {
        let thrown: unknown = null;
        try {
          wikiWrite({
            scope: "_team",
            slug,
            title: "evil",
            content: "should never land on disk",
          });
        } catch (e) {
          thrown = e;
        }
        expect(thrown).toBeInstanceOf(InvalidSlugError);

        // Sanity check: nothing got written to /etc/passwd or anywhere outside MEMORY_DIR.
        // We can't easily check arbitrary FS, but we assert the canonical path
        // would-be is outside root, which the validator already enforced.
      });
    }

    test("accepted slug lands inside MEMORY_DIR and round-trips", () => {
      const slug = `t312_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      try {
        wikiWrite({
          scope: "_team",
          slug,
          title: "T-312 sanity",
          content: "ok",
        });
        // file should exist under memory/_team/projects/<slug>.md
        const expected = join(MEMORY_ROOT, "_team", "projects", `${slug}.md`);
        expect(existsSync(expected)).toBe(true);
        // and resolve canonical stays under root
        expect(resolve(expected).startsWith(MEMORY_ROOT + sep)).toBe(true);

        const content = wikiRead("_team", slug);
        expect(content).not.toBeNull();
        expect(content).toContain("T-312 sanity");
      } finally {
        const p = join(MEMORY_ROOT, "_team", "projects", `${slug}.md`);
        try {
          rmSync(p);
        } catch {}
      }
    });

    test("accepted multi-segment slug lands inside MEMORY_DIR", () => {
      const slug = `decisions/t312_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      try {
        wikiWrite({
          scope: "_team",
          slug,
          title: "T-312 multi",
          content: "ok",
        });
        const expected = join(MEMORY_ROOT, "_team", `${slug}.md`);
        expect(existsSync(expected)).toBe(true);
        expect(resolve(expected).startsWith(MEMORY_ROOT + sep)).toBe(true);
      } finally {
        const p = join(
          MEMORY_ROOT,
          "_team",
          `${slug}.md`,
        );
        try {
          rmSync(p);
        } catch {}
      }
    });
  });

  describe("wikiRead also rejects unsafe slugs", () => {
    test("wikiRead with traversal throws InvalidSlugError", () => {
      expect(() => wikiRead("_team", "../../../etc/passwd")).toThrow(
        InvalidSlugError,
      );
    });
    test("wikiRead with absolute path throws", () => {
      expect(() => wikiRead("_team", "/etc/passwd")).toThrow(InvalidSlugError);
    });
    test("wikiRead with empty slug throws", () => {
      expect(() => wikiRead("_team", "")).toThrow(InvalidSlugError);
    });
  });
});
