#!/usr/bin/env bun
/**
 * T-303: Wiki hot-path benchmark — sync vs async.
 *
 * Simulates the per-message wiki read pattern in message-handler.ts:
 *   - wikiIndex("_team")
 *   - wikiLog("_team")
 *   - wikiIndex(agentKey)
 *   - wikiRead(scope, slug) × N_HITS (the FTS hit fan-out)
 *
 * BEFORE (synchronous, sequential):
 *   readFileSync × 4 calls in sequence
 *
 * AFTER (async, all parallel):
 *   await Promise.all([readFile × 4])
 *
 * Run: bun agent/tools/t303-wiki-hotpath-bench.ts
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const BENCH_DIR = join("/tmp", `t303-bench-${Date.now()}`);
const ITERATIONS = 200;
const N_HITS = 4; // matches wikiSearch limit in message-handler
const FILE_SIZE_BYTES = 4096; // ~4 KB wiki page

// ---------- setup ----------

await mkdir(BENCH_DIR, { recursive: true });
const files: string[] = [];
for (let i = 0; i < N_HITS + 3; i++) {
  const p = join(BENCH_DIR, `page-${i}.md`);
  const content = `# Page ${i}\n\n` + "x".repeat(FILE_SIZE_BYTES - 12 - String(i).length);
  writeFileSync(p, content);
  files.push(p);
}
const [teamIdxFile, teamLogFile, privIdxFile, ...hitFiles] = files;

// ---------- before: sequential sync ----------

function syncHotPath(): void {
  const _teamIdx = readFileSync(teamIdxFile, "utf8");
  const _teamLog = readFileSync(teamLogFile, "utf8");
  const _privIdx = readFileSync(privIdxFile, "utf8");
  for (const f of hitFiles) {
    const _body = readFileSync(f, "utf8");
  }
}

const syncStart = performance.now();
for (let i = 0; i < ITERATIONS; i++) {
  syncHotPath();
}
const syncMs = performance.now() - syncStart;

// ---------- after: parallel async ----------

async function asyncHotPath(): Promise<void> {
  await Promise.all([
    readFile(teamIdxFile, "utf8"),
    readFile(teamLogFile, "utf8"),
    readFile(privIdxFile, "utf8"),
    ...hitFiles.map((f) => readFile(f, "utf8")),
  ]);
}

const asyncStart = performance.now();
for (let i = 0; i < ITERATIONS; i++) {
  await asyncHotPath();
}
const asyncMs = performance.now() - asyncStart;

// ---------- results ----------

const syncAvgMs = (syncMs / ITERATIONS).toFixed(3);
const asyncAvgMs = (asyncMs / ITERATIONS).toFixed(3);
const deltaMs = (parseFloat(syncAvgMs) - parseFloat(asyncAvgMs)).toFixed(3);
const speedup = (syncMs / asyncMs).toFixed(2);

console.log("=== T-303 wiki hot-path benchmark ===");
console.log(`Files: ${N_HITS + 3} × ~${FILE_SIZE_BYTES}B, iterations: ${ITERATIONS}`);
console.log(`BEFORE (sync sequential):  total=${syncMs.toFixed(1)}ms  avg=${syncAvgMs}ms/req`);
console.log(`AFTER  (async parallel):   total=${asyncMs.toFixed(1)}ms  avg=${asyncAvgMs}ms/req`);
console.log(`Delta per request: ${deltaMs}ms  (${speedup}× speedup)`);

// ---------- teardown ----------
try {
  rmSync(BENCH_DIR, { recursive: true, force: true });
} catch {}
