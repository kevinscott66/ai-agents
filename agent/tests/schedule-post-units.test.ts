/**
 * Аудит 2026-08-12: SCHEDULE_POST описан в секундах, а проверяется в миллисекундах.
 *
 * В схеме инструмента (tools-schema.ts) поле scheduledAt называлось «Unix
 * timestamp» — а это по общему соглашению СЕКУНДЫ. Валидатор же сравнивал
 * значение с Date.now(), то есть с миллисекундами: честные секунды («через
 * час» ≈ 1.79e9) всегда меньше 1.78e12 и получали отказ «scheduledAt must be a
 * future timestamp». Модель видела «время в прошлом» для будущего времени и
 * уходила гадать.
 *
 * Секунды и миллисекунды в диапазоне будущих дат не пересекаются: значение
 * меньше 1e11 в миллисекундах — это 1973 год, будущим оно быть не может.
 */
import { describe, expect, test } from "bun:test";
import { buildPayload } from "../lib/dispatch/build-payload.ts";

const HOUR_MS = 60 * 60 * 1000;

const CTX = { agentKey: "smm" };

function build(scheduledAt: number) {
  return buildPayload(
    "SCHEDULE_POST",
    { channel: "@delabsru", content: "текст поста", scheduledAt },
    CTX,
  );
}

describe("SCHEDULE_POST scheduledAt", () => {
  test("миллисекунды принимаются как есть", () => {
    const at = Date.now() + HOUR_MS;
    const r = build(at);
    expect(r.ok).toBe(true);
    expect(r.ok && r.payload.scheduledAt).toBe(at);
  });

  test("секунды приводятся к миллисекундам, а не отвергаются", () => {
    const sec = Math.floor((Date.now() + HOUR_MS) / 1000);
    const r = build(sec);
    // Старое поведение: «scheduledAt must be a future timestamp».
    expect(r.ok).toBe(true);
    expect(r.ok && r.payload.scheduledAt).toBe(sec * 1000);
  });

  test("прошлое отвергается в обеих единицах", () => {
    expect(build(Date.now() - HOUR_MS).ok).toBe(false);
    expect(build(Math.floor((Date.now() - HOUR_MS) / 1000)).ok).toBe(false);
  });

  test("ноль и мусор отвергаются", () => {
    expect(build(0).ok).toBe(false);
    expect(build(Number.NaN).ok).toBe(false);
  });
});
