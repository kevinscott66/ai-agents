/**
 * Аудит 2026-09-11: отказ от правки промпта искал свою строку по содержимому,
 * хотя точный ключ был у него в аргументах.
 *
 * Круг 2026-09-10 перевёл на `approval_id` только ОДНУ половину решения —
 * применение (`handleUpdateAgentPromptApproved`). Отказ получал `approvalId`
 * и тратил его на строку `audit_logs` и warn, а саму версию по-прежнему
 * выбирал `agent_key + prompt + reason ORDER BY version ASC`. Миграция 050
 * заводилась ровно против этого способа сопоставления — и её докстрока
 * (migrations.ts) называет обе функции поимённо.
 *
 * Чем это плохо на практике. Два одинаковых предложения — обычный повтор
 * после «зависшей» первой заявки; по тексту они неразличимы. Владелец решает
 * очередь не по порядку (в Mini App это одно нажатие) — и отказ встаёт не на
 * ту версию. Дальше рушится и вторая половина: одобрение своей строки уже не
 * находит (она помечена `rejected_at`), уходит в запасной путь по содержимому
 * и штампует `applied_at` на версию, чью заявку только что отклонили.
 * `GET_PROMPT_HISTORY` — единственный след правок system prompt'ов — показывает
 * оба решения перевёрнутыми.
 *
 * Запасной путь по содержимому проверяется отдельно: у строк, заведённых до
 * миграции 050, `approval_id` пуст, и поведение для них меняться не должно.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { db } from "../lib/db.ts";
import {
  insertPendingAgentPrompt,
  handleUpdateAgentPromptApproved,
  handleUpdateAgentPromptRejected,
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

interface Row {
  version: number;
  applied_at: number | null;
  rejected_at: number | null;
  approval_id: string | null;
}

function rows(): Row[] {
  return db
    .prepare(
      `SELECT version, applied_at, rejected_at, approval_id FROM agent_prompts
       WHERE agent_key=? ORDER BY version ASC`,
    )
    .all(AGENT) as Row[];
}

function reject(approvalId: string): void {
  handleUpdateAgentPromptRejected({
    payload: PAYLOAD,
    decidedBy: "owner",
    requestedBy: "aieng",
    approvalId,
    chatId: -1,
    reason: "не сейчас",
  });
}

describe("отказ от правки промпта находит строку по id заявки", () => {
  beforeEach(() => {
    db.prepare(`DELETE FROM agent_prompts WHERE agent_key=?`).run(AGENT);
  });

  test("отказ не по порядку помечает ту версию, которую отклонили", () => {
    insertPendingAgentPrompt(PAYLOAD, "aieng", db, "appr-v1");
    insertPendingAgentPrompt(PAYLOAD, "aieng", db, "appr-v2");

    // Владелец отклоняет ВТОРУЮ. До правки ASC ставил rejected_at на первую.
    reject("appr-v2");

    const [v1, v2] = rows();
    expect(v1.rejected_at).toBeNull();
    expect(v2.rejected_at).not.toBeNull();
    expect(v2.approval_id).toBe("appr-v2");
  });

  test("после отказа не по порядку одобрение первой заявки не переворачивается", () => {
    insertPendingAgentPrompt(PAYLOAD, "aieng", db, "appr-v1");
    insertPendingAgentPrompt(PAYLOAD, "aieng", db, "appr-v2");

    // Полный сценарий развала: сначала отказ второй, потом одобрение первой.
    reject("appr-v2");
    handleUpdateAgentPromptApproved(PAYLOAD, {
      agentKey: "owner",
      chatId: -1,
      approvalId: "appr-v1",
    });

    const [v1, v2] = rows();
    // Одобрена заявка A → применена её версия, не чужая.
    expect(v1.applied_at).not.toBeNull();
    expect(v1.rejected_at).toBeNull();
    // Отклонена заявка B → отказ на её версии, и применённой она не стала.
    expect(v2.rejected_at).not.toBeNull();
    expect(v2.applied_at).toBeNull();
    // Ни одна из двух половин решения не завела третью версию.
    expect(rows()).toHaveLength(2);
  });

  test("без approval_id в строке отбор остаётся прежним (ASC)", () => {
    // Строки до миграции 050: ключа связи нет, работает запасной путь.
    insertPendingAgentPrompt(PAYLOAD, "aieng", db, null);
    insertPendingAgentPrompt(PAYLOAD, "aieng", db, null);

    reject("appr-неизвестная");

    const [v1, v2] = rows();
    expect(v1.rejected_at).not.toBeNull();
    expect(v2.rejected_at).toBeNull();
  });

  test("неизвестный id заявки не заводит строк и не молчит", () => {
    insertPendingAgentPrompt(PAYLOAD, "aieng", db, "appr-v1");

    // id, которого нет ни в одной строке: точного совпадения нет, запасной
    // путь по содержимому находит единственную ждущую версию.
    reject("appr-чужая");

    const all = rows();
    expect(all).toHaveLength(1);
    expect(all[0].rejected_at).not.toBeNull();
  });
});
