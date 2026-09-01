import { test, expect, describe } from "bun:test";
import { mdToTelegramHtml, sendWithHtml } from "../lib/telegram-format.ts";

describe("mdToTelegramHtml (T-fmt)", () => {
  test("bold/italic/code/strike", () => {
    expect(mdToTelegramHtml("**Результат:** ок")).toBe("<b>Результат:</b> ок");
    expect(mdToTelegramHtml("a *b* c")).toBe("a <i>b</i> c");
    expect(mdToTelegramHtml("see `x`")).toBe("see <code>x</code>");
    expect(mdToTelegramHtml("~~no~~")).toBe("<s>no</s>");
    expect(mdToTelegramHtml("__b__")).toBe("<b>b</b>");
  });
  test("escapes HTML special chars and code-block content", () => {
    expect(mdToTelegramHtml("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
    expect(mdToTelegramHtml("```\n1<2 && 3>2\n```")).toBe("<pre>1&lt;2 &amp;&amp; 3&gt;2</pre>");
  });
  test("headings → bold, bullets → •, links", () => {
    expect(mdToTelegramHtml("# Title")).toBe("<b>Title</b>");
    expect(mdToTelegramHtml("- item")).toBe("• item");
    expect(mdToTelegramHtml("[t](https://x.com)")).toBe('<a href="https://x.com">t</a>');
  });
  test("plain text passes through unchanged", () => {
    expect(mdToTelegramHtml("просто текст без формата")).toBe("просто текст без формата");
  });
  test("no asterisks leak for partial markdown (best-effort, never throws)", () => {
    expect(() => mdToTelegramHtml("**unclosed and `weird")).not.toThrow();
  });
});

describe("mdToTelegramHtml — blockquote & spoiler", () => {
  test("single-line blockquote", () => {
    expect(mdToTelegramHtml("> цитата")).toBe("<blockquote>цитата</blockquote>");
  });
  test("multi-line blockquote collapses into one block", () => {
    expect(mdToTelegramHtml("> строка 1\n> строка 2")).toBe(
      "<blockquote>строка 1\nстрока 2</blockquote>",
    );
  });
  test("expandable blockquote via >!", () => {
    expect(mdToTelegramHtml(">! длинная\n> ещё")).toBe(
      "<blockquote expandable>длинная\nещё</blockquote>",
    );
  });
  test("blockquote keeps inline formatting and a following normal line", () => {
    expect(mdToTelegramHtml("> **жирно** и [ссылка](https://x.io)\nобычный")).toBe(
      '<blockquote><b>жирно</b> и <a href="https://x.io">ссылка</a></blockquote>\nобычный',
    );
  });
  test("spoiler ||x||", () => {
    expect(mdToTelegramHtml("это ||секрет|| тут")).toBe(
      "это <tg-spoiler>секрет</tg-spoiler> тут",
    );
  });
  test("plain '>' inside a line is not a blockquote (stays escaped)", () => {
    expect(mdToTelegramHtml("a > b")).toBe("a &gt; b");
  });
});

describe("sendWithHtml fallback", () => {
  test("first tries HTML; falls back to plain on send error", async () => {
    const calls: Array<{ text: string; pm?: string }> = [];
    let first = true;
    const send = async (text: string, pm?: "HTML") => {
      calls.push({ text, pm });
      if (first) { first = false; throw new Error("can't parse entities"); }
      return { ok: true };
    };
    await sendWithHtml(send, "**x**");
    expect(calls.length).toBe(2);
    expect(calls[0].pm).toBe("HTML");
    expect(calls[0].text).toBe("<b>x</b>");
    expect(calls[1].pm).toBeUndefined();
    expect(calls[1].text).toBe("**x**"); // raw fallback
  });
});

/**
 * Аудит 2026-08-04: `catch` в sendWithHtml был без разбора типа ошибки.
 * Таймаут сокета не значит «не доставлено» — запрос мог дойти до Telegram, а
 * потеряться мог ответ. Слепой ретрай в этом случае доставлял второй экземпляр
 * сообщения, и на пути публикации в канал тоже.
 */
describe("sendWithHtml — ретрай только на ошибке разметки", () => {
  function recorder(fail: unknown) {
    const calls: Array<{ text: string; pm?: string }> = [];
    let first = true;
    const send = async (text: string, pm?: "HTML") => {
      calls.push({ text, pm });
      if (first) {
        first = false;
        throw fail;
      }
      return { ok: true };
    };
    return { calls, send };
  }

  test("таймаут не ретраится — сообщение не задваивается", async () => {
    const { calls, send } = recorder(
      Object.assign(new Error("socket hang up"), { code: "ETIMEDOUT" }),
    );
    await expect(sendWithHtml(send, "**x**")).rejects.toThrow("socket hang up");
    expect(calls.length).toBe(1);
  });

  test("429 ретраится, но только переждав запрошенные секунды", async () => {
    // Аудит 2026-08-20. Раньше здесь стояло «не ретраится» — и это лечило
    // симптом: проблемой был МГНОВЕННЫЙ повтор, а не повтор как таковой. 429
    // приходит ДО обработки (сообщение не доставлено) и несёт точное число
    // секунд — переждать и повторить безопасно, в отличие от таймаута ниже,
    // где неизвестно, дошёл ли запрос. Без этого длинный ответ просто терялся,
    // а решение о повторе принимала модель — иногда через секунду.
    const slept: number[] = [];
    const { calls, send } = recorder({
      response: { error_code: 429, description: "Too Many Requests: retry after 5" },
      message: "429: Too Many Requests",
    });
    await sendWithHtml(send, "**x**", undefined, {
      sleep: async (ms) => void slept.push(ms),
    });
    expect(calls.length).toBe(2);
    // Ключевое: пауза именно та, что назвал сервер.
    expect(slept).toEqual([5000]);
  });

  test("429 с блокировкой длиннее минуты не ретраится вовсе", async () => {
    const slept: number[] = [];
    const { calls, send } = recorder({
      response: { error_code: 429, description: "Too Many Requests: retry after 3600" },
      message: "429: Too Many Requests",
    });
    await expect(
      sendWithHtml(send, "**x**", undefined, { sleep: async (ms) => void slept.push(ms) }),
    ).rejects.toBeDefined();
    expect(calls.length).toBe(1);
    expect(slept).toEqual([]);
  });

  test("5xx не ретраится", async () => {
    const { calls, send } = recorder({
      response: { error_code: 502, description: "Bad Gateway" },
      message: "502: Bad Gateway",
    });
    await expect(sendWithHtml(send, "**x**")).rejects.toBeDefined();
    expect(calls.length).toBe(1);
  });

  test("400 про разметку — ретрай plain-текстом", async () => {
    const { calls, send } = recorder({
      response: {
        error_code: 400,
        description: "Bad Request: can't parse entities: unsupported start tag \"z\"",
      },
      message: "400: Bad Request",
    });
    await sendWithHtml(send, "**x**");
    expect(calls.length).toBe(2);
    expect(calls[1].pm).toBeUndefined();
    expect(calls[1].text).toBe("**x**");
  });

  test("400 не про разметку (чат не найден) — не ретраится", async () => {
    const { calls, send } = recorder({
      response: { error_code: 400, description: "Bad Request: chat not found" },
      message: "400: Bad Request",
    });
    await expect(sendWithHtml(send, "**x**")).rejects.toBeDefined();
    expect(calls.length).toBe(1);
  });
});
