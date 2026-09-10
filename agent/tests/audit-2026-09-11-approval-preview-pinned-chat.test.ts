/**
 * Аудит 2026-09-11: карточка одобрения называла чат, в котором ничего не
 * произойдёт.
 *
 * Выжимка печатала `payload.chatId` («удалить сообщение 8231 в чате -1001»),
 * а исполнение пинит действие к чату ЗАЯВКИ: `executeApproved` передаёт
 * `chatId: approval.chat_id`, дальше `pinnedChatId(payload.chatId, ctx.chatId,
 * …)` всегда возвращает `ctx.chatId` (dispatch/helpers.ts). То есть человек
 * читал одно, а подписывал другое.
 *
 * Цена ошибки максимальна у `DELETE_MESSAGE`: номера сообщений в каждом чате
 * свои, так что «удалить 8231 в чате -1001», одобренное как уборка своего
 * черновика в соседнем чате, необратимо удаляет ЧУЖОЕ сообщение с номером
 * 8231 в чате заявки. У `FORWARD_MESSAGE` пиннятся оба конца
 * (dispatch/telegram.ts:441-442) — пересылка всегда внутри своего чата, и
 * строка «из чата -42» была выдумкой целиком.
 *
 * Отсюда два требования к выжимке: назвать чат исполнения и, если payload
 * просил другой, сказать, что просьбу проигнорируют.
 */
import { test, expect, describe } from "bun:test";
import { approvalPreview } from "../lib/approvals.ts";

const CHAT = -1001;

describe("выжимка называет чат, в котором заявка исполнится", () => {
  test("DELETE_MESSAGE не выдаёт чужой чат из payload за цель", () => {
    const s = approvalPreview("DELETE_MESSAGE", { chatId: -777, messageId: 8231 }, undefined, {
      chatId: CHAT,
    });
    expect(s).toContain("8231");
    expect(s).toContain(String(CHAT));
    // Чат из payload может быть упомянут только как отклонённый — но никогда
    // как место, где сообщение удалят.
    expect(s).toMatch(/-777.*(игнор)/s);
    expect(s).not.toMatch(/в чате -777/);
  });

  test("PIN_MESSAGE называет чат заявки, когда payload молчит", () => {
    const s = approvalPreview("PIN_MESSAGE", { messageId: 77 }, undefined, { chatId: CHAT });
    expect(s).toContain("77");
    expect(s).toContain(String(CHAT));
  });

  test("FORWARD_MESSAGE не обещает пересылку из другого чата", () => {
    const s = approvalPreview("FORWARD_MESSAGE", { messageId: 5, fromChatId: -42 }, undefined, {
      chatId: CHAT,
    });
    expect(s).toContain(String(CHAT));
    expect(s).not.toMatch(/из чата -42/);
  });

  test("совпадение чатов не добавляет шума про игнорирование", () => {
    const s = approvalPreview("DELETE_MESSAGE", { chatId: CHAT, messageId: 8231 }, undefined, {
      chatId: CHAT,
    });
    expect(s).toContain(String(CHAT));
    expect(s).not.toContain("игнор");
  });

  test("без контекста чат не называется вовсе", () => {
    // Старый вызывающий (или Mini App, если появится) не должен получать
    // чат из payload под видом цели: лучше умолчать, чем солгать.
    const s = approvalPreview("DELETE_MESSAGE", { chatId: -777, messageId: 8231 });
    expect(s).toContain("8231");
    expect(s).not.toContain("-777");
  });

  test("выжимка остаётся в пределах лимита", () => {
    const s = approvalPreview("DELETE_MESSAGE", { chatId: -777, messageId: 8231 }, 120, {
      chatId: CHAT,
    });
    expect(s.length).toBeLessThanOrEqual(120);
  });
});
