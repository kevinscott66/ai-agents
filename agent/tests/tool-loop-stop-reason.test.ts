/**
 * Необычная остановка хода перестаёт быть молчанием (аудит 2026-08-04).
 *
 * Цикл выходил на ЛЮБОМ stop_reason кроме tool_use, отдавая накопленный текст.
 * Два следствия:
 *
 *  - `max_tokens` (потолок MAX_REPLY_TOKENS, по умолчанию 1500) на середине
 *    tool_use-блока оставляет lastText пустым → оркестратор делает
 *    `if (!reply) return` и бот в чате МОЛЧИТ. Со стороны это «бот сломался»,
 *    а не «ответ не поместился».
 *  - `pause_turn` (возможен при включённом серверном web_search) означает
 *    «продолжи ход с тем же контекстом», а трактовался как конец: половина
 *    ответа вместе с уже оплаченным поиском выбрасывалась.
 *
 * `end_turn` с пустым текстом остаётся пустым сознательно: агент уже всё сказал
 * инструментом, добавленный текст стал бы дублем в чате.
 */
import { describe, test, expect } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { runWithTools, explainEmptyStop } from "../lib/tool-loop.ts";

const base = {
  model: "t",
  system: [{ type: "text" as const, text: "s" }],
  messages: [{ role: "user" as const, content: "сделай" }],
  agentKey: "orchestrator",
  chatId: -1,
};

/** Модель, отдающая заранее заданную последовательность ответов. */
function scripted(steps: Array<Partial<Anthropic.Message>>, captured: any[]) {
  let i = 0;
  return {
    messages: {
      create: async (req: any) => {
        captured.push(req);
        const s = steps[Math.min(i++, steps.length - 1)];
        return {
          id: "m",
          type: "message",
          role: "assistant",
          model: "t",
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
          content: [],
          stop_reason: "end_turn",
          ...s,
        } as unknown as Anthropic.Message;
      },
    },
  } as unknown as Anthropic;
}

describe("explainEmptyStop", () => {
  test("end_turn — пусто (агент ответил инструментом)", () => {
    expect(explainEmptyStop("end_turn")).toBe("");
    expect(explainEmptyStop(null)).toBe("");
  });

  test("max_tokens — объясняет обрыв по длине", () => {
    expect(explainEmptyStop("max_tokens")).toMatch(/лимит длины/i);
  });

  test("refusal — говорит про отказ", () => {
    expect(explainEmptyStop("refusal")).toMatch(/отказ/i);
  });

  test("незнакомая причина попадает в текст", () => {
    // Чтобы новая причина остановки не превратилась снова в тишину.
    expect(explainEmptyStop("something_new")).toMatch(/something_new/);
  });
});

describe("runWithTools и stop_reason", () => {
  test("max_tokens без текста → объяснение, а не пустая строка", async () => {
    const cap: any[] = [];
    const out = await runWithTools({
      ...base,
      anthropic: scripted([{ stop_reason: "max_tokens", content: [] }], cap),
    });
    expect(out).not.toBe("");
    expect(out).toMatch(/лимит длины/i);
  });

  test("max_tokens с текстом → отдаём текст как раньше", async () => {
    const cap: any[] = [];
    const out = await runWithTools({
      ...base,
      anthropic: scripted(
        [
          {
            stop_reason: "max_tokens",
            content: [{ type: "text", text: "начал отвеч" }] as any,
          },
        ],
        cap,
      ),
    });
    expect(out).toBe("начал отвеч");
  });

  test("end_turn без текста остаётся пустым", async () => {
    // Иначе к сообщению, отправленному через SEND_MESSAGE, добавился бы дубль.
    const cap: any[] = [];
    const out = await runWithTools({
      ...base,
      anthropic: scripted([{ stop_reason: "end_turn", content: [] }], cap),
    });
    expect(out).toBe("");
  });

  test("pause_turn продолжает ход, а не заканчивает его", async () => {
    const cap: any[] = [];
    const out = await runWithTools({
      ...base,
      anthropic: scripted(
        [
          { stop_reason: "pause_turn", content: [] },
          {
            stop_reason: "end_turn",
            content: [{ type: "text", text: "нашёл и отвечаю" }] as any,
          },
        ],
        cap,
      ),
    });
    expect(cap).toHaveLength(2);
    expect(out).toBe("нашёл и отвечаю");
  });

  test("бесконечная пауза упирается в лимит раундов, а не висит", async () => {
    // Контроль на зацикливание: `continue` безопасен только потому, что цикл
    // ограничен MAX_TOOL_ITERS.
    const cap: any[] = [];
    const iters = Number.parseInt(process.env.MAX_TOOL_ITERS ?? "14", 10) || 14;
    await runWithTools({
      ...base,
      anthropic: scripted([{ stop_reason: "pause_turn", content: [] }], cap),
    });
    // iters раундов + один финализирующий вызов.
    expect(cap.length).toBeLessThanOrEqual(iters + 1);
  });
});
