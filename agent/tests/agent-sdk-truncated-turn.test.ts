/**
 * Аудит 2026-08-20: оборванный SDK-ход выдавался за законченный ответ.
 *
 * При `subtype === "error_max_turns"` SDK останавливается ровно тогда, когда
 * модель собиралась сделать следующий шаг инструментом. Накопленный к этому
 * моменту текст — почти всегда преамбула («сейчас посмотрю логи и отвечу»), и
 * `runViaAgentSdk` возвращал её как обычный ответ. Дальше отличить огрызок от
 * готового ответа было нечем: `respondAs` → `{status:"answered"}`,
 * action-dispatch → `closeDelegatedTask("done")`, оркестратор рапортует
 * «готово» на невыполненной задаче.
 *
 * Raw-путь в тех же обстоятельствах честен: `tool-loop.ts` просит модель подвести
 * итог без инструментов, а если и это не вышло — приписывает
 * «(достигнут предел шагов инструментов…)». Инвариант: SDK-путь говорит об
 * обрыве теми же словами.
 */
import { describe, test, expect } from "bun:test";
import { markTruncatedTurn } from "../lib/agent-sdk-runtime.ts";

const PREAMBLE = "Сейчас посмотрю логи и вернусь с ответом.";

describe("markTruncatedTurn", () => {
  test("успешный ход не трогаем вовсе", () => {
    expect(markTruncatedTurn("готовый ответ", "success")).toBe("готовый ответ");
  });

  test("subtype отсутствует — тоже не трогаем", () => {
    expect(markTruncatedTurn("готовый ответ", undefined)).toBe("готовый ответ");
  });

  test("error_max_turns — та же формулировка, что на raw-пути", () => {
    const out = markTruncatedTurn(PREAMBLE, "error_max_turns");
    expect(out).toContain(PREAMBLE);
    expect(out).toContain(
      "(достигнут предел шагов инструментов — задача может быть выполнена частично)",
    );
  });

  test("преамбулу больше нельзя принять за законченный ответ", () => {
    // Суть правки: текст, вернувшийся с оборванного хода, отличим от текста
    // успешного хода — по содержимому, а не по внешнему знанию о subtype.
    const truncated = markTruncatedTurn(PREAMBLE, "error_max_turns");
    const finished = markTruncatedTurn(PREAMBLE, "success");
    expect(truncated).not.toBe(finished);
    expect(truncated.length).toBeGreaterThan(finished.length);
  });

  test("прочие non-success subtype называются своим именем", () => {
    const out = markTruncatedTurn(PREAMBLE, "error_during_execution");
    expect(out).toContain("ход прерван: error_during_execution");
    expect(out).toContain("может быть выполнена частично");
  });

  test("хвостовые переводы строк не копятся", () => {
    const out = markTruncatedTurn("ответ\n\n\n", "error_max_turns");
    expect(out).toBe(
      "ответ\n\n(достигнут предел шагов инструментов — задача может быть выполнена частично)",
    );
  });
});
