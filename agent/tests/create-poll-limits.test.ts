/**
 * Аудит 2026-08-08: CREATE_POLL не проверял ни одного ограничения Bot API.
 *
 * У опроса свои лимиты: вопрос 1..300, вариантов 2..10, каждый вариант 1..100.
 * Проверялось только «вопрос непустой и вариантов ≥2», всё остальное уезжало в
 * Telegram и возвращалось как 400 POLL_QUESTION_INVALID — уже ПОСЛЕ апрува,
 * потому что CREATE_POLL требует подтверждения владельца. То есть человек
 * тратил внимание на действие, которое не могло сработать в принципе, и по
 * тексту ошибки не мог понять, что именно чинить.
 *
 * buildPayload отрабатывает ДО гейта апрува, поэтому проверка живёт там:
 * модель получает отказ сразу и переделывает опрос в том же ходу.
 */
import { test, expect, describe } from "bun:test";
import { buildPayload } from "../lib/dispatch/build-payload.ts";

const CTX = { agentKey: "pm" };

function build(input: Record<string, unknown>) {
  return buildPayload("CREATE_POLL", { chatId: -100500, ...input }, CTX);
}

describe("CREATE_POLL: лимиты Telegram проверяются до апрува", () => {
  test("нормальный опрос собирается как раньше", () => {
    const r = build({ question: "Обедаем?", options: ["Пицца", "Салат"] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.question).toBe("Обедаем?");
    expect(r.payload.options).toEqual(["Пицца", "Салат"]);
    // Умолчание анонимности не изменилось.
    expect(r.payload.isAnonymous).toBe(true);
  });

  test("вопрос длиннее 300 отбивается с указанием лимита", () => {
    const r = build({ question: "я".repeat(301), options: ["а", "б"] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // Сообщение должно давать модели починить с первой попытки.
    expect(r.error).toContain("301");
    expect(r.error).toContain("300");
  });

  test("вопрос ровно на границе проходит", () => {
    const r = build({ question: "я".repeat(300), options: ["а", "б"] });
    expect(r.ok).toBe(true);
  });

  test("11 вариантов отбиваются, 10 проходят", () => {
    const opts = (n: number) => Array.from({ length: n }, (_, k) => `в${k}`);
    const bad = build({ question: "Что?", options: opts(11) });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("10");
    expect(build({ question: "Что?", options: opts(10) }).ok).toBe(true);
  });

  test("вариант длиннее 100 символов отбивается с номером варианта", () => {
    const r = build({ question: "Что?", options: ["ок", "я".repeat(101)] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("options[1]");
    expect(r.error).toContain("100");
  });

  test("пустой вариант не отбрасывается молча, а называется", () => {
    // Отбросить его было бы хуже: опрос стал бы одновариантным, и модель не
    // узнала бы, что потеряла строку.
    const r = build({ question: "Что?", options: ["Да", "   "] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("options[1]");
  });

  test("пробелы по краям срезаются, а не считаются содержимым", () => {
    const r = build({ question: "  Обедаем?  ", options: [" Пицца", "Салат "] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.question).toBe("Обедаем?");
    expect(r.payload.options).toEqual(["Пицца", "Салат"]);
  });

  test("один вариант и пустой вопрос по-прежнему отбиваются", () => {
    expect(build({ question: "Что?", options: ["Да"] }).ok).toBe(false);
    expect(build({ question: "   ", options: ["Да", "Нет"] }).ok).toBe(false);
    expect(build({ question: "Что?" }).ok).toBe(false);
  });
});
