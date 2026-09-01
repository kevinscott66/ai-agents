/**
 * Аудит 2026-08-09: явный CREATE_DIAGNOSTIC_TASK не имел ни дедупа, ни троттла.
 *
 * Забавная симметрия. Неявный путь (createDiagnosticTask) дедупит по паре
 * (failed_action_id, error_category) — но failed_action_id туда приходит из
 * logAction, то есть это свежий crypto.randomUUID() на каждый вызов. Ключ не
 * может совпасть никогда: дедуп живёт там, где он физически невозможен.
 *
 * А в явном handler'е failed_action_id приходит ОТ МОДЕЛИ и повторяется
 * сколько угодно раз — и там-то дедупа как раз не было. Плюс не было и
 * почасового троттла T-705, который у соседней C15-петли есть.
 *
 * Цена: агент, трижды попросивший разобраться с одним провалом, получал три
 * задачи на доске и три чужих запуска; поток падений одного класса — сколько
 * угодно задач в час.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import { handleCreateDiagnosticTask } from "../lib/dispatch/diagnostic-action.ts";
import { createDiagnosticTask } from "../lib/diagnostic.ts";
import { logAction } from "../lib/audit.ts";
import { diagTaskThrottleMax } from "../lib/fix-chain.ts";

const CHAT = -1_000_720;
const CTX = { agentKey: "backend", chatId: CHAT };
const HYPOTHESIS = "похоже, у роли нет права на это действие";
// Синтетические типы действий: троттл считает по title ГЛОБАЛЬНО, а title —
// это `[diagnostic] <категория>: <тип действия>`. С реальным типом счётчик
// делится с любым другим тестовым файлом, заведшим diag-задачу того же класса,
// и тест становится зависимым от порядка запуска. Собственное пространство
// имён — единственный честный способ изоляции, менять ради тестов глобальность
// самого троттла нельзя: она и есть анти-шторм.
const ACT_A = "AUDIT_STORM_A";
const ACT_B = "AUDIT_STORM_B";

function failedAction(error: string, actionType = ACT_A): string {
  const { id } = logAction({
    agentKey: "backend",
    actionType,
    chatId: CHAT,
    payload: {},
    status: "error",
    error,
  } as never);
  return id;
}

function diagRows(): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM tasks
       WHERE chat_id = ? AND input LIKE '%"type":"diagnostic"%'`,
    )
    .get(CHAT) as { n: number };
  return row.n;
}

function cleanup() {
  db.prepare(`DELETE FROM tasks WHERE chat_id = ?`).run(CHAT);
  db.prepare(`DELETE FROM agent_actions WHERE chat_id = ?`).run(CHAT);
}

let savedMax: string | undefined;

beforeEach(() => {
  savedMax = process.env.DIAG_TASK_MAX_PER_HOUR;
  cleanup();
});

afterEach(() => {
  if (savedMax === undefined) delete process.env.DIAG_TASK_MAX_PER_HOUR;
  else process.env.DIAG_TASK_MAX_PER_HOUR = savedMax;
  cleanup();
});

describe("явный CREATE_DIAGNOSTIC_TASK: дедуп", () => {
  test("повтор по тому же провалу возвращает ту же задачу, а не вторую", () => {
    const id = failedAction(`permission denied for ${ACT_A}`);
    const first = handleCreateDiagnosticTask(
      { failed_action_id: id, hypothesis: HYPOTHESIS } as never,
      CTX,
    );
    expect(first.ok).toBe(true);
    const taskId = (first as { result: { task_id: string } }).result.task_id;
    expect(taskId).toBeTruthy();
    expect(diagRows()).toBe(1);

    for (let i = 0; i < 5; i++) {
      const again = handleCreateDiagnosticTask(
        { failed_action_id: id, hypothesis: HYPOTHESIS } as never,
        CTX,
      );
      expect(again.ok).toBe(true);
      const r = (again as { result: Record<string, unknown> }).result;
      expect(r.skipped_reason).toBe("duplicate");
      // Возвращаем id уже существующей задачи: вызывающему нужен указатель,
      // а не молчаливый null, иначе он попробует ещё раз.
      expect(r.task_id).toBe(taskId);
    }
    // Шесть запросов — одна строка на доске.
    expect(diagRows()).toBe(1);
  });

  test("дедуп снимается, когда задача закрыта", () => {
    const id = failedAction(`permission denied for ${ACT_A}`);
    const first = handleCreateDiagnosticTask(
      { failed_action_id: id, hypothesis: HYPOTHESIS } as never,
      CTX,
    );
    const taskId = (first as { result: { task_id: string } }).result.task_id;
    db.prepare(`UPDATE tasks SET status = 'done' WHERE id = ?`).run(taskId);

    // Провал повторился после того, как расследование закрыли — это уже новый
    // повод, а не дубль. Дедуп смотрит только на pending/running.
    const second = handleCreateDiagnosticTask(
      { failed_action_id: id, hypothesis: HYPOTHESIS } as never,
      CTX,
    );
    const r = (second as { result: Record<string, unknown> }).result;
    expect(r.skipped_reason).toBeUndefined();
    expect(r.task_id).not.toBe(taskId);
  });

  test("другой провал того же класса дедупом не глушится", () => {
    const a = failedAction(`permission denied for ${ACT_A}`);
    const b = failedAction(`permission denied for ${ACT_B}`, ACT_B);
    handleCreateDiagnosticTask(
      { failed_action_id: a, hypothesis: HYPOTHESIS } as never,
      CTX,
    );
    const second = handleCreateDiagnosticTask(
      { failed_action_id: b, hypothesis: HYPOTHESIS } as never,
      CTX,
    );
    expect(
      (second as { result: Record<string, unknown> }).result.skipped_reason,
    ).toBeUndefined();
    expect(diagRows()).toBe(2);
  });

  test("явный путь видит и задачу, созданную неявным путём", () => {
    const id = failedAction(`permission denied for ${ACT_A}`);
    // Неявный T-704 уже завёл расследование по этому же действию.
    const implicit = createDiagnosticTask({
      failedActionId: id,
      actionType: ACT_A,
      error: `permission denied for ${ACT_A}`,
      chatId: CHAT,
      originatingAgent: "backend",
    });
    expect(implicit.task).not.toBeNull();

    const explicit = handleCreateDiagnosticTask(
      { failed_action_id: id, hypothesis: HYPOTHESIS } as never,
      CTX,
    );
    const r = (explicit as { result: Record<string, unknown> }).result;
    expect(r.skipped_reason).toBe("duplicate");
    expect(r.task_id).toBe(implicit.task!.id);
    expect(diagRows()).toBe(1);
  });
});

describe("явный CREATE_DIAGNOSTIC_TASK: троттл", () => {
  test("поток разных провалов одного класса упирается в лимит за час", () => {
    process.env.DIAG_TASK_MAX_PER_HOUR = "3";
    const created: string[] = [];
    let throttled = 0;
    // Десять РАЗНЫХ провалов — дедуп тут не при чём, каждый ключ уникален.
    for (let i = 0; i < 10; i++) {
      const id = failedAction(`permission denied #${i} for ${ACT_A}`);
      const res = handleCreateDiagnosticTask(
        { failed_action_id: id, hypothesis: HYPOTHESIS } as never,
        CTX,
      );
      const r = (res as { result: Record<string, unknown> }).result;
      if (r.skipped_reason === "throttled") throttled++;
      else if (typeof r.task_id === "string") created.push(r.task_id);
    }
    expect(created.length).toBe(3);
    expect(throttled).toBe(7);
    expect(diagRows()).toBe(3);
  });

  test("троттл считает по любому исполнителю, а не только по aieng", () => {
    process.env.DIAG_TASK_MAX_PER_HOUR = "2";
    // Явно роутим на разные роли: до фикса счётчик смотрел только на 'aieng',
    // и любой другой адресат обнулял его — шторм считался нулевым.
    const roles = ["perm", "orchestrator", "qa", "pm"];
    const reasons: unknown[] = [];
    for (const role of roles) {
      const id = failedAction(`permission denied ${role} for ${ACT_A}`);
      const res = handleCreateDiagnosticTask(
        {
          failed_action_id: id,
          hypothesis: HYPOTHESIS,
          target_agent_key: role,
        } as never,
        CTX,
      );
      reasons.push((res as { result: Record<string, unknown> }).result.skipped_reason);
    }
    expect(reasons).toEqual([undefined, undefined, "throttled", "throttled"]);
  });

  test("лимит по умолчанию — 5/час", () => {
    delete process.env.DIAG_TASK_MAX_PER_HOUR;
    expect(diagTaskThrottleMax()).toBe(5);
    let created = 0;
    for (let i = 0; i < 8; i++) {
      const id = failedAction(`permission denied #${i} for ${ACT_A}`);
      const res = handleCreateDiagnosticTask(
        { failed_action_id: id, hypothesis: HYPOTHESIS } as never,
        CTX,
      );
      if ((res as { result: { task_id: unknown } }).result.task_id) created++;
    }
    expect(created).toBe(5);
  });

  test("троттл по классу ошибки, а не по всему подряд", () => {
    process.env.DIAG_TASK_MAX_PER_HOUR = "2";
    for (let i = 0; i < 3; i++) {
      handleCreateDiagnosticTask(
        {
          failed_action_id: failedAction(`permission denied #${i}`),
          hypothesis: HYPOTHESIS,
        } as never,
        CTX,
      );
    }
    // Другой тип действия → другой title → своя корзина. Забитый класс не
    // должен глушить расследование не связанного с ним провала.
    const other = handleCreateDiagnosticTask(
      {
        failed_action_id: failedAction(`permission denied for ${ACT_B}`, ACT_B),
        hypothesis: HYPOTHESIS,
      } as never,
      CTX,
    );
    expect(
      (other as { result: Record<string, unknown> }).result.skipped_reason,
    ).toBeUndefined();
  });
});

describe("неявный T-704 путь: троттл тоже нужен", () => {
  test("пятьдесят падений одного типа не дают пятьдесят задач", () => {
    process.env.DIAG_TASK_MAX_PER_HOUR = "4";
    let created = 0;
    let throttled = 0;
    for (let i = 0; i < 20; i++) {
      // Ключ дедупа здесь уникален по построению (в проде это UUID из
      // logAction), поэтому дедуп не срабатывает ни разу — единственной
      // границей остаётся троттл.
      const res = createDiagnosticTask({
        failedActionId: `uuid-${i}`,
        actionType: ACT_A,
        error: `permission denied for ${ACT_A}`,
        chatId: CHAT,
        originatingAgent: "backend",
      });
      if (res.task) created++;
      if (res.skippedReason === "throttled") throttled++;
    }
    expect(created).toBe(4);
    expect(throttled).toBe(16);
  });
});
