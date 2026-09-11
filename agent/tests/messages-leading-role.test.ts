/**
 * Аудит 2026-08-12: ход мог уйти в API с ведущим assistant-сообщением.
 *
 * Messages API требует, чтобы ПЕРВОЕ сообщение было от роли "user" — иначе 400
 * invalid_request_error, ход падает целиком. А оба сборщика messages в проекте
 * строят историю одинаково: строка чата становится "assistant", если её написал
 * сам этот агент (orchestrator/message-handler.ts и
 * lib/handoff.ts buildDelegateMessages). Про хвост оба заботятся —
 * message-handler дописывает user-реплику, buildDelegateMessages дописывает
 * триггер, — а про голову не заботится никто.
 *
 * Голова окна — это просто N-е с конца сообщение чата. Достаточно, чтобы им
 * оказалась реплика самого агента: он ответил длинной серией, окно съехало, и
 * первым в срезе лежит его собственный текст. В командном чате, где роль ведёт
 * ветку, это обычное дело, а не экзотика.
 *
 * Цена — молчание: ошибка ловится наверху, логируется, пользователю не уходит
 * ничего. Хуже того, raw-путь на проде (USE_AGENT_SDK=true) — это ОТКАТ после
 * сбоя Agent SDK, то есть отказывает именно тот путь, который должен спасать.
 *
 * Инвариант: что бы ни лежало в истории, первое сообщение запроса — от "user",
 * и список не пустой.
 */
import { describe, test, expect } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { runWithTools } from "../lib/tool-loop.ts";
import { buildDelegateMessages } from "../lib/handoff.ts";

function fakeAnthropic(captured: any[]) {
  return {
    messages: {
      create: async (req: any) => {
        // Снимок, а не ссылка: tool-loop дописывает ответ модели в ТОТ ЖЕ
        // массив после вызова, и проверять было бы уже не то, что ушло.
        captured.push(JSON.parse(JSON.stringify(req)));
        return {
          id: "m",
          type: "message",
          role: "assistant",
          model: "t",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
          content: [{ type: "text", text: "ok" }],
        } as unknown as Anthropic.Message;
      },
    },
  } as unknown as Anthropic;
}

const base = {
  model: "t",
  system: [{ type: "text" as const, text: "s" }],
  agentKey: "design",
  chatId: -1,
};

describe("runWithTools: первое сообщение всегда от user", () => {
  test("окно истории, начавшееся с реплики самого агента", async () => {
    const cap: any[] = [];
    await runWithTools({
      ...base,
      anthropic: fakeAnthropic(cap),
      messages: [
        { role: "assistant", content: "мой прошлый ответ" },
        { role: "assistant", content: "и продолжение" },
        { role: "user", content: "[pm] теперь сделай макет" },
      ],
    });
    expect(cap[0].messages[0].role).toBe("user");
    // Отрезаем только голову: сама задача обязана доехать.
    expect(cap[0].messages.at(-1).content).toContain("сделай макет");
  });

  test("история целиком из своих реплик не даёт пустой запрос", async () => {
    // Пустой messages — тоже 400. Худший вход не должен превращаться в него.
    const cap: any[] = [];
    await runWithTools({
      ...base,
      anthropic: fakeAnthropic(cap),
      messages: [
        { role: "assistant", content: "первое" },
        { role: "assistant", content: "последнее" },
      ],
    });
    expect(cap[0].messages.length).toBeGreaterThan(0);
    expect(cap[0].messages[0].role).toBe("user");
    expect(cap[0].messages.at(-1).content).toContain("последнее");
  });

  test("нормальная история не трогается", async () => {
    const cap: any[] = [];
    const messages = [
      { role: "user" as const, content: "[pm] привет" },
      { role: "assistant" as const, content: "привет" },
      { role: "user" as const, content: "[pm] сделай макет" },
    ];
    await runWithTools({ ...base, anthropic: fakeAnthropic(cap), messages });
    expect(cap[0].messages).toEqual(messages);
  });
});

describe("buildDelegateMessages: голова окна", () => {
  test("своя реплика первой — запрос всё равно начинается с user", async () => {
    const recent = [
      { text: "мой прошлый ответ", is_bot: 1, agent_key: "design" },
      { text: "ок, спасибо", is_bot: 0, from_name: "user" },
    ];
    const msgs = buildDelegateMessages(recent, "design", "pm", "сделай баннер");
    const cap: any[] = [];
    await runWithTools({ ...base, anthropic: fakeAnthropic(cap), messages: msgs });
    expect(cap[0].messages[0].role).toBe("user");
  });
});
