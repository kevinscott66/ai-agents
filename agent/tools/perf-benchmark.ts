#!/usr/bin/env bun
/**
 * T-303 Performance audit: benchmark database operations
 * 
 * This script measures typical operations to identify performance bottlenecks:
 * - Database query latency
 * - N+1 query patterns vs. a single batched query
 *
 * Аудит 2026-09-11, круг 51: в списке стояло ещё «File I/O in hot paths».
 * Ни один из шести замеров файлового ввода-вывода не трогает — все шесть
 * работают с SQLite. Синхронный I/O по тому же T-303 меряет другой скрипт,
 * tools/sync-io-audit.ts; строка здесь обещала покрытие, которого нет, и
 * прочитавший её счёл бы горячие пути проверенными.
 */

import { Database } from "bun:sqlite";
import { performance } from "perf_hooks";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const BENCH_DB_PATH = "/tmp/bench-perf.db";

// Clean up any existing benchmark db
if (existsSync(BENCH_DB_PATH)) {
  await Bun.file(BENCH_DB_PATH).unlink();
}

mkdirSync(dirname(BENCH_DB_PATH), { recursive: true });
const db = new Database(BENCH_DB_PATH, { create: true });

// Apply same pragmas as production
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA synchronous = NORMAL;");
db.exec("PRAGMA cache_size = -64000;");
db.exec("PRAGMA mmap_size = 268435456;");
db.exec("PRAGMA temp_store = MEMORY;");
db.exec("PRAGMA busy_timeout = 5000;");
db.exec("PRAGMA foreign_keys = ON;");

// Create test schema (simplified from production)
db.exec(`
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    agent_key TEXT,
    text TEXT NOT NULL,
    ts INTEGER NOT NULL
  );
  CREATE INDEX idx_messages_chat_ts ON messages(chat_id, ts DESC);

  CREATE TABLE agent_actions (
    id TEXT PRIMARY KEY,
    agent_key TEXT NOT NULL,
    task_id TEXT,
    action_type TEXT NOT NULL,
    payload TEXT,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_agent_actions_agent ON agent_actions(agent_key, created_at DESC);
  CREATE INDEX idx_agent_actions_task ON agent_actions(task_id);

  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    chat_id INTEGER NOT NULL,
    assigned_to TEXT,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_tasks_assignee ON tasks(assigned_to, status);
`);

interface BenchResult {
  operation: string;
  avgLatency: number;
  minLatency: number;
  maxLatency: number;
  iterations: number;
}

function benchmark(name: string, iterations: number, fn: () => void): BenchResult {
  const times: number[] = [];
  
  // Warmup
  for (let i = 0; i < 5; i++) {
    fn();
  }

  // Actual benchmark
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    fn();
    const end = performance.now();
    times.push(end - start);
  }

  const avgLatency = times.reduce((a, b) => a + b, 0) / times.length;
  const minLatency = Math.min(...times);
  const maxLatency = Math.max(...times);

  return {
    operation: name,
    avgLatency: Number(avgLatency.toFixed(3)),
    minLatency: Number(minLatency.toFixed(3)),
    maxLatency: Number(maxLatency.toFixed(3)),
    iterations
  };
}

// Prepare statements (this is what production should be doing)
const insertMessage = db.prepare(`
  INSERT INTO messages(chat_id, agent_key, text, ts) VALUES (?, ?, ?, ?)
`);

const getRecentMessages = db.prepare(`
  SELECT * FROM messages WHERE chat_id = ? ORDER BY ts DESC LIMIT ?
`);

const insertAction = db.prepare(`
  INSERT INTO agent_actions(id, agent_key, task_id, action_type, payload, status, created_at) 
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const getActionsByAgent = db.prepare(`
  SELECT * FROM agent_actions WHERE agent_key = ? ORDER BY created_at DESC LIMIT ?
`);

console.log("=== T-303 Performance Benchmark Results ===\\n");

// Benchmark 1: Single message inserts (current hot path)
const result1 = benchmark("Insert single message", 1000, () => {
  const chatId = "chat_" + Math.floor(Math.random() * 10);
  const ts = Date.now() + Math.random() * 1000;
  insertMessage.run(chatId, "orchestrator", "Test message", ts);
});

// Benchmark 2: Message retrieval (recent messages)
// First insert some data
for (let i = 0; i < 100; i++) {
  insertMessage.run("test_chat", "orchestrator", `Message ${i}`, Date.now() + i);
}

const result2 = benchmark("Get recent messages", 1000, () => {
  getRecentMessages.all("test_chat", 30);
});

// Benchmark 3: Action logging (very common in production)
const result3 = benchmark("Insert action log", 1000, () => {
  const id = crypto.randomUUID();
  const agentKey = ["orchestrator", "backend", "frontend", "design"][Math.floor(Math.random() * 4)];
  insertAction.run(id, agentKey, null, "SEND_MESSAGE", "{}", "ok", Date.now());
});

// Benchmark 4: Action retrieval by agent (dashboard queries)
// Insert test data
for (let i = 0; i < 100; i++) {
  const id = crypto.randomUUID();
  insertAction.run(id, "orchestrator", null, "SEND_MESSAGE", "{}", "ok", Date.now() + i);
}

const result4 = benchmark("Get actions by agent", 1000, () => {
  getActionsByAgent.all("orchestrator", 20);
});

// Benchmark 5: Potential N+1 scenario - getting actions for multiple agents
const agentKeys = ["orchestrator", "backend", "frontend", "design", "pm", "qa"];
const result5 = benchmark("N+1 pattern: actions for 6 agents", 100, () => {
  // This simulates the anti-pattern where we query each agent separately
  for (const agent of agentKeys) {
    getActionsByAgent.all(agent, 5);
  }
});

// Benchmark 6: Better pattern - batch query
const getBatchActions = db.prepare(`
  SELECT * FROM agent_actions 
  WHERE agent_key IN (?, ?, ?, ?, ?, ?) 
  ORDER BY created_at DESC 
  LIMIT ?
`);

const result6 = benchmark("Batch query: actions for 6 agents", 100, () => {
  getBatchActions.all(...agentKeys, 30);
});

// Print results
const results = [result1, result2, result3, result4, result5, result6];

console.log("| Operation | Avg (ms) | Min (ms) | Max (ms) | Iterations |");
console.log("|-----------|----------|----------|----------|------------|");

for (const result of results) {
  const { operation, avgLatency, minLatency, maxLatency, iterations } = result;
  console.log(`| ${operation.padEnd(25)} | ${avgLatency.toString().padStart(8)} | ${minLatency.toString().padStart(8)} | ${maxLatency.toString().padStart(8)} | ${iterations.toString().padStart(10)} |`);
}

console.log(`\\n=== Analysis ===`);

// Analyze N+1 vs batch performance
const n1Time = result5.avgLatency;
const batchTime = result6.avgLatency;
const improvement = ((n1Time - batchTime) / n1Time * 100).toFixed(1);

console.log(`N+1 pattern: ${n1Time}ms avg`);
console.log(`Batch query: ${batchTime}ms avg`);
console.log(`Performance improvement: ${improvement}% faster with batch queries`);

// Check if any operations are concerningly slow
const slowThreshold = 5; // ms
const slowOps = results.filter(r => r.avgLatency > slowThreshold);

if (slowOps.length > 0) {
  console.log(`\\n⚠️  Slow operations (> ${slowThreshold}ms):`);
  slowOps.forEach(op => {
    console.log(`- ${op.operation}: ${op.avgLatency}ms avg`);
  });
} else {
  console.log(`\\n✅ All operations under ${slowThreshold}ms threshold`);
}

// Cleanup
db.close();
await Bun.file(BENCH_DB_PATH).unlink();

console.log(`\\nBenchmark complete. Database cleaned up.`);