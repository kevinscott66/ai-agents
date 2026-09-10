/**
 * T-545: Tests for trigger anti-duplication logic.
 * Ensures the same (chat_id, tg_message_id) trigger doesn't process twice within N seconds.
 */

import { beforeEach, test, expect, describe } from "bun:test";
import { db } from "../lib/db.ts";
import { shouldProcessTrigger, getTriggerStats } from "../lib/trigger-anti-dup.ts";

describe("T-545: Trigger Anti-Duplication", () => {
  beforeEach(() => {
    // Clean slate for each test
    db.prepare("DELETE FROM processed_triggers").run();
  });

  test("should process new trigger message", () => {
    const chatId = "12345";
    const tgMessageId = 67890;

    const result = shouldProcessTrigger(chatId, tgMessageId, "orchestrator");
    
    expect(result).toBe(true);
    
    // Verify it was recorded
    const recorded = db.prepare(`
      SELECT COUNT(*) as count FROM processed_triggers 
      WHERE chat_id = ? AND tg_message_id = ?
    `).get(chatId, tgMessageId) as { count: number };
    
    expect(recorded.count).toBe(1);
  });

  test("should reject duplicate trigger within window", () => {
    const chatId = "12345";
    const tgMessageId = 67890;

    // First processing should succeed
    const first = shouldProcessTrigger(chatId, tgMessageId, "orchestrator");
    expect(first).toBe(true);

    // Second processing should be rejected as duplicate
    const second = shouldProcessTrigger(chatId, tgMessageId, "orchestrator");
    expect(second).toBe(false);
  });

  test("should allow same message ID in different chats", () => {
    const chatId1 = "12345";
    const chatId2 = "67890";
    const tgMessageId = 999;

    const result1 = shouldProcessTrigger(chatId1, tgMessageId, "orchestrator");
    expect(result1).toBe(true);

    // Same message ID but different chat should be allowed
    const result2 = shouldProcessTrigger(chatId2, tgMessageId, "orchestrator");
    expect(result2).toBe(true);
  });

  test("should allow same chat with different message IDs", () => {
    const chatId = "12345";
    const tgMessageId1 = 111;
    const tgMessageId2 = 222;

    const result1 = shouldProcessTrigger(chatId, tgMessageId1, "orchestrator");
    expect(result1).toBe(true);

    // Same chat but different message ID should be allowed
    const result2 = shouldProcessTrigger(chatId, tgMessageId2, "orchestrator");
    expect(result2).toBe(true);
  });

  test("should always process when tgMessageId is undefined", () => {
    const chatId = "12345";

    // Should process when no message ID
    const result1 = shouldProcessTrigger(chatId, undefined, "orchestrator");
    expect(result1).toBe(true);

    // Should process again even for same chat (no dedup without message ID)
    const result2 = shouldProcessTrigger(chatId, undefined, "orchestrator");
    expect(result2).toBe(true);
  });

  test("should clean up old entries", () => {
    const chatId = "12345";
    const tgMessageId1 = 111;
    const tgMessageId2 = 222;

    // Insert an old record manually (simulate past processing)
    const oldTimestamp = Math.floor(Date.now() / 1000) - 120; // 2 minutes ago
    db.prepare(`
      INSERT INTO processed_triggers (chat_id, tg_message_id, agent_key, processed_at)
      VALUES (?, ?, 'orchestrator', ?)
    `).run(chatId, tgMessageId1, oldTimestamp);

    // Process new trigger - this should clean up the old entry
    shouldProcessTrigger(chatId, tgMessageId2, "orchestrator");

    // Old entry should be gone
    const oldExists = db.prepare(`
      SELECT COUNT(*) as count FROM processed_triggers 
      WHERE chat_id = ? AND tg_message_id = ?
    `).get(chatId, tgMessageId1) as { count: number };
    
    expect(oldExists.count).toBe(0);

    // New entry should exist
    const newExists = db.prepare(`
      SELECT COUNT(*) as count FROM processed_triggers 
      WHERE chat_id = ? AND tg_message_id = ?
    `).get(chatId, tgMessageId2) as { count: number };
    
    expect(newExists.count).toBe(1);
  });

  test("should allow reprocessing after window expires", () => {
    const chatId = "12345";
    const tgMessageId = 67890;

    // First processing should succeed
    const first = shouldProcessTrigger(chatId, tgMessageId, "orchestrator");
    expect(first).toBe(true);

    // Manually update the timestamp to simulate expired window
    const expiredTimestamp = Math.floor(Date.now() / 1000) - 120; // 2 minutes ago
    db.prepare(`
      UPDATE processed_triggers 
      SET processed_at = ? 
      WHERE chat_id = ? AND tg_message_id = ?
    `).run(expiredTimestamp, chatId, tgMessageId);

    // Should now allow processing again
    const second = shouldProcessTrigger(chatId, tgMessageId, "orchestrator");
    expect(second).toBe(true);
  });

  test("should handle race condition gracefully", () => {
    // This test verifies the INSERT OR IGNORE behavior
    const chatId = "12345";
    const tgMessageId = 67890;
    const now = Math.floor(Date.now() / 1000);

    // Manually insert a record to simulate race condition
    db.prepare(`
      INSERT INTO processed_triggers (chat_id, tg_message_id, agent_key, processed_at)
      VALUES (?, ?, 'orchestrator', ?)
    `).run(chatId, tgMessageId, now);

    // Should return false (duplicate detected)
    const result = shouldProcessTrigger(chatId, tgMessageId, "orchestrator");
    expect(result).toBe(false);
  });

  // Аудит 2026-08-20: прежний тест здесь вставлял строки «30 минут назад» и
  // «2 дня назад» напрямую и проверял, что lastHour=2, lastDay=3. Он проверял
  // арифметику SQL в мире, которого в проде не бывает: shouldProcessTrigger
  // при каждом вызове сносит всё старше 60 секунд, поэтому окна в час и в
  // сутки ненаблюдаемы. Поля убраны, тест переписан на реальный контракт.
  test("getTriggerStats считает окно дедупа, а не выдуманные час и сутки", () => {
    const now = Math.floor(Date.now() / 1000);

    db.prepare(`
      INSERT INTO processed_triggers (chat_id, tg_message_id, agent_key, processed_at)
      VALUES
        ('123', 1, 'orchestrator', ?),
        ('123', 2, 'orchestrator', ?),
        ('123', 3, 'orchestrator', ?),
        ('123', 4, 'orchestrator', ?)
    `).run(
      now,
      now - 30,      // внутри окна
      now - 7200,    // 2 часа назад — вне окна, но ещё не подметено
      now - 172800   // 2 дня назад — вне окна, но ещё не подметено
    );

    const stats = getTriggerStats();

    expect(stats.windowSeconds).toBe(60);
    expect(stats.inWindow).toBe(2);
    // Уборка ленивая: строки вне окна живут до следующего shouldProcessTrigger.
    expect(stats.total).toBe(4);
  });
});