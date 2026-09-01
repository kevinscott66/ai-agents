/**
 * Аудит 2026-08-12: ингест userbot'а писал историю под ДРУГИМ ключом чата.
 *
 * `makeHandler` (lib/userbot.ts) берёт `msg.chatId` как есть, а allowlist
 * сверяет по «ободранному» виду (`normalizeChatId`: снять -100). Комментарий в
 * том же файле прямо говорит, почему сравнение такое: «gramjs отдаёт peer то с
 * префиксом -100, то без». То есть обе формы штатно проходят границу — и обе
 * уезжают в `recordMessage` как `chat_id`.
 *
 * Замер (probe: allowlist ["-1009305555"], два апдейта из ОДНОГО чата):
 *
 *   ингест выдал chatId: [ "9305555", "-1009305555" ]
 *   история чата, как её видит агент (chat_id = -1009305555):
 *     [[502,"userbot","привет"], [501,"bot_api","[Voice] …"]]
 *   осело мимо, под chat_id = 9305555: [[501,"userbot",""]]
 *
 * Читатели истории (`getRecentMessages`, message-handler) знают ровно ту форму,
 * которую даёт Bot API — `String(ctx.chat.id)`, то есть `-100…`. Всё, что
 * gramjs отдал без префикса, оседает в отдельной ветке таблицы: агент этих
 * сообщений не видит никогда, дедуп T-543 по (chat_id, tg_message_id) не
 * срабатывает, и один и тот же ход лежит в базе дважды под разными ключами.
 *
 * Канонизируем на границе: раз allowlist уже нашёл, какому чату принадлежит
 * апдейт, — эту запись из TELEGRAM_ALLOWED_GROUP_IDS и пишем. Она задана
 * владельцем в том же виде, что читает Bot API-путь. Обратное преобразование
 * (добрать -100 к голому id) невозможно в принципе: по «9305555» не отличить
 * супергруппу от лички с юзером 9305555 — об этом отдельный абзац в шапке
 * normalizeChatId.
 *
 * Второе, вскрытое тем же замером: как только ключи сошлись, заработал дедуп —
 * и начал ГЛОТАТЬ расшифровки голосовых. У voice-сообщения `msg.message === ""`,
 * userbot пишет пустую строку мгновенно, Whisper приезжает через несколько
 * секунд, `INSERT OR IGNORE` его отбрасывает:
 *
 *   строк в истории: 1 [{"text":"","transport":"userbot"}]
 *
 * Поэтому дозапись пустой строки разрешена ровно в одну сторону: пустой текст
 * можно заполнить, непустой — переписать нельзя. Иначе поздний дубликат мог бы
 * подменить уже сказанное.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import { canonicalChatId, makeHandler } from "../lib/userbot.ts";
import { recordMessage, getRecentMessages } from "../lib/memory.ts";

const ALLOWED = "-1009305555";
const BARE = "9305555";

afterEach(() => {
  db.prepare(`DELETE FROM messages WHERE chat_id IN (?, ?)`).run(ALLOWED, BARE);
});

const evt = (chatId: string, id: number, message = "") => ({
  message: { chatId: { toString: () => chatId }, id, message },
});

describe("ингест userbot'а канонизирует chat_id", () => {
  test("обе формы peer'а дают одну запись из allowlist", () => {
    expect(canonicalChatId([ALLOWED], BARE)).toBe(ALLOWED);
    expect(canonicalChatId([ALLOWED], ALLOWED)).toBe(ALLOWED);
    expect(canonicalChatId([ALLOWED], "-9305555")).toBe(ALLOWED);
  });

  test("чужой чат — null, граница остаётся fail-closed", () => {
    expect(canonicalChatId([ALLOWED], "777")).toBeNull();
    expect(canonicalChatId([], BARE)).toBeNull();
  });

  test("число в allowlist отдаётся строкой — в chat_id идёт текст", () => {
    expect(canonicalChatId([-1009305555], BARE)).toBe(ALLOWED);
  });

  test("замер из шапки: оба апдейта попадают в одну историю", async () => {
    const seen: Array<{ chatId: string; messageId: number; text: string }> = [];
    const h = makeHandler({
      allowedChatIds: [ALLOWED],
      onMessage: (m: never) => seen.push(m),
    } as never);

    await h(evt(BARE, 501));
    await h(evt(ALLOWED, 502, "привет"));

    expect(seen.map((m) => m.chatId)).toEqual([ALLOWED, ALLOWED]);

    for (const m of seen) {
      recordMessage({
        chatId: m.chatId,
        agentKey: null,
        isBot: false,
        fromUserId: "1",
        fromName: "owner",
        text: m.text,
        tgMessageId: m.messageId,
        transport: "userbot",
      });
    }
    expect(getRecentMessages(BARE)).toHaveLength(0);
    expect(getRecentMessages(ALLOWED)).toHaveLength(2);
  });
});

describe("расшифровка голосового не теряется на дедупе", () => {
  const rows = () =>
    getRecentMessages(ALLOWED).map((r) => [r.tg_message_id, r.transport, r.text]);

  const voiceThenTranscript = () => {
    // userbot видит голосовое мгновенно: текста у него нет.
    recordMessage({
      chatId: ALLOWED, agentKey: null, isBot: false, fromUserId: "1",
      fromName: "owner", text: "", tgMessageId: 501, transport: "userbot",
    });
    // Whisper отвечает через несколько секунд — тот же tg_message_id.
    recordMessage({
      chatId: ALLOWED, agentKey: null, isBot: false, fromUserId: "1",
      fromName: "owner", text: "[Voice] переставь релиз на четверг",
      tgMessageId: 501, transport: "bot_api",
    });
  };

  test("пустая строка дозаполняется расшифровкой, дубль не плодится", () => {
    voiceThenTranscript();
    expect(rows()).toEqual([[501, "bot_api", "[Voice] переставь релиз на четверг"]]);
  });

  test("непустой текст поздним дублем не переписывается", () => {
    recordMessage({
      chatId: ALLOWED, agentKey: null, isBot: false, fromUserId: "1",
      fromName: "owner", text: "сказанное владельцем", tgMessageId: 502,
      transport: "userbot",
    });
    recordMessage({
      chatId: ALLOWED, agentKey: null, isBot: false, fromUserId: "666",
      fromName: "кто-то", text: "подменённое", tgMessageId: 502,
      transport: "bot_api",
    });
    expect(rows()).toEqual([[502, "userbot", "сказанное владельцем"]]);
  });

  test("пустой дубль поверх пустой строки ничего не портит", () => {
    for (let i = 0; i < 2; i++) {
      recordMessage({
        chatId: ALLOWED, agentKey: null, isBot: false, fromUserId: "1",
        fromName: "owner", text: "", tgMessageId: 503, transport: "userbot",
      });
    }
    expect(rows()).toEqual([[503, "userbot", ""]]);
  });
});
