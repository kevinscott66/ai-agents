/**
 * Аудит 2026-08-13: «не больше двух вызовов за ход» считалось не за ход.
 *
 * C12 заводит свою карту счётчиков ВНУТРИ итерации цикла инструментов, а
 * итераций до MAX_TOOL_ITERS (по умолчанию 14). То есть охрана меряла один
 * ответ модели, а не ход пользователя: настоящий потолок выходил 2 × 14 = 28.
 *
 * Хуже, чем цифра: типичная петля — это один вызов на итерацию, четырнадцать
 * итераций подряд. Такую охрана не задевала ВООБЩЕ, n никогда не доходило до
 * трёх. Ровно тот сценарий, ради которого её и ставили. На SDK-пути счётчик на
 * прогон завели ещё в августе (SDK_MAX_CALLS_PER_TOOL), у raw-пути его не было.
 *
 * Теперь границы две: пачка в одном ответе — C12 (2), размазанный по ходу
 * разгон — MAX_CALLS_PER_TOOL_PER_RUN (8, то же число, что на SDK-пути).
 *
 * Проверяется счёт, а не результат самого инструмента: обе охраны стоят ДО
 * executeTool, и что вернул GET_METRICS, для них безразлично.
 */
import { describe, test, expect } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { runWithTools } from "../lib/tool-loop.ts";
import {
  MAX_CALLS_PER_TOOL_PER_RUN,
  MAX_CALLS_PER_TOOL_PER_RESPONSE,
} from "../lib/constants.ts";

const TOOL = "GET_METRICS";

const base = {
  model: "t",
  system: [{ type: "text" as const, text: "s" }],
  messages: [{ role: "user" as const, content: "посчитай метрики" }],
  agentKey: "backend",
  chatId: -1_000_931,
};

/** Ответ модели: `n` вызовов одного инструмента в одном tool_use-ходе. */
function useTool(n: number, name = TOOL, offset = 0): Partial<Anthropic.Message> {
  return {
    stop_reason: "tool_use",
    content: Array.from({ length: n }, (_, i) => ({
      type: "tool_use" as const,
      id: `tu-${name}-${offset + i}`,
      name,
      input: {},
    })) as Anthropic.ContentBlock[],
  };
}

const DONE: Partial<Anthropic.Message> = {
  stop_reason: "end_turn",
  content: [{ type: "text", text: "готово" }] as Anthropic.ContentBlock[],
};

/**
 * Модель по сценарию. Последний шаг повторяется, если цикл попросит ещё —
 * так тест не зависит от того, сколько итераций реально понадобится.
 */
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

/** Все tool_result, которые цикл отдал модели обратно, по порядку. */
function toolResults(captured: any[]): Array<{ id: string; text: string }> {
  const out: Array<{ id: string; text: string }> = [];
  const seen = new Set<string>();
  for (const req of captured) {
    for (const m of req.messages ?? []) {
      if (m.role !== "user" || !Array.isArray(m.content)) continue;
      for (const b of m.content) {
        if (b?.type !== "tool_result" || seen.has(b.tool_use_id)) continue;
        seen.add(b.tool_use_id);
        out.push({ id: b.tool_use_id, text: String(b.content ?? "") });
      }
    }
  }
  return out;
}

const isRunCap = (t: string) => /за один ход/.test(t);
const isResponseCap = (t: string) => /refusing to prevent loop/.test(t);

describe("потолок вызовов одного инструмента за ход", () => {
  test("один вызов на итерацию — та самая петля, которую C12 не ловил", async () => {
    const captured: any[] = [];
    // 12 ходов подряд по одному вызову. До правки не отбивался ни один.
    const steps = Array.from({ length: 12 }, (_, i) => useTool(1, TOOL, i));
    await runWithTools({
      ...base,
      anthropic: scripted([...steps, DONE], captured),
    } as never);

    const res = toolResults(captured);
    const refused = res.filter((r) => isRunCap(r.text));
    expect(res.length).toBeGreaterThan(MAX_CALLS_PER_TOOL_PER_RUN);
    expect(refused.length).toBeGreaterThan(0);
    // Первые MAX_CALLS_PER_TOOL_PER_RUN проходят, всё после — отбито.
    expect(res.slice(0, MAX_CALLS_PER_TOOL_PER_RUN).some((r) => isRunCap(r.text))).toBe(false);
    expect(res.slice(MAX_CALLS_PER_TOOL_PER_RUN).every((r) => isRunCap(r.text))).toBe(true);
  });

  test("отказ говорит модели, что делать дальше, а не просто «нельзя»", async () => {
    const captured: any[] = [];
    const steps = Array.from({ length: 10 }, (_, i) => useTool(1, TOOL, i));
    await runWithTools({
      ...base,
      anthropic: scripted([...steps, DONE], captured),
    } as never);

    const refused = toolResults(captured).find((r) => isRunCap(r.text))!;
    expect(refused.text).toContain(TOOL);
    expect(refused.text).toMatch(/Подведи итог/);
    expect(JSON.parse(refused.text).ok).toBe(false);
  });

  test("бюджет у каждого инструмента свой", async () => {
    const captured: any[] = [];
    // Инструмент A выбирает свой бюджет; B в том же ходе не должен пострадать.
    const steps = [
      ...Array.from({ length: 10 }, (_, i) => useTool(1, TOOL, i)),
      useTool(1, "GET_BOT_INFO", 100),
      DONE,
    ];
    await runWithTools({
      ...base,
      anthropic: scripted(steps, captured),
    } as never);

    const b = toolResults(captured).find((r) => r.id.includes("GET_BOT_INFO"))!;
    expect(b).toBeDefined();
    expect(isRunCap(b.text)).toBe(false);
  });

  test("C12 продолжает бить по пачке в одном ответе", async () => {
    const captured: any[] = [];
    await runWithTools({
      ...base,
      anthropic: scripted([useTool(3), DONE], captured),
    } as never);

    const res = toolResults(captured);
    expect(res.length).toBe(3);
    expect(res.slice(0, MAX_CALLS_PER_TOOL_PER_RESPONSE).some((r) => isResponseCap(r.text))).toBe(
      false,
    );
    expect(isResponseCap(res[MAX_CALLS_PER_TOOL_PER_RESPONSE]!.text)).toBe(true);
  });

  test("отбитое C12 не тратит бюджет хода — иначе потолок был бы ниже заявленного", async () => {
    const captured: any[] = [];
    // Четыре ответа по три вызова: третий в каждом отбивает C12, значит
    // бюджет хода тратят ровно 2×4 = MAX_CALLS_PER_TOOL_PER_RUN.
    const steps = [
      ...Array.from({ length: 4 }, (_, i) => useTool(3, TOOL, i * 3)),
      DONE,
    ];
    await runWithTools({
      ...base,
      anthropic: scripted(steps, captured),
    } as never);

    const res = toolResults(captured);
    expect(res.length).toBe(12);
    expect(res.some((r) => isRunCap(r.text))).toBe(false);
    expect(res.filter((r) => isResponseCap(r.text)).length).toBe(4);
  });
});

describe("значение потолка", () => {
  test("выше, чем у C12, и ограничено сверху", () => {
    // Ниже C12 — бессмысленно (охрана ответа никогда бы не сработала), выше
    // MAX_TOOL_ITERS — потолок перестал бы существовать.
    expect(MAX_CALLS_PER_TOOL_PER_RUN).toBeGreaterThan(MAX_CALLS_PER_TOOL_PER_RESPONSE);
    expect(MAX_CALLS_PER_TOOL_PER_RUN).toBeLessThanOrEqual(14);
  });

  test("одно число на оба пути исполнения", async () => {
    const { SDK_MAX_CALLS_PER_TOOL } = await import("../lib/agent-sdk-runtime.ts");
    expect(SDK_MAX_CALLS_PER_TOOL).toBe(MAX_CALLS_PER_TOOL_PER_RUN);
  });
});
