/**
 * Аудит 2026-08-20 — отправки userbot'а возвращались в историю как реплики
 * владельца.
 *
 * `makeHandler` подписан на `new NewMessage({})` (userbot.ts) — без
 * `outgoing:false`, то есть исходящие сообщения аккаунта приезжают в ингест
 * наравне с чужими. Фильтр `ownBotIds` в `makeUserbotRecorder` их не ловит: он
 * знает id роль-ботов, а userbot шлёт от ЛИЧНОГО аккаунта владельца. Итог —
 * `record({ isBot:false, agentKey:null })` на каждый кусок `sendChunked`, и в
 * промпте следующего хода собственный текст команды выглядит как указание
 * владельца.
 *
 * Глухой `if (msg.out) return` (так сделано в обработчике NewMessage у
 * orchestrator-userbot.ts —
 * командный путь в личке) здесь был бы второй регрессией: набранные руками
 * сообщения владельца в группе идут ровно этим же путём, и другого источника у
 * них нет — роль-боты работают с privacy mode и чужих реплик не видят.
 */
import { describe, expect, it, beforeEach } from "bun:test";
import { makeUserbotRecorder, type UserbotIngestMessage } from "../lib/userbot-ingest.ts";
import {
  markSelfSend,
  consumeSelfSend,
  normalizeChatId,
  _resetSelfSends,
  _pendingSelfSends,
} from "../lib/userbot-self-sends.ts";
import { buildHandle, makeHandler } from "../lib/userbot.ts";

const CHAT = "-1001234567890";

function incoming(over: Partial<UserbotIngestMessage> = {}): UserbotIngestMessage {
  return {
    chatId: CHAT,
    messageId: 7,
    fromUserId: "555",
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
});

describe("реестр собственных отправок", () => {
  it("снимается ровно один раз на регистрацию", () => {
    markSelfSend(CHAT, "привет");
    expect(consumeSelfSend(CHAT, "привет")).toBe(true);
    expect(consumeSelfSend(CHAT, "привет")).toBe(false);
  });

  it("считает повторы одного текста", () => {
    markSelfSend(CHAT, "дубль");
    markSelfSend(CHAT, "дубль");
    expect(_pendingSelfSends()).toBe(2);
    expect(consumeSelfSend(CHAT, "дубль")).toBe(true);
    expect(consumeSelfSend(CHAT, "дубль")).toBe(true);
    expect(consumeSelfSend(CHAT, "дубль")).toBe(false);
  });

  it("не путает чаты и тексты", () => {
    markSelfSend(CHAT, "а");
    expect(consumeSelfSend("-1009999999999", "а")).toBe(false);
    expect(consumeSelfSend(CHAT, "б")).toBe(false);
    expect(consumeSelfSend(CHAT, "а")).toBe(true);
  });

  it("-100 из allowlist и голый id из апдейта — один чат", () => {
    markSelfSend("-1001234567890", "нормализация");
    expect(consumeSelfSend("1234567890", "нормализация")).toBe(true);
    expect(normalizeChatId("-1001234567890")).toBe(normalizeChatId("1234567890"));
  });

  it("пустой текст не регистрируется и ни с чем не совпадает", () => {
    markSelfSend(CHAT, "");
    expect(_pendingSelfSends()).toBe(0);
    expect(consumeSelfSend(CHAT, "")).toBe(false);
  });

  it("реестр ограничен сверху — эхо может и не прийти", () => {
    for (let i = 0; i < 500; i++) markSelfSend(CHAT, `текст-${i}`);
    expect(_pendingSelfSends()).toBeLessThanOrEqual(200);
    // Последние отправки — те, чьё эхо ещё в пути, — уцелели.
    expect(consumeSelfSend(CHAT, "текст-499")).toBe(true);
  });
});

describe("makeHandler отдаёт признак исходящего", () => {
  function handlerFor(): { seen: any[]; h: (e: any) => Promise<void> } {
    const seen: any[] = [];
    const h = makeHandler({
      allowedChatIds: [CHAT],
      onMessage: (m) => seen.push(m),
    } as any);
    return { seen, h };
  }

  it("msg.out=true доезжает как isOutgoing", async () => {
    const { seen, h } = handlerFor();
    await h({ message: { chatId: CHAT, id: 1, message: "своё", out: true } });
    expect(seen[0].isOutgoing).toBe(true);
  });

  it("чужое сообщение — isOutgoing=false, а не undefined", async () => {
    const { seen, h } = handlerFor();
    await h({ message: { chatId: CHAT, id: 2, message: "чужое" } });
    expect(seen[0].isOutgoing).toBe(false);
  });
});

describe("граница ингеста", () => {
  it("эхо собственной отправки не пишется в историю", () => {
    const { rows, rec } = recorder();
    markSelfSend(CHAT, "ответ команды");
    rec(incoming({ text: "ответ команды", isOutgoing: true }));
    expect(rows).toHaveLength(0);
  });

  it("каждый кусок sendChunked гасится своим эхом", () => {
    const { rows, rec } = recorder();
    const chunks = ["часть 1", "часть 2", "часть 3"];
    for (const c of chunks) markSelfSend(CHAT, c);
    chunks.forEach((c, i) => rec(incoming({ text: c, messageId: 10 + i, isOutgoing: true })));
    expect(rows).toHaveLength(0);
  });

  it("владелец набрал руками — пишется, хотя тоже исходящее", () => {
    const { rows, rec } = recorder();
    rec(incoming({ text: "сделайте дайджест", isOutgoing: true }));
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("сделайте дайджест");
    expect(rows[0].isBot).toBe(false);
  });

  it("владелец повторил текст бота — гасится только одна строка", () => {
    const { rows, rec } = recorder();
    markSelfSend(CHAT, "ок");
    rec(incoming({ text: "ок", messageId: 20, isOutgoing: true }));
    rec(incoming({ text: "ок", messageId: 21, isOutgoing: true }));
    expect(rows).toHaveLength(1);
    expect(rows[0].tgMessageId).toBe(21);
  });

  it("входящее чужое сообщение с тем же текстом не тратит регистрацию", () => {
    const { rows, rec } = recorder();
    markSelfSend(CHAT, "ок");
    rec(incoming({ text: "ок", fromUserId: "777", messageId: 30 }));
    expect(rows).toHaveLength(1);
    expect(_pendingSelfSends()).toBe(1);
  });

  it("свой бот по-прежнему отсекается по ownBotIds", () => {
    const { rows, rec } = recorder();
    rec(incoming({ fromUserId: "999" }));
    expect(rows).toHaveLength(0);
  });

  it("сервисное исходящее пишется — пустой текст не эхо", () => {
    const { rows, rec } = recorder();
    rec(incoming({ text: "", isService: true, isOutgoing: true }));
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("[service] <no-text>");
  });
});

describe("buildHandle регистрирует отправку", () => {
  it("sendMessage помечает текст ДО ухода запроса", async () => {
    let markedAtCallTime = false;
    const client: any = {
      getInputEntity: async (id: any) => id,
      sendMessage: async () => {
        markedAtCallTime = consumeSelfSend(CHAT, "живой текст");
        return { id: 42 };
      },
    };
    const h = buildHandle(client, {} as any);
    const res = await h.sendMessage(CHAT, "живой текст");
    expect(res.message_id).toBe(42);
    // Регистрация существовала уже внутри вызова API — окно гонки закрыто.
    expect(markedAtCallTime).toBe(true);
  });

  it("пустой текст отправки реестр не засоряет", async () => {
    const client: any = {
      getInputEntity: async (id: any) => id,
      sendMessage: async () => ({ id: 1 }),
    };
    await buildHandle(client, {} as any).sendMessage(CHAT, "");
    expect(_pendingSelfSends()).toBe(0);
  });
});
