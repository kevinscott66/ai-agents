/**
 * Аудит 2026-08-11, продолжение health-снапшота: тот же секрет, другие каналы.
 *
 * `getErrorMessage` — общий идиом «превратить брошенное в текст для человека»,
 * 75 вызовов в lib/ и orchestrator/. Часть из них оборачивает вызовы Bot API:
 * PUBLISH_TO_CHANNEL, CREATE_TEAM_CHANNEL и прочие уходят через telegraf →
 * node-fetch@2, а он на сетевой ошибке пишет
 * `request to https://api.telegram.org/bot<ТОКЕН>/sendMessage failed, ...`.
 * Результат ложится в `agent_actions.error` — то есть токен оседает в SQLite
 * на диске и потом отдаётся админам через /api/actions.
 *
 * Чинить 75 мест по одному — гарантированно пропустить часть и не закрыть
 * будущие. Секрет вычищается там, где текст ошибки и становится текстом.
 */
import { describe, test, expect } from "bun:test";
import { getErrorMessage } from "../lib/errors.ts";

const FAKE_TOKEN = "7123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";

describe("getErrorMessage не выносит секреты наружу", () => {
  test("токен из URL node-fetch вычищается", () => {
    const msg = getErrorMessage(
      new Error(
        `request to https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage ` +
          `failed, reason: connect ETIMEDOUT`,
      ),
    );

    expect(msg).not.toContain(FAKE_TOKEN);
    expect(msg).toContain("ETIMEDOUT");
  });

  test("не-Error значения тоже проходят через скруббер", () => {
    expect(getErrorMessage(`boom at /bot${FAKE_TOKEN}/getUpdates`)).not.toContain(
      FAKE_TOKEN,
    );
  });

  test("обычные сообщения не портятся", () => {
    expect(getErrorMessage(new Error("400: chat not found"))).toBe(
      "400: chat not found",
    );
  });

  test("текст остаётся пригодным для веток по коду ошибки", () => {
    // replyForTurnError разбирает сообщение регуляркой на 429/rate limit —
    // скруббер не должен ломать эту логику.
    const msg = getErrorMessage(new Error("429: Too Many Requests: retry after 30"));
    expect(/\b429\b/.test(msg)).toBe(true);
  });
});
