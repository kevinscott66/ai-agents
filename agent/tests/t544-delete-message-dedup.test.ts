/**
 * T-544: Schlop DELETE_MESSAGE/SET_REACTION candidates by resolve-by-text
 * 
 * Tests that LIST_RECENT_MESSAGES deduplicates messages by tg_message_id
 * to prevent orchestrator from creating multiple DELETE_MESSAGE actions
 * when resolving "delete message with text X" commands.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import { dispatchAction } from "../lib/action-dispatch.ts";

const TEST_CHAT = 12345;

/** Элемент `messages` из результата LIST_RECENT_MESSAGES (см. handleListRecentMessages). */
interface RecentMessage {
  id: number;
  ts: number;
  from_name: string | null;
  is_bot: boolean;
  text_preview: string;
  agent_key?: string;
  tg_message_id: number | null;
}

/** DispatchResult.result объявлен как unknown — сужаем до формы этого хендлера. */
interface ListRecentResult {
  messages: RecentMessage[];
  count: number;
}

function seedMessage(args: {
  chatId: number;
  text: string;
  ts?: number;
  tgMessageId?: number;
  transport?: string;
  fromName?: string;
}) {
  const insertStmt = args.tgMessageId
    ? db.prepare(`
        INSERT OR IGNORE INTO messages(chat_id, agent_key, is_bot, from_user_id, from_name, text, ts, tg_message_id, transport)
        VALUES (?, 'test', 0, 'user123', ?, ?, ?, ?, ?)
      `)
    : db.prepare(`
        INSERT INTO messages(chat_id, agent_key, is_bot, from_user_id, from_name, text, ts, transport)
        VALUES (?, 'test', 0, 'user123', ?, ?, ?, ?)
      `);

  if (args.tgMessageId) {
    insertStmt.run(
      args.chatId,
      args.fromName ?? "testuser",
      args.text,
      args.ts ?? Date.now(),
      args.tgMessageId,
      args.transport ?? "bot_api"
    );
  } else {
    insertStmt.run(
      args.chatId,
      args.fromName ?? "testuser", 
      args.text,
      args.ts ?? Date.now(),
      args.transport ?? "bot_api"
    );
  }
}

function clearMessages(chatId: number) {
  db.prepare("DELETE FROM messages WHERE chat_id = ?").run(chatId);
}

describe("T-544 — DELETE_MESSAGE candidate deduplication", () => {
  beforeEach(() => {
    clearMessages(TEST_CHAT);
  });

  afterEach(() => {
    clearMessages(TEST_CHAT);
  });

  test("should deduplicate messages with same tg_message_id from different transports", async () => {
    const now = Date.now();
    
    // Simulate T-543 scenario: same logical message from both Bot API and userbot
    seedMessage({
      chatId: TEST_CHAT,
      text: "target message to delete",
      ts: now - 1000,
      tgMessageId: 42,
      transport: "bot_api",
      fromName: "Alexander | DeLabs"
    });
    
    seedMessage({
      chatId: TEST_CHAT,
      text: "target message to delete", // Same text content
      ts: now - 1000,
      tgMessageId: 42, // Same tg_message_id
      transport: "userbot",
      fromName: "dobropalm" // Different from_name (userbot vs bot_api)
    });

    // Аудит 2026-08-09: дубликат до хендлера не доживает. Миграция 030 держит
    // UNIQUE(chat_id, tg_message_id) WHERE tg_message_id IS NOT NULL, а
    // recordMessage пишет через INSERT OR IGNORE — вторая вставка молча
    // отбрасывается. То есть настоящая гарантия здесь на уровне БД, а ручной
    // цикл в handleListRecentMessages на этих данных просто не срабатывает.
    // Проверяем это явно: иначе тест утверждает дедуп там, где его нет, и
    // молча ослабнет, если индекс или OR IGNORE когда-нибудь уберут.
    const stored = db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND tg_message_id = 42`,
      )
      .get(String(TEST_CHAT)) as { n: number };
    expect(stored.n).toBe(1);

    // Add another unique message to verify normal operation
    seedMessage({
      chatId: TEST_CHAT,
      text: "other message",
      ts: now - 500,
      tgMessageId: 43,
      transport: "bot_api"
    });

    const result = await dispatchAction(
      "LIST_RECENT_MESSAGES",
      { chat_id: TEST_CHAT, kinds: ["all"], limit: 10 },
      { agentKey: "orchestrator", chatId: TEST_CHAT, userbot: null }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.result as ListRecentResult;

    // T-544: Should only return ONE message for tg_message_id=42, not two
    const targetMessages = data.messages.filter((m) =>
      m.text_preview.includes("target message to delete")
    );

    expect(targetMessages).toHaveLength(1);
    expect(targetMessages[0].tg_message_id).toBe(42);

    // Should still return the other unique message
    const otherMessages = data.messages.filter((m) =>
      m.text_preview.includes("other message")
    );
    expect(otherMessages).toHaveLength(1);
    expect(otherMessages[0].tg_message_id).toBe(43);

    // Total count should be 2 (not 3 due to deduplication)
    expect(data.messages).toHaveLength(2);
  });

  test("should preserve messages without tg_message_id (legacy compatibility)", async () => {
    const now = Date.now();

    // Legacy message without tg_message_id
    seedMessage({
      chatId: TEST_CHAT,
      text: "legacy message without tg_message_id",
      ts: now - 2000
    });

    // Another legacy message
    seedMessage({
      chatId: TEST_CHAT,
      text: "another legacy message",
      ts: now - 1500
    });

    // Modern message with tg_message_id
    seedMessage({
      chatId: TEST_CHAT,
      text: "modern message with tg_message_id",
      ts: now - 1000,
      tgMessageId: 100
    });

    const result = await dispatchAction(
      "LIST_RECENT_MESSAGES",
      { chat_id: TEST_CHAT, kinds: ["all"], limit: 10 },
      { agentKey: "orchestrator", chatId: TEST_CHAT, userbot: null }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.result as ListRecentResult;

    // Should return all 3 messages (no deduplication without tg_message_id)
    expect(data.messages).toHaveLength(3);

    // Verify tg_message_id is correctly exposed in response
    const modernMessage = data.messages.find((m) =>
      m.text_preview.includes("modern message")
    );
    expect(modernMessage?.tg_message_id).toBe(100);

    const legacyMessages = data.messages.filter((m) =>
      m.text_preview.includes("legacy")
    );
    expect(legacyMessages).toHaveLength(2);
    legacyMessages.forEach((msg) => {
      expect(msg.tg_message_id).toBeNull();
    });
  });

  test("should maintain ordering by timestamp for unique messages", async () => {
    const now = Date.now();
    
    // Create messages with different tg_message_id but verify ordering works
    seedMessage({
      chatId: TEST_CHAT,
      text: "older message",
      ts: now - 2000,
      tgMessageId: 50,
      transport: "bot_api",
      fromName: "user1"
    });
    
    seedMessage({
      chatId: TEST_CHAT,
      text: "newer message",
      ts: now - 1000,
      tgMessageId: 51,
      transport: "bot_api", 
      fromName: "user2"
    });

    const result = await dispatchAction(
      "LIST_RECENT_MESSAGES",
      { chat_id: TEST_CHAT, kinds: ["all"], limit: 10 },
      { agentKey: "orchestrator", chatId: TEST_CHAT, userbot: null }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.result as ListRecentResult;

    expect(data.messages).toHaveLength(2);

    // Should be ordered by timestamp DESC (newer first)
    expect(data.messages[0].from_name).toBe("user2"); // newer
    expect(data.messages[0].tg_message_id).toBe(51);
    expect(data.messages[1].from_name).toBe("user1"); // older
    expect(data.messages[1].tg_message_id).toBe(50);
  });

  test("should apply limit correctly after deduplication", async () => {
    const now = Date.now();
    
    // Create 3 unique messages
    for (let i = 1; i <= 3; i++) {
      seedMessage({
        chatId: TEST_CHAT,
        text: `unique message ${i}`,
        ts: now - (i * 1000),
        tgMessageId: 60 + i
      });
    }
    
    // Add duplicates for each (should be filtered out)
    for (let i = 1; i <= 3; i++) {
      seedMessage({
        chatId: TEST_CHAT,
        text: `unique message ${i}`,
        ts: now - (i * 1000) - 100,
        tgMessageId: 60 + i,
        transport: "userbot"
      });
    }

    const result = await dispatchAction(
      "LIST_RECENT_MESSAGES",
      { chat_id: TEST_CHAT, kinds: ["all"], limit: 2 }, // Limit to 2
      { agentKey: "orchestrator", chatId: TEST_CHAT, userbot: null }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.result as ListRecentResult;

    // Should return exactly 2 messages (not 4 or 6)
    expect(data.messages).toHaveLength(2);

    // Should be the 2 most recent unique messages
    expect(data.messages[0].text_preview).toBe("unique message 1");
    expect(data.messages[1].text_preview).toBe("unique message 2");
  });
});