/**
 * Аудит 2026-08-28: гашение эха держалось на `isOutgoing`, а этот флаг верен
 * только для сессии-ОТПРАВИТЕЛЯ.
 *
 * `orchestrator/services.ts` отдаёт ОДИН рекордер и синглтонному userbot'у, и
 * per-character сессиям роутера (T-401). Как только рядом с синглтоном
 * поднимается вторая сессия, одно и то же сообщение приезжает в ингест дважды:
 * отправителю как исходящее, соседу — как обычное ВХОДЯЩЕЕ от чужого аккаунта.
 * Регистрация в `userbot-self-sends.ts` при этом одна: её тратит первая
 * пришедшая копия, вторая записывается как реплика человека
 * (`isBot:false`, `agentKey:null`) — то есть дыра, закрытая аудитом
 * 2026-08-20, воскресала от одного включения роутера, и слова агента снова
 * уезжали в промпт следующего хода как указания владельца.
 *
 * Обычный дедуп `recordMessage` по (chat_id, tg_message_id) тут не помогает:
 * строки нет вовсе — первую копию мы сознательно не пишем.
 *
 * Две части починки, и обе проверяются ниже:
 *  1. опознанные своими (chatId, messageId) помнятся в рекордере, поэтому
 *     любая следующая копия того же сообщения глохнет независимо от сессии;
 *  2. на ВХОДЯЩЕЙ копии текстовая проверка включается, только если отправитель
 *     — один из наших же MTProto-аккаунтов (`markSelfAccount`, заполняется из
 *     `getMe()` при подключении). Без этого признака входящее чужое сообщение
 *     с тем же текстом по-прежнему НЕ тратит регистрацию — инвариант
 *     2026-08-20, у него свой тест в соседнем файле, дублируем и здесь.
 */
import { describe, expect, it, beforeEach } from "bun:test";
import { makeUserbotRecorder, type UserbotIngestMessage } from "../lib/userbot-ingest.ts";
import {
  markSelfSend,
  markSelfAccount,
  isSelfAccount,
  _resetSelfSends,
  _resetSelfAccounts,
  _pendingSelfSends,
} from "../lib/userbot-self-sends.ts";
import { registerSelfAccount, type UserbotClientLike } from "../lib/userbot.ts";

const CHAT = "-1001234567890";
/** Личный аккаунт владельца — от него уходит синглтонный userbot. */
const OWNER = "555";
/** Аккаунт per-character сессии роутера. */
const AGENT_ACCOUNT = "444";

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

/** Один рекордер на все сессии — ровно как в orchestrator/services.ts. */
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

describe("две сессии видят одно сообщение", () => {
  it("копия для соседней сессии больше не пишется как реплика человека", () => {
    const { rows, rec } = recorder();
    markSelfAccount(OWNER);
    markSelfSend(CHAT, "ответ команды");
    // Сессия-отправитель: исходящее, регистрация тратится.
    rec(incoming({ text: "ответ команды", messageId: 42, isOutgoing: true }));
    // Соседняя сессия: то же сообщение, но для неё оно входящее.
    rec(incoming({ text: "ответ команды", messageId: 42, isOutgoing: false }));
    expect(rows).toHaveLength(0);
  });

  it("обратный порядок прихода даёт тот же результат", () => {
    const { rows, rec } = recorder();
    markSelfAccount(AGENT_ACCOUNT);
    markSelfSend(CHAT, "готово, выложил");
    // Сначала соседняя сессия — опознаём по реестру аккаунтов.
    rec(
      incoming({
        text: "готово, выложил",
        messageId: 43,
        fromUserId: AGENT_ACCOUNT,
        isOutgoing: false,
      }),
    );
    // Потом сама отправившая — регистрации уже нет, спасает память по id.
    rec(
      incoming({
        text: "готово, выложил",
        messageId: 43,
        fromUserId: AGENT_ACCOUNT,
        isOutgoing: true,
      }),
    );
    expect(rows).toHaveLength(0);
  });

  it("ответ нашего бота глохнет во всех сессиях", () => {
    const { rows, rec } = recorder();
    rec(incoming({ fromUserId: "999", messageId: 44 }));
    rec(incoming({ fromUserId: "999", messageId: 44 }));
    expect(rows).toHaveLength(0);
  });

  it("память по id не глушит соседние сообщения того же чата", () => {
    const { rows, rec } = recorder();
    markSelfAccount(OWNER);
    markSelfSend(CHAT, "эхо");
    rec(incoming({ text: "эхо", messageId: 50, isOutgoing: true }));
    rec(incoming({ text: "а это уже человек", messageId: 51, fromUserId: "777" }));
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("а это уже человек");
  });
});

describe("инвариант 2026-08-20 не тронут", () => {
  it("входящее от НЕзарегистрированного аккаунта не тратит регистрацию", () => {
    const { rows, rec } = recorder();
    markSelfSend(CHAT, "ок");
    rec(incoming({ text: "ок", fromUserId: "777", messageId: 60 }));
    expect(rows).toHaveLength(1);
    expect(_pendingSelfSends()).toBe(1);
  });

  it("владелец пишет руками с нашего же аккаунта — пишется, регистрации нет", () => {
    const { rows, rec } = recorder();
    markSelfAccount(OWNER);
    rec(incoming({ text: "сделайте дайджест", messageId: 61, isOutgoing: true }));
    expect(rows).toHaveLength(1);
    expect(rows[0].isBot).toBe(false);
  });

  it("совпал текст, но регистрация одна — гасится ровно одна копия", () => {
    const { rows, rec } = recorder();
    markSelfAccount(OWNER);
    markSelfSend(CHAT, "ок");
    rec(incoming({ text: "ок", messageId: 70, isOutgoing: true }));
    rec(incoming({ text: "ок", messageId: 71, isOutgoing: true }));
    expect(rows).toHaveLength(1);
    expect(rows[0].tgMessageId).toBe(71);
  });

  it("пустой текст (сервисное) не совпадает ни с чем", () => {
    const { rows, rec } = recorder();
    markSelfAccount(OWNER);
    rec(incoming({ text: "", isService: true, messageId: 80, isOutgoing: true }));
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("[service] <no-text>");
  });
});

describe("реестр собственных аккаунтов", () => {
  it("пустые значения не попадают в реестр", () => {
    markSelfAccount(null);
    markSelfAccount("");
    markSelfAccount(0);
    expect(isSelfAccount(null)).toBe(false);
    expect(isSelfAccount("")).toBe(false);
    expect(isSelfAccount("0")).toBe(false);
  });

  it("id из getMe() записывается", async () => {
    const client = {
      getMe: async () => ({ id: 12345 }),
    } as unknown as UserbotClientLike;
    await registerSelfAccount(client);
    expect(isSelfAccount("12345")).toBe(true);
    expect(isSelfAccount(12345)).toBe(true);
  });

  it("клиент без getMe не роняет запуск", async () => {
    await registerSelfAccount({} as unknown as UserbotClientLike);
    expect(isSelfAccount("12345")).toBe(false);
  });

  it("падение getMe не роняет запуск — просто реестр пуст", async () => {
    const client = {
      getMe: async () => {
        throw new Error("AUTH_KEY_UNREGISTERED");
      },
    } as unknown as UserbotClientLike;
    await registerSelfAccount(client);
    expect(isSelfAccount("12345")).toBe(false);
  });
});
