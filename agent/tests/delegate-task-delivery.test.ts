/**
 * Аудит 2026-08-08: делегат не получал текст делегированной задачи.
 *
 * respondAs дописывал триггер в messages только если последним в истории
 * говорил сам делегат. На mention-пути это безвредно (реплика соседа уже в
 * истории), но DELEGATE_TO_ROLE передаёт задачу, которой в истории нет:
 * анонс «🔀 X → Y: …» уходит telegram.sendMessage без recordMessage, а ответ
 * делегирующего агента запишется только после конца хода. Последним лежало
 * сообщение пользователя (role "user") → триггер не дописывался → делегат
 * читал DELEGATED_EXECUTION_MANDATE, не зная задачи.
 */
import { describe, test, expect } from "bun:test";
import { buildDelegateMessages } from "../lib/handoff.ts";

const TASK = "напиши тест на ретрай публикации в канал";

function texts(ms: ReturnType<typeof buildDelegateMessages>): string[] {
  return ms.map((m) => (typeof m.content === "string" ? m.content : ""));
}

describe("buildDelegateMessages: задача доходит до делегата", () => {
  test("DELEGATE_TO_ROLE — задача дописывается, хотя последним говорил человек", () => {
    // Ровно прод-состояние на момент вызова делегата.
    const recent = [
      { text: "@orchestrator покрой тестами публикацию", from_name: "owner" },
    ];
    const ms = buildDelegateMessages(recent, "qa", "orchestrator", TASK);

    const last = ms[ms.length - 1]!;
    expect(last.role).toBe("user");
    expect(String(last.content)).toContain(TASK);
    expect(String(last.content)).toContain("orchestrator");
  });

  test("история пользователя сохраняется, задача добавляется в хвост", () => {
    const recent = [
      { text: "привет", from_name: "owner" },
      { text: "@orchestrator покрой тестами публикацию", from_name: "owner" },
    ];
    const ms = buildDelegateMessages(recent, "qa", "orchestrator", TASK);
    expect(ms.length).toBe(3);
    expect(texts(ms)[0]).toContain("привет");
    expect(texts(ms)[2]).toContain(TASK);
  });

  test("mention-путь не задваивает реплику соседа", () => {
    // Триггером служит ответ pm, который respondAs уже записал в историю.
    const reply = "нужен тест на ретрай, @qa займись";
    const recent = [
      { text: "поехали", from_name: "owner" },
      { text: reply, is_bot: 1, agent_key: "pm" },
    ];
    const ms = buildDelegateMessages(recent, "qa", "pm", reply);
    expect(ms.length).toBe(2);
    expect(texts(ms).filter((t) => t.includes(reply)).length).toBe(1);
  });

  test("свои прошлые реплики делегата идут как assistant и без префикса", () => {
    const recent = [
      { text: "я уже смотрел логи", is_bot: 1, agent_key: "qa" },
      { text: "ок", from_name: "owner" },
    ];
    const ms = buildDelegateMessages(recent, "qa", "orchestrator", TASK);
    expect(ms[0]!.role).toBe("assistant");
    expect(ms[0]!.content).toBe("я уже смотрел логи");
    expect(ms[1]!.role).toBe("user");
    expect(texts(ms)[1]).toContain("[owner]");
  });

  test("чужая реплика бота помечается ролью автора, а не делегата", () => {
    const recent = [{ text: "готово", is_bot: 1, agent_key: "backend" }];
    const ms = buildDelegateMessages(recent, "qa", "orchestrator", TASK);
    expect(ms[0]!.role).toBe("user");
    expect(texts(ms)[0]).toContain("[backend]");
  });

  test("пустая история — задача всё равно доезжает первой", () => {
    const ms = buildDelegateMessages([], "qa", "orchestrator", TASK);
    expect(ms.length).toBe(1);
    expect(ms[0]!.role).toBe("user");
    expect(String(ms[0]!.content)).toContain(TASK);
  });

  test("пустой триггер не создаёт сообщения-пустышки", () => {
    // Модель не должна получить хвост «[pm] (handoff)» без содержания.
    const recent = [{ text: "привет", from_name: "owner" }];
    const ms = buildDelegateMessages(recent, "qa", "pm", "   ");
    expect(ms.length).toBe(2);
    expect(String(ms[1]!.content)).toBe("[pm] (handoff)");
  });

  test("последним всегда user — иначе API отклонит ход", () => {
    const cases: HistoryArg[] = [
      [{ text: "я тут", is_bot: 1, agent_key: "qa" }],
      [{ text: "ок", from_name: "owner" }],
      [],
    ];
    for (const recent of cases) {
      const ms = buildDelegateMessages(recent, "qa", "orchestrator", TASK);
      expect(ms[ms.length - 1]!.role).toBe("user");
    }
  });
});

type HistoryArg = Parameters<typeof buildDelegateMessages>[0];
