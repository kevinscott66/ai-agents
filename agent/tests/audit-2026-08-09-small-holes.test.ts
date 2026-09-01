/**
 * Аудит 2026-08-09: три отдельные мелочи, каждая из которых тихо превращает
 * защиту в её отсутствие.
 *
 *  1. TOKEN_BUDGET_* с опечаткой читался как «лимита нет».
 *  2. Кулдаун повторных алертов был приделан к короткому шторму и не приделан
 *     к бэклогу аппрувалов, который по природе длится сутками.
 *  3. `/audit <опечатка>` молча отдавал журнал по всем ролям.
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { db } from "../lib/db.ts";
import { getBudget, _resetBudgetEnvWarnings } from "../lib/token-budget.ts";
import { checkApprovalBacklog, _resetAlertCooldowns } from "../lib/alerting.ts";
import { cmdAudit } from "../lib/commands.ts";

describe("бюджет: испорченный env — не «без лимита»", () => {
  const KEYS = ["TOKEN_BUDGET_DEFAULT", "TOKEN_BUDGET_BACKEND"];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    for (const k of KEYS) delete process.env[k];
    _resetBudgetEnvWarnings();
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
    _resetBudgetEnvWarnings();
  });

  test("незаданный бюджет по-прежнему означает отсутствие лимита", () => {
    expect(getBudget("backend")).toBe(Infinity);
  });

  test("подчёркивания в числе не снимают потолок", () => {
    // `2_000_000` — валидный числовой литерал в TS и мусор в env.
    process.env.TOKEN_BUDGET_DEFAULT = "2_000_000";
    expect(getBudget("backend")).not.toBe(Infinity);
  });

  test("суффикс k не снимает потолок", () => {
    process.env.TOKEN_BUDGET_DEFAULT = "500k";
    expect(getBudget("backend")).not.toBe(Infinity);
  });

  test("ноль значит ноль, а не бесконечность", () => {
    process.env.TOKEN_BUDGET_DEFAULT = "0";
    expect(getBudget("backend")).toBe(0);
  });

  test("испорченный ключ роли не отменяет валидный DEFAULT", () => {
    process.env.TOKEN_BUDGET_BACKEND = "много";
    process.env.TOKEN_BUDGET_DEFAULT = "50000";
    // Мусор в конкретном ключе — это «здесь ничего вменяемого нет», а не
    // «лимита нет»: падаем на общий, а не в Infinity.
    //
    // Аудит 2026-08-20: раньше тут стояло `toBeLessThanOrEqual(100_000)` — то
    // есть тест был зелёным ровно в том случае, который проверяет его же имя:
    // getBudget возвращал MALFORMED_ENV_BUDGET (100000) и до DEFAULT не
    // доходил никогда. Проверяем точное значение.
    expect(getBudget("backend")).toBe(50_000);
  });

  test("опечатка в ключе роли не ПОДНИМАЕТ жёсткий DEFAULT", () => {
    // Оператор задал жёсткую экономию и опечатался пробелом в одной роли.
    // До 2026-08-20 эта роль получала 100_000 — в сто раз больше дефолта.
    process.env.TOKEN_BUDGET_DEFAULT = "1000";
    process.env.TOKEN_BUDGET_BACKEND = "50 000";
    expect(getBudget("backend")).toBe(1000);
  });

  test("мусор везде — консервативный потолок, не Infinity", () => {
    process.env.TOKEN_BUDGET_DEFAULT = "500k";
    process.env.TOKEN_BUDGET_BACKEND = "2_000_000";
    const n = getBudget("backend");
    expect(n).not.toBe(Infinity);
    expect(n).toBe(100_000);
  });

  test("мусор в DEFAULT не мешает валидному ключу роли", () => {
    process.env.TOKEN_BUDGET_DEFAULT = "не число";
    process.env.TOKEN_BUDGET_BACKEND = "7777";
    expect(getBudget("backend")).toBe(7777);
  });

  test("валидное значение работает как раньше", () => {
    process.env.TOKEN_BUDGET_BACKEND = "12345";
    expect(getBudget("backend")).toBe(12345);
  });
});

describe("алерт о бэклоге аппрувалов не повторяется каждый час", () => {
  const CHAT = -100781;

  /** Сколько «старых» pending уже лежит в общей БД — порог считаем от этого. */
  function baseline(): number {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM approvals
         WHERE status='pending' AND created_at < ?`,
      )
      .get(Date.now() - 60 * 60_000) as { n: number };
    return row.n;
  }

  function seedPending(n: number) {
    const ts = Date.now() - 120 * 60_000;
    for (let i = 0; i < n; i++) {
      db.prepare(
        `INSERT INTO approvals(id, action_id, chat_id, requested_by, action_type,
                               payload, status, created_at)
         VALUES (?, ?, ?, 'backend', 'SEND_MESSAGE', '{}', 'pending', ?)`,
      ).run(`bk-${i}-${ts}`, `act-${i}-${ts}`, CHAT, ts);
    }
  }

  beforeEach(() => {
    db.prepare("DELETE FROM approvals WHERE chat_id = ?").run(CHAT);
    _resetAlertCooldowns();
  });
  afterEach(() => {
    db.prepare("DELETE FROM approvals WHERE chat_id = ?").run(CHAT);
    _resetAlertCooldowns();
  });

  test("первый тик сигналит", () => {
    const min = baseline() + 12;
    seedPending(12);
    expect(checkApprovalBacklog({ thresholds: { approvalBacklogMin: min } })).toBe(
      true,
    );
  });

  test("следующий час — тишина, бэклог тот же", () => {
    const opts = { thresholds: { approvalBacklogMin: baseline() + 12 } };
    seedPending(12);
    expect(checkApprovalBacklog(opts)).toBe(true);
    // Хендлер зовётся раз в час; человек ещё не разобрал очередь. До фикса
    // здесь была вторая запись в audit_logs — и так все 24 часа в сутки.
    expect(checkApprovalBacklog(opts)).toBe(false);
  });

  test("кулдаун можно выключить нулём", () => {
    const opts = {
      thresholds: {
        approvalBacklogMin: baseline() + 12,
        approvalBacklogCooldownMinutes: 0,
      },
    };
    seedPending(12);
    expect(checkApprovalBacklog(opts)).toBe(true);
    expect(checkApprovalBacklog(opts)).toBe(true);
  });

  test("бэклог ниже порога не сигналит вовсе", () => {
    const opts = { thresholds: { approvalBacklogMin: baseline() + 12 } };
    seedPending(2);
    expect(checkApprovalBacklog(opts)).toBe(false);
  });
});

describe("/audit не угадывает роль", () => {
  test("опечатка в ключе роли — явная ошибка", () => {
    const out = cmdAudit({ args: ["backnd"] });
    expect(out).toContain("Неизвестный agent");
  });

  test("правдоподобное, но чужое имя тоже отвергается", () => {
    // Реальный ключ — `design`. До фикса это отдавало журнал всех двенадцати.
    const out = cmdAudit({ args: ["designer"] });
    expect(out).toContain("Неизвестный agent");
  });

  test("валидные аргументы работают", () => {
    const out = cmdAudit({ args: ["orchestrator", "5"] });
    expect(out).not.toContain("Неизвестный agent");
  });

  test("без аргументов — общий журнал, это законно", () => {
    const out = cmdAudit({ args: [] });
    expect(out).not.toContain("Неизвестный agent");
  });
});
