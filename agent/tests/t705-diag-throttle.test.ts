/**
 * T-705 throttle: авто-создание diagnostic-task ограничено N/час по типу действия
 * (анти-шторм fix-loop'ов). Покрывает чистый предикат isDiagTaskThrottled.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import { isDiagTaskThrottled, diagTaskThrottleMax } from "../lib/fix-chain.ts";

/**
 * Заголовки намеренно СВОИ, а не боевые «Tool error: SEND_MESSAGE».
 *
 * P2bis (nightly, 2026-09-10): `isDiagTaskThrottled` считает по паре
 * (assigned_to='aieng', title) в окне `created_at >= now - 1ч`, а `NOW` здесь —
 * 2001 год. Любая diag-задача, оставленная соседним файлом (self-diag заводит
 * их пачками и называет ровно `Tool error: <ACTION>`), лежит в 2026-м, то есть
 * заведомо ПОЗЖЕ границы окна и досчитывается сюда. На общей `data/memory.db`
 * под `--rerun-each=5` таких хвостов набиралось больше потолка, и «под лимитом
 * → не throttled» получал true. Чистка по `id LIKE 'thr-%'` их не видела:
 * идентификаторы чужие.
 *
 * Для предиката title — непрозрачный ключ, поэтому собственный ключ ничего не
 * ослабляет: проверяется ровно то же поведение, но на данных, которые никто,
 * кроме этого файла, не пишет.
 */
const TITLE = "Tool error: T705_PROBE_SEND";
const OTHER_TITLE = "Tool error: T705_PROBE_DELETE";
const NOW = 1_000_000_000_000;

function seedDiagTasks(n: number, ts: number) {
  const ins = db.prepare(
    `INSERT INTO tasks(id, chat_id, created_by, assigned_to, title, status, created_at, updated_at)
     VALUES (?, -1, 'orchestrator', 'aieng', ?, 'pending', ?, ?)`,
  );
  for (let k = 0; k < n; k++) ins.run(`thr-${ts}-${k}`, TITLE, ts, ts);
}

function clearProbeTasks(): void {
  db.prepare(
    "DELETE FROM tasks WHERE id LIKE 'thr-%' OR title IN (?, ?)",
  ).run(TITLE, OTHER_TITLE);
}

describe("T-705 diag-task throttle", () => {
  // Симметрично: за собой файл убирает тоже — свои строки в общей БД он иначе
  // оставит следующему.
  beforeEach(clearProbeTasks);
  afterEach(clearProbeTasks);

  test("под лимитом → не throttled", () => {
    seedDiagTasks(diagTaskThrottleMax() - 1, NOW - 1000);
    expect(isDiagTaskThrottled(TITLE, NOW)).toBe(false);
  });

  test("на лимите → throttled", () => {
    seedDiagTasks(diagTaskThrottleMax(), NOW - 1000);
    expect(isDiagTaskThrottled(TITLE, NOW)).toBe(true);
  });

  test("старые (>1ч) не считаются", () => {
    seedDiagTasks(diagTaskThrottleMax() + 2, NOW - 2 * 60 * 60 * 1000);
    expect(isDiagTaskThrottled(TITLE, NOW)).toBe(false);
  });

  test("другой actionType не влияет", () => {
    seedDiagTasks(diagTaskThrottleMax(), NOW - 1000);
    expect(isDiagTaskThrottled(OTHER_TITLE, NOW)).toBe(false);
  });
});
