/**
 * Аудит 2026-08-08: у песочницы QUERY_DB были бюджеты времени и объёма, но не
 * количества. Каждый вызов — отдельный процесс bun (~40 МБ RSS на рантайм) плюс
 * буфер читателя; QUERY_DB отдан backend и orchestrator, лимит tool-раундов 14,
 * а в discussion-режиме роли отвечают веером. Десяток одновременных песочниц
 * набирается без злого умысла и валит юнит целиком, а не запрос.
 */
import { describe, test, expect } from "bun:test";
import {
  runQueryDbSandboxed,
  _queryDbRunning,
  QUERY_DB_MAX_CONCURRENT,
} from "../lib/query-db.ts";

// Достаточно тяжёлый, чтобы соседний вызов застал его выполняющимся, но
// заведомо укладывающийся в таймаут.
const SLOW = `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 400000) SELECT count(*) AS n FROM c`;
const FAST = `SELECT 1 AS n`;

describe("QUERY_DB: лимит одновременных песочниц", () => {
  test("по умолчанию не больше QUERY_DB_MAX_CONCURRENT", () => {
    expect(QUERY_DB_MAX_CONCURRENT).toBeGreaterThan(0);
    expect(QUERY_DB_MAX_CONCURRENT).toBeLessThanOrEqual(4);
  });

  test("счётчик обнуляется после завершения", async () => {
    expect(_queryDbRunning()).toBe(0);
    await runQueryDbSandboxed(FAST, 50, { timeoutMs: 5000 });
    expect(_queryDbRunning()).toBe(0);
  });

  test("лишний вызов получает отказ, а не встаёт в очередь", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        runQueryDbSandboxed(SLOW, 50, { timeoutMs: 8000, maxConcurrent: 1 }),
      ),
    );
    const refused = results.filter(
      (r) => !r.ok && /песочниц|одновременно|другие запросы/i.test(r.error),
    );
    expect(refused.length).toBe(4);
    expect(results.filter((r) => r.ok).length).toBe(1);
    expect(_queryDbRunning()).toBe(0);
  }, 30_000);

  test("после отказа слот освобождается и следующий запрос проходит", async () => {
    await Promise.all(
      Array.from({ length: 3 }, () =>
        runQueryDbSandboxed(SLOW, 50, { timeoutMs: 8000, maxConcurrent: 1 }),
      ),
    );
    const after = await runQueryDbSandboxed(FAST, 50, { timeoutMs: 5000 });
    expect(after.ok).toBe(true);
  }, 30_000);

  test("отказ не убивает уже запущенный запрос", async () => {
    const [first, second] = await Promise.all([
      runQueryDbSandboxed(SLOW, 50, { timeoutMs: 8000, maxConcurrent: 1 }),
      runQueryDbSandboxed(FAST, 50, { timeoutMs: 8000, maxConcurrent: 1 }),
    ]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
  }, 30_000);
});
