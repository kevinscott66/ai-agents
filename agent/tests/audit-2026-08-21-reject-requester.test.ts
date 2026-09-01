/**
 * Аудит 2026-08-21: в записи об отказе не было того, КТО просил.
 *
 * `UPDATE_AGENT_PROMPT_REJECTED` — самая чувствительная строка журнала: правки
 * system prompt'ов влияют на поведение всех 12 ботов в проде. Строка выглядела
 * так (замер на временной базе):
 *
 *   agent_key : backend
 *   payload   : {"target_agent_key":"backend","reason":"хочу поменять",
 *                "decided_by":"12345","reject_reason":"нет"}
 *
 * Есть чей промпт, есть кто отказал и почему. Нет заказчика — и нет ни одного
 * ключа, по которому его можно было бы найти: id самого approval'а в строке
 * тоже отсутствует. `approvals.requested_by` существует и заполнен, но связи с
 * ним из журнала нет никакой, а сами approval'ы уезжают в архив по расписанию.
 *
 * Цена конкретная: system prompt роли `perm` прямым текстом велит читать
 * audit_logs при разборе денаев (см. /api/audit-logs, аудит 2026-08-08). Роль
 * приходит разбираться, видит «кто-то пытался переписать промпт backend'а, ему
 * отказали» — и на вопрос «кто» ответить не может.
 *
 * Оба вызывающих (cmdReject и POST /api/approvals/:id/decide) держат в руках
 * полную строку approval'а с `requested_by` и `id`. Поля сделаны
 * ОБЯЗАТЕЛЬНЫМИ намеренно: у этого модуля уже есть правило «проверять внутри,
 * а не у вызывающего, иначе третий путь отказа снова забудет» (аудит
 * 2026-08-08) — обязательный параметр то же правило доводит до компилятора.
 *
 * `agent_key` намеренно оставлен целевой ролью: /api/audit-logs фильтрует по
 * нему (`?agent=`), и «покажи всё про backend» должно находить попытку
 * переписать промпт backend'а. Заказчик живёт в payload, рядом с decided_by.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { db } from "../lib/db.ts";
import { auditRejectedApproval } from "../lib/dispatch/agent-prompt.ts";

const CHAT = -1_000_821;

function rows() {
  return db
    .prepare(
      `SELECT agent_key, payload FROM audit_logs
       WHERE event_type = 'UPDATE_AGENT_PROMPT_REJECTED' AND chat_id = ?`,
    )
    .all(CHAT) as Array<{ agent_key: string; payload: string }>;
}

const PAYLOAD = {
  target_agent_key: "backend",
  new_prompt: "новый промпт",
  reason: "хочу поменять",
};

beforeEach(() => {
  db.prepare(`DELETE FROM audit_logs WHERE chat_id = ?`).run(CHAT);
});

describe("отказ по правке system prompt хранит заказчика", () => {
  test("requested_by и approval_id лежат в payload", () => {
    auditRejectedApproval({
      actionType: "UPDATE_AGENT_PROMPT",
      payload: PAYLOAD,
      decidedBy: "tg:777",
      chatId: CHAT,
      reason: "нет",
      requestedBy: "pm",
      approvalId: "appr-1",
    });
    const all = rows();
    expect(all.length).toBe(1);
    const p = JSON.parse(all[0]!.payload);
    expect(p.requested_by).toBe("pm");
    expect(p.approval_id).toBe("appr-1");
  });

  test("прежние поля на месте — запись расширена, а не переписана", () => {
    auditRejectedApproval({
      actionType: "UPDATE_AGENT_PROMPT",
      payload: PAYLOAD,
      decidedBy: "miniapp:777",
      chatId: CHAT,
      reason: "не сейчас",
      requestedBy: "pm",
      approvalId: "appr-2",
    });
    const p = JSON.parse(rows()[0]!.payload);
    expect(p.target_agent_key).toBe("backend");
    expect(p.reason).toBe("хочу поменять");
    expect(p.decided_by).toBe("miniapp:777");
    expect(p.reject_reason).toBe("не сейчас");
  });

  test("agent_key остаётся целевой ролью: по нему фильтрует /api/audit-logs", () => {
    auditRejectedApproval({
      actionType: "UPDATE_AGENT_PROMPT",
      payload: PAYLOAD,
      decidedBy: "tg:777",
      chatId: CHAT,
      requestedBy: "pm",
      approvalId: "appr-3",
    });
    expect(rows()[0]!.agent_key).toBe("backend");
  });

  test("заказчик и целевая роль различимы, даже если совпали бы по смыслу", () => {
    // Роль вправе просить правку СВОЕГО промпта. Тогда обе строки равны — но
    // это должно быть видно как факт, а не как отсутствие данных.
    auditRejectedApproval({
      actionType: "UPDATE_AGENT_PROMPT",
      payload: PAYLOAD,
      decidedBy: "tg:777",
      chatId: CHAT,
      requestedBy: "backend",
      approvalId: "appr-4",
    });
    const p = JSON.parse(rows()[0]!.payload);
    expect(p.requested_by).toBe("backend");
    expect(p.target_agent_key).toBe("backend");
  });

  test("чужой тип действия по-прежнему не пишется", () => {
    auditRejectedApproval({
      actionType: "SEND_MESSAGE",
      payload: { text: "привет" },
      decidedBy: "tg:777",
      chatId: CHAT,
      requestedBy: "pm",
      approvalId: "appr-5",
    });
    expect(rows().length).toBe(0);
  });

  test("битый payload не роняет отказ — решение человека уже записано", () => {
    expect(() =>
      auditRejectedApproval({
        actionType: "UPDATE_AGENT_PROMPT",
        payload: null,
        decidedBy: "tg:777",
        chatId: CHAT,
        requestedBy: "pm",
        approvalId: "appr-6",
      }),
    ).not.toThrow();
  });
});
