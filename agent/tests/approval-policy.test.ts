/**
 * Политика владельца: деньги, DNS, main, удаление, выключение и сообщения
 * третьим лицам — только с подтверждением, при любой автономии.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { approvalCategories } from "../lib/approval-policy.ts";
import { evaluateGate, payloadForcesApproval, setAutonomy, setPermission, type ActionType } from "../lib/permissions.ts";
import { savePermissions } from "./_helpers.ts";

const run = (prompt: string, mode = "accept_edits") => approvalCategories("MAC_RUN_CLAUDE", { project: "/p", prompt, mode });

describe("categories", () => {
  test("fixed actions and flags", () => {
    expect(approvalCategories("DELETE_MESSAGE", {})).toEqual(["delete"]);
    expect(approvalCategories("DELETE_MESSAGE", { via_userbot: true })).toEqual(["delete", "third_party_message"]);
    expect(approvalCategories("SEND_MESSAGE", { via_userbot: true })).toEqual(["third_party_message"]);
    expect(approvalCategories("SEND_MESSAGE", { text: "hi" })).toEqual([]);
    expect(approvalCategories("REVIEW_AND_MERGE_PR", {})).toEqual(["push_main"]);
    expect(approvalCategories("ORDER_FOOD", {})).toEqual(["money"]);
    expect(approvalCategories("CLOUDFLARE_DNS", {})).toEqual(["dns"]);
    expect(approvalCategories("MAC_CONTROL", { command: "restart" })).toEqual(["shutdown"]);
    expect(approvalCategories("MAC_CONTROL", { command: "lock" })).toEqual([]);
  });

  test("Mac prompts: dangerous asks are caught, ordinary work is not", () => {
    expect(run("сделай git push origin main")).toEqual(["push_main"]);
    expect(run("запушь в main")).toEqual(["push_main"]);
    expect(run("git push origin feature/x")).toEqual([]);
    expect(run("rm -rf build и удали старые логи")).toEqual(["delete"]);
    expect(run("поменяй A-запись в Cloudflare")).toEqual(["dns"]);
    expect(run("оплати подписку")).toEqual(["money"]);
    expect(run("sudo shutdown -h now")).toEqual(["shutdown"]);
    expect(run("отправь сообщение Пете")).toEqual(["third_party_message"]);
    expect(run("почини тест в agent/tests и прогони bun test")).toEqual([]);
    expect(run("оплати подписку", "plan")).toEqual([]);
  });
});

describe("gate", () => {
  const CHAT = -1_000_777;
  let saved: string | undefined;
  let restorePerms: () => void;
  beforeAll(() => {
    saved = process.env.MAC_AUTONOMOUS;
    process.env.MAC_AUTONOMOUS = "true";
    restorePerms = savePermissions([["orchestrator", "MAC_RUN_CLAUDE"], ["orchestrator", "MAC_CONTROL"]]);
  });
  // _setup.ts возвращает permissions к посеву перед каждым тестом — ставим заново.
  beforeEach(() => {
    setAutonomy("chat", String(CHAT), "auto");
    setPermission("orchestrator", "MAC_RUN_CLAUDE", { allowed: true, requires_approval: true });
    setPermission("orchestrator", "MAC_CONTROL", { allowed: true, requires_approval: false });
  });
  afterAll(() => { restorePerms(); if (saved === undefined) delete process.env.MAC_AUTONOMOUS; else process.env.MAC_AUTONOMOUS = saved; });

  const decide = (actionType: ActionType, payload: unknown) => {
    const reason = payloadForcesApproval(actionType, payload);
    return evaluateGate({ agentKey: "orchestrator", actionType, chatId: CHAT, forceApproval: reason !== null, ...(reason ? { forceReason: reason } : {}) } as never).decision;
  };

  test("MAC_AUTONOMOUS + auto still asks for push to main", () => {
    expect(decide("MAC_RUN_CLAUDE", { project: "/p", prompt: "почини тест", mode: "accept_edits" })).toBe("allow");
    expect(decide("MAC_RUN_CLAUDE", { project: "/p", prompt: "git push origin main", mode: "accept_edits" })).toBe("approval");
  });

  test("lock goes, shutdown asks", () => {
    expect(decide("MAC_CONTROL", { command: "lock" })).toBe("allow");
    expect(decide("MAC_CONTROL", { command: "shutdown" })).toBe("approval");
  });

  test("reason names the category", () => {
    expect(payloadForcesApproval("MAC_CONTROL", { command: "shutdown" })).toContain("выключение");
  });
});
