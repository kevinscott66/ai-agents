/**
 * Аудит 2026-09-10: применение промпта искало свою строку по содержимому,
 * хотя точный ключ уже был.
 *
 * `agent_prompts.approval_id` пишется при постановке в очередь (миграция 050),
 * и `closeAgentPromptProposals` по нему уже закрывает строки протухших заявок.
 * Применение же сопоставляло по `agent_key + prompt + reason` и разрешало
 * ничью порядком `ORDER BY version ASC` — «владелец решает старшую первой».
 *
 * Это угадывание, а не чтение. Очередь можно решить не по порядку одним
 * нажатием в Mini App: одобрили v6, а `applied_at` встал на v5. Тексты
 * одинаковы, так что заметить нечем — врёт только версионный след, ровно как
 * в аудитах 2026-08-20 и 2026-08-27, чинивших этот же ORDER BY с двух сторон.
 * Не хватало одного: довезти id заявки до хендлера.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { db } from "../lib/db.ts";
import {
  insertPendingAgentPrompt,
  handleUpdateAgentPromptApproved,
} from "../lib/dispatch/agent-prompt.ts";

// Ключ обязан быть настоящей ролью (`VALID_AGENT_KEYS`), длины промпта и
// причины — выше порогов валидатора (50 и 20 символов).
const AGENT = "qa";
const PAYLOAD = {
  target_agent_key: AGENT,
  new_prompt:
    "Ты QA. Проверяй сценарии по шагам, фиксируй воспроизведение и не закрывай задачу без прогона.",
  reason: "уточняем тон и порядок проверки сценариев",
};

function rows() {
  return db
    .prepare(
      `SELECT version, applied_at, approval_id FROM agent_prompts
       WHERE agent_key=? ORDER BY version ASC`,
    )
    .all(AGENT) as Array<{ version: number; applied_at: number | null; approval_id: string | null }>;
}

describe("применение промпта находит строку по id заявки", () => {
  beforeEach(() => {
    db.prepare(`DELETE FROM agent_prompts WHERE agent_key=?`).run(AGENT);
  });

  test("решение не по порядку стампует ту версию, которую одобрили", () => {
    // Два одинаковых предложения — типичный повтор после «зависшей» первой
    // заявки. По содержимому они неразличимы.
    insertPendingAgentPrompt(PAYLOAD, "aieng", db, "appr-v1");
    insertPendingAgentPrompt(PAYLOAD, "aieng", db, "appr-v2");

    // Владелец одобряет ВТОРУЮ. До аудита applied_at по ASC вставал на первую.
    handleUpdateAgentPromptApproved(PAYLOAD, {
      agentKey: "owner",
      chatId: -1,
      approvalId: "appr-v2",
    });

    const [v1, v2] = rows();
    expect(v1!.applied_at).toBe(null);
    expect(v2!.applied_at).not.toBe(null);
  });

  test("без id заявки поведение прежнее — ASC-порядок", () => {
    // Запасной путь обязан остаться: у строк до миграции approval_id пуст.
    insertPendingAgentPrompt(PAYLOAD, "aieng", db, null);
    insertPendingAgentPrompt(PAYLOAD, "aieng", db, null);

    handleUpdateAgentPromptApproved(PAYLOAD, { agentKey: "owner", chatId: -1 });

    const [v1, v2] = rows();
    expect(v1!.applied_at).not.toBe(null);
    expect(v2!.applied_at).toBe(null);
  });

  test("id заявки, которой нет среди строк, откатывается к содержимому", () => {
    // Строка заведена до миграции, заявка решается сейчас: id есть, а строки
    // с ним нет. Вставлять новую версию в этом случае нельзя.
    insertPendingAgentPrompt(PAYLOAD, "aieng", db, null);

    handleUpdateAgentPromptApproved(PAYLOAD, {
      agentKey: "owner",
      chatId: -1,
      approvalId: "appr-которого-нет",
    });

    const all = rows();
    expect(all.length).toBe(1);
    expect(all[0]!.applied_at).not.toBe(null);
  });
});
