/**
 * Аудит 2026-08-08: лимит на генерацию картинок не держал именно там, где нужен.
 *
 * GENERATE_IMAGE стоит реальных денег ($0.04 за вызов), и списываются они внутри
 * dispatch'а — до отправки результата в Telegram. dispatchAction на любой ошибке
 * звал refundRateLimit и возвращал слот. Значит при стабильно падающей отправке
 * (бота выкинули из чата, фото не проходит по размеру) счётчик стоял на месте, а
 * счёт OpenAI рос: «6/час на агента» превращалось в «сколько успеет».
 *
 * Тест держит обе стороны размена: у GENERATE_IMAGE слот не возвращается, у
 * дешёвых действий — возвращается по-прежнему.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import {
  checkAndConsumeRateLimit,
  refundRateLimit,
  _resetRateLimits,
} from "../lib/rate-limits.ts";
import { DEFAULT_GENERATE_IMAGE_PER_AGENT_LIMIT } from "../lib/constants.ts";

const AGENT = "design";

beforeEach(() => {
  _resetRateLimits();
});

describe("GENERATE_IMAGE: рефанд не возвращает потраченные деньги", () => {
  test("цикл «зарезервировал → упал → рефанд» упирается в лимит", () => {
    const max = DEFAULT_GENERATE_IMAGE_PER_AGENT_LIMIT;
    expect(max).toBeGreaterThan(0);

    // Ровно тот сценарий, что был в проде: OpenAI отработал, tgSendPhoto упал,
    // dispatchAction откатил резервацию.
    for (let i = 0; i < max; i++) {
      const r = checkAndConsumeRateLimit(AGENT, "GENERATE_IMAGE");
      expect(r.ok).toBe(true);
      refundRateLimit(AGENT, "GENERATE_IMAGE");
    }

    const next = checkAndConsumeRateLimit(AGENT, "GENERATE_IMAGE");
    expect(next.ok).toBe(false);
  });

  test("глобальный бакет тоже не откатывается", () => {
    // Разные агенты, чтобы упереться именно в global, а не в perAgent.
    _resetRateLimits();
    let consumed = 0;
    for (let i = 0; i < 200; i++) {
      const r = checkAndConsumeRateLimit(`a${i}`, "GENERATE_IMAGE");
      if (!r.ok) break;
      consumed++;
      refundRateLimit(`a${i}`, "GENERATE_IMAGE");
    }
    // Без фикса цикл дошёл бы до 200: каждый агент свежий, а global откатывался.
    expect(consumed).toBeLessThan(200);
  });
});

describe("дешёвые действия рефандятся как раньше", () => {
  test("WRITE_WIKI: слот возвращается", () => {
    for (let i = 0; i < 50; i++) {
      const r = checkAndConsumeRateLimit(AGENT, "WRITE_WIKI");
      expect(r.ok).toBe(true);
      refundRateLimit(AGENT, "WRITE_WIKI");
    }
  });

  test("SEND_MESSAGE: слот возвращается", () => {
    for (let i = 0; i < 50; i++) {
      const r = checkAndConsumeRateLimit(AGENT, "SEND_MESSAGE");
      expect(r.ok).toBe(true);
      refundRateLimit(AGENT, "SEND_MESSAGE");
    }
  });
});
