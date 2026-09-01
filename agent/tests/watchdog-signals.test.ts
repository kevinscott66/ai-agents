import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const WORKFLOW = readFileSync(join(ROOT, ".github", "workflows", "watchdog.yml"), "utf8");

test("watchdog keeps status, blocked, episode, and focus signals", () => {
  expect(WORKFLOW).toContain("FOCUS_INPUT: ${{ github.event.inputs.focus }}");
  expect(WORKFLOW).toContain("STATUS-*.md");
  expect(WORKFLOW).toContain("BLOCKED*.md");
  expect(WORKFLOW).toContain(".claude/memory/episodes");
  expect(WORKFLOW).toContain("Manual focus:");
});

test("watchdog does not send repository text to a write-capable model", () => {
  expect(WORKFLOW).not.toContain("anthropics/claude-code-base-action");
  expect(WORKFLOW).not.toContain("focus-hint");
});
