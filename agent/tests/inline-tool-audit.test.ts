/**
 * Каждый вызов инлайновой тулзы — строка в agent_actions.
 *
 * Инцидент 2026-09-18: агент дважды получил shop_busy от Mac, а на сервере не
 * осталось ни одной записи о его вызовах SHOP_* — ни в agent_actions, ни в
 * audit_logs. Восстановить, что держало браузер, было нечем, а сам агент не
 * мог через GET_LOGS посмотреть свои сбои и просил владельца «повторить».
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { executeTool, inlineOutcome } from "../lib/tools-schema.ts";
import { _resetRateLimits } from "../lib/rate-limits.ts";
import { db } from "../lib/db.ts";

const CTX = { agentKey: "_test_inline_audit", chatId: -1_000_918 };

type Row = { action_type: string; status: string; error: string | null; payload: string | null; result: string | null };
const rows = () =>
  db
    .prepare(`SELECT action_type, status, error, payload, result FROM agent_actions WHERE agent_key = ? ORDER BY created_at`)
    .all(CTX.agentKey) as Row[];

const clean = () => db.prepare(`DELETE FROM agent_actions WHERE agent_key = ?`).run(CTX.agentKey);

beforeEach(() => {
  _resetRateLimits();
  clean();
});
afterEach(() => {
  _resetRateLimits();
  clean();
});

describe("итог инлайновой тулзы", () => {
  test("ok, код отказа, текст отказа, не-JSON", () => {
    expect(inlineOutcome(JSON.stringify({ ok: true, state: "delivering" }))).toEqual({ ok: true, error: null });
    expect(inlineOutcome(JSON.stringify({ ok: false, code: "shop_busy" }))).toEqual({ ok: false, error: "shop_busy" });
    expect(inlineOutcome(JSON.stringify({ ok: false, error: "forbidden: нет" }))).toEqual({ ok: false, error: "forbidden: нет" });
    expect(inlineOutcome(JSON.stringify({ error: "bad" }))).toEqual({ ok: false, error: "bad" });
    expect(inlineOutcome("просто текст")).toEqual({ ok: true, error: null });
  });
});

describe("аудит инлайновых вызовов", () => {
  test("успех и отказ пишутся строкой ok/error без входа", async () => {
    await executeTool("READ_WIKI", { scope: "_team", slug: "нет-такой-страницы" }, CTX);
    await executeTool("GET_LOGS", { limit: 1 }, CTX);
    const got = rows();
    expect(got.map((r) => r.action_type)).toEqual(["READ_WIKI", "GET_LOGS"]);
    expect(got[0]!.status).toBe("error");
    expect(got[1]!.status).toBe("ok");
    for (const r of got) {
      expect(r.payload ?? "{}").not.toContain("нет-такой-страницы");
      expect(JSON.parse(r.result ?? "{}").ms).toBeGreaterThanOrEqual(0);
    }
  });

  test("агент видит свой сбой через GET_LOGS status=error", async () => {
    await executeTool("READ_WIKI", { scope: "_team", slug: "нет-такой-страницы" }, CTX);
    const out = JSON.parse(await executeTool("GET_LOGS", { status: "error", limit: 5 }, CTX));
    expect(out.ok).toBe(true);
    expect(out.logs.some((l: { action: string }) => l.action === "READ_WIKI")).toBe(true);
  });

  test("гейтованные тулзы этой обёрткой не пишутся", async () => {
    await executeTool("NO_SUCH_TOOL", {}, CTX);
    expect(rows().filter((r) => r.action_type === "NO_SUCH_TOOL")).toEqual([]);
  });
});
