/**
 * Аудит 2026-08-07: publishPost без фото возвращал message_id 0 ВСЕГДА.
 *
 * client.sendMessage/sendFile отдают готовый Message с `.id`, а
 * client.invoke(messages.SendMessage) — объект Updates, у которого `.id` нет
 * вовсе: настоящий id лежит в updates[]. Прежний `Number(res?.id ?? 0)` это
 * молча проглатывал, и в agent_actions уезжал несуществующий id — у агента не
 * оставалось ручки, чтобы потом закрепить или отредактировать свой же пост.
 */
import { describe, test, expect } from "bun:test";
import { extractMessageId } from "../lib/userbot.ts";

describe("extractMessageId", () => {
  test("Message с прямым .id (sendMessage/sendFile)", () => {
    expect(extractMessageId({ id: 4242 })).toBe(4242);
  });

  test("Updates от messages.SendMessage → UpdateMessageID", () => {
    const updates = {
      className: "Updates",
      updates: [
        { className: "UpdateMessageID", id: 777, randomId: "123" },
        { className: "UpdateReadChannelInbox" },
      ],
    };
    expect(extractMessageId(updates)).toBe(777);
  });

  test("Updates с UpdateNewChannelMessage → id вложенного message", () => {
    const updates = {
      className: "Updates",
      updates: [
        { className: "UpdateReadChannelInbox" },
        { className: "UpdateNewChannelMessage", message: { id: 909, message: "пост" } },
      ],
    };
    expect(extractMessageId(updates)).toBe(909);
  });

  test("пустой/непонятный ответ → 0, а не исключение", () => {
    expect(extractMessageId(null)).toBe(0);
    expect(extractMessageId({})).toBe(0);
    expect(extractMessageId({ updates: [] })).toBe(0);
    expect(extractMessageId({ updates: [{ className: "UpdateReadChannelInbox" }] })).toBe(0);
  });

  test("id=0 и мусорные значения не считаются валидными", () => {
    expect(extractMessageId({ id: 0 })).toBe(0);
    expect(extractMessageId({ id: "не число" })).toBe(0);
    // Но если рядом в updates есть настоящий — берём его.
    expect(extractMessageId({ id: 0, updates: [{ id: 55 }] })).toBe(55);
  });
});
