/**
 * Аудит 2026-08-29: карточка аппрува молчала ровно там, где решение
 * необратимо.
 *
 * 1) Payload'ы из одних чисел. У DELETE_MESSAGE, PIN_MESSAGE и
 *    FORWARD_MESSAGE нет ни одного строкового поля: chatId, messageId,
 *    fromChatId, via_userbot, disableNotification. Рендерера на эти типы не
 *    было, PREVIEW_FIELDS строк не находил, и последний общий проход тоже
 *    фильтрует по `typeof v === "string"` — выжимка выходила пустой, а
 *    `/approvals` печатал одну голову: «<uuid> orchestrator DELETE_MESSAGE
 *    (создано …)». DELETE_MESSAGE необратим и лежит в SEMI_AUTO_RISKY, то есть
 *    в режиме по умолчанию заявка создаётся ВСЕГДА — и владельца просили
 *    одобрить удаление, не назвав ни сообщения, ни чата.
 *
 * 2) via_userbot. Флаг означает смену личности отправителя: сообщение уйдёт с
 *    настоящего аккаунта владельца. Ради этого аппрув и требуется
 *    (USERBOT_FORCE_APPROVAL), но причина гейта в строку approvals не
 *    сохраняется — reason пишется NULL. Карточка получалась байт-в-байт как у
 *    рядового SEND_MESSAGE, которых в semi_auto десятки в день. Владелец,
 *    привыкший штамповать /approve, публиковал «официальное заявление» от
 *    своего имени. В Mini App payload есть, но внутри свёрнутого <details>, а
 *    в Telegram его не достать вовсе.
 *
 * Шапка PREVIEW_BY_ACTION описывает ровно этот класс дефекта для
 * REVIEW_AND_MERGE_PR — рендерер тогда добавили одному типу, а три с такой же
 * формой payload'а пропустили.
 */
import { test, expect, describe } from "bun:test";
import { approvalPreview } from "../lib/approvals.ts";

describe("payload из одних чисел даёт непустую выжимку", () => {
  test("DELETE_MESSAGE называет сообщение и чат", () => {
    // Чат приходит контекстом (`approvals.chat_id`), а не из payload'а:
    // см. аудит 2026-09-11 и его тест про пиннинг.
    const s = approvalPreview("DELETE_MESSAGE", { chatId: -1001, messageId: 8231 }, undefined, {
      chatId: -1001,
    });
    expect(s).toContain("8231");
    expect(s).toContain("-1001");
  });

  test("PIN_MESSAGE называет сообщение", () => {
    const s = approvalPreview("PIN_MESSAGE", {
      chatId: -1001,
      messageId: 77,
      disableNotification: true,
    });
    expect(s).toContain("77");
  });

  test("FORWARD_MESSAGE называет сообщение и чат исполнения", () => {
    const s = approvalPreview("FORWARD_MESSAGE", { messageId: 5, fromChatId: -42 }, undefined, {
      chatId: -42,
    });
    expect(s).toContain("5");
    expect(s).toContain("-42");
  });

  test("EDIT_MESSAGE показывает и номер сообщения, и новый текст", () => {
    const s = approvalPreview("EDIT_MESSAGE", { messageId: 12, text: "новая версия" });
    expect(s).toContain("12");
    expect(s).toContain("новая версия");
  });

  test("неполный payload не роняет выжимку в пустоту", () => {
    // Payload приходит от LLM: поля может не быть вовсе.
    expect(approvalPreview("DELETE_MESSAGE", {}).trim()).not.toBe("");
  });
});

describe("via_userbot виден в карточке", () => {
  test("SEND_MESSAGE от лица владельца отличается от обычного", () => {
    const owner = approvalPreview("SEND_MESSAGE", {
      text: "официальное заявление",
      via_userbot: true,
    });
    const plain = approvalPreview("SEND_MESSAGE", { text: "официальное заявление" });
    expect(owner).not.toBe(plain);
    expect(owner).toContain("ВЛАДЕЛЬЦА");
    expect(plain).not.toContain("ВЛАДЕЛЬЦА");
  });

  test("метка идёт первой — строка режется по 120 символам с хвоста", () => {
    const s = approvalPreview("SEND_MESSAGE", {
      text: "я".repeat(400),
      via_userbot: true,
    });
    expect(s.startsWith("ОТ ЛИЦА ВЛАДЕЛЬЦА")).toBe(true);
    expect(s.length).toBeLessThanOrEqual(120);
  });

  test("DELETE_MESSAGE от лица владельца помечен", () => {
    const s = approvalPreview("DELETE_MESSAGE", { messageId: 1, via_userbot: true });
    expect(s).toContain("ВЛАДЕЛЬЦА");
  });

  test("SET_REACTION от лица владельца помечен и называет эмодзи", () => {
    const s = approvalPreview("SET_REACTION", {
      messageId: 9,
      emoji: "👍",
      via_userbot: true,
    });
    expect(s).toContain("ВЛАДЕЛЬЦА");
    expect(s).toContain("👍");
    expect(s).toContain("9");
  });

  test("via_userbot: false и отсутствие флага метку не ставят", () => {
    expect(approvalPreview("SET_REACTION", { messageId: 9, emoji: "👍", via_userbot: false }))
      .not.toContain("ВЛАДЕЛЬЦА");
    // Строка "true" — не boolean true: подмена личности только по строгому ===.
    expect(approvalPreview("SET_REACTION", { messageId: 9, emoji: "👍", via_userbot: "true" }))
      .not.toContain("ВЛАДЕЛЬЦА");
  });
});

describe("прежнее поведение не изменилось", () => {
  test("текст обычного SEND_MESSAGE всё так же в выжимке", () => {
    expect(approvalPreview("SEND_MESSAGE", { text: "привет" })).toBe("привет");
  });

  test("незнакомый тип по-прежнему идёт общим путём", () => {
    // Аудит 2026-09-10: здесь стоял PUBLISH_TO_CHANNEL — он же и получил
    // собственный рендерер (карточка не называла ни канал, ни картинку), так
    // что «незнакомым» быть перестал. Берём тип, у которого рендерера нет и
    // по смыслу не нужно: общий путь проверяется, пример другой.
    expect(approvalPreview("WRITE_WIKI", { title: "заголовок" })).toBe("заголовок");
  });

  test("не-объект даёт пустую строку", () => {
    expect(approvalPreview("DELETE_MESSAGE", null)).toBe("");
    expect(approvalPreview("DELETE_MESSAGE", [1, 2])).toBe("");
  });

  test("переводы строк по-прежнему схлопываются", () => {
    expect(approvalPreview("SEND_MESSAGE", { text: "а\nб\n\nв" })).toBe("а б в");
  });
});
