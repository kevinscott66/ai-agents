/**
 * T-543: Test message ingestion deduplication by telegram message_id
 * 
 * Context: Bot API and MTProto userbot both record the same Telegram message
 * creating duplicates. The fix adds tg_message_id and uses INSERT OR IGNORE
 * with UNIQUE constraint for deduplication.
 */
import { describe, test, beforeEach, expect } from "bun:test";
import { db } from "../lib/db.ts";
import { recordMessage } from "../lib/memory.ts";

/** Колонки `messages`, которые читают проверки ниже. db.all()/db.get() отдают unknown. */
interface MessageRow {
  chat_id: string;
  text: string;
  from_name: string | null;
  tg_message_id: number | null;
  transport: string;
}

describe("T-543 message deduplication", () => {
  beforeEach(() => {
    // Clean up messages table for each test
    db.prepare("DELETE FROM messages").run();
  });

  test("should prevent duplicate messages with same (chat_id, tg_message_id)", () => {
    const commonMessage = {
      chatId: "-1001234567890",
      agentKey: null,
      isBot: false,
      fromUserId: "123456789",
      fromName: "TestUser",
      text: "Hello world",
      tgMessageId: 12345,
    };

    // First insertion via bot_api
    recordMessage({
      ...commonMessage,
      transport: 'bot_api',
    });

    // Second insertion via userbot (should be ignored due to dedup)
    recordMessage({
      ...commonMessage,
      transport: 'userbot',
      fromName: 'TestUser (different name)', // Different name to prove dedup works
    });

    // Should only have 1 message in database
    const messages = db.prepare("SELECT * FROM messages WHERE chat_id = ?")
      .all(commonMessage.chatId) as MessageRow[];

    expect(messages).toHaveLength(1);
    expect(messages[0].tg_message_id).toBe(12345);
    expect(messages[0].transport).toBe('bot_api'); // First one wins
  });

  test("should allow different messages with different tg_message_id", () => {
    const chatId = "-1001234567890";
    const baseMessage = {
      chatId,
      agentKey: null,
      isBot: false,
      fromUserId: "123456789",
      fromName: "TestUser",
    };

    // Record two different messages
    recordMessage({
      ...baseMessage,
      text: "First message",
      tgMessageId: 12345,
      transport: 'bot_api',
    });

    recordMessage({
      ...baseMessage,
      text: "Second message", 
      tgMessageId: 12346,
      transport: 'userbot',
    });

    // Should have 2 messages in database
    const messages = db.prepare("SELECT * FROM messages WHERE chat_id = ? ORDER BY tg_message_id")
      .all(chatId) as MessageRow[];

    expect(messages).toHaveLength(2);
    expect(messages[0].text).toBe("First message");
    expect(messages[1].text).toBe("Second message");
  });

  test("should allow same tg_message_id in different chats", () => {
    const baseMessage = {
      agentKey: null,
      isBot: false,
      fromUserId: "123456789",
      fromName: "TestUser",
      text: "Same message",
      tgMessageId: 12345,
    };

    // Same message ID in different chats should be allowed
    recordMessage({
      ...baseMessage,
      chatId: "-1001234567890",
      transport: 'bot_api',
    });

    recordMessage({
      ...baseMessage,
      chatId: "-1001234567891",
      transport: 'bot_api',
    });

    // Should have 2 messages in database
    const messages = db.prepare("SELECT * FROM messages WHERE tg_message_id = ?")
      .all(12345) as MessageRow[];

    expect(messages).toHaveLength(2);
    expect(messages[0].chat_id).toBe("-1001234567890");
    expect(messages[1].chat_id).toBe("-1001234567891");
  });

  test("should fallback to original behavior when tgMessageId not provided", () => {
    const baseMessage = {
      chatId: "-1001234567890",
      agentKey: null,
      isBot: false,
      fromUserId: "123456789",
      fromName: "TestUser",
      text: "Message without tg_message_id",
    };

    // Record same message twice without tgMessageId (should create 2 records)
    recordMessage({
      ...baseMessage,
      transport: 'bot_api',
    });

    recordMessage({
      ...baseMessage,
      transport: 'userbot',
    });

    // Should have 2 messages (no deduplication without tg_message_id)
    const messages = db.prepare("SELECT * FROM messages WHERE chat_id = ?")
      .all(baseMessage.chatId) as MessageRow[];

    expect(messages).toHaveLength(2);
    expect(messages[0].tg_message_id).toBe(null);
    expect(messages[1].tg_message_id).toBe(null);
  });

  test("should track transport source correctly", () => {
    recordMessage({
      chatId: "-1001234567890",
      agentKey: null,
      isBot: false,
      fromUserId: "123456789", 
      fromName: "TestUser",
      text: "Bot API message",
      tgMessageId: 12345,
      transport: 'bot_api',
    });

    recordMessage({
      chatId: "-1001234567890",
      agentKey: null,
      isBot: false,
      fromUserId: "123456789",
      fromName: "TestUser", 
      text: "Userbot message",
      tgMessageId: 12346,
      transport: 'userbot',
    });

    const messages = db.prepare("SELECT * FROM messages ORDER BY tg_message_id")
      .all() as MessageRow[];

    expect(messages).toHaveLength(2);
    expect(messages[0].transport).toBe('bot_api');
    expect(messages[1].transport).toBe('userbot');
  });

  test("should default to bot_api transport when not specified", () => {
    recordMessage({
      chatId: "-1001234567890",
      agentKey: null,
      isBot: false,
      fromUserId: "123456789",
      fromName: "TestUser",
      text: "Message without transport",
      tgMessageId: 12345,
    });

    const message = db.prepare("SELECT * FROM messages WHERE tg_message_id = ?")
      .get(12345) as MessageRow;

    expect(message.transport).toBe('bot_api');
  });

  test("should handle null values correctly", () => {
    recordMessage({
      chatId: "-1001234567890",
      agentKey: null,
      isBot: false,
      fromUserId: "123456789",
      fromName: null, // null name
      text: "Message with null name",
      tgMessageId: 12345,
      transport: 'userbot',
    });

    const message = db.prepare("SELECT * FROM messages WHERE tg_message_id = ?")
      .get(12345) as MessageRow;

    expect(message.from_name).toBe(null);
    expect(message.transport).toBe('userbot');
    expect(message.tg_message_id).toBe(12345);
  });
});