/**
 * Аудит 2026-08-12: MTProto-наблюдатель заводил слова наших же ботов как пользовательские.
 *
 * Userbot сидит в группе от аккаунта владельца и видит ВСЁ, включая сообщения
 * наших 12 ботов. `makeHandler` о своих ботах не знает — он пишет любое
 * сообщение с `isBot: false, agentKey: null`. Пока Bot API-путь успевает
 * записать тот же id первым, дедуп по (chat_id, tg_message_id) это скрывает.
 *
 * Скрывает ровно одно сообщение из N: длинный ответ уходит частями
 * (`sendChunked`), а `recordMessage` получает id ТОЛЬКО последней части —
 * sendChunked возвращает последнее sent. Замер на ответе в три части:
 *
 *   частей ушло в Telegram: 3 ids: 500,501,502
 *   sendChunked вернул message_id: 502
 *   строк в истории: 3
 *     id=500 is_bot=0 agent=null transport=userbot head="(1/3) AAAAAA"
 *     id=501 is_bot=0 agent=null transport=userbot head="(2/3) BBBBBB"
 *     id=502 is_bot=1 agent=design transport=bot_api head="AAAAAAAAAAAA"
 *   свои же слова, лежащие как пользовательские: 2
 *
 *   --- как это видит следующий агент ---
 *     [design] AAAAAAAAAAAAAAAAAAAAAAAA…
 *     [design_bot] (1/3) AAAAAAAAAAAAAAAAAA…
 *     [design_bot] (2/3) BBBBBBBBBBBBBBBBBB…
 *
 * То есть ответ агента лежит в истории трижды, дважды — от «пользователя»
 * design_bot. Дальше это уходит в промпт следующего хода как чужая реплика: у
 * агента появляется «просьба» с телом его же предыдущего ответа. Плюс
 * дублирование контекста на ровном месте.
 *
 * Дедуп по id тут не помогает и не мог: id частей 500 и 501 в Bot API-путь не
 * попадали вовсе. Чинить надо на границе — наблюдатель должен узнавать своих.
 *
 * Инвариант: сообщение, отправленное нашим же ботом, в историю через
 * MTProto-путь не попадает; всё остальное попадает как раньше.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { makeUserbotRecorder } from "../lib/userbot-ingest.ts";
import { sendChunked } from "../lib/telegram-chunking.ts";
import { recordMessage } from "../lib/memory.ts";
import { db } from "../lib/db.ts";

const CHAT = "-1009999002";
/** Telegram-id наших ботов: RunningBot.id, ровно то, что пишет message-handler. */
const OWN = [770, 771];

function rows() {
  return db
    .prepare(
      "SELECT tg_message_id AS id, is_bot, agent_key, transport FROM messages WHERE chat_id = ? ORDER BY tg_message_id",
    )
    .all(CHAT) as { id: number; is_bot: number; agent_key: string | null; transport: string }[];
}

function wipe() {
  db.prepare("DELETE FROM messages WHERE chat_id = ?").run(CHAT);
}

beforeEach(wipe);
afterEach(wipe);

function msg(over: Partial<Parameters<ReturnType<typeof makeUserbotRecorder>>[0]> = {}) {
  return {
    chatId: CHAT,
    messageId: 900,
    fromUserId: "42",
    fromName: "Егор",
    text: "привет",
    isService: false,
    ...over,
  };
}

describe("наблюдатель узнаёт своих", () => {
  test("сообщение нашего бота не попадает в историю", () => {
    const record = makeUserbotRecorder({ ownBotIds: OWN });
    record(msg({ fromUserId: "770", fromName: "design_bot", text: "(1/3) …" }));
    expect(rows()).toHaveLength(0);
  });

  test("сообщение живого человека попадает как раньше", () => {
    const record = makeUserbotRecorder({ ownBotIds: OWN });
    record(msg());
    const [r] = rows();
    expect(r).toMatchObject({ id: 900, is_bot: 0, agent_key: null, transport: "userbot" });
  });

  test("сервисное сообщение не от бота попадает", () => {
    const record = makeUserbotRecorder({ ownBotIds: OWN });
    record(msg({ messageId: 901, isService: true, text: "" }));
    expect(rows()).toHaveLength(1);
  });

  test("неизвестный отправитель пишется — своих определяем по списку, а не по догадке", () => {
    const record = makeUserbotRecorder({ ownBotIds: OWN });
    record(msg({ fromUserId: null }));
    expect(rows()).toHaveLength(1);
  });

  test("пустой список своих ботов ничего не отсеивает", () => {
    const record = makeUserbotRecorder({ ownBotIds: [] });
    record(msg({ fromUserId: "770" }));
    expect(rows()).toHaveLength(1);
  });

  test("id сверяются строкой и числом одинаково", () => {
    const record = makeUserbotRecorder({ ownBotIds: ["770"] });
    record(msg({ fromUserId: "770" }));
    expect(rows()).toHaveLength(0);
  });
});

describe("сцена из шапки целиком", () => {
  test("ответ в три части оставляет ровно одну строку — свою", async () => {
    const reply = ["A".repeat(4000), "B".repeat(4000), "C".repeat(4000)].join("\n\n");
    let nextId = 500;
    const wire: { id: number; text: string }[] = [];
    const sent = await sendChunked(async (text: string) => {
      const id = nextId++;
      wire.push({ id, text });
      return { message_id: id, date: 0 };
    }, reply);

    expect(wire).toHaveLength(3);
    // sendChunked отдаёт последнее sent — id первых частей наружу не выходит.
    expect(sent.message_id).toBe(502);

    // Путь Bot API: одна запись на весь ответ.
    recordMessage({
      chatId: CHAT,
      agentKey: "design",
      isBot: true,
      fromUserId: "770",
      fromName: "design_bot",
      text: reply,
      tgMessageId: sent.message_id,
      transport: "bot_api",
    });

    // Путь MTProto: наблюдатель видит каждую часть отдельным сообщением.
    const record = makeUserbotRecorder({ ownBotIds: OWN });
    for (const w of wire) {
      record(msg({ messageId: w.id, fromUserId: "770", fromName: "design_bot", text: w.text }));
    }

    const all = rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: 502, is_bot: 1, agent_key: "design" });
  });
});
