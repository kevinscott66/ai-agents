/**
 * C6B: команды модерации Lead-бота — /grant, /revoke, /perms, /audit, /approvals.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import {
  cmdGrant,
  cmdRevoke,
  cmdPerms,
  cmdAudit,
  cmdApprovals,
} from "../lib/commands.ts";
import {
  getPermission,
  setPermission,
  type Permission,
} from "../lib/permissions.ts";
import { createApproval } from "../lib/approvals.ts";

const TEST_CHAT = -1_000_888;

const restores: Array<() => void> = [];

function snapshot(agent: string, action: any): () => void {
  const p = getPermission(agent, action);
  return () => setPermission(agent, action, p);
}

afterEach(() => {
  while (restores.length) restores.pop()!();
  db.prepare(`DELETE FROM approvals WHERE chat_id = ?`).run(TEST_CHAT);
});

describe("cmdGrant / cmdRevoke", () => {
  test("grant qa DELETE_MESSAGE auto", () => {
    restores.push(snapshot("qa", "DELETE_MESSAGE"));
    const out = cmdGrant({ args: ["qa", "DELETE_MESSAGE", "auto"] });
    expect(out).toContain("qa.DELETE_MESSAGE");
    const p = getPermission("qa", "DELETE_MESSAGE");
    expect(p.allowed).toBe(true);
    expect(p.requires_approval).toBe(false);
  });
  test("grant qa SET_REACTION approval", () => {
    restores.push(snapshot("qa", "SET_REACTION"));
    cmdGrant({ args: ["qa", "SET_REACTION", "approval"] });
    const p = getPermission("qa", "SET_REACTION");
    expect(p.allowed).toBe(true);
    expect(p.requires_approval).toBe(true);
  });
  test("grant unknown agent → ошибка", () => {
    const out = cmdGrant({ args: ["unknown_agent", "SEND_MESSAGE"] });
    expect(out.toLowerCase()).toMatch(/неизвест|не найден/);
  });
  test("grant qa WRONG_ACTION → ошибка про action", () => {
    const out = cmdGrant({ args: ["qa", "WRONG_ACTION"] });
    expect(out.toLowerCase()).toContain("action");
  });
  test("revoke qa SET_REACTION → allowed=false", () => {
    restores.push(snapshot("qa", "SET_REACTION"));
    cmdRevoke({ args: ["qa", "SET_REACTION"] });
    const p = getPermission("qa", "SET_REACTION");
    expect(p.allowed).toBe(false);
  });
});

describe("cmdPerms", () => {
  test("без аргументов содержит pm и SEND_MESSAGE", () => {
    const out = cmdPerms({ args: [] });
    expect(out).toContain("pm");
    expect(out).toContain("SEND_MESSAGE");
  });
  test("с агентом qa содержит SET_REACTION и PIN_MESSAGE", () => {
    const out = cmdPerms({ args: ["qa"] });
    expect(out).toContain("SET_REACTION");
    expect(out).toContain("PIN_MESSAGE");
  });
});

describe("cmdAudit", () => {
  test("без аргументов — не падает", () => {
    const out = cmdAudit({ args: [] });
    expect(typeof out).toBe("string");
  });
  test("с агентом и лимитом — не падает", () => {
    const out = cmdAudit({ args: ["orchestrator", "5"] });
    expect(typeof out).toBe("string");
  });
});

describe("cmdApprovals", () => {
  test("пустой — 'нет ожидающих'", () => {
    const out = cmdApprovals({ chatId: TEST_CHAT, args: [] });
    expect(out).toContain("нет ожидающих");
  });
  test("после createApproval — строка содержит id", () => {
    const a = createApproval({
      actionId: crypto.randomUUID(),
      chatId: TEST_CHAT,
      requestedBy: "qa",
      actionType: "PIN_MESSAGE",
      payload: { messageId: 1 },
    });
    const out = cmdApprovals({ chatId: TEST_CHAT, args: [] });
    expect(out).toContain(a.id);
    expect(out).toContain("qa");
    expect(out).toContain("PIN_MESSAGE");
  });
});
