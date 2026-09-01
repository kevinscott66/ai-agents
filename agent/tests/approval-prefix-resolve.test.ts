/**
 * Фикс: /approve <короткий-префикс> не находил approval (оркестратор показывает
 * обрезанный id, а getApproval искал по точному совпадению).
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { resolveApproval } from "../lib/approvals.ts";
import { db } from "../lib/db.ts";

const FULL = "abcd1234-95ee-48c1-a064-0be8ef3ee794";

describe("resolveApproval (prefix)", () => {
  beforeEach(() => {
    db.prepare("DELETE FROM approvals WHERE id LIKE 'abcd1234%' OR id LIKE 'dup0%'").run();
    db.prepare(
      `INSERT INTO approvals(id, action_id, action_type, requested_by, payload, status, chat_id, created_at)
       VALUES (?, 'act1', 'MAC_RUN_CLAUDE', 'orchestrator', '{}', 'pending', -1, 1)`,
    ).run(FULL);
  });

  test("точный id — находит", () => {
    expect(resolveApproval(FULL)?.id).toBe(FULL);
  });
  test("уникальный префикс — находит полный", () => {
    expect(resolveApproval("abcd1234")?.id).toBe(FULL);
  });
  test("слишком короткий префикс (<4) — null", () => {
    expect(resolveApproval("abc")).toBeNull();
  });
  test("неизвестный префикс — null", () => {
    expect(resolveApproval("zzzzqqqq")).toBeNull();
  });
  test("неоднозначный префикс — null", () => {
    db.prepare(
      `INSERT INTO approvals(id, action_id, action_type, requested_by, payload, status, chat_id, created_at)
       VALUES ('dup0aaaa-1','a','SEND_MESSAGE','orchestrator','{}','pending',-1,1),
              ('dup0bbbb-2','b','SEND_MESSAGE','orchestrator','{}','pending',-1,1)`,
    ).run();
    expect(resolveApproval("dup0")).toBeNull();
  });
});
