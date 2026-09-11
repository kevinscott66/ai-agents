/**
 * Аудит 2026-09-11, круг 21: обрезка `partialText` в `replyForTurnError`
 * рубила суррогатную пару пополам.
 *
 * `t.slice(0, PARTIAL_TEXT_MAX - 1)` режет по code units UTF-16. Если на
 * границе стоит не-BMP символ (эмодзи — обычное дело в ответах ролей), кусок
 * заканчивается одиноким высоким суррогатом, а при кодировании в UTF-8 он
 * превращается в U+FFFD. Человек видит «…🔥» как «…�».
 *
 * Правило в репозитории уже есть и записано дважды — `cutBlock`
 * (lib/telegram-format.ts) и `sliceOneEnd` (lib/telegram-chunking.ts) обе
 * снимают высокий суррогат с хвоста. Третье место обрезки его не
 * унаследовало.
 *
 * Путь до человека: `replyForTurnError` уходит в `ctx.reply(...)` обычным
 * текстом без parse_mode — то есть не падает, а молча показывает ромб.
 */
import { describe, test, expect } from "bun:test";
import { replyForTurnError } from "../orchestrator/message-handler.ts";
import { BudgetExceededError } from "../lib/token-budget.ts";

/** Ровно на границе: PARTIAL_TEXT_MAX = 700, режется по 699. */
const onBoundary = (filler: string) => "a".repeat(698) + filler + "хвост";

function replyFor(partialText: string): string {
  return replyForTurnError(
    new BudgetExceededError("smm", 100, 50, { partialText, sideEffects: false }),
  );
}

describe("обрезка partialText не рвёт суррогатную пару", () => {
  test("эмодзи на границе не превращается в U+FFFD", () => {
    const reply = replyFor(onBoundary("🔥"));
    expect(reply).not.toContain("�");
    expect(Buffer.from(reply, "utf8").toString("utf8")).toBe(reply);
    // Одинокого высокого суррогата в выдаче быть не должно.
    for (let i = 0; i < reply.length; i++) {
      const c = reply.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = reply.charCodeAt(i + 1);
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
      }
    }
  });

  test("обрезка всё ещё происходит и заканчивается многоточием", () => {
    const reply = replyFor(onBoundary("🔥"));
    expect(reply).toContain("…");
    expect(reply).toContain("Дневной лимит токенов исчерпан");
  });

  test("короткий текст не трогаем", () => {
    const reply = replyFor("готово 🔥");
    expect(reply).toContain("готово 🔥");
    expect(reply).not.toContain("�");
  });
});
