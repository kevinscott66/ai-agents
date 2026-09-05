import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const WORKFLOW_PATH = join(ROOT, ".github", "workflows", "watchdog.yml");
// watchdog.yml удалён при публичном релизе 2026-09-01 — сигналы читать неоткуда.
// Вернётся воркфлоу в .github/workflows/ — оба теста включатся сами.
const HAS_WORKFLOW = existsSync(WORKFLOW_PATH);
const WORKFLOW = HAS_WORKFLOW ? readFileSync(WORKFLOW_PATH, "utf8") : "";

test.skipIf(!HAS_WORKFLOW)("watchdog keeps status, blocked, episode, and focus signals", () => {
  expect(WORKFLOW).toContain("FOCUS_INPUT: ${{ github.event.inputs.focus }}");
  expect(WORKFLOW).toContain("STATUS-*.md");
  expect(WORKFLOW).toContain("BLOCKED*.md");
  expect(WORKFLOW).toContain(".claude/memory/episodes");
  expect(WORKFLOW).toContain("Manual focus:");
});

test.skipIf(!HAS_WORKFLOW)("watchdog does not send repository text to a write-capable model", () => {
  expect(WORKFLOW).not.toContain("anthropics/claude-code-base-action");
  expect(WORKFLOW).not.toContain("focus-hint");
});
