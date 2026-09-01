/**
 * Финализирующий вызов после лимита раундов (аудит 2026-08-04).
 *
 * Когда цикл упирался в MAX_TOOL_ITERS, а модель всё ещё просила инструменты,
 * делался ОДИН вызов без `tools` — чтобы модель подвела итог текстом вместо
 * заглушки «(достигнут предел шагов…)». Но к этому моменту `messages` полны
 * tool_use/tool_result, а такой запрос API отбивает 400: «requests which
 * include tool_use or tool_result blocks must define tools». 400 не ретраится
 * (anthropic-client), исключение ловится тут же — то есть вызов падал ВСЕГДА:
 * лишний оплаченный запрос, и ровно та заглушка, которую он должен был убрать.
 *
 * Инструменты возвращены в запрос, а запрет на новые вызовы даёт
 * tool_choice:none.
 */
import { describe, test, expect } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { runWithTools } from "../lib/tool-loop.ts";

const ITERS = Number.parseInt(process.env.MAX_TOOL_ITERS ?? "14", 10) || 14;

/**
 * Модель, которая всегда просит инструмент — гарантированно доводит цикл до
 * лимита. Инструмент несуществующий: executeTool отбивает его на «unknown
 * tool» до диспатчера, побочных эффектов нет.
 */
function insatiableModel(captured: any[], finalText = "итог") {
  return {
    messages: {
      create: async (req: any) => {
        captured.push(req);
        const isFinal = req.tool_choice?.type === "none" || !req.tools;
        return {
          id: "m",
          type: "message",
          role: "assistant",
          model: "t",
          stop_reason: isFinal ? "end_turn" : "tool_use",
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
          content: isFinal
            ? [{ type: "text", text: finalText }]
            : [
                { type: "text", text: "" },
                {
                  type: "tool_use",
                  id: `tu-${captured.length}`,
                  name: "NO_SUCH_TOOL",
                  input: {},
                },
              ],
        } as unknown as Anthropic.Message;
      },
    },
  } as unknown as Anthropic;
}

const base = {
  model: "t",
  system: [{ type: "text" as const, text: "s" }],
  messages: [{ role: "user" as const, content: "сделай" }],
  agentKey: "orchestrator",
  chatId: -1,
};

function hasToolBlocks(req: any): boolean {
  return (req.messages as any[]).some(
    (m) =>
      Array.isArray(m.content) &&
      m.content.some(
        (b: any) => b.type === "tool_use" || b.type === "tool_result",
      ),
  );
}

describe("финализирующий вызов после лимита раундов", () => {
  test("делается ровно один раз сверх лимита", async () => {
    const cap: any[] = [];
    await runWithTools({ ...base, anthropic: insatiableModel(cap) });
    expect(cap).toHaveLength(ITERS + 1);
  });

  test("несёт tools и tool_choice:none", async () => {
    const cap: any[] = [];
    await runWithTools({ ...base, anthropic: insatiableModel(cap) });
    const final = cap[cap.length - 1];
    // Без tools API вернёт 400 и текст не дойдёт до пользователя.
    expect(Array.isArray(final.tools)).toBe(true);
    expect(final.tools.length).toBeGreaterThan(0);
    // Со свободным tool_choice модель попросит инструмент снова, а исполнять
    // его уже некому: цикл закончился.
    expect(final.tool_choice).toEqual({ type: "none" });
  });

  test("текст финализации доходит до пользователя вместо заглушки", async () => {
    const cap: any[] = [];
    const out = await runWithTools({
      ...base,
      anthropic: insatiableModel(cap, "сделал А и Б, В не успел"),
    });
    expect(out).toBe("сделал А и Б, В не успел");
    expect(out).not.toMatch(/предел шагов/);
  });

  test("ни один запрос с tool-блоками не уходит без tools", async () => {
    // Инвариант API, а не деталь финализации: сюда попадут и будущие вызовы.
    const cap: any[] = [];
    await runWithTools({ ...base, anthropic: insatiableModel(cap) });
    let withBlocks = 0;
    for (const req of cap) {
      if (hasToolBlocks(req)) {
        withBlocks++;
        expect(Array.isArray(req.tools) && req.tools.length > 0).toBe(true);
      }
    }
    // Без этих двух строк тест зелёный и когда запросов нет вовсе, и когда
    // tool-блоков в них нет: проверять инвариант было бы не на чем.
    expect(cap.length).toBeGreaterThan(0);
    expect(withBlocks).toBeGreaterThan(0);
  });

  test("если модель закончила сама, финализации нет", async () => {
    // Контроль: без него «ровно один раз сверх лимита» прошло бы и при
    // финализации, делающейся всегда.
    const cap: any[] = [];
    const quiet = {
      messages: {
        create: async (req: any) => {
          cap.push(req);
          return {
            id: "m",
            type: "message",
            role: "assistant",
            model: "t",
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
            content: [{ type: "text", text: "готово" }],
          } as unknown as Anthropic.Message;
        },
      },
    } as unknown as Anthropic;
    const out = await runWithTools({ ...base, anthropic: quiet });
    expect(cap).toHaveLength(1);
    expect(out).toBe("готово");
  });
});
