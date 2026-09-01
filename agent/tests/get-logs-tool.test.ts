/**
 * T-715 (2026-06-10): GET_LOGS — read-only доступ агентов к audit-логу.
 * Безопасность by-design: структурированный agent_actions, проекция без
 * payload/result (нет секретов/переписки), фильтр по status='error'.
 *
 * Аудит 2026-08-20: фильтры agentKey/status теперь валидируются по закрытым
 * множествам. Сид переехал с синтетического `gl-test` на настоящую роль
 * `design` — именно потому, что несуществующий ключ больше не «просто пустая
 * выборка», а ошибка. Область чистится по chat_id, который уникален для файла.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { executeTool } from "../lib/tools-schema.ts";
import { logAction } from "../lib/audit.ts";
import { db } from "../lib/db.ts";

const CHAT = -1_000_715;
const CTX = { agentKey: "qa", chatId: CHAT };

describe("GET_LOGS", () => {
  beforeEach(() => {
    db.prepare("DELETE FROM agent_actions WHERE chat_id = ?").run(CHAT);
    logAction({ agentKey: "design", actionType: "SEND_MESSAGE", status: "ok", chatId: CHAT });
    logAction({
      agentKey: "design",
      actionType: "DELETE_MESSAGE",
      status: "error",
      chatId: CHAT,
      error: "boom",
    });
  });

  test("возвращает компактные записи без payload", async () => {
    const out = JSON.parse(
      await executeTool("GET_LOGS", { agentKey: "design", limit: 10 }, CTX),
    );
    expect(out.ok).toBe(true);
    expect(out.count).toBeGreaterThanOrEqual(2);
    const rec = out.logs[0];
    expect(rec.agent).toBe("design");
    expect("payload" in rec).toBe(false);
    expect("result" in rec).toBe(false);
  });

  test("фильтр status='error' возвращает только сбои", async () => {
    const out = JSON.parse(
      await executeTool("GET_LOGS", { agentKey: "design", status: "error" }, CTX),
    );
    expect(out.ok).toBe(true);
    expect(out.logs.every((l: { status: string }) => l.status === "error")).toBe(true);
    expect(out.logs[0].error).toBe("boom");
  });

  test("limit зажимается в 1..50", async () => {
    const out = JSON.parse(await executeTool("GET_LOGS", { limit: 9999 }, CTX));
    expect(out.ok).toBe(true);
    expect(out.logs.length).toBeLessThanOrEqual(50);
  });

  // --- Аудит 2026-08-20: опечатка в фильтре — ошибка, а не «ничего не было» ---

  test("несуществующая роль отвергается, а не отдаёт пустой список", async () => {
    // `designer` — ровно то, что напишет модель: роль называется `design`.
    const out = JSON.parse(
      await executeTool("GET_LOGS", { agentKey: "designer" }, CTX),
    );
    expect(out.ok).toBe(false);
    expect(out.error).toContain("unknown agentKey");
    // В сообщении есть подсказка с допустимыми ключами.
    expect(out.error).toContain("design");
    expect(out.count).toBeUndefined();
  });

  test("несуществующий статус отвергается, а не отдаёт пустой список", async () => {
    // `failed` — как «неуспех» называется в большинстве API; здесь это `error`.
    const out = JSON.parse(
      await executeTool("GET_LOGS", { agentKey: "design", status: "failed" }, CTX),
    );
    expect(out.ok).toBe(false);
    expect(out.error).toContain("unknown status");
    expect(out.error).toContain("error");
    expect(out.count).toBeUndefined();
  });

  test("все шесть валидных статусов проходят валидацию", async () => {
    for (const s of [
      "attempted",
      "ok",
      "error",
      "forbidden",
      "pending_approval",
      "rate_limited",
    ]) {
      const out = JSON.parse(await executeTool("GET_LOGS", { status: s }, CTX));
      expect(out.ok).toBe(true);
    }
  });

  test("пустые/пробельные фильтры — это «без фильтра», не ошибка", async () => {
    const out = JSON.parse(
      await executeTool("GET_LOGS", { agentKey: "   ", status: "" }, CTX),
    );
    expect(out.ok).toBe(true);
    expect(out.count).toBeGreaterThanOrEqual(2);
  });
});
