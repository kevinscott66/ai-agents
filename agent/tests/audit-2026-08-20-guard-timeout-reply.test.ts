/**
 * Аудит 2026-08-20: на сработавшем handlerTimeout guard отвечал «Не смог
 * обработать это сообщение» — то есть врал.
 *
 * `p-timeout` reject'ит СНАРУЖИ хендлера и ничего не отменяет: `promise.cancel`
 * у обычного промиса нет. Тяжёлый ход (web_search + обложка +
 * PUBLISH_TO_CHANNEL) переваливает HANDLER_TIMEOUT_MS, пользователь читает «не
 * смог» — и через полминуты получает пост в канале и настоящий ответ бота.
 * Оба сообщения попадают в историю чата, а значит и в контекст модели.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  buildErrorGuard,
  isHandlerTimeout,
  GUARD_REPLY,
  GUARD_TIMEOUT_REPLY,
} from "../lib/bot-error-guard.ts";

const CHAT = -100777;
const ALLOWED = [String(CHAT)];

/** Ровно то, что бросает p-timeout при срабатывании таймера. */
class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Promise timed out after ${ms} milliseconds`);
    this.name = "TimeoutError";
  }
}

function fakeCtx(sent: string[]) {
  return {
    chat: { id: CHAT },
    update: { update_id: 42 },
    reply: async (t: string) => {
      sent.push(t);
    },
  } as any;
}

describe("isHandlerTimeout", () => {
  it("узнаёт TimeoutError из p-timeout", () => {
    expect(isHandlerTimeout(new TimeoutError(300000))).toBe(true);
  });

  it("обычная ошибка — не таймаут", () => {
    expect(isHandlerTimeout(new Error("Promise timed out after 5 ms"))).toBe(false);
  });

  it("не падает на null/undefined/строке", () => {
    expect(isHandlerTimeout(null)).toBe(false);
    expect(isHandlerTimeout(undefined)).toBe(false);
    expect(isHandlerTimeout("TimeoutError")).toBe(false);
  });

  it("объект с name: 'TimeoutError' тоже считается (не только instanceof)", () => {
    // Важно: p-timeout своего класса наружу не экспортирует, сверять
    // instanceof не с чем — сверяем name.
    expect(isHandlerTimeout({ name: "TimeoutError" })).toBe(true);
  });
});

describe("ответ guard'а честен относительно того, что произошло", () => {
  it("на таймауте не говорит «не смог»", async () => {
    const sent: string[] = [];
    await buildErrorGuard("smm", ALLOWED)(new TimeoutError(300000), fakeCtx(sent));
    expect(sent).toEqual([GUARD_TIMEOUT_REPLY]);
    expect(sent[0]).not.toBe(GUARD_REPLY);
  });

  it("на таймауте предупреждает, что работа могла выполниться", () => {
    expect(GUARD_TIMEOUT_REPLY).toMatch(/могла|проверь/i);
    expect(GUARD_TIMEOUT_REPLY).not.toMatch(/Не смог обработать/);
  });

  it("на настоящем падении текст прежний", async () => {
    const sent: string[] = [];
    await buildErrorGuard("smm", ALLOWED)(new Error("бум"), fakeCtx(sent));
    expect(sent).toEqual([GUARD_REPLY]);
  });

  it("два текста различимы", () => {
    expect(GUARD_TIMEOUT_REPLY).not.toBe(GUARD_REPLY);
  });

  it("allowlist по-прежнему главнее: вне списка молчим и на таймауте", async () => {
    const sent: string[] = [];
    await buildErrorGuard("smm", ["-100999"])(
      new TimeoutError(300000),
      fakeCtx(sent),
    );
    expect(sent).toEqual([]);
  });

  it("guard не пробрасывает таймаут дальше", async () => {
    const ctx = {
      chat: { id: CHAT },
      reply: async () => {
        throw new Error("telegram лёг");
      },
    } as any;
    await expect(
      buildErrorGuard("smm", ALLOWED)(new TimeoutError(1), ctx),
    ).resolves.toBeUndefined();
  });
});

describe("лог отличает таймаут от падения", () => {
  it("в объект лога добавляется timedOut, и только на таймауте", async () => {
    const src = await Bun.file(
      new URL("../lib/bot-error-guard.ts", import.meta.url),
    ).text();
    // Без этого поля в логе таймаут неотличим от обычного throw, а именно по
    // логу и разбирают «почему бот сказал одно, а сделал другое».
    expect(src).toContain("...(timedOut ? { timedOut: true } : {})");
  });
});

describe("допущение о telegraf/p-timeout закреплено", () => {
  it("telegraf прогоняет middleware через p-timeout с handlerTimeout", async () => {
    const src = await Bun.file(
      new URL("../node_modules/telegraf/lib/telegraf.js", import.meta.url),
    ).text();
    expect(src).toMatch(/p_timeout_1\.default.*this\.options\.handlerTimeout/);
  });

  it("p-timeout называет свою ошибку TimeoutError и не умеет отменять промис", async () => {
    const src = await Bun.file(
      new URL("../node_modules/p-timeout/index.js", import.meta.url),
    ).text();
    expect(src).toContain("this.name = 'TimeoutError'");
    // Отмена возможна только у промиса с .cancel — у обычного его нет,
    // поэтому хендлер после reject продолжает работать.
    expect(src).toContain("typeof promise.cancel === 'function'");
  });
});
