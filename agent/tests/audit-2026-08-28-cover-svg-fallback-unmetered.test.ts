/**
 * Аудит 2026-08-28: SVG-фолбэк обложки не считался вообще ни в один бакет.
 *
 * Аудит 2026-08-12 перенёс счёт денег в `generateCoverPng`, потому что второй
 * маршрут к картинке (PUBLISH_TO_CHANNEL → coverPrompt) не видел бакета
 * GENERATE_IMAGE. Но закрыт был только дорогой рукав. Ветка «бюджет кончился»
 * (`if (!slot.ok) return await cheapCover(...)`) уходила к `generateSvgFromPrompt`
 * — это запрос к Claude, ровно та работа, ради которой заведён отдельный бакет
 * `GENERATE_SVG_IMAGE: 20/мин на агента` (rate-limits.ts:41). Слот при этом не
 * списывался: растровый бакет по определению пуст, а SVG-бакет никто не трогал.
 *
 * То есть после шестой картинки за час у `design` начинался ровно тот же
 * обход, что чинили 2026-08-12, только движком Claude вместо OpenAI: сколько
 * публикаций пропустит общий гейт (60/мин на агента) — столько и запросов к
 * Claude, без потолка. Аудит 2026-08-20 признал этот класс дыры для соседней
 * ветки («SVG-фолбэк стоит запроса к Claude, то есть тех же денег») и поставил
 * там счётчик — а здесь он остался.
 *
 * Чиним, не меняя решения 2026-08-12: публикация по-прежнему не падает от
 * исчерпанного растрового бюджета, но дешёвый рукав платит своим бакетом. 20
 * обложек в минуту — потолок недостижимый для живой публикации и достижимый
 * для цикла.
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { generateCoverPng } from "../lib/dispatch/media.ts";
import {
  _resetRateLimits,
  checkAndConsumeRateLimit,
  checkRateLimit,
} from "../lib/rate-limits.ts";

const AGENT = "design";
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"></svg>`;

beforeEach(() => _resetRateLimits());
afterEach(() => _resetRateLimits());

/** Счётчики вызовов вместо походов в OpenAI/Anthropic. */
function deps() {
  const calls = { paid: 0, cheap: 0 };
  return {
    calls,
    generate: async () => {
      calls.paid++;
      return Buffer.from("png-от-openai");
    },
    fallbackSvg: async () => {
      calls.cheap++;
      return SVG;
    },
  };
}

/** Выбрать растровый бюджет роли, не трогая SVG-бакет. */
function drainRaster(): void {
  for (let i = 0; i < 6; i++) {
    expect(checkAndConsumeRateLimit(AGENT, "GENERATE_IMAGE").ok).toBe(true);
  }
  expect(checkRateLimit(AGENT, "GENERATE_IMAGE").ok).toBe(false);
}

describe("предпосылки", () => {
  test("у SVG-генерации есть собственный бакет 20/мин на агента", () => {
    for (let i = 0; i < 20; i++) {
      expect(checkAndConsumeRateLimit(AGENT, "GENERATE_SVG_IMAGE").ok).toBe(true);
    }
    const denied = checkRateLimit(AGENT, "GENERATE_SVG_IMAGE");
    expect(denied.ok).toBe(false);
    expect(denied.reason).toContain("GENERATE_SVG_IMAGE");
  });

  test("растровый и SVG бакеты независимы — выбранный растр не трогает SVG", () => {
    drainRaster();
    expect(checkRateLimit(AGENT, "GENERATE_SVG_IMAGE").ok).toBe(true);
  });
});

describe("дешёвый рукав платит своим бакетом", () => {
  test("обложка на исчерпанном бюджете списывает слот GENERATE_SVG_IMAGE", async () => {
    const d = deps();
    drainRaster();
    // Девятнадцать слотов выбраны заранее: двадцатый должен закрыть бакет.
    for (let i = 0; i < 19; i++) checkAndConsumeRateLimit(AGENT, "GENERATE_SVG_IMAGE");

    await generateCoverPng("обложка", AGENT, d);

    expect(d.calls.cheap).toBe(1);
    expect(checkRateLimit(AGENT, "GENERATE_SVG_IMAGE").ok).toBe(false);
  });

  test("исчерпанный SVG-бакет — отказ, а не ещё один запрос к Claude", async () => {
    const d = deps();
    drainRaster();
    for (let i = 0; i < 20; i++) checkAndConsumeRateLimit(AGENT, "GENERATE_SVG_IMAGE");

    await expect(generateCoverPng("обложка", AGENT, d)).rejects.toThrow(/бюджет/);
    expect(d.calls.cheap).toBe(0);
    expect(d.calls.paid).toBe(0);
  });

  test("двадцать пять обложек подряд дают ровно двадцать вызовов Claude", async () => {
    const d = deps();
    drainRaster();
    let failed = 0;
    for (let i = 0; i < 25; i++) {
      try {
        await generateCoverPng(`обложка ${i}`, AGENT, d);
      } catch {
        failed++;
      }
    }
    expect(d.calls.cheap).toBe(20);
    expect(failed).toBe(5);
  });

  test("в отказе видно оба бакета: и растровый, и SVG", async () => {
    const d = deps();
    drainRaster();
    for (let i = 0; i < 20; i++) checkAndConsumeRateLimit(AGENT, "GENERATE_SVG_IMAGE");
    await expect(generateCoverPng("обложка", AGENT, d)).rejects.toThrow(
      /GENERATE_IMAGE[\s\S]*GENERATE_SVG_IMAGE/,
    );
  });
});

describe("оплаченные маршруты не платят второй раз", () => {
  test("обычная обложка тратит растровый бакет и не трогает SVG", async () => {
    const d = deps();
    await generateCoverPng("обложка", AGENT, d);
    expect(d.calls.paid).toBe(1);
    expect(d.calls.cheap).toBe(0);
    for (let i = 0; i < 20; i++) {
      expect(checkAndConsumeRateLimit(AGENT, "GENERATE_SVG_IMAGE").ok).toBe(true);
    }
  });

  test("quota-ошибка OpenAI: слот уже уплачен, SVG-бакет не трогаем", async () => {
    const d = deps();
    const buf = await generateCoverPng("обложка", AGENT, {
      ...d,
      generate: async () => {
        d.calls.paid++;
        throw new Error("429 You exceeded your current quota, please check your plan");
      },
    });
    expect(buf.length).toBeGreaterThan(0);
    expect(d.calls.paid).toBe(1);
    expect(d.calls.cheap).toBe(1);
    for (let i = 0; i < 20; i++) {
      expect(checkAndConsumeRateLimit(AGENT, "GENERATE_SVG_IMAGE").ok).toBe(true);
    }
  });
});

describe("соседние ветки не сдвинулись", () => {
  test("роль без обоих инструментов по-прежнему получает отказ, а не картинку", async () => {
    const d = deps();
    await expect(generateCoverPng("обложка", "smm", d)).rejects.toThrow(
      /не выдан ни GENERATE_IMAGE, ни GENERATE_SVG_IMAGE/,
    );
    expect(d.calls.cheap).toBe(0);
  });

  test("исчерпанный бюджет по-прежнему не роняет публикацию (тест 2026-08-12)", async () => {
    const d = deps();
    drainRaster();
    await expect(generateCoverPng("обложка", AGENT, d)).resolves.toBeInstanceOf(Buffer);
  });
});
