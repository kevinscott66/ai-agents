/**
 * Аудит 2026-08-29: часовой тик алертов db-maint не должен трогать проверку
 * шторма rate-limit.
 *
 * Правка 2026-08-08 вынесла `checkRateLimitStorm` на собственный таймер с
 * периодом `stormTickMs()` — не длиннее окна наблюдения, иначе проверка,
 * считающая частоту в пятиминутном окне, видит 1/12 каждого часа. Но часовой
 * тик продолжал звать агрегатор `checkBacklogAlerts()`, дёргавший обе
 * проверки, — то есть отменял ровно то, ради чего таймеры разделили.
 *
 * Ущерб не сводится к лишнему индексированному COUNT(*) в час: кулдаун
 * `takeCooldown("rate_limit.storm", …)` не различает, кто его взял. Часовой
 * тик, попавший на конец окна, забирал кулдаун на пустом месте, и настоящий
 * алерт штормового таймера в следующую минуту глушился.
 *
 * Тест поднимает планировщик с часовым тиком в несколько миллисекунд (шов
 * `alertingTickMs`). Штормовой таймер при этом остаётся на `stormTickMs()`,
 * то есть минимум минуту — за время кейса он заведомо не сработает ни разу.
 * Значит любая запись `alert.rate_limit.storm` может прийти только из
 * часового тика.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import * as alerting from "../lib/alerting.ts";
import { _resetAlertCooldowns, stormTickMs } from "../lib/alerting.ts";
import { startMaintScheduler } from "../lib/db-maint.ts";

const TEST_CHAT = -1009003251;
const TEST_AGENT = "qa-hourly-tick";

const ENV_KEYS = [
  "ALERT_APPROVAL_BACKLOG_MIN",
  "ALERT_APPROVAL_BACKLOG_AGE_MINUTES",
  "ALERT_RATE_LIMIT_STORM_COUNT",
  "ALERT_RATE_LIMIT_STORM_WINDOW_MINUTES",
];
let savedEnv: Record<string, string | undefined> = {};

function cleanup(): void {
  db.prepare(`DELETE FROM audit_logs WHERE agent_key='system'`).run();
  db.prepare(`DELETE FROM approvals`).run();
  db.prepare(`DELETE FROM agent_actions WHERE status='rate_limited'`).run();
  db.prepare(`DELETE FROM agent_actions WHERE agent_key=? OR chat_id=?`).run(
    TEST_AGENT,
    TEST_CHAT,
  );
  _resetAlertCooldowns();
}

function countAlerts(code: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM audit_logs WHERE event_type=? AND agent_key='system'`,
    )
    .get(`alert.${code}`) as { n: number };
  return row.n;
}

function seedBacklog(n: number): void {
  const old = Date.now() - 120 * 60_000;
  for (let i = 0; i < n; i++) {
    db.prepare(
      `INSERT INTO approvals(id, action_id, chat_id, requested_by, action_type, payload, status, created_at)
       VALUES (?, ?, ?, ?, 'SEND_MESSAGE', '{}', 'pending', ?)`,
    ).run(
      crypto.randomUUID(),
      crypto.randomUUID(),
      TEST_CHAT,
      TEST_AGENT,
      old,
    );
  }
}

function seedStorm(n: number): void {
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    db.prepare(
      `INSERT INTO agent_actions(id, agent_key, chat_id, action_type, status, created_at)
       VALUES (?, ?, ?, 'SEND_MESSAGE', 'rate_limited', ?)`,
    ).run(crypto.randomUUID(), TEST_AGENT, TEST_CHAT, now - 30_000);
  }
}

/** Планировщик с быстрым часовым тиком; остальные шаги отключены большими периодами. */
function withScheduler(fn: () => Promise<void>): Promise<void> {
  const handle = startMaintScheduler({
    gcIntervalMs: 24 * 3600 * 1000,
    dailyPollMs: 24 * 3600 * 1000,
    alertingTickMs: 5,
    nowProvider: () => new Date(2000, 0, 1),
  });
  return fn().finally(() => handle.stop());
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.ALERT_APPROVAL_BACKLOG_MIN = "3";
  process.env.ALERT_APPROVAL_BACKLOG_AGE_MINUTES = "60";
  process.env.ALERT_RATE_LIMIT_STORM_COUNT = "5";
  process.env.ALERT_RATE_LIMIT_STORM_WINDOW_MINUTES = "5";
  cleanup();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  cleanup();
});

describe("db-maint: часовой тик алертов", () => {
  test("штормовой таймер за время кейса сработать не может", () => {
    // Инвариант, на котором держатся остальные кейсы: опрос шторма зажат
    // снизу минутой, а кейс живёт сотни миллисекунд.
    expect(stormTickMs()).toBeGreaterThanOrEqual(60_000);
  });

  test("поднимает backlog одобрений", async () => {
    seedBacklog(5);
    await withScheduler(async () => {
      await sleep(150);
      expect(countAlerts("approval.backlog")).toBeGreaterThanOrEqual(1);
    });
  });

  test("не поднимает алерт шторма — это дело штормового таймера", async () => {
    seedStorm(20);
    await withScheduler(async () => {
      await sleep(150);
      expect(countAlerts("rate_limit.storm")).toBe(0);
    });
  });

  test("не выбирает кулдаун шторма из-под штормового таймера", async () => {
    // Часовой тик отработал десятки раз. Если бы он звал проверку шторма,
    // кулдаун был бы занят — и следующий настоящий вызов промолчал бы.
    seedStorm(20);
    await withScheduler(async () => {
      await sleep(150);
    });
    expect(alerting.checkRateLimitStorm()).toBe(true);
    expect(countAlerts("rate_limit.storm")).toBe(1);
  });

  test("агрегатор checkBacklogAlerts не возвращается", () => {
    // Именно он держал устаревшую пару проверок живой: правку таймеров
    // 2026-08-08 он пережил молча, потому что вызов выглядел безобидно.
    expect("checkBacklogAlerts" in alerting).toBe(false);
  });
});
