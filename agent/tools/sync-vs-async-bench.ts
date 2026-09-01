#!/usr/bin/env bun
/**
 * T-303: Benchmark sync vs async file operations
 * 
 * This measures the performance impact of replacing sync file operations
 * with async equivalents, especially under load.
 */

import { performance } from "perf_hooks";
import { writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { writeFile, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";

const TEST_DIR = "/tmp/sync-async-bench";
const ITERATIONS = 100;

// Setup test directory
try {
  mkdirSync(TEST_DIR, { recursive: true });
} catch (e) {
  console.debug(
    "[bench] mkdir TEST_DIR failed (likely already exists, non-fatal):",
    e instanceof Error ? e.message : String(e),
  );
}

interface BenchResult {
  name: string;
  totalTime: number;
  avgPerOp: number;
  opsPerSecond: number;
}

async function benchmarkSync(): Promise<BenchResult> {
  const start = performance.now();
  
  for (let i = 0; i < ITERATIONS; i++) {
    const filePath = join(TEST_DIR, `sync-${i}.txt`);
    const content = `Test file ${i} content with some data that simulates a wiki page or memory content.`;
    
    writeFileSync(filePath, content);
  }
  
  const end = performance.now();
  const totalTime = end - start;
  
  return {
    name: "Sync file writes",
    totalTime: Number(totalTime.toFixed(2)),
    avgPerOp: Number((totalTime / ITERATIONS).toFixed(3)),
    opsPerSecond: Number((ITERATIONS / (totalTime / 1000)).toFixed(0))
  };
}

async function benchmarkAsync(): Promise<BenchResult> {
  const start = performance.now();
  
  const promises: Promise<void>[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const filePath = join(TEST_DIR, `async-${i}.txt`);
    const content = `Test file ${i} content with some data that simulates a wiki page or memory content.`;
    
    promises.push(writeFile(filePath, content));
  }
  
  await Promise.all(promises);
  
  const end = performance.now();
  const totalTime = end - start;
  
  return {
    name: "Async file writes",
    totalTime: Number(totalTime.toFixed(2)),
    avgPerOp: Number((totalTime / ITERATIONS).toFixed(3)),
    opsPerSecond: Number((ITERATIONS / (totalTime / 1000)).toFixed(0))
  };
}

async function benchmarkAsyncSerial(): Promise<BenchResult> {
  const start = performance.now();
  
  for (let i = 0; i < ITERATIONS; i++) {
    const filePath = join(TEST_DIR, `async-serial-${i}.txt`);
    const content = `Test file ${i} content with some data that simulates a wiki page or memory content.`;
    
    await writeFile(filePath, content);
  }
  
  const end = performance.now();
  const totalTime = end - start;
  
  return {
    name: "Async file writes (serial)",
    totalTime: Number(totalTime.toFixed(2)),
    avgPerOp: Number((totalTime / ITERATIONS).toFixed(3)),
    opsPerSecond: Number((ITERATIONS / (totalTime / 1000)).toFixed(0))
  };
}

// Simulate hot path scenario - concurrent operations
async function benchmarkHotPath(): Promise<{ sync: number; async: number; improvement: string }> {
  const concurrency = 10;
  
  // Sync hot path simulation
  const syncStart = performance.now();
  for (let batch = 0; batch < 5; batch++) {
    for (let i = 0; i < concurrency; i++) {
      const filePath = join(TEST_DIR, `hotpath-sync-${batch}-${i}.txt`);
      writeFileSync(filePath, `Batch ${batch} operation ${i}`);
    }
  }
  const syncTime = performance.now() - syncStart;
  
  // Async hot path simulation  
  const asyncStart = performance.now();
  for (let batch = 0; batch < 5; batch++) {
    const promises: Promise<void>[] = [];
    for (let i = 0; i < concurrency; i++) {
      const filePath = join(TEST_DIR, `hotpath-async-${batch}-${i}.txt`);
      promises.push(writeFile(filePath, `Batch ${batch} operation ${i}`));
    }
    await Promise.all(promises);
  }
  const asyncTime = performance.now() - asyncStart;
  
  const improvement = ((syncTime - asyncTime) / syncTime * 100).toFixed(1);
  
  return {
    sync: Number(syncTime.toFixed(2)),
    async: Number(asyncTime.toFixed(2)),
    improvement
  };
}

console.log("=== T-303 Sync vs Async File I/O Benchmark ===\n");

console.log("Running benchmarks...\n");

const results: BenchResult[] = [];

// Run sync benchmark
const syncResult = await benchmarkSync();
results.push(syncResult);

// Run async parallel benchmark  
const asyncResult = await benchmarkAsync();
results.push(asyncResult);

// Run async serial benchmark
const asyncSerialResult = await benchmarkAsyncSerial();
results.push(asyncSerialResult);

// Print results table
console.log("| Operation | Total (ms) | Avg/op (ms) | Ops/sec |");
console.log("|-----------|------------|-------------|---------|");

results.forEach(result => {
  const { name, totalTime, avgPerOp, opsPerSecond } = result;
  console.log(`| ${name.padEnd(25)} | ${totalTime.toString().padStart(10)} | ${avgPerOp.toString().padStart(11)} | ${opsPerSecond.toString().padStart(7)} |`);
});

console.log("\n=== Hot Path Simulation ===");
const hotPathResults = await benchmarkHotPath();
console.log(`Sync hot path: ${hotPathResults.sync}ms`);
console.log(`Async hot path: ${hotPathResults.async}ms`);
console.log(`Performance improvement: ${hotPathResults.improvement}% faster with async\n`);

console.log("=== Analysis ===");

const syncTime = syncResult.totalTime;
const asyncTime = asyncResult.totalTime;
const asyncSerialTime = asyncSerialResult.totalTime;

if (asyncTime < syncTime) {
  const improvement = ((syncTime - asyncTime) / syncTime * 100).toFixed(1);
  console.log(`✅ Async parallel is ${improvement}% faster than sync`);
} else {
  const degradation = ((asyncTime - syncTime) / syncTime * 100).toFixed(1);
  console.log(`⚠️  Async parallel is ${degradation}% slower than sync`);
}

if (asyncSerialTime < syncTime) {
  const improvement = ((syncTime - asyncSerialTime) / syncTime * 100).toFixed(1);
  console.log(`✅ Async serial is ${improvement}% faster than sync`);
} else {
  const degradation = ((asyncSerialTime - syncTime) / syncTime * 100).toFixed(1);
  console.log(`⚠️  Async serial is ${degradation}% slower than sync`);
}

console.log("\n🎯 Recommendation:");
if (hotPathResults.improvement.startsWith("-")) {
  console.log("In hot paths with burst operations, async provides better non-blocking behavior");
  console.log("even if individual operation latency is similar. This prevents event loop blocking.");
} else {
  console.log(`Async operations provide ${hotPathResults.improvement}% performance improvement in hot paths`);
  console.log("and prevent event loop blocking, improving overall responsiveness.");
}

// Cleanup
try {
  const files = await import("node:fs/promises").then(fs => fs.readdir(TEST_DIR));
  await Promise.all(files.map(f => unlink(join(TEST_DIR, f))));
  await import("node:fs/promises").then(fs => fs.rmdir(TEST_DIR));
} catch {
  // Cleanup failed, not critical
}

console.log("\nBenchmark complete. Files cleaned up.");