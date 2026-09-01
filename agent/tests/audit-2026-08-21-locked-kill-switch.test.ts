/**
 * Аудит 2026-08-21: `locked` держал дешёвое и пропускал необратимое.
 *
 * `evaluateGate` проверял режим автономии ПОСЛЕ двух ранних возвратов —
 * `forceApproval` и `ALWAYS_APPROVE_ACTIONS`. Оба уходили раньше, чем
 * `getAutonomy` вообще вызывался, так что рубильник не применялся ровно к тому
 * набору действий, ради которого его и дёргают. Замер на чате в `locked`:
 *
 *   SEND_MESSAGE          обычное         → deny      остановлено
 *   GRANT_PERMISSION      ALWAYS_APPROVE  → approval  ВЫПОЛНИТСЯ
 *   UPDATE_AGENT_PROMPT   ALWAYS_APPROVE  → approval  ВЫПОЛНИТСЯ
 *   REVIEW_AND_MERGE_PR   ALWAYS_APPROVE  → approval  ВЫПОЛНИТСЯ
 *   SPAWN_ROLE            ALWAYS_APPROVE  → approval  ВЫПОЛНИТСЯ
 *   MAC_RUN_CLAUDE        ALWAYS_APPROVE  → approval  ВЫПОЛНИТСЯ
 *   PUBLISH_TO_CHANNEL    ALWAYS_APPROVE  → approval  ВЫПОЛНИТСЯ
 *
 * Владелец выключает чат и получает обратное задуманному: обычное сообщение
 * встаёт, а выдача прав, смена системного промпта, мерж в main, запуск роли,
 * запуск claude на его машине и пост подписчикам канала — проходят.
 *
 * Второй половиной дефект доезжал до исполнения. `executeApproved`
 * (commands.ts:183) при нажатии «Approve» перепроверяет гейт и берёт ТОЛЬКО
 * deny-слои — «апрув здесь уже удовлетворён». Карточка, созданная до
 * блокировки, у обычного действия упиралась в `blocked at execution`, а у
 * ALWAYS_APPROVE не упиралась ни во что: до `locked` вызов не доходил.
 *
 * Прецедент внутри того же файла: аудит 2026-08-10 перенёс READONLY_ACTIONS
 * (ныне LOW_FRICTION_ACTIONS) ПОД `locked` с формулировкой «`locked` означает
 * ровно одно — эта роль не действует». Тогда починили COMMENT_TASK; здесь то
 * же самое доделано для остальных.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { evaluateGate, setAutonomy, ALWAYS_APPROVE_ACTIONS, type ActionType } from "../lib/permissions.ts";
import { db } from "../lib/db.ts";

const CHAT = -1_000_821;
/** Роли берём реальные — те, кому эти действия и выдаются в проде. */
const CASES: Array<[string, ActionType]> = [
  ["perm", "GRANT_PERMISSION"],
  ["aieng", "UPDATE_AGENT_PROMPT"],
  ["perm", "CHANGE_AGENT_STATUS"],
  ["orchestrator", "REVIEW_AND_MERGE_PR"],
  ["orchestrator", "SPAWN_ROLE"],
  ["orchestrator", "MAC_RUN_CLAUDE"],
  ["smm", "PUBLISH_TO_CHANNEL"],
];

/**
 * Готовим состояние в beforeEach, а не в beforeAll: `tests/_setup.ts` сбрасывает
 * `autonomy_modes` и восстанавливает `permissions` перед КАЖДЫМ тестом (T-812),
 * так что разовая подготовка не доживает до второго случая. Убирать за собой не
 * нужно по той же причине.
 */
function arm() {
  const up = db.prepare(
    `INSERT OR REPLACE INTO permissions (agent_key, action_type, allowed, requires_approval) VALUES (?,?,1,0)`,
  );
  for (const [a, t] of CASES) up.run(a, t);
}

beforeEach(() => {
  arm();
  setAutonomy("chat", String(CHAT), "locked");
});

describe("locked — рубильник, а не просьба подтвердить", () => {
  for (const [agent, action] of CASES) {
    test(`${action} (${agent}) → deny`, () => {
      const d = evaluateGate({ agentKey: agent, actionType: action, chatId: CHAT });
      expect(d.decision).toBe("deny");
      if (d.decision === "deny") expect(d.reason).toContain("locked");
    });
  }

  test("все семь — из ALWAYS_APPROVE_ACTIONS, то есть покрыт весь набор", () => {
    for (const [, a] of CASES) expect(ALWAYS_APPROVE_ACTIONS.has(a)).toBe(true);
    // Набор в коде мог вырасти — тогда этот тест должен вырасти вместе с ним.
    expect(ALWAYS_APPROVE_ACTIONS.size).toBe(CASES.length);
  });

  test("forceApproval (owner-voice via_userbot) тоже не обходит", () => {
    // Отправка от лица владельца — это всё ещё действие агента, а `locked`
    // говорит, что агент не действует.
    const d = evaluateGate({
      agentKey: "smm",
      actionType: "SEND_MESSAGE",
      chatId: CHAT,
      forceApproval: true,
      forceApprovalReason: "owner voice",
    });
    expect(d.decision).toBe("deny");
  });
});

describe("вне locked ничего не поменялось", () => {
  const OTHER = -1_000_822;

  test("в auto ALWAYS_APPROVE по-прежнему требует апрув, а не проходит молча", () => {
    setAutonomy("chat", String(OTHER), "auto");
    const d = evaluateGate({ agentKey: "perm", actionType: "GRANT_PERMISSION", chatId: OTHER });
    expect(d.decision).toBe("approval");
    if (d.decision === "approval") expect(d.reason).toContain("always-approve");
  });

  test("в manual forceApproval по-прежнему даёт approval", () => {
    setAutonomy("chat", String(OTHER), "manual");
    const d = evaluateGate({
      agentKey: "smm",
      actionType: "SEND_MESSAGE",
      chatId: OTHER,
      forceApproval: true,
      forceApprovalReason: "owner voice",
    });
    expect(d.decision).toBe("approval");
    if (d.decision === "approval") expect(d.reason).toContain("owner voice");
  });
});
