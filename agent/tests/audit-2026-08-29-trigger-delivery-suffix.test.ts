/**
 * Аудит 2026-08-29: `isTriggerDelivered` считал доставкой ВХОЖДЕНИЕ триггера
 * в последнюю реплику окна, а не совпадение с её хвостом.
 *
 * Оба сборщика истории склеивают строку как `[speaker] text`
 * (lib/handoff.ts:216, orchestrator/message-handler.ts:565-570), то есть
 * доставленный триггер всегда стоит в самом КОНЦЕ последней реплики. При
 * `includes` любая более длинная последняя реплика, содержащая триггер
 * подстрокой, выдавала «доставлено» — мандат в хвост не дописывался, и роль
 * читала как задание чужую инструкцию.
 *
 * Это строго хуже задвоения, которое докблок модуля принимает осознанно: там
 * реплика повторяется, здесь — подменяется. `endsWith` может ошибиться только
 * в сторону задвоения, то есть в уже принятую.
 *
 * Тест держит обе границы: новые ложные срабатывания закрыты, а всё
 * задокументированное поведение (три состояния окна) осталось прежним.
 */
import { describe, test, expect } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { isTriggerDelivered } from "../lib/trigger-delivery.ts";

/** Реплика в том виде, в каком её кладут оба сборщика. */
const said = (speaker: string, text: string): Anthropic.MessageParam => ({
  role: "user",
  content: `[${speaker}] ${text}`,
});

const TRIGGER = "@delabs_qa_bot проверь";

describe("ложное «доставлено»", () => {
  test("последняя реплика длиннее триггера и содержит его — это не доставка", () => {
    // Группа общая, между записью триггера и чтением истории стоит await:
    // чужая реплика в хвосте — норма. Раньше здесь возвращалось true, и
    // делегат отвечал на «ещё раз вот это» вместо своего задания.
    const messages = [
      said("petya", TRIGGER),
      said("masha", `${TRIGGER} ещё раз вот это`),
    ];
    expect(isTriggerDelivered(messages, TRIGGER)).toBe(false);
  });

  test("триггер в начале последней реплики после ника — тоже не доставка", () => {
    expect(isTriggerDelivered([said("petya", "срочно проверь баннер")], "срочно")).toBe(
      false,
    );
  });

  test("триггер в середине последней реплики — не доставка", () => {
    expect(
      isTriggerDelivered([said("petya", "я думаю срочно надо, да")], "срочно"),
    ).toBe(false);
  });
});

describe("настоящая доставка распознаётся по-прежнему", () => {
  test("триггер — хвост последней реплики", () => {
    expect(isTriggerDelivered([said("petya", TRIGGER)], TRIGGER)).toBe(true);
  });

  test("перед триггером в той же реплике может стоять что угодно", () => {
    expect(isTriggerDelivered([said("petya", `коллеги, ${TRIGGER}`)], TRIGGER)).toBe(
      true,
    );
  });

  test("висячий пробел и перевод строки в хвосте не ломают совпадение", () => {
    // `trigger` приходит после trim(), поэтому и хвост сверяется по trimEnd().
    expect(isTriggerDelivered([said("petya", `${TRIGGER}  \n`)], TRIGGER)).toBe(true);
  });

  test("триггер сверяется после trim() своей стороны", () => {
    expect(isTriggerDelivered([said("petya", TRIGGER)], `  ${TRIGGER}  `)).toBe(true);
  });

  test("собственная реплика бота лежит без префикса-ника и тоже совпадает", () => {
    expect(
      isTriggerDelivered([{ role: "assistant", content: TRIGGER }], TRIGGER),
    ).toBe(true);
  });
});

describe("задокументированные состояния окна не изменились", () => {
  test("триггера в окне нет — не доставлен", () => {
    expect(isTriggerDelivered([said("petya", "и вообще давайте запускаться")], TRIGGER)).toBe(
      false,
    );
  });

  test("третье состояние: триггер есть, но не последний — не доставлен", () => {
    // Осознанный размен из докблока модуля: сюда дописывается второй
    // экземпляр, потому что молча уронить мандат хуже, чем повторить его.
    const messages = [said("petya", TRIGGER), said("petya", "срочно")];
    expect(isTriggerDelivered(messages, TRIGGER)).toBe(false);
  });

  test("пустой триггер и пустое окно — не доставлен", () => {
    expect(isTriggerDelivered([said("petya", TRIGGER)], "   ")).toBe(false);
    expect(isTriggerDelivered([], TRIGGER)).toBe(false);
  });

  test("content блоками, а не строкой — не доставлен (дописываем)", () => {
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: [{ type: "text", text: `[petya] ${TRIGGER}` }] },
    ];
    expect(isTriggerDelivered(messages, TRIGGER)).toBe(false);
  });
});
