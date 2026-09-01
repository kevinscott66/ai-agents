/**
 * Аудит 2026-08-28: реестр своих отправок запоминал текст ДО разметки.
 *
 * `sendMessage` звал `markSelfSend(chatId, text)` сырым текстом, а дальше
 * отдавал этот же текст в `client.sendMessage` без `parseMode` и без
 * `formattingEntities`. У gramjs это значит «применить парс-мод клиента», а он
 * задан в базовом конструкторе безусловно:
 * `telegramBaseClient.js:133` → `this._parseMode = MarkdownParser`
 * `messages.js:530` → `formattingEntities == undefined` → `_parseMessageText`
 * `messageParse.js:41-50` → `parseMode == undefined` → `client.parseMode`
 *
 * То есть в Telegram уезжала СНЯТАЯ разметка, эхо приезжало снятым, а в
 * реестре лежал сырой ключ — совпадения не было. `userbot-ingest.ts:122-125`
 * получал `self === null` и записывал ответ агента в историю как реплику
 * владельца: `agentKey: null`, `isBot: false`, `fromUserId` — личный аккаунт
 * владельца. Ровно та дыра, которую шапка `userbot-self-sends.ts:9-15`
 * объявляет закрытой: свои же слова возвращаются следующим ходом как указание
 * человека.
 *
 * Соседний `publishPost` (userbot.ts) делает правильно: разбирает текст
 * сам, регистрирует `plain` и передаёт явные entities — парс-моду там нечего
 * применять. Расходился только `sendMessage`.
 *
 * Тесты гоняют НАСТОЯЩИЙ `MarkdownParser` из gramjs, а не его пересказ.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MarkdownParser } from "telegram/extensions/markdown.js";
import { buildHandle, type UserbotClientLike } from "../lib/userbot.ts";
import {
  consumeSelfSendMeta,
  _pendingSelfSends,
  _resetSelfSends,
} from "../lib/userbot-self-sends.ts";

const CHAT = -1001234567890;

/**
 * Клиент, повторяющий разбор gramjs: нет `formattingEntities` — значит текст
 * проходит через парс-мод клиента, и в Telegram уходит уже без разметки.
 */
function fakeClient(box: { sent: string | null }, opts?: { fail?: boolean }): UserbotClientLike {
  return {
    connect: async () => {},
    disconnect: async () => {},
    addEventHandler: () => {},
    invoke: async () => ({}),
    deleteMessages: async () => ({}),
    getInputEntity: async (peer: any) => ({ peer }),
    sendMessage: async (_peer: any, params: any) => {
      if (opts?.fail) throw new Error("network down");
      const [plain] =
        params.formattingEntities === undefined
          ? MarkdownParser.parse(params.message)
          : [params.message];
      box.sent = plain;
      return { id: 42 };
    },
  };
}

beforeEach(() => _resetSelfSends());
afterEach(() => _resetSelfSends());

describe("предпосылки", () => {
  test("парс-мод gramjs действительно снимает разметку", () => {
    const [plain] = MarkdownParser.parse("Готово: **деплой прошёл**, лог в `journalctl`.");
    expect(plain).toBe("Готово: деплой прошёл, лог в journalctl.");
  });
});

describe("эхо размеченного сообщения опознаётся своим", () => {
  test("жирный и код: эхо совпадает с регистрацией", async () => {
    const box: { sent: string | null } = { sent: null };
    const h = buildHandle(fakeClient(box), {});
    await h.sendMessage(CHAT, "Готово: **деплой прошёл**, лог в `journalctl`.", {
      agentKey: "backend",
    });

    expect(box.sent).toBe("Готово: деплой прошёл, лог в journalctl.");
    const self = consumeSelfSendMeta(CHAT, box.sent!);
    expect(self).not.toBeNull();
    expect(self!.agentKey).toBe("backend");
  });

  test("после опознания в реестре не остаётся висячих регистраций", async () => {
    const box: { sent: string | null } = { sent: null };
    const h = buildHandle(fakeClient(box), {});
    await h.sendMessage(CHAT, "__курсив__ и ~~зачёркнутое~~", { agentKey: "qa" });
    expect(consumeSelfSendMeta(CHAT, box.sent!)).not.toBeNull();
    expect(_pendingSelfSends()).toBe(0);
  });

  test("многострочный блок кода тоже", async () => {
    const box: { sent: string | null } = { sent: null };
    const h = buildHandle(fakeClient(box), {});
    await h.sendMessage(CHAT, "Смотри:\n```\nbun test tests\n```\nвсё зелено", {
      agentKey: "aieng",
    });
    expect(consumeSelfSendMeta(CHAT, box.sent!)).not.toBeNull();
  });
});

describe("прежнее поведение не задето", () => {
  test("текст без разметки работает как работал", async () => {
    const box: { sent: string | null } = { sent: null };
    const h = buildHandle(fakeClient(box), {});
    const res = await h.sendMessage(CHAT, "Обычный текст без разметки", { agentKey: "pm" });

    expect(res.message_id).toBe(42);
    expect(box.sent).toBe("Обычный текст без разметки");
    expect(consumeSelfSendMeta(CHAT, "Обычный текст без разметки")?.agentKey).toBe("pm");
  });

  test("текст, который увидит Telegram, не меняется правкой", async () => {
    // Регистрируем другое — отправляем ровно то же, что и раньше.
    const box: { sent: string | null } = { sent: null };
    const h = buildHandle(fakeClient(box), {});
    await h.sendMessage(CHAT, "**жирный** хвост");
    expect(box.sent).toBe("жирный хвост");
  });
});

describe("откат при неудачной отправке снимает ту же запись", () => {
  test("после исключения регистраций не остаётся", async () => {
    const box: { sent: string | null } = { sent: null };
    const h = buildHandle(fakeClient(box, { fail: true }), {});
    await expect(
      h.sendMessage(CHAT, "Не ушло: **важное**", { agentKey: "backend" }),
    ).rejects.toThrow("network down");
    // Иначе висячая запись две минуты съедает первое совпадающее сообщение
    // владельца, набранное руками (аудит 2026-08-27).
    expect(_pendingSelfSends()).toBe(0);
  });
});
