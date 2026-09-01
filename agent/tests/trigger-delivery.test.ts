/**
 * Аудит 2026-08-12: упомянутая роль могла отвечать, не увидев вопроса.
 *
 * Триггерное сообщение попадает в контекст двумя разными путями: либо оно уже
 * лежит в короткой памяти (его пишет ТОЛЬКО хендлер оркестратора, строка ~201),
 * либо хендлер дописывает его в хвост messages сам. Второй путь и есть страховка
 * от первого — но условие страховки было про РОЛЬ последнего сообщения:
 *
 *   if (!messages.length || messages.at(-1).role !== "user") push(trigger)
 *
 * Двенадцать ботов — двенадцать независимых long-polling циклов. Порядок, в
 * котором они получают один и тот же апдейт, не задан ничем: у упомянутой роли
 * между началом хода и чтением истории стоит await (sendChatAction), а у
 * оркестратора запись идёт синхронно, — но раньше или позже придёт его апдейт,
 * код не знает. Приходит позже — роль читает историю БЕЗ триггера, а последней
 * там лежит чужая реплика, то есть role "user", и условие молчит.
 *
 * Итог: агент отвечает на предыдущую реплику чата, вежливо и мимо. Ровно этот
 * дефект уже чинили в buildDelegateMessages (handoff.ts): там решают «по факту
 * доставки, а не по роли последнего сообщения». Правило было записано дважды и
 * во второй копии осталось старым — тот же класс, что и с футером канала.
 *
 * Инвариант: текст, на который агента позвали, обязан быть в запросе — и ровно
 * один раз (задвоенная реплика в хвосте истории читается моделью как повтор).
 *
 * Уточнение 2026-08-21: «ровно один раз» верно для двух состояний окна из трёх
 * — триггера нет вовсе и триггер лежит последним. Третье (триггер есть, но не
 * последний) не проверялось ни здесь, ни в исходном фиксе, и в нём инвариант
 * не держится: реплика дописывается вторым побайтово равным экземпляром.
 * Разменивать это нечем — «быть последним» и «быть однажды» для append
 * несовместимы, — поэтому третье состояние ниже зафиксировано КАК ЕСТЬ, а не
 * как хотелось бы. Тест сторожит не идеал, а осознанность: если поведение
 * поменяют, это будет решением, а не случайностью.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { registerMessageHandler } from "../orchestrator/message-handler.ts";
import { buildDelegateMessages } from "../lib/handoff.ts";
import { recordMessage } from "../lib/memory.ts";
import { CHARACTERS } from "../characters/index.ts";
import { db } from "../lib/db.ts";

const CHAT = -1009001;
const CHAT_S = String(CHAT);
const DESIGN = CHARACTERS.find((c) => c.key === "design")!;
const USERNAME = "delabs_design_bot";
const TRIGGER = `@${USERNAME} сделай баннер к посту про NEAR`;

function fakeAnthropic(captured: any[]) {
  return {
    messages: {
      create: async (req: any) => {
        captured.push(JSON.parse(JSON.stringify(req)));
        return {
          id: "m",
          type: "message",
          role: "assistant",
          model: "t",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
          content: [{ type: "text", text: "ок" }],
        } as unknown as Anthropic.Message;
      },
    },
  } as unknown as Anthropic;
}

/** Прогнать один входящий апдейт через настоящий хендлер роли. */
async function deliver(captured: any[]): Promise<void> {
  let handler: ((ctx: any) => Promise<void>) | null = null;
  const bot: any = {
    on: (_ev: string, h: any) => {
      handler = h;
    },
    telegram: {},
  };
  const running: any = { def: DESIGN, bot, username: USERNAME, id: 42 };
  const anthropic = fakeAnthropic(captured);
  registerMessageHandler(bot, DESIGN, running, {
    bots: [running],
    // Список fail-closed (lib/allowlist.ts): пустой запрещает всех.
    allowed: [CHAT_S],
    historyLimit: 30,
    anthropic,
    model: "test-model",
    handoffDeps: { anthropic, model: "test-model", historyLimit: 30, bots: [running] } as any,
  });

  const ctx: any = {
    chat: { id: CHAT },
    from: { id: 777, username: "petya", is_bot: false },
    message: {
      message_id: 1001,
      text: TRIGGER,
      // isMentioned читает именно entities, а не текст.
      entities: [{ type: "mention", offset: 0, length: USERNAME.length + 1 }],
    },
    sendChatAction: async () => {},
    reply: async () => ({ message_id: 1002, date: Math.floor(Date.now() / 1000) }),
  };
  await handler!(ctx);
}

beforeEach(() => {
  db.prepare(`DELETE FROM messages WHERE chat_id = ?`).run(CHAT_S);
});

describe("упомянутая роль видит вопрос, на который её позвали", () => {
  test("апдейт оркестратора ещё не пришёл — триггера в истории нет", async () => {
    // Предыдущая реплика чата — от человека, то есть role "user". Именно на ней
    // старое условие («последний не user?») и молчало.
    recordMessage({
      chatId: CHAT_S,
      agentKey: null,
      isBot: false,
      fromUserId: "777",
      fromName: "petya",
      text: "и вообще давайте уже запускаться",
      ts: Date.now() - 60_000,
    });

    const cap: any[] = [];
    await deliver(cap);

    expect(cap.length).toBeGreaterThan(0);
    const sent = JSON.stringify(cap[0].messages);
    expect(sent).toContain("сделай баннер к посту про NEAR");
  });

  test("оркестратор успел записать — реплика не задваивается", async () => {
    recordMessage({
      chatId: CHAT_S,
      agentKey: null,
      isBot: false,
      fromUserId: "777",
      fromName: "petya",
      text: TRIGGER,
      tgMessageId: 1001,
    });

    const cap: any[] = [];
    await deliver(cap);

    const texts = cap[0].messages.map((m: any) => String(m.content));
    const hits = texts.filter((t: string) => t.includes("сделай баннер к посту про NEAR"));
    expect(hits.length).toBe(1);
  });
});

describe("третье состояние: триггер в истории, но не последний", () => {
  test("реплика задваивается — это размен, а не случайность", async () => {
    recordMessage({
      chatId: CHAT_S, agentKey: null, isBot: false, fromUserId: "777",
      fromName: "petya", text: TRIGGER, tgMessageId: 1001, ts: Date.now() - 2000,
    });
    // Человек дописал вдогонку, пока роль была внутри хода: между записью
    // истории и её чтением у неё стоит await (sendChatAction).
    recordMessage({
      chatId: CHAT_S, agentKey: null, isBot: false, fromUserId: "777",
      fromName: "petya", text: "срочно", tgMessageId: 1002, ts: Date.now() - 1000,
    });

    const cap: any[] = [];
    await deliver(cap);
    const texts = cap[0].messages.map((m: any) => String(m.content));
    const hits = texts.filter((t: string) => t.includes("сделай баннер к посту про NEAR"));

    // Замер, а не пожелание: копий две, и они побайтово равны.
    expect(hits.length).toBe(2);
    expect(hits[0]).toBe(hits[1]);
    // Мандат при этом на месте и читается последним — ради этого размен и шёл.
    expect(String(texts[texts.length - 1])).toContain("сделай баннер к посту про NEAR");
  });

  test("при этом «срочно» из окна не пропадает", async () => {
    recordMessage({
      chatId: CHAT_S, agentKey: null, isBot: false, fromUserId: "777",
      fromName: "petya", text: TRIGGER, tgMessageId: 1001, ts: Date.now() - 2000,
    });
    recordMessage({
      chatId: CHAT_S, agentKey: null, isBot: false, fromUserId: "777",
      fromName: "petya", text: "срочно", tgMessageId: 1002, ts: Date.now() - 1000,
    });

    const cap: any[] = [];
    await deliver(cap);
    const texts = cap[0].messages.map((m: any) => String(m.content));
    expect(texts.some((t: string) => t.includes("срочно"))).toBe(true);
  });
});

describe("buildDelegateMessages: то же правило, тот же результат", () => {
  test("триггера нет в хвосте — дописывается", () => {
    const msgs = buildDelegateMessages(
      [{ text: "и вообще давайте уже запускаться", is_bot: 0, from_name: "petya" }],
      "design",
      "pm",
      "сделай баннер",
    );
    expect(JSON.stringify(msgs)).toContain("сделай баннер");
  });

  test("триггер уже в хвосте — не задваивается", () => {
    const msgs = buildDelegateMessages(
      [{ text: "сделай баннер", is_bot: 0, from_name: "pm" }],
      "design",
      "pm",
      "сделай баннер",
    );
    const hits = msgs.filter((m) => String(m.content).includes("сделай баннер"));
    expect(hits.length).toBe(1);
  });
});
