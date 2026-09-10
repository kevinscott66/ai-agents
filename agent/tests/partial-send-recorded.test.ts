/**
 * Аудит 2026-08-13: ответ, доставленный наполовину, исчезал из короткой памяти.
 *
 * Длинный ответ уходит несколькими сообщениями (`sendChunked`), и падение на
 * k-м — 429 после ретраев, сетевой сбой, бот выкинут из чата — бросало наружу.
 * `recordMessage` стоит СЛЕДУЮЩЕЙ строкой, до неё дело не доходило.
 *
 * Итог: у пользователя на экране k сообщений ответа, а в истории чата ответа
 * нет вовсе. Следующим ходом агент читает короткую память, своего ответа там не
 * находит и делает работу заново — тем же дорогим ходом, с теми же
 * инструментами, и отвечает второй раз. Ровно тот сценарий, ради которого
 * короткая память и заводилась.
 *
 * Инвариант: что дошло до пользователя — то записано, даже если дошло не всё.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { registerMessageHandler } from "../orchestrator/message-handler.ts";
import { CHARACTERS } from "../characters/index.ts";
import { sendChunked } from "../lib/telegram-chunking.ts";
import { db } from "../lib/db.ts";

const CHAT = -1009002;
const CHAT_S = String(CHAT);
const DESIGN = CHARACTERS.find((c) => c.key === "design")!;
const USERNAME = "delabs_design_bot";
const TRIGGER = `@${USERNAME} распиши подробно`;

/** Ответ заведомо длиннее одного сообщения: два абзаца по ~3000 символов. */
const HEAD = "МАРКЕР-НАЧАЛО " + "первая половина ответа. ".repeat(120);
const TAIL = "МАРКЕР-КОНЕЦ " + "вторая половина ответа. ".repeat(120);
const REPLY = `${HEAD}\n\n${TAIL}`;

function fakeAnthropic(): Anthropic {
  return {
    messages: {
      create: async () =>
        ({
          id: "m",
          type: "message",
          role: "assistant",
          model: "t",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
          content: [{ type: "text", text: REPLY }],
        }) as unknown as Anthropic.Message,
    },
  } as unknown as Anthropic;
}

/**
 * Прогнать апдейт через настоящий хендлер роли.
 * `failOnCall` — номер вызова ctx.reply, который сорвётся (1-based).
 */
async function deliver(failOnCall: number | null): Promise<string[]> {
  let handler: ((ctx: any) => Promise<void>) | null = null;
  const bot: any = { on: (_ev: string, h: any) => { handler = h; }, telegram: {} };
  const running: any = { def: DESIGN, bot, username: USERNAME, id: 42 };
  const anthropic = fakeAnthropic();
  registerMessageHandler(bot, DESIGN, running, {
    bots: [running],
    allowed: [CHAT_S],
    historyLimit: 30,
    anthropic,
    model: "test-model",
    handoffDeps: { anthropic, model: "test-model", historyLimit: 30, bots: [running] } as any,
  });

  const outgoing: string[] = [];
  let calls = 0;
  const ctx: any = {
    chat: { id: CHAT },
    from: { id: 777, username: "petya", is_bot: false },
    message: {
      message_id: 2001,
      text: TRIGGER,
      entities: [{ type: "mention", offset: 0, length: USERNAME.length + 1 }],
    },
    sendChatAction: async () => {},
    reply: async (text: string) => {
      calls += 1;
      // Не ошибка разметки: у sendWithHtml на неё есть плейн-фолбэк, и сбой
      // проглотился бы. 429 он пробрасывает — как настоящий Telegram.
      if (calls === failOnCall) throw new Error("429: Too Many Requests");
      outgoing.push(text);
      return { message_id: 3000 + calls, date: Math.floor(Date.now() / 1000) };
    },
  };
  await handler!(ctx);
  return outgoing;
}

function botTexts(): string[] {
  return (
    db
      .prepare(`SELECT text FROM messages WHERE chat_id = ? AND is_bot = 1 ORDER BY id`)
      .all(CHAT_S) as { text: string }[]
  ).map((r) => r.text);
}

beforeEach(() => {
  db.prepare(`DELETE FROM messages WHERE chat_id = ?`).run(CHAT_S);
  // Аудит 2026-09-11: дедуп триггеров стал считать роль, и роли, отличные
  // от оркестратора, теперь тоже через него проходят. Сценарии ниже
  // переиспользуют ОДИН message_id как разные входящие апдейты, поэтому
  // второй и дальше отсекались бы как дубли. Чистим кэш дедупа, а не
  // раздаём тестам разные id: id здесь часть фикстуры «пришло вот это».
  db.prepare(`DELETE FROM processed_triggers WHERE chat_id = ?`).run(CHAT_S);
});

describe("ответ, доставленный частично, всё равно попадает в историю", () => {
  test("сбой на второй части — первая записана", async () => {
    const outgoing = await deliver(2);
    // Первая часть у пользователя на экране...
    expect(outgoing.some((t) => t.includes("МАРКЕР-НАЧАЛО"))).toBe(true);
    expect(outgoing.some((t) => t.includes("МАРКЕР-КОНЕЦ"))).toBe(false);

    // ...значит она обязана быть и в короткой памяти.
    const recorded = botTexts().filter((t) => t.includes("МАРКЕР-НАЧАЛО"));
    expect(recorded.length).toBe(1);
    expect(recorded[0]).not.toContain("МАРКЕР-КОНЕЦ");
  });

  test("сбой на первой части — записывать нечего, лишней строки не появляется", async () => {
    await deliver(1);
    expect(botTexts().length).toBe(0);
  });

  test("без сбоя — записан весь ответ, ровно одной строкой", async () => {
    await deliver(null);
    const recorded = botTexts();
    expect(recorded.length).toBe(1);
    expect(recorded[0]).toContain("МАРКЕР-НАЧАЛО");
    expect(recorded[0]).toContain("МАРКЕР-КОНЕЦ");
  });
});

describe("sendChunked сообщает о каждой доставленной части", () => {
  test("часть отдаётся без счётчика «(i/N) »", async () => {
    const parts: string[] = [];
    await sendChunked(async (t) => ({ ok: t }), REPLY, (_s, part) => parts.push(part));
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => !p.startsWith("("))).toBe(true);
    expect(parts[0]).toContain("МАРКЕР-НАЧАЛО");
  });

  test("о непрошедшей части не сообщается", async () => {
    const parts: string[] = [];
    let n = 0;
    await expect(
      sendChunked(
        async () => {
          n += 1;
          if (n === 2) throw new Error("429: Too Many Requests");
          return { ok: true };
        },
        REPLY,
        (_s, part) => parts.push(part),
      ),
    ).rejects.toThrow("429");
    expect(parts.length).toBe(1);
  });

  test("callback необязателен — старые вызывающие не сломаны", async () => {
    const last = await sendChunked(async (t) => ({ echo: t }), "коротко");
    expect(last).toEqual({ echo: "коротко" });
  });
});
