/**
 * Аудит 2026-08-21: явный CREATE_DIAGNOSTIC_TASK заводил задачи по сетевым
 * сбоям и по части rate-limit'ов, хотя шапка модуля обещает их пропускать.
 *
 * Два независимых промаха складывались в один результат.
 *
 * Первый: фильтр стоял на СВОЁМ регэкспе `/429|rate.?limit/i`, который уже,
 * чем `categorizeError` (`\b429\b|rate.?limit|too many requests|
 * quota.?exceed|rate.?exceed`). «Too Many Requests: retry after 30» и «quota
 * exceeded» — это `rate_limited` по классификатору и НЕ rate-limit по
 * фильтру.
 *
 * Второй: `pickResponsibleRole` документирован как «возвращает null, когда
 * задачу создавать НЕ надо (rate_limited / network — обрабатываются в другом
 * месте)», а вызывающий гасил этот null через `?? "orchestrator"`. То есть
 * сигнал «не создавать» превращался в «создать и повесить на оркестратора».
 *
 * Итог: моргнула сеть → GENERATE_IMAGE упал с `fetch failed` → агент просит
 * разобраться → на доске владельца висит `[diagnostic] network: …` на
 * orchestrator. Неявный путь (`createDiagnosticTask`) на тех же ошибках
 * возвращает `deferred_network` / `deferred_rate_limited` и не создаёт
 * ничего. Троттл T-705 по title поток ограничивает, но не отменяет: разные
 * типы упавшего действия дают разные title.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import { handleCreateDiagnosticTask } from "../lib/dispatch/diagnostic-action.ts";
import { createDiagnosticTask } from "../lib/diagnostic.ts";
import { logAction } from "../lib/audit.ts";

const CHAT = -1_000_821;
const CTX = { agentKey: "backend", chatId: CHAT };
const HYPOTHESIS = "провайдер моргнул, надо посмотреть логи ретраев";

// Собственное пространство имён типов действий: троттл T-705 считает по title
// ГЛОБАЛЬНО, а title — `[diagnostic] <категория>: <тип>`. С реальным типом
// счётчик делится с любым другим тестовым файлом того же класса, и тест
// становится зависимым от порядка запуска.
const ACT = "AUDIT_TRANSIENT_A";
const ACT_CTL = "AUDIT_TRANSIENT_CTL";

function failedAction(error: string, actionType = ACT): string {
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

beforeEach(cleanup);
afterEach(cleanup);

function ask(error: string, actionType = ACT, target?: string) {
  const id = failedAction(error, actionType);
  const res = handleCreateDiagnosticTask(
    {
      failed_action_id: id,
      hypothesis: HYPOTHESIS,
      ...(target ? { target_agent_key: target } : {}),
    } as never,
    CTX,
  );
  if (!res.ok) throw new Error(`unexpected failure: ${res.error}`);
  return res.result;
}

describe("явный CREATE_DIAGNOSTIC_TASK: транзиентные ошибки не идут на доску", () => {
  test("сетевой сбой — пропуск, а не задача на orchestrator", () => {
    const r = ask("fetch failed");
    expect(r.error_category).toBe("network");
    expect(r.skipped_reason).toBe("skipped_network");
    expect(r.task_id).toBeNull();
    expect(r.assigned_to).toBeNull();
    expect(diagRows()).toBe(0);
  });

  test("ETIMEDOUT и 502 — тот же пропуск", () => {
    for (const e of ["ETIMEDOUT connecting to api", "Bad Gateway 502"]) {
      cleanup();
      const r = ask(e);
      expect(r.error_category).toBe("network");
      expect(r.skipped_reason).toBe("skipped_network");
      expect(diagRows()).toBe(0);
    }
  });

  test("rate-limit без слова «429» тоже пропускается", () => {
    for (const e of [
      "Too Many Requests: retry after 30",
      "quota exceeded for images",
      "rate exceeded",
    ]) {
      cleanup();
      const r = ask(e);
      expect(r.error_category).toBe("rate_limited");
      expect(r.skipped_reason).toBe("skipped_rate_limited");
      expect(r.task_id).toBeNull();
      expect(diagRows()).toBe(0);
    }
  });

  test("явный target_agent_key не отменяет пропуск транзиентной ошибки", () => {
    const r = ask("fetch failed", ACT, "backend");
    expect(r.skipped_reason).toBe("skipped_network");
    expect(r.task_id).toBeNull();
    expect(diagRows()).toBe(0);
  });

  test("контроль: нетранзиентная ошибка по-прежнему заводит задачу", () => {
    const r = ask("API 400: invalid parse_mode", ACT_CTL);
    expect(r.error_category).toBe("unknown");
    expect(r.skipped_reason).toBeUndefined();
    expect(r.assigned_to).toBe("orchestrator");
    expect(r.task_id).toBeTruthy();
    expect(diagRows()).toBe(1);
  });

  test("явный путь молчит там же, где молчит неявный", () => {
    for (const e of ["fetch failed", "Too Many Requests: retry after 30"]) {
      cleanup();
      const implicit = createDiagnosticTask({
        chatId: CHAT,
        failedActionId: failedAction(e),
        actionType: ACT,
        agentKey: "backend",
        error: e,
      } as never);
      expect(implicit.task).toBeNull();

      cleanup();
      const explicit = ask(e);
      expect(explicit.task_id).toBeNull();
    }
  });
});
