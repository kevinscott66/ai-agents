/**
 * Аудит 2026-08-12: три выхода gateOrDispatch писали строку аудита без
 * request_id.
 *
 * T-410 заводил request_id ради одного: собрать все действия ОДНОГО хода в
 * группу («что ещё произошло в том же запросе»). Соседние выходы того же
 * тела — forbidden, pending_approval, ok, ошибка dispatchAndAudit — id
 * передают. Не передавали ровно три, и все три — про отказ:
 *
 *   - невалидный payload (GRANT_PERMISSION / CHANGE_AGENT_STATUS /
 *     UPDATE_AGENT_PROMPT / CREATE_DIAGNOSTIC_TASK),
 *   - падение insertPendingAgentPrompt на approval-пути,
 *   - проигрыш гонки за слот рейт-лимита (status = rate_limited).
 *
 * То есть корреляция терялась именно на разборе инцидента: «покажи всё, что
 * этот ход сделал» не показывало отказов, из-за которых ход и разбирают.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { gateOrDispatch } from "../lib/action-dispatch.ts";
import { db } from "../lib/db.ts";
import { cleanupChat } from "./_helpers.ts";

const TEST_CHAT = 999_410_002;
const AGENT = "orchestrator";

afterEach(() => {
  db.prepare(`DELETE FROM agent_actions WHERE chat_id = ?`).run(TEST_CHAT);
  cleanupChat(TEST_CHAT, AGENT);
});

describe("request_id на путях отказа", () => {
  test("невалидный payload пишет строку аудита с request_id", async () => {
    const requestId = "req_test_0410";
    const res = await gateOrDispatch(
      "CREATE_DIAGNOSTIC_TASK",
      { action_type: "" } as any,
      { agentKey: AGENT, chatId: TEST_CHAT, requestId },
    );
    expect(res.kind).toBe("error");
    const row = db
      .prepare(
        `SELECT request_id, status FROM agent_actions
         WHERE chat_id = ? ORDER BY rowid DESC LIMIT 1`,
      )
      .get(TEST_CHAT) as { request_id: string | null; status: string };
    expect(row.status).toBe("error");
    expect(row.request_id).toBe(requestId);
  });
});

describe("структура", () => {
  test("ни один logAction в диспетчере не пишет строку без request_id", () => {
    // Правило, применённое к части вызовов, — это не правило: так три выхода
    // из семи и оказались без корреляции.
    const src = readFileSync(
      new URL("../lib/action-dispatch.ts", import.meta.url),
      "utf8",
    );
    const calls = [...src.matchAll(/logAction\(\{/g)];
    expect(calls.length).toBeGreaterThan(0);
    const missing: number[] = [];
    for (const m of calls) {
      // Тело объектного литерала до закрывающей `})`: вложенных объектов в
      // этих вызовах нет.
      const start = m.index! + m[0].length;
      const body = src.slice(start, src.indexOf("})", start));
      if (!/\brequestId\b/.test(body)) {
        missing.push(src.slice(0, m.index!).split("\n").length);
      }
    }
    expect(missing).toEqual([]);
  });
});
