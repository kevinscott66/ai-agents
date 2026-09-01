/**
 * Аудит 2026-08-12: бюджет на картинки обходился вторым маршрутом.
 *
 * Лимит «6/час на агента, 30/час суммарно» подписан ценой прямо в комментарии
 * к RULES (lib/rate-limits.ts:31) — $0.04 за вызов OpenAI. Висит он на действии
 * GENERATE_IMAGE. Но к тому же самому API ведёт второй путь: PUBLISH_TO_CHANNEL
 * → generateCoverPng → generateImage (action-dispatch.ts:494), а
 * PUBLISH_TO_CHANNEL в RULES отсутствует. Замер:
 *
 *   GENERATE_IMAGE через гейт: прошло 6 → rate limit: 6/3600s
 *   PUBLISH_TO_CHANNEL через гейт: прошло 50 (упёрлось в общий 60/мин)
 *   бакет картинок после этого: {"ok":true}
 *
 * Пятьдесят обложек — и оба бакета картинок нетронуты. Человек в контуре есть
 * (PUBLISH_TO_CHANNEL в ALWAYS_APPROVE_ACTIONS), но он одобряет ПОСТ, а не
 * покупку картинки: обложка — деталь реализации, которой в карточке апрува не
 * видно.
 *
 * Счёт переносим в единственное место, где деньги и тратятся. Исчерпанный
 * бюджет не роняет публикацию: для «OpenAI недоступен» тут уже написан
 * SVG-фолбэк, и «бюджет кончился» — тот же случай. Слот не возвращаем —
 * GENERATE_IMAGE в NO_REFUND_ACTIONS.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { generateCoverPng } from "../lib/dispatch/media.ts";
import {
  _resetRateLimits,
  checkAndConsumeRateLimit,
  checkRateLimit,
} from "../lib/rate-limits.ts";

const AGENT = "design";
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"></svg>`;

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

describe("обложка публикации считается в бюджет картинок", () => {
  test("замер из шапки: шестая обложка исчерпывает бакет, седьмая — уже нет", async () => {
    const d = deps();
    expect(checkRateLimit(AGENT, "GENERATE_IMAGE").ok).toBe(true);

    for (let i = 0; i < 6; i++) {
      await generateCoverPng(`обложка ${i}`, AGENT, d);
    }
    expect(d.calls.paid).toBe(6);
    expect(checkRateLimit(AGENT, "GENERATE_IMAGE").ok).toBe(false);

    // Седьмая идёт по дешёвому пути — денег больше не тратим.
    const buf = await generateCoverPng("седьмая", AGENT, d);
    expect(d.calls.paid).toBe(6);
    expect(d.calls.cheap).toBe(1);
    expect(buf.length).toBeGreaterThan(0);
  });

  test("бакет общий с прямым GENERATE_IMAGE, а не отдельный", async () => {
    const d = deps();
    for (let i = 0; i < 6; i++) {
      expect(checkAndConsumeRateLimit(AGENT, "GENERATE_IMAGE").ok).toBe(true);
    }
    // Дизайнер выбрал свои шесть картинок за час — обложка поста уже не платная.
    await generateCoverPng("обложка", AGENT, d);
    expect(d.calls.paid).toBe(0);
    expect(d.calls.cheap).toBe(1);
  });

  test("исчерпанный бюджет не роняет публикацию", async () => {
    const d = deps();
    for (let i = 0; i < 6; i++) checkAndConsumeRateLimit(AGENT, "GENERATE_IMAGE");
    await expect(generateCoverPng("обложка", AGENT, d)).resolves.toBeInstanceOf(Buffer);
  });

  test("quota-ошибка OpenAI по-прежнему уходит в SVG-фолбэк", async () => {
    const d = deps();
    const buf = await generateCoverPng("обложка", AGENT, {
      ...d,
      generate: async () => {
        d.calls.paid++;
        throw new Error("429 You exceeded your current quota, please check your plan");
      },
    });
    expect(d.calls.paid).toBe(1);
    expect(d.calls.cheap).toBe(1);
    expect(buf.length).toBeGreaterThan(0);
  });

  test("прочие ошибки наружу — их ловит хендлер публикации, а не мы", async () => {
    const d = deps();
    await expect(
      generateCoverPng("обложка", AGENT, {
        ...d,
        generate: async () => {
          throw new Error("500 internal");
        },
      }),
    ).rejects.toThrow(/500 internal/);
    expect(d.calls.cheap).toBe(0);
  });
});
