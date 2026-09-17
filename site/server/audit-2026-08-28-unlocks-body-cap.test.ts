/**
 * Аудит 2026-08-28: потолок тела был ровно размером фида.
 *
 * `MAX_BODY_BYTES` стоял на 25 МБ, и ровно 25 МБ — наблюдаемый размер фида
 * (докстрока `startUnlocksRefresh` в index.ts: «Фид — 25 МБ JSON»). Запаса
 * ноль: один байт роста апстрима, и
 * каждая из четырёх попыток `fetchEmissions` качает 25 МБ и бросает на
 * последних байтах. Это ~2.4 ГБ трафика в сутки при часовом цикле и календарь,
 * замерший навсегда — снаружи только `console.warn`.
 *
 * Отказ при этом наступал бы молча-постепенно: сегодня 24.9 МБ проходят, завтра
 * 25.1 не проходят, и ничто заранее не говорит, что мы у края.
 *
 * Про `content-length` в fetchOnce: fetch распаковывает тело прозрачно, так что
 * заголовок несёт СЖАТЫЙ размер, а потолок меряет распакованные байты. Проверка
 * односторонняя — она может не сработать, но ложно отвергнуть не может, — и
 * оставлена как есть; здесь чинится сам потолок.
 */
import { describe, expect, test } from "bun:test";
import { MAX_BODY_BYTES, BODY_WARN_BYTES, readCapped } from "./unlocks.ts";

const MB = 1024 * 1024;
/** Наблюдаемый размер фида на 2026-08-28. */
const FEED_MB = 25;

function streamed(chunks: Uint8Array[]): Response {
  return new Response(
    new ReadableStream({
      start(c) {
        for (const ch of chunks) c.enqueue(ch);
        c.close();
      },
    }),
  );
}

const enc = new TextEncoder();
const filler = (bytes: number) => new Uint8Array(bytes).fill(0x61); // 'a'

// Восстанавливать console.warn обязательно в finally: readCapped асинхронна, и
// подмена, снятая до await, ловила бы предупреждение соседнего теста, а не своё.
async function captureWarn<T>(fn: () => Promise<T>): Promise<{ out: T; warnings: string[] }> {
  const real = console.warn;
  const warnings: string[] = [];
  console.warn = (...a: unknown[]) => {
    warnings.push(a.map(String).join(" "));
  };
  try {
    return { out: await fn(), warnings };
  } finally {
    console.warn = real;
  }
}

describe("потолок тела", () => {
  test("запас над наблюдаемым размером фида — кратный, а не нулевой", () => {
    expect(MAX_BODY_BYTES).toBeGreaterThanOrEqual(FEED_MB * MB * 2);
  });

  test("порог предупреждения ниже потолка и выше сегодняшнего фида", () => {
    expect(BODY_WARN_BYTES).toBeLessThan(MAX_BODY_BYTES);
    expect(BODY_WARN_BYTES).toBeGreaterThan(FEED_MB * MB);
  });
});

describe("readCapped", () => {
  test("тело в пределах потолка читается целиком", async () => {
    const res = streamed([enc.encode('{"data":'), enc.encode("[]}")]);
    expect(await readCapped(res, 1000)).toBe('{"data":[]}');
  });

  test("превышение потолка — отказ с указанием предела", async () => {
    const res = streamed([filler(600), filler(600)]);
    await expect(readCapped(res, 1000)).rejects.toThrow(/exceeded 1000 bytes/);
  });

  test("многобайтный символ на границе чанков не бьётся", async () => {
    const bytes = enc.encode("разблокировка");
    const res = streamed([bytes.slice(0, 5), bytes.slice(5)]);
    expect(await readCapped(res, 1000)).toBe("разблокировка");
  });

  test("тело без потока читается как текст", async () => {
    const res = new Response(null);
    expect(await readCapped(res, 1000)).toBe("");
  });
});

describe("предупреждение о приближении к потолку", () => {
  test("тело выше порога предупреждает, но проходит", async () => {
    const { out, warnings } = await captureWarn(() => readCapped(streamed([filler(900)]), 1000));
    expect(out.length).toBe(900);
    expect(warnings.join("\n")).toMatch(/900/);
  });

  test("обычное тело молчит", async () => {
    const { warnings } = await captureWarn(() => readCapped(streamed([filler(100)]), 1000));
    expect(warnings).toEqual([]);
  });
});
