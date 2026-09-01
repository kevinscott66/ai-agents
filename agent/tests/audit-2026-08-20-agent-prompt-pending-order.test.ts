/**
 * Аудит 2026-08-20: применённая версия промпта не совпадала с одобренной.
 *
 * `handleUpdateAgentPromptApproved` ищет pending-строку по СОДЕРЖИМОМУ
 * (agent_key + prompt + reason) — одобрение не приносит сюда id строки. Значит
 * два одинаковых предложения (типичный повтор после «зависшей» первой заявки)
 * неразличимы, и всё решает `ORDER BY`.
 *
 * Было `version DESC`: владелец одобряет СТАРШУЮ заявку (v5), а `applied_at`
 * ставится младшей (v6); следующее одобрение стампует v5. Версионный след
 * перевёрнут относительно фактических решений. Тексты идентичны, поэтому
 * содержимого не теряется — это рассинхрон журнала, а не данных, но журнал
 * версий именно для того и ведётся, чтобы по нему можно было восстановить
 * порядок решений.
 *
 * Плюс `UPDATE … WHERE id = ?` не повторял `applied_at IS NULL`, то есть
 * повторное одобрение перештамповало бы уже применённую строку новым временем.
 *
 * Инвариант: первое одобрение применяет самую раннюю pending-версию, второе —
 * следующую; уже применённая строка не переписывается.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  insertPendingAgentPrompt,
  handleUpdateAgentPromptApproved,
  type UpdateAgentPromptResult,
} from "../lib/dispatch/agent-prompt.ts";
import { db } from "../lib/db.ts";

const TARGET = "qa";
const CHAT = 999_806_310;
const PROMPT = "Одинаковый текст предложения для проверки порядка версий.";
const REASON = "повтор после зависшей заявки";

const payload = {
  target_agent_key: TARGET,
  new_prompt: PROMPT,
  reason: REASON,
} as any;

function cleanup(): void {
  db.prepare(`DELETE FROM agent_prompts WHERE agent_key = ? AND reason = ?`).run(
    TARGET,
    REASON,
  );
  db.prepare(`DELETE FROM agent_actions WHERE chat_id = ?`).run(CHAT);
  db.prepare(`DELETE FROM audit_logs WHERE chat_id = ?`).run(CHAT);
}

function rows(): Array<{ version: number; applied_at: number | null }> {
  return db
    .prepare(
      `SELECT version, applied_at FROM agent_prompts
        WHERE agent_key = ? AND reason = ? ORDER BY version ASC`,
    )
    .all(TARGET, REASON) as Array<{ version: number; applied_at: number | null }>;
}

/** Одобрение — успешный путь; неуспех здесь означал бы сломанный payload. */
function approve(): { version: number; prompt_row_id: number } {
  const r = handleUpdateAgentPromptApproved(payload, {
    agentKey: "perm",
    chatId: CHAT,
  });
  expect(r.ok).toBe(true);
  return (r as UpdateAgentPromptResult).result;
}

beforeEach(cleanup);
afterEach(cleanup);

describe("одобрение применяет ту версию, которую одобрили", () => {
  test("две одинаковые заявки применяются в порядке подачи", () => {
    const first = insertPendingAgentPrompt(payload, "perm");
    const second = insertPendingAgentPrompt(payload, "perm");
    expect(second.version).toBeGreaterThan(first.version);

    const r1 = approve();
    // До фикса здесь стояла младшая версия — журнал переворачивался.
    expect(r1.version).toBe(first.version);

    const r2 = approve();
    expect(r2.version).toBe(second.version);

    // Обе применены, каждая ровно один раз, новых строк не появилось.
    const all = rows();
    expect({
      count: all.length,
      unapplied: all.filter((r) => r.applied_at === null).length,
    }).toEqual({ count: 2, unapplied: 0 });
  });

  test("уже применённая строка не перештамповывается", () => {
    const only = insertPendingAgentPrompt(payload, "perm");
    approve();
    const stampedAt = rows().find((r) => r.version === only.version)!.applied_at;
    expect(stampedAt).not.toBeNull();

    // Третье одобрение того же содержимого: pending-строк больше нет, поэтому
    // штатный путь заводит НОВУЮ версию, а старую не трогает.
    approve();
    const after = rows().find((r) => r.version === only.version)!.applied_at;
    expect(after).toBe(stampedAt);
  });
});
