/**
 * Аудит 2026-08-12: список аппрувов в Telegram не показывал, что именно
 * одобряют.
 *
 * lib/commands.ts, cmdApprovals:
 *
 *   `${a.id} ${a.requested_by} ${a.action_type} (создано ${fmtTs(...)})`
 *
 * То есть владелец видит «1a2b3c smm PUBLISH_TO_CHANNEL (создано …)» и жмёт
 * `/approve 1a2b3c`, не увидев ни строки текста, который после этого уйдёт
 * подписчикам. Полезная нагрузка в строке не участвует вообще.
 *
 * Аппрув существует ровно затем, чтобы человек посмотрел на содержимое до
 * необратимого действия — публикации в канал, отправки документа, письма.
 * Список без содержимого превращает его в формальность: единственный способ
 * узнать, что одобряешь, — открыть Mini App, а команда `/approvals` при этом
 * есть и работает.
 *
 * Инвариант: в строке аппрува видно, что именно произойдёт — короткая выжимка
 * из payload'а (текст поста, заголовок, адресат), обрезанная до одной строки.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { cmdApprovals } from "../lib/commands.ts";
import { createApproval, approvalPreview } from "../lib/approvals.ts";
import { db } from "../lib/db.ts";

const CHAT_ID = -100_900_901;

const POST_TEXT =
  "📰 **Дайджест дня**\nБиржа X открыла регистрацию, дедлайн 20 августа. " +
  "Подробности по ссылке на сайте.";

beforeEach(() => {
  db.prepare(`DELETE FROM approvals WHERE chat_id = ?`).run(CHAT_ID);
});

afterEach(() => {
  db.prepare(`DELETE FROM approvals WHERE chat_id = ?`).run(CHAT_ID);
});

describe("cmdApprovals: видно, что одобряешь", () => {
  test("в строке публикации есть текст поста", () => {
    createApproval({
      actionId: `act-${Math.random()}`,
      chatId: CHAT_ID,
      requestedBy: "smm",
      actionType: "PUBLISH_TO_CHANNEL",
      payload: { channelId: -100_1, text: POST_TEXT },
    });
    const out = cmdApprovals({ chatId: CHAT_ID, args: [] });
    expect(out).toInclude("Дайджест дня");
  });

  test("выжимка — одна строка и не разрастается", () => {
    createApproval({
      actionId: `act-${Math.random()}`,
      chatId: CHAT_ID,
      requestedBy: "smm",
      actionType: "PUBLISH_TO_CHANNEL",
      payload: { channelId: -100_1, text: "я".repeat(500) },
    });
    const out = cmdApprovals({ chatId: CHAT_ID, args: [] });
    expect(out.split("\n").length).toBe(1);
    expect(out.length).toBeLessThan(300);
  });

  test("перевод строки в тексте не ломает построчный формат списка", () => {
    createApproval({
      actionId: `act-${Math.random()}`,
      chatId: CHAT_ID,
      requestedBy: "copy",
      actionType: "SEND_MESSAGE",
      payload: { text: "первая строка\nвторая строка\nтретья" },
    });
    const out = cmdApprovals({ chatId: CHAT_ID, args: [] });
    expect(out.split("\n").length).toBe(1);
    expect(out).toInclude("первая строка");
  });

  test("payload без текста — берётся то, что есть", () => {
    expect(approvalPreview("SEND_DOCUMENT", { filename: "report.pdf" })).toInclude(
      "report.pdf",
    );
    expect(approvalPreview("CREATE_TEAM_CHANNEL", { title: "DeLabs News" })).toInclude(
      "DeLabs News",
    );
  });

  test("пустой или странный payload не роняет список", () => {
    for (const p of [null, undefined, 42, [], {}, { text: "" }]) {
      expect(typeof approvalPreview("SOME_ACTION", p)).toBe("string");
    }
    createApproval({
      actionId: `act-${Math.random()}`,
      chatId: CHAT_ID,
      requestedBy: "pm",
      actionType: "SOME_ACTION",
      payload: null,
    });
    const out = cmdApprovals({ chatId: CHAT_ID, args: [] });
    expect(out).toInclude("SOME_ACTION");
  });

  test("прежние поля никуда не делись", () => {
    const a = createApproval({
      actionId: `act-${Math.random()}`,
      chatId: CHAT_ID,
      requestedBy: "smm",
      actionType: "PUBLISH_TO_CHANNEL",
      payload: { text: POST_TEXT },
    });
    const out = cmdApprovals({ chatId: CHAT_ID, args: [] });
    expect(out).toInclude(a.id);
    expect(out).toInclude("smm");
    expect(out).toInclude("PUBLISH_TO_CHANNEL");
  });
});
