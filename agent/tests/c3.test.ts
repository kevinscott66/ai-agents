/**
 * C3: permissions-gate + autonomy overlay.
 *
 * Тесты пишут реальную БД (data/memory.db), используют выделенные test chat_id
 * и agent_key, и аккуратно восстанавливают изменённые permissions/autonomy.
 */
import { describe, test, expect, afterEach } from "bun:test";
import {
  getPermission,
  setPermission,
  setAutonomy,
  evaluateGate,
  type ActionType,
} from "../lib/permissions.ts";
import { CHARACTERS } from "../characters/index.ts";
import {
  cleanupChat,
  saveAutonomy,
  restoreAutonomy,
  savePermissions,
} from "./_helpers.ts";

const TEST_CHAT = 999_222_333;
const TEST_CHAT_OVERRIDE = -42;
const TEST_AGENT = "pm"; // используем реальную роль из сидов

const ACTION_TYPES: ActionType[] = [
  "SEND_MESSAGE",
  "CREATE_TASK",
  "ASSIGN_TASK",
  "UPDATE_TASK_STATUS",
  "REQUEST_REVIEW",
  "COMMENT_TASK",
];

// Сохранение и восстановление глобальной autonomy между тестами.
let savedGlobal = saveAutonomy();

afterEach(() => {
  restoreAutonomy(savedGlobal);
  cleanupChat(TEST_CHAT);
  cleanupChat(TEST_CHAT_OVERRIDE);
});

describe("permissions: default seed", () => {
  test("all 12 roles × 6 actions allowed=true, requires_approval=false", () => {
    expect(CHARACTERS.length).toBe(12);
    // Несколько случайных проверок.
    const samples: Array<[string, ActionType]> = [
      ["pm", "CREATE_TASK"],
      ["backend", "SEND_MESSAGE"],
      ["qa", "COMMENT_TASK"],
      ["design", "UPDATE_TASK_STATUS"],
      ["orchestrator", "ASSIGN_TASK"],
      ["smm", "REQUEST_REVIEW"],
    ];
    // Сравниваем строкой с именем пары: `expect(p.allowed).toBe(true)` в цикле
    // на 72 итерации сообщает только «Expected: true, Received: false» — какая
    // именно роль и какое действие протекли, приходится искать руками. Это
    // стоило времени при разборе order-dependency (T-751).
    const state = (agent: string, action: ActionType) => {
      const p = getPermission(agent, action);
      return `${agent}/${action}: allowed=${p.allowed} approval=${p.requires_approval}`;
    };
    const seeded = (agent: string, action: ActionType) =>
      `${agent}/${action}: allowed=true approval=false`;

    for (const [agent, action] of samples) {
      expect(state(agent, action)).toBe(seeded(agent, action));
    }
    // И — полный обход всех 12×6 для уверенности.
    for (const c of CHARACTERS) {
      for (const at of ACTION_TYPES) {
        expect(state(c.key, at)).toBe(seeded(c.key, at));
      }
    }
  });
});

describe("autonomy: global locked → deny", () => {
  test("SEND_MESSAGE denied", () => {
    savedGlobal = saveAutonomy(); // semi_auto by default
    setAutonomy("global", "*", "locked");
    const g = evaluateGate({
      agentKey: TEST_AGENT,
      actionType: "SEND_MESSAGE",
    });
    expect(g.decision).toBe("deny");
  });
});

describe("autonomy: chat override", () => {
  test("chat=auto overrides global=manual", () => {
    savedGlobal = saveAutonomy();
    setAutonomy("global", "*", "manual");
    setAutonomy("chat", String(TEST_CHAT_OVERRIDE), "auto");

    // requires_approval=false (по сиду) — в auto → allow.
    const allow = evaluateGate({
      agentKey: TEST_AGENT,
      actionType: "SEND_MESSAGE",
      chatId: TEST_CHAT_OVERRIDE,
    });
    expect(allow.decision).toBe("allow");

    // Без chatId — глобальный manual → approval.
    const appr = evaluateGate({
      agentKey: TEST_AGENT,
      actionType: "SEND_MESSAGE",
    });
    expect(appr.decision).toBe("approval");
  });
});

describe("autonomy: semi_auto", () => {
  test("SEND_MESSAGE → approval (risky)", () => {
    savedGlobal = saveAutonomy();
    setAutonomy("global", "*", "semi_auto");
    const g = evaluateGate({
      agentKey: TEST_AGENT,
      actionType: "SEND_MESSAGE",
    });
    expect(g.decision).toBe("approval");
  });

  test("CREATE_TASK + requires_approval=false → allow", () => {
    savedGlobal = saveAutonomy();
    setAutonomy("global", "*", "semi_auto");
    const g = evaluateGate({
      agentKey: TEST_AGENT,
      actionType: "CREATE_TASK",
    });
    expect(g.decision).toBe("allow");
  });

  test("CREATE_TASK + requires_approval=true → approval, restored", () => {
    savedGlobal = saveAutonomy();
    setAutonomy("global", "*", "semi_auto");
    const before = getPermission(TEST_AGENT, "CREATE_TASK");
    // Здесь строка заведомо есть (pm/CREATE_TASK — из сида миграции 007), но
    // возврат идёт через общий хелпер: правило «кто пишет права, тот и снимает
    // снимок» держится пробой test-state-isolation, и исключений в ней нет.
    const restorePerms = savePermissions([[TEST_AGENT, "CREATE_TASK"]]);
    try {
      setPermission(TEST_AGENT, "CREATE_TASK", {
        allowed: true,
        requires_approval: true,
      });
      const g = evaluateGate({
        agentKey: TEST_AGENT,
        actionType: "CREATE_TASK",
      });
      expect(g.decision).toBe("approval");
    } finally {
      restorePerms();
    }
    // Проверяем восстановление.
    const restored = getPermission(TEST_AGENT, "CREATE_TASK");
    expect(restored).toEqual(before);
  });
});
