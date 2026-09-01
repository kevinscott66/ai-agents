/**
 * Аудит 2026-08-27: отказ владельца записывался как одобрение.
 *
 * `applied_at IS NULL` означал сразу две вещи — «ждёт решения» и «владелец
 * отказал»: `handleUpdateAgentPromptRejected` саму строку версии не трогал.
 * А одобрение ищет строку по СОДЕРЖИМОМУ (agent_key + prompt + reason — id
 * одобрение сюда не приносит) и берёт `ORDER BY version ASC LIMIT 1`.
 *
 * Отсюда сценарий, который и воспроизводится ниже: владелец отклонил v1, автор
 * переспросил тем же текстом, владелец одобрил v2 — applied_at вставал на v1,
 * ОТКЛОНЁННУЮ, а одобренная v2 оставалась «не применена никогда».
 * `GET_PROMPT_HISTORY` — единственный след правок system prompt'ов — показывал
 * ровно перевёрнутую картину решений человека.
 *
 * Лечится колонкой `rejected_at` (миграция 048), а не маркером в applied_at:
 * «отклонена» не должно читаться как «применена».
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import { executeTool } from "../lib/tools-schema.ts";
import {
  insertPendingAgentPrompt,
  handleUpdateAgentPromptApproved,
  handleUpdateAgentPromptRejected,
} from "../lib/dispatch/agent-prompt.ts";
import type { UpdateAgentPromptPayload } from "../lib/action-payload.ts";

const TARGET = "qa";
const CHAT = -100_999_827;

/** Валидация ручки требует >= 50 символов промпта и >= 20 символов причины. */
function payload(suffix = ""): UpdateAgentPromptPayload {
  return {
    target_agent_key: TARGET,
    new_prompt: `Ты QA-инженер команды. Проверяй строго, отвечай коротко и по делу.${suffix}`,
    reason: `уточняем тон ответов роли QA после жалоб владельца${suffix}`,
  } as UpdateAgentPromptPayload;
}

function reject(p: UpdateAgentPromptPayload) {
  handleUpdateAgentPromptRejected({
    payload: p,
    decidedBy: "owner",
    requestedBy: "aieng",
    approvalId: `a-${Math.floor(Math.random() * 1e9)}`,
    chatId: CHAT,
  });
}

function rows() {
  return db
    .prepare(
      `SELECT version, applied_at, rejected_at FROM agent_prompts
       WHERE agent_key = ? ORDER BY version`,
    )
    .all(TARGET) as Array<{
    version: number;
    applied_at: number | null;
    rejected_at: number | null;
  }>;
}

function clean() {
  db.prepare("DELETE FROM agent_prompts WHERE agent_key = ?").run(TARGET);
  db.prepare(
    "DELETE FROM audit_logs WHERE chat_id = ? AND event_type = 'UPDATE_AGENT_PROMPT_REJECTED'",
  ).run(CHAT);
}

describe("отказ по system prompt не выдаётся за применение", () => {
  beforeEach(clean);
  afterEach(clean);

  test("схема несёт rejected_at (миграция 048)", () => {
    const cols = (
      db.prepare("PRAGMA table_info(agent_prompts)").all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    expect(cols).toContain("rejected_at");
  });

  test("отказ помечает саму строку версии, а не только журнал", () => {
    insertPendingAgentPrompt(payload(), "aieng");
    reject(payload());
    const [v1] = rows();
    expect(v1!.rejected_at).not.toBeNull();
    expect(v1!.applied_at).toBeNull();
  });

  test("повтор того же текста: applied встаёт на одобренную, не на отклонённую", () => {
    insertPendingAgentPrompt(payload(), "aieng"); // v1
    reject(payload());
    insertPendingAgentPrompt(payload(), "aieng"); // v2
    const res = handleUpdateAgentPromptApproved(payload(), {
      agentKey: "aieng",
      chatId: CHAT,
    });
    expect(res.ok).toBe(true);
    // Ручка отчитывается той же версией, которую пометила.
    expect((res as { result: { version: number } }).result.version).toBe(2);
    const [v1, v2] = rows();
    expect(v1!.applied_at, "отклонённая v1 помечена применённой").toBeNull();
    expect(v1!.rejected_at).not.toBeNull();
    expect(v2!.applied_at, "одобренная v2 осталась без applied_at").not.toBeNull();
    expect(v2!.rejected_at).toBeNull();
  });

  test("две отклонённые подряд не перехватывают третье одобрение", () => {
    insertPendingAgentPrompt(payload(), "aieng"); // v1
    reject(payload());
    insertPendingAgentPrompt(payload(), "aieng"); // v2
    reject(payload());
    insertPendingAgentPrompt(payload(), "aieng"); // v3
    const res = handleUpdateAgentPromptApproved(payload(), {
      agentKey: "aieng",
      chatId: CHAT,
    });
    expect((res as { result: { version: number } }).result.version).toBe(3);
    expect(rows().map((r) => (r.applied_at ? "applied" : r.rejected_at ? "rejected" : "pending")))
      .toEqual(["rejected", "rejected", "applied"]);
  });

  test("отклонённую версию нельзя применить повторным одобрением", () => {
    insertPendingAgentPrompt(payload(), "aieng"); // v1
    reject(payload());
    // Ни одной ожидающей строки нет: одобрение падает на fallback-ветку и
    // заводит НОВУЮ версию, а не воскрешает отклонённую.
    const res = handleUpdateAgentPromptApproved(payload(), {
      agentKey: "aieng",
      chatId: CHAT,
    });
    expect(res.ok).toBe(true);
    const list = rows();
    expect(list[0]!.applied_at, "v1 воскрешена одобрением").toBeNull();
    expect(list.length).toBe(2);
    expect(list[1]!.applied_at).not.toBeNull();
  });

  test("порядок ASC для ожидающих сохранён (регрессия 2026-08-20)", () => {
    insertPendingAgentPrompt(payload(), "aieng"); // v1
    insertPendingAgentPrompt(payload(), "aieng"); // v2 — тот же текст
    const res = handleUpdateAgentPromptApproved(payload(), {
      agentKey: "aieng",
      chatId: CHAT,
    });
    // Очередь показывает старшую первой, её и одобряют первой.
    expect((res as { result: { version: number } }).result.version).toBe(1);
  });

  test("GET_PROMPT_HISTORY различает отказ и ожидание", async () => {
    insertPendingAgentPrompt(payload(), "aieng"); // v1
    reject(payload());
    insertPendingAgentPrompt(payload(), "aieng"); // v2
    handleUpdateAgentPromptApproved(payload(), { agentKey: "aieng", chatId: CHAT });
    insertPendingAgentPrompt(payload(), "aieng"); // v3 — висит

    const out = JSON.parse(
      await executeTool(
        "GET_PROMPT_HISTORY",
        { agentKey: TARGET },
        { agentKey: "aieng", chatId: CHAT },
      ),
    ) as { ok: boolean; history: Array<{ version: number; status: string }> };
    expect(out.ok).toBe(true);
    const byVersion = new Map(out.history.map((h) => [h.version, h.status]));
    // Три разных исхода — три разных слова. До миграции 048 отказ и ожидание
    // приходили сюда одинаково (`applied: false`), и роль могла переспросить
    // ровно то, в чём ей уже отказали.
    expect(byVersion.get(1)).toBe("rejected");
    expect(byVersion.get(2)).toBe("applied");
    expect(byVersion.get(3)).toBe("pending");
  });

  test("отказ по-прежнему пишет строку в audit_logs", () => {
    insertPendingAgentPrompt(payload(), "aieng");
    reject(payload());
    const n = db
      .prepare(
        `SELECT count(*) AS n FROM audit_logs
         WHERE chat_id = ? AND event_type = 'UPDATE_AGENT_PROMPT_REJECTED'`,
      )
      .get(CHAT) as { n: number };
    expect(n.n).toBe(1);
  });

  test("отказ без строки версии не роняет решение человека", () => {
    // Строки версии нет вовсе — её кладут ДО создания approval'а, так что это
    // «чего мы не понимаем». Отказ обязан записаться всё равно.
    expect(() => reject(payload("-нет-строки"))).not.toThrow();
    const n = db
      .prepare(
        `SELECT count(*) AS n FROM audit_logs
         WHERE chat_id = ? AND event_type = 'UPDATE_AGENT_PROMPT_REJECTED'`,
      )
      .get(CHAT) as { n: number };
    expect(n.n).toBe(1);
  });
});
