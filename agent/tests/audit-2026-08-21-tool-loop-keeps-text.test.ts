/**
 * Аудит 2026-08-21: реплика, сказанная в середине хода, пропадала вместе с
 * лимитом раундов.
 *
 * `lastText` в runWithTools перезаписывается на КАЖДОЙ итерации, в том числе
 * пустой строкой — а ход с tool_use сплошь и рядом идёт без текста. Трём
 * читателям переменной это и нужно: на ветках «модель закончила» и «tool_use
 * без блоков» вернуть надо ровно то, что сказано сейчас.
 *
 * Четвёртому читателю — заглушке после исчерпания MAX_TOOL_ITERS — нужно
 * обратное. До этой строки доходят только через предел, то есть последняя
 * итерация просила инструмент и текста не несла: `lastText` там заведомо
 * пуст. Всё, что модель наговорила раньше, выбрасывалось, и вызывающий
 * получал «(достигнут предел шагов…)» вместо готовой ссылки на картинку.
 *
 * Замер до правки: модель на первой итерации отвечает
 * «Картинка готова, вот ссылка: https://x/y.png» и просит инструмент,
 * финализирующий вызов падает — на выходе одна заглушка.
 */
import { describe, test, expect } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { runWithTools } from "../lib/tool-loop.ts";

const STUB = "(достигнут предел шагов инструментов";
const SPOKEN = "Картинка готова, вот ссылка: https://x/y.png";

const base = {
  model: "t",
  system: [{ type: "text" as const, text: "s" }],
  messages: [{ role: "user" as const, content: "сделай баннер" }],
  agentKey: "orchestrator",
  chatId: -1,
};

/**
 * Ненасытная модель: всегда просит несуществующий инструмент (executeTool
 * отбивает его на «unknown tool» до диспатчера — побочных эффектов нет),
 * поэтому цикл гарантированно доходит до MAX_TOOL_ITERS.
 *
 * `speakOn` — номер итерации, на которой она произносит текст; остальные идут
 * с пустым text-блоком, как настоящий tool_use-ход.
 * `finalize` — что делает финализирующий вызов (без tools / tool_choice none).
 */
function insatiable(opts: { speakOn: number; finalize: "throw" | "empty" | "text" }) {
  let n = 0;
  return {
    messages: {
      create: async (req: any) => {
        const isFinal = req.tool_choice?.type === "none" || !req.tools;
        if (isFinal) {
          if (opts.finalize === "throw") throw new Error("boom");
          return {
            id: "m", type: "message", role: "assistant", model: "t",
            stop_reason: "end_turn", stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
            content: [{ type: "text", text: opts.finalize === "text" ? "итог" : "" }],
          } as unknown as Anthropic.Message;
        }
        const text = n++ === opts.speakOn ? SPOKEN : "";
        return {
          id: "m", type: "message", role: "assistant", model: "t",
          stop_reason: "tool_use", stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
          content: [
            { type: "text", text },
            { type: "tool_use", id: `tu-${n}`, name: "NO_SUCH_TOOL", input: {} },
          ],
        } as unknown as Anthropic.Message;
      },
    },
  } as unknown as Anthropic;
}

describe("сказанное в середине хода не теряется на пределе раундов", () => {
  test("реплика с первой итерации доживает до ответа, когда финализация упала", async () => {
    const out = await runWithTools({
      ...base,
      anthropic: insatiable({ speakOn: 0, finalize: "throw" }),
    } as never);

    // До правки здесь была одна заглушка.
    expect(out).toBe(SPOKEN);
    expect(out).not.toContain(STUB);
  });

  test("то же, когда финализирующий вызов вернул пустой текст", async () => {
    const out = await runWithTools({
      ...base,
      anthropic: insatiable({ speakOn: 2, finalize: "empty" }),
    } as never);

    expect(out).toBe(SPOKEN);
  });

  test("заглушка остаётся, если модель не сказала вообще ничего", async () => {
    const out = await runWithTools({
      ...base,
      anthropic: insatiable({ speakOn: -1, finalize: "throw" }),
    } as never);

    expect(out).toContain(STUB);
  });

  test("удачная финализация по-прежнему главнее сказанного раньше", async () => {
    const out = await runWithTools({
      ...base,
      anthropic: insatiable({ speakOn: 0, finalize: "text" }),
    } as never);

    // Итог, подведённый моделью в конце, точнее промежуточной реплики.
    expect(out).toBe("итог");
  });
});

describe("свежесть ответа на ранних выходах не тронута", () => {
  test("модель закончила молча — отдаём объяснение, а не старую реплику", async () => {
    let n = 0;
    const anthropic = {
      messages: {
        create: async () => {
          const first = n++ === 0;
          return {
            id: "m", type: "message", role: "assistant", model: "t",
            stop_reason: first ? "tool_use" : "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
            content: first
              ? [
                  { type: "text", text: SPOKEN },
                  { type: "tool_use", id: "tu-1", name: "NO_SUCH_TOOL", input: {} },
                ]
              : [{ type: "text", text: "" }],
          } as unknown as Anthropic.Message;
        },
      },
    } as unknown as Anthropic;

    const out = await runWithTools({ ...base, anthropic } as never);

    // Ветка «пустой текст + необычная остановка» должна остаться прежней:
    // выдавать реплику первой итерации за финальный ответ нельзя.
    expect(out).not.toBe(SPOKEN);
  });
});
