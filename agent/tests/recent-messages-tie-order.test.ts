/**
 * Аудит 2026-08-12: сообщения одной секунды приезжали модели В ОБРАТНОМ порядке.
 *
 * История чата читается так:
 *
 *   SELECT * FROM messages WHERE chat_id = ? ORDER BY ts DESC LIMIT ?
 *   ...
 *   return rows.reverse(); // от старого к новому
 *
 * Тай-брейкера нет, а совпадающий `ts` — не редкость, а норма: входящие пишутся
 * временем Telegram, у которого гранулярность СЕКУНДА (handoff.ts:363 и
 * message-handler.ts:493 — `(sent?.date ?? …) * 1000`). Всё, что прилетело в
 * одну секунду — вопрос и мгновенный ответ, две реплики подряд, фан-аут по
 * ролям, — имеет ровно одинаковый ts.
 *
 * И порядок при этом не «случайный», а стабильно неправильный: индекс
 * `idx_messages_chat_ts(chat_id, ts DESC)` сканируется вперёд, внутри
 * одинакового ts строки идут по rowid ВОЗРАСТАЮЩЕМУ, а сверху ещё
 * `.reverse()`. Замер до починки — ровно этот тест: вставленные «первое,
 * второе, третье, четвёртое» возвращались как «четвёртое, третье, второе,
 * первое».
 *
 * Что это значит на проде: модель получает кусок диалога задом наперёд и
 * отвечает на реплику, которой ещё не было. Ни в логах, ни в БД следа нет —
 * данные лежат правильно, портится только чтение.
 *
 * Второй пострадавший — LIST_RECENT_MESSAGES (lib/dispatch/misc.ts): там на том
 * же порядке держится дедуп по tg_message_id, который комментарием обещает
 * «keeping the most recent occurrence».
 */
import { describe, test, expect, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import { getRecentMessages, recordMessage } from "../lib/memory.ts";

const CHAT = "-1000999124";
/** Одна секунда Telegram-времени: ровно то, что даёт `date * 1000`. */
const TS = 1_760_000_000_000;
const ORDER = ["первое", "второе", "третье", "четвёртое"];

afterEach(() => {
  db.prepare(`DELETE FROM messages WHERE chat_id = ?`).run(CHAT);
});

function seedSameSecond(): void {
  for (const [i, text] of ORDER.entries()) {
    recordMessage({
      chatId: CHAT,
      agentKey: null,
      isBot: false,
      fromUserId: "1",
      fromName: "u",
      text,
      ts: TS,
      tgMessageId: 5000 + i,
    });
  }
}

describe("getRecentMessages при совпадающем ts", () => {
  test("порядок вставки сохраняется, а не переворачивается", () => {
    seedSameSecond();
    expect(getRecentMessages(CHAT, 10).map((r) => r.text)).toEqual(ORDER);
  });

  test("LIMIT отрезает старые, а не новые", () => {
    // Обратная сторона того же дефекта: при неверном порядке «последние 2»
    // оказывались первыми двумя репликами секунды.
    seedSameSecond();
    expect(getRecentMessages(CHAT, 2).map((r) => r.text)).toEqual([
      "третье",
      "четвёртое",
    ]);
  });

  test("разные секунды по-прежнему идут по времени", () => {
    recordMessage({
      chatId: CHAT,
      agentKey: null,
      isBot: false,
      fromUserId: "1",
      fromName: "u",
      text: "раньше",
      ts: TS - 1000,
      tgMessageId: 4999,
    });
    seedSameSecond();
    expect(getRecentMessages(CHAT, 10).map((r) => r.text)).toEqual([
      "раньше",
      ...ORDER,
    ]);
  });
});

describe("структура", () => {
  test("оба чтения messages сортируют с тай-брейкером по id", async () => {
    // Правило одно, мест два: история для модели (lib/memory.ts) и
    // LIST_RECENT_MESSAGES (lib/dispatch/misc.ts, там на порядке ещё и дедуп).
    for (const f of ["../lib/memory.ts", "../lib/dispatch/misc.ts"]) {
      const src = await Bun.file(new URL(f, import.meta.url)).text();
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((l) => !l.trim().startsWith("//"))
        .join("\n");
      const bare = [...code.matchAll(/ORDER BY\s+ts DESC(?!\s*,\s*id DESC)/g)];
      expect({ file: f, bare: bare.length }).toEqual({ file: f, bare: 0 });
    }
  });
});
