/**
 * Аудит 2026-08-20: ответ делегата, доставленный наполовину, наверх уходил как
 * «делегат не ответил».
 *
 * `sendChunked` бросает ПОСЛЕ того, как k из N частей уже видны в чате, а
 * `deliveredReply = reply` в `respondAs` стояло строкой НИЖЕ. Значит в `catch`
 * накопленного не было, и функция возвращала `{status:"failed"}`. Дальше
 * action-dispatch закрывал строку доски как `failed` и отдавал модели
 * `delegate_failed: …` с `is_error`, а `shouldSkipSelfDiag` этот текст не
 * фильтрует — то есть ход повторялся дважды: моделью и самодиагностикой через
 * ~30с. Каждый повтор заново гонял платный прогон роли, заново делал её
 * side-effect'ы и дописывал ВЕСЬ ответ поверх уже видимой части 1.
 *
 * Инварианты: (1) что дошло — то записано в короткую память; (2) наверх это
 * «ответил», а не «провалился»; (3) в тексте наверх сказано, сколько частей уже
 * доставлено и что слепой повтор их продублирует — та же формулировка, что у
 * partialSendFailure в dispatch/telegram.ts.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { respondAs } from "../lib/handoff.ts";
import { CHARACTERS } from "../characters/index.ts";
import { db } from "../lib/db.ts";

const CHAT = "-1009021";
const DESIGN = CHARACTERS.find((c) => c.key === "design")!;
const USERNAME = "delabs_design_bot";

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
 * Прогнать делегирование через настоящий `respondAs`.
 * `failOnCall` — номер вызова sendMessage, который сорвётся (1-based).
 */
async function delegate(failOnCall: number | null) {
  const outgoing: string[] = [];
  let calls = 0;
  const bot: any = {
    telegram: {
      sendChatAction: async () => {},
      sendMessage: async (_chat: string, text: string) => {
        calls += 1;
        // Не ошибка разметки: у sendWithHtml на неё есть плейн-фолбэк, и сбой
        // проглотился бы. 429 он пробрасывает — как настоящий Telegram.
        if (calls === failOnCall) throw new Error("429: Too Many Requests");
        outgoing.push(text);
        return { message_id: 3000 + calls, date: Math.floor(Date.now() / 1000) };
      },
    },
  };
  const running: any = { def: DESIGN, bot, username: USERNAME, id: 42 };
  const anthropic = fakeAnthropic();
  const outcome = await respondAs(
    {
      target: running,
      chatId: CHAT,
      triggerText: "распиши подробно",
      triggerAgentKey: "pm",
      depth: 1,
      visited: new Set(["pm"]),
    },
    { anthropic, model: "test-model", historyLimit: 30, bots: [running] },
  );
  return { outcome, outgoing };
}

function botTexts(): string[] {
  return (
    db
      .prepare(`SELECT text FROM messages WHERE chat_id = ? AND is_bot = 1 ORDER BY id`)
      .all(CHAT) as { text: string }[]
  ).map((r) => r.text);
}

beforeEach(() => {
  db.prepare(`DELETE FROM messages WHERE chat_id = ?`).run(CHAT);
});

describe("respondAs: частичная доставка — это не провал делегата", () => {
  test("сбой на второй части: наверх «ответил», а не failed", async () => {
    const { outcome, outgoing } = await delegate(2);
    // Первая часть у пользователя на экране...
    expect(outgoing.some((t) => t.includes("МАРКЕР-НАЧАЛО"))).toBe(true);
    expect(outgoing.some((t) => t.includes("МАРКЕР-КОНЕЦ"))).toBe(false);
    // ...значит «делегат не ответил» — это враньё, за которым идёт повтор хода.
    expect(outcome.status).toBe("answered");
  });

  test("в ответе наверх сказано, что доставлено и что повтор продублирует", async () => {
    const { outcome } = await delegate(2);
    expect(outcome.status).toBe("answered");
    const reply = (outcome as { status: "answered"; reply: string }).reply;
    // Доставленное — на месте, недоставленное — нет.
    expect(reply).toContain("МАРКЕР-НАЧАЛО");
    expect(reply).not.toContain("МАРКЕР-КОНЕЦ");
    // И прямой запрет на слепой повтор, а не только текст.
    expect(reply).toMatch(/Части 1\.\.1 уже доставлены/);
    expect(reply).toContain("продублирует");
    expect(reply).toContain("429");
  });

  test("доставленная часть попадает в короткую память", async () => {
    await delegate(2);
    const recorded = botTexts();
    expect(recorded.length).toBe(1);
    expect(recorded[0]).toContain("МАРКЕР-НАЧАЛО");
    expect(recorded[0]).not.toContain("МАРКЕР-КОНЕЦ");
  });

  test("сбой на ПЕРВОЙ части — это по-прежнему failed", async () => {
    // Ничего не доставлено — значит повторить ход можно и нужно. Правка не
    // должна превращать настоящий провал в «ответил».
    const { outcome, outgoing } = await delegate(1);
    expect(outgoing).toHaveLength(0);
    expect(outcome.status).toBe("failed");
    expect(botTexts()).toHaveLength(0);
  });

  test("без сбоя — answered с полным текстом, одна строка в памяти", async () => {
    const { outcome } = await delegate(null);
    expect(outcome.status).toBe("answered");
    const reply = (outcome as { status: "answered"; reply: string }).reply;
    expect(reply).toContain("МАРКЕР-НАЧАЛО");
    expect(reply).toContain("МАРКЕР-КОНЕЦ");
    // Никаких примечаний про частичность, когда доставлено всё.
    expect(reply).not.toContain("продублирует");
    const recorded = botTexts();
    expect(recorded.length).toBe(1);
    expect(recorded[0]).toContain("МАРКЕР-КОНЕЦ");
  });
});
