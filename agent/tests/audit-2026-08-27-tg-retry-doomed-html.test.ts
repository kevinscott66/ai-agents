/**
 * Аудит 2026-08-27: ретрай по 429 оборачивал ВЕСЬ `sendWithHtmlOnce`, включая
 * уже провалившуюся HTML-попытку.
 *
 * Разметка ломается детерминированно: если Telegram ответил «can't parse
 * entities», он ответит так же и через секунду, и через минуту — текст-то тот
 * же. А 429 в этой связке ловит как раз ПЛЕЙН-фолбэк (он идёт вторым). Ретрай
 * при этом перезапускал функцию с начала, то есть заново слал заведомо-400
 * HTML-запрос — и слал его ВНУТРЬ того самого флуд-окна, из-за которого мы и
 * ждём. Три попытки давали шесть запросов вместо четырёх, и три из шести были
 * обречены с самого начала.
 *
 * Здесь замеряется именно последовательность запросов, а не только результат:
 * тест на результат прошёл бы и до фикса.
 */
import { describe, expect, it } from "bun:test";
import { sendWithHtml } from "../lib/telegram-format.ts";

const PARSE_ERROR = {
  response: { error_code: 400, description: "Bad Request: can't parse entities in message text" },
};
const RATE_LIMIT = {
  response: {
    error_code: 429,
    description: "Too Many Requests: retry after 1",
    parameters: { retry_after: 0 },
  },
};
const NO_SLEEP = { sleep: async () => {} };

/** Записывает, каким parse-режимом шёл каждый запрос. */
function recorder(plan: (n: number, mode: "HTML" | "PLAIN") => unknown) {
  const calls: Array<"HTML" | "PLAIN"> = [];
  const send = async (_text: string, parseMode?: "HTML") => {
    const mode = parseMode === "HTML" ? "HTML" : "PLAIN";
    calls.push(mode);
    const outcome = plan(calls.length, mode);
    if (outcome instanceof Error || (outcome && typeof outcome === "object")) throw outcome;
    return outcome as string;
  };
  return { calls, send };
}

describe("sendWithHtml: 429 на плейн-фолбэке не воскрешает HTML-попытку", () => {
  it("не повторяет HTML после того, как разметка уже отвергнута", async () => {
    // HTML падает на разметке всегда; плейн ловит 429 дважды, потом проходит.
    let plainSeen = 0;
    const { calls, send } = recorder((_n, mode) => {
      if (mode === "HTML") return PARSE_ERROR;
      plainSeen += 1;
      return plainSeen <= 2 ? RATE_LIMIT : "sent";
    });

    const out = await sendWithHtml(send, "**bold", undefined, NO_SLEEP);

    expect(out).toBe("sent");
    // Ровно одна HTML-попытка на весь вызов, остальное — плейн.
    expect(calls).toEqual(["HTML", "PLAIN", "PLAIN", "PLAIN"]);
    expect(calls.filter((c) => c === "HTML").length).toBe(1);
  });

  it("состояние живёт внутри одного вызова, а не в модуле", async () => {
    const first = recorder((_n, mode) => (mode === "HTML" ? PARSE_ERROR : "ok"));
    await sendWithHtml(first.send, "**bold", undefined, NO_SLEEP);
    expect(first.calls).toEqual(["HTML", "PLAIN"]);

    // Следующий вызов — другой текст, разметка может быть валидной: он обязан
    // снова начать с HTML, иначе фикс превратился бы в глобальный тумблер.
    const second = recorder(() => "ok");
    await sendWithHtml(second.send, "чистый текст", undefined, NO_SLEEP);
    expect(second.calls).toEqual(["HTML"]);
  });

  it("контроль: валидная разметка уходит одним HTML-запросом", async () => {
    const { calls, send } = recorder(() => "ok");
    await sendWithHtml(send, "**bold**", undefined, NO_SLEEP);
    expect(calls).toEqual(["HTML"]);
  });

  it("контроль: одиночный фолбэк без 429 остаётся двумя запросами", async () => {
    const { calls, send } = recorder((_n, mode) => (mode === "HTML" ? PARSE_ERROR : "ok"));
    const out = await sendWithHtml(send, "**bold", undefined, NO_SLEEP);
    expect(out).toBe("ok");
    expect(calls).toEqual(["HTML", "PLAIN"]);
  });

  it("контроль: не-429 с плейн-пути пробрасывается сразу, без лишних запросов", async () => {
    const boom = { response: { error_code: 400, description: "Bad Request: chat not found" } };
    const { calls, send } = recorder((_n, mode) => (mode === "HTML" ? PARSE_ERROR : boom));
    await expect(sendWithHtml(send, "**bold", undefined, NO_SLEEP)).rejects.toMatchObject({
      response: { description: "Bad Request: chat not found" },
    });
    expect(calls).toEqual(["HTML", "PLAIN"]);
  });

  it("контроль: 429 на самой HTML-попытке по-прежнему повторяет HTML", async () => {
    // Тут HTML не отвергнут по разметке — он просто не доехал. Повторять его
    // МОЖНО и НУЖНО: форматирование не виновато.
    let n = 0;
    const { calls, send } = recorder(() => {
      n += 1;
      return n === 1 ? RATE_LIMIT : "ok";
    });
    const out = await sendWithHtml(send, "**bold**", undefined, NO_SLEEP);
    expect(out).toBe("ok");
    expect(calls).toEqual(["HTML", "HTML"]);
  });
});
