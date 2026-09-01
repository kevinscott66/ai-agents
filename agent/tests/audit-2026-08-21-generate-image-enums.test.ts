/**
 * Аудит 2026-08-21: GENERATE_IMAGE молча подменял size / quality / background.
 *
 * `buildGenerateImagePayload` проверял каждое из трёх полей на членство в своём
 * списке и при промахе клал `undefined` — то есть «поля нет». Дальше в
 * OpenAI уходил дефолт, картинка возвращалась, действие рапортовало успех.
 *
 * Модель просит `size: "1792x1024"` (законный размер у DALL·E-3, у gpt-image-1
 * такого нет) — и получает КВАДРАТ, не узнав об этом ниоткуда. Дальше она
 * подписывает его как широкий баннер и отправляет в чат. Отказ она чинит сама,
 * молчаливую подмену — нечем.
 *
 * Та же доктрина, что у #502 на соседнем `build-payload.ts`: либо целиком
 * дальше, либо явный отказ. Отсутствующее поле по-прежнему легально.
 */
import { describe, expect, test } from "bun:test";
import { buildGenerateImagePayload } from "../lib/dispatch/media.ts";

const ok = (input: Record<string, unknown>) =>
  buildGenerateImagePayload({ prompt: "a cat", ...input }, 42);

describe("buildGenerateImagePayload: перечислимые поля", () => {
  test("размер не из списка — отказ, а не квадрат втихую", () => {
    const r = ok({ size: "1792x1024" });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain("1792x1024");
    expect((r as { error: string }).error).toContain("1024x1536");
  });

  test("quality не из списка — отказ", () => {
    const r = ok({ quality: "hd" });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain("hd");
  });

  test("background не из списка — отказ", () => {
    const r = ok({ background: "white" });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain("white");
  });

  test("не-строка тоже отказ, а не «поля нет»", () => {
    expect(ok({ size: 1024 }).ok).toBe(false);
    expect(ok({ quality: ["high"] }).ok).toBe(false);
  });

  test("отсутствующее поле легально — это не ошибка", () => {
    const r = ok({});
    expect(r.ok).toBe(true);
    const p = (r as unknown as { payload: Record<string, unknown> }).payload;
    expect({ size: p.size, quality: p.quality, background: p.background }).toEqual({
      size: undefined,
      quality: undefined,
      background: undefined,
    });
  });

  test("null — тоже «поля нет», модель так обнуляет необязательное", () => {
    expect(ok({ size: null, quality: null, background: null }).ok).toBe(true);
  });

  test("законные значения проходят насквозь", () => {
    const r = ok({ size: "1536x1024", quality: "high", background: "transparent" });
    expect(r.ok).toBe(true);
    const p = (r as unknown as { payload: Record<string, unknown> }).payload;
    expect({ size: p.size, quality: p.quality, background: p.background }).toEqual({
      size: "1536x1024",
      quality: "high",
      background: "transparent",
    });
  });
});
