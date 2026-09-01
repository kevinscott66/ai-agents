/**
 * Аудит 2026-08-28: отправка агента через userbot исчезала из истории чата.
 *
 * `userbot-ingest.ts` глушил эхо собственной отправки безусловно, опираясь на
 * то, что «ответ уже записан Bot API-путём». Для ответа оркестратора это
 * правда — `message-handler.ts` зовёт `recordMessage` сам. Для MTProto-отправки
 * второго писателя НЕТ: `dispatch/telegram.ts` в ветке userbot дёргает только
 * `ub.sendMessage`, и никакого `recordMessage` на этом пути нет вовсе.
 *
 * То есть всё, что роль сказала от лица владельца, из `messages` пропадало — а
 * значит, и из краткосрочной памяти следующего хода. Агент спрашивает от лица
 * владельца «сносим прод?», человек отвечает «да», и агент видит только «да»,
 * без своего вопроса. Заметка в шапке `userbot-self-sends.ts` (правка (а) от
 * 2026-08-27) этот факт уже фиксировала, но как объяснение, а не как дефект.
 *
 * Чинить дропом наоборот нельзя: писать эхо как реплику владельца — это ровно
 * дыра 2026-08-20, слова агента возвращаются в промпт как указания человека.
 * Поэтому регистрация носит `agentKey`, и совпадение пишется с атрибуцией
 * отправителя. Публикация в канал роли-автора в этом смысле не имеет —
 * у неё `agentKey` нет, и она по-прежнему только глушится.
 *
 * Инварианты 2026-08-20 и 2026-08-28 (мульти-сессия) обязаны выжить, поэтому
 * продублированы здесь же: чужое сообщение с тем же текстом пишется как
 * человеческое и НЕ тратит регистрацию, а одна отправка не даёт двух строк,
 * сколько бы сессий её ни увидело.
 */
import { describe, expect, it, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import {
  makeUserbotRecorder,
  type UserbotIngestMessage,
} from "../lib/userbot-ingest.ts";
import {
  markSelfSend,
  unmarkSelfSend,
  consumeSelfSend,
  consumeSelfSendMeta,
  markSelfAccount,
  _resetSelfSends,
  _resetSelfAccounts,
  _pendingSelfSends,
} from "../lib/userbot-self-sends.ts";

const CHAT = "-1001234567890";
/** Личный аккаунт владельца — от него уходит userbot. */
const OWNER = "555";

const DISPATCH_SRC = readFileSync(
  new URL("../lib/dispatch/telegram.ts", import.meta.url),
  "utf8",
);
const USERBOT_SRC = readFileSync(
  new URL("../lib/userbot.ts", import.meta.url),
  "utf8",
);

function incoming(over: Partial<UserbotIngestMessage> = {}): UserbotIngestMessage {
  return {
    chatId: CHAT,
    messageId: 7,
    fromUserId: OWNER,
    fromName: "Owner",
    text: "текст",
    isService: false,
    ...over,
  };
}

function recorder() {
  const rows: any[] = [];
  const rec = makeUserbotRecorder({
    ownBotIds: ["999"],
    record: ((r: any) => {
      rows.push(r);
    }) as any,
  });
  return { rows, rec };
}

beforeEach(() => {
  _resetSelfSends();
  _resetSelfAccounts();
});

describe("отправка роли доезжает до истории", () => {
  it("эхо пишется с атрибуцией роли, а не пропадает", () => {
    const { rows, rec } = recorder();
    markSelfSend(CHAT, "сносим прод?", "backend");
    rec(incoming({ text: "сносим прод?", messageId: 42, isOutgoing: true }));
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("сносим прод?");
    expect(rows[0].agentKey).toBe("backend");
    expect(rows[0].transport).toBe("userbot");
    expect(rows[0].tgMessageId).toBe(42);
  });

  it("не как реплика человека — дыра 2026-08-20 не вернулась", () => {
    const { rows, rec } = recorder();
    markSelfSend(CHAT, "выложил черновик", "smm");
    rec(incoming({ text: "выложил черновик", messageId: 43, isOutgoing: true }));
    expect(rows[0].isBot).toBe(true);
    expect(rows[0].agentKey).not.toBeNull();
  });

  it("отправка без роли (публикация в канал) по-прежнему только глушится", () => {
    const { rows, rec } = recorder();
    markSelfSend(CHAT, "пост в канал");
    rec(incoming({ text: "пост в канал", messageId: 44, isOutgoing: true }));
    expect(rows).toHaveLength(0);
  });

  it("одна отправка — одна строка, сколько бы сессий её ни увидело", () => {
    const { rows, rec } = recorder();
    markSelfAccount(OWNER);
    markSelfSend(CHAT, "готово", "pm");
    // Сессия-отправитель.
    rec(incoming({ text: "готово", messageId: 45, isOutgoing: true }));
    // Соседняя сессия роутера: для неё то же сообщение — входящее.
    rec(incoming({ text: "готово", messageId: 45, isOutgoing: false }));
    expect(rows).toHaveLength(1);
    expect(rows[0].agentKey).toBe("pm");
  });

  it("чужое сообщение с тем же текстом пишется как человеческое", () => {
    // Инвариант 2026-08-20: регистрацию тратит только своё сообщение.
    const { rows, rec } = recorder();
    markSelfSend(CHAT, "ок", "qa");
    rec(
      incoming({
        text: "ок",
        messageId: 46,
        fromUserId: "777",
        fromName: "Кто-то",
        isOutgoing: false,
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].isBot).toBe(false);
    expect(rows[0].agentKey).toBeNull();
    // Регистрация цела и ждёт настоящего эха.
    expect(_pendingSelfSends()).toBe(1);
  });

  it("после провала отправки регистрация снята — эхо не подменяется", () => {
    const { rows, rec } = recorder();
    markSelfSend(CHAT, "не ушло", "design");
    unmarkSelfSend(CHAT, "не ушло");
    // Владелец набрал тот же текст руками — это человеческая реплика.
    rec(incoming({ text: "не ушло", messageId: 47, isOutgoing: true }));
    expect(rows).toHaveLength(1);
    expect(rows[0].isBot).toBe(false);
  });
});

describe("реестр отправок", () => {
  it("consumeSelfSendMeta отдаёт роль и снимает регистрацию", () => {
    markSelfSend(CHAT, "раз", "backend");
    expect(consumeSelfSendMeta(CHAT, "раз")).toEqual({ agentKey: "backend" });
    expect(consumeSelfSendMeta(CHAT, "раз")).toBeNull();
  });

  it("роли нет — meta всё равно отдаётся, с null", () => {
    markSelfSend(CHAT, "два");
    expect(consumeSelfSendMeta(CHAT, "два")).toEqual({ agentKey: null });
  });

  it("consumeSelfSend остался булевым", () => {
    markSelfSend(CHAT, "три", "pm");
    expect(consumeSelfSend(CHAT, "три")).toBe(true);
    expect(consumeSelfSend(CHAT, "три")).toBe(false);
  });

  it("одинаковый текст от разных ролей разбирается по очереди", () => {
    markSelfSend(CHAT, "ок", "backend");
    markSelfSend(CHAT, "ок", "qa");
    expect(consumeSelfSendMeta(CHAT, "ок")).toEqual({ agentKey: "backend" });
    expect(consumeSelfSendMeta(CHAT, "ок")).toEqual({ agentKey: "qa" });
  });

  it("пустой текст не регистрируется и с ролью", () => {
    markSelfSend(CHAT, "", "backend");
    expect(_pendingSelfSends()).toBe(0);
    expect(consumeSelfSendMeta(CHAT, "")).toBeNull();
  });
});

describe("проводка атрибуции", () => {
  it("диспатч передаёт роль в userbot-отправку", () => {
    expect(DISPATCH_SRC).toContain("agentKey: ctx.agentKey,");
  });

  it("userbot регистрирует отправку вместе с ролью", () => {
    // `registered`, а не `text`: gramjs применяет к тексту свой парс-мод, и в
    // реестр обязан лечь тот вариант, который реально уедет в Telegram
    // (аудит 2026-08-28, audit-2026-08-28-userbot-markdown-self-echo).
    expect(USERBOT_SRC).toContain("markSelfSend(chatId, registered, opts?.agentKey)");
    // Публикация в канал роль не носит — там дроп и остаётся.
    expect(USERBOT_SRC).toContain("markSelfSend(channelId, plain)");
  });
});
