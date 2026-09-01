/**
 * T-710..712 (2026-06-10): read-only role-tools — закрытие пробелов самоаудита.
 *  GET_BOT_INFO (tgdev), GET_METRICS (backend/aieng),
 *  LIST_SCHEDULED_POSTS + CANCEL_SCHEDULED_POST (smm).
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { executeTool } from "../lib/tools-schema.ts";
import { db } from "../lib/db.ts";

const CTX = { agentKey: "smm", chatId: -1_000_711 };

function fakeTg() {
  return {
    getMe: mock(() =>
      Promise.resolve({
        id: 42,
        username: "test_bot",
        first_name: "Test",
        can_join_groups: true,
        can_read_all_group_messages: false,
      }),
    ),
  } as never;
}

describe("GET_BOT_INFO", () => {
  test("возвращает id/username через getMe", async () => {
    const out = JSON.parse(await executeTool("GET_BOT_INFO", {}, { ...CTX, telegram: fakeTg() }));
    expect(out.ok).toBe(true);
    expect(out.id).toBe(42);
    expect(out.username).toBe("test_bot");
  });
  test("без telegram-контекста → ошибка", async () => {
    const out = JSON.parse(await executeTool("GET_BOT_INFO", {}, CTX));
    expect(out.ok).toBe(false);
  });
});

describe("GET_METRICS", () => {
  test("возвращает prometheus-текст", async () => {
    // Аудит 2026-08-28: инструмент сузили до aieng/orchestrator (шапка файла
    // всегда обещала «backend/aieng», а карта ролей его не знала вовсе), поэтому
    // здесь роль своя, а не общий smm-контекст.
    const out = JSON.parse(await executeTool("GET_METRICS", {}, { ...CTX, agentKey: "aieng" }));
    expect(out.ok).toBe(true);
    expect(out.format).toBe("prometheus");
    expect(typeof out.metrics).toBe("string");
  });
});

describe("LIST/CANCEL_SCHEDULED_POSTS", () => {
  beforeEach(() => {
    db.prepare("DELETE FROM content_calendar WHERE id LIKE 'rt-test-%'").run();
    // T-722: rows are chat-scoped → seed with CTX.chatId (-1_000_711).
    db.prepare(
      `INSERT INTO content_calendar(id, channel, scheduled_at, payload, status, created_at, chat_id)
       VALUES ('rt-test-1', '@ch', 9999999999000, '{}', 'scheduled', 1, -1000711),
              ('rt-test-2', '@ch', 9999999999000, '{}', 'scheduled', 1, -1000711)`,
    ).run();
  });

  test("LIST возвращает запланированные", async () => {
    const out = JSON.parse(await executeTool("LIST_SCHEDULED_POSTS", { channel: "@ch" }, CTX));
    expect(out.ok).toBe(true);
    expect(out.count).toBeGreaterThanOrEqual(2);
    expect(out.posts.some((p: { id: string }) => p.id === "rt-test-1")).toBe(true);
  });

  test("CANCEL помечает cancelled", async () => {
    const out = JSON.parse(await executeTool("CANCEL_SCHEDULED_POST", { id: "rt-test-1" }, CTX));
    expect(out.ok).toBe(true);
    expect(out.status).toBe("cancelled");
    const row = db
      .prepare("SELECT status FROM content_calendar WHERE id = 'rt-test-1'")
      .get() as { status: string };
    expect(row.status).toBe("cancelled");
  });

  test("CANCEL несуществующего → ошибка", async () => {
    const out = JSON.parse(await executeTool("CANCEL_SCHEDULED_POST", { id: "nope" }, CTX));
    expect(out.ok).toBe(false);
  });
});
