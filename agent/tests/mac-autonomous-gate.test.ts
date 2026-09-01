/**
 * Owner opt-in: MAC_RUN_CLAUDE без approval при MAC_AUTONOMOUS=true И autonomy=auto.
 * Дефолт (флаг выкл) — approval. semi_auto — всё равно approval. Чужая роль — deny.
 */
import { describe, test, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import { evaluateGate, setPermission, setAutonomy } from "../lib/permissions.ts";
import { savePermissions } from "./_helpers.ts";

const CHAT = -1_000_999;
const gate = (over = {}) =>
  evaluateGate({ agentKey: "orchestrator", actionType: "MAC_RUN_CLAUDE", chatId: CHAT, ...over });

let savedEnv: string | undefined;
// Права возвращаются вместе с env: строка orchestrator/MAC_RUN_CLAUDE иначе
// оставалась переписанной до конца прогона. T-751.
let restorePerms: () => void;
beforeAll(() => {
  savedEnv = process.env.MAC_AUTONOMOUS;
  restorePerms = savePermissions([["orchestrator", "MAC_RUN_CLAUDE"]]);
});
// T-812: снимок снимается ОДИН раз на файл, а право ставится перед КАЖДЫМ
// тестом. Глобальный beforeEach в `_setup.ts` возвращает `permissions` к
// посеянному состоянию, как только какой-нибудь тест её сдвинул, — и снёс бы
// разовую установку из beforeAll. Здесь это пока совпадало с посевом, но
// полагаться на совпадение значит ждать красного файла при первой же правке
// миграции 007.
beforeEach(() => {
  setPermission("orchestrator", "MAC_RUN_CLAUDE", { allowed: true, requires_approval: true });
});
afterAll(() => {
  restorePerms();
  if (savedEnv === undefined) delete process.env.MAC_AUTONOMOUS;
  else process.env.MAC_AUTONOMOUS = savedEnv;
});

describe("MAC autonomous gate", () => {
  test("флаг ВЫКЛ + auto → approval (безопасный дефолт)", () => {
    delete process.env.MAC_AUTONOMOUS;
    setAutonomy("chat", String(CHAT), "auto");
    expect(gate().decision).toBe("approval");
  });
  test("флаг ВКЛ + auto → allow (автономно)", () => {
    process.env.MAC_AUTONOMOUS = "true";
    setAutonomy("chat", String(CHAT), "auto");
    expect(gate().decision).toBe("allow");
  });
  test("флаг ВКЛ + semi_auto → approval (только auto разрешает)", () => {
    process.env.MAC_AUTONOMOUS = "true";
    setAutonomy("chat", String(CHAT), "semi_auto");
    expect(gate().decision).toBe("approval");
  });
  test("флаг ВКЛ, но не-orchestrator → deny (CALLER_RESTRICTED цел)", () => {
    process.env.MAC_AUTONOMOUS = "true";
    setAutonomy("chat", String(CHAT), "auto");
    expect(gate({ agentKey: "backend" }).decision).toBe("deny");
  });
});
