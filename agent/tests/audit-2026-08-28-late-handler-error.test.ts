/**
 * Аудит 2026-08-28: падение хендлера ПОСЛЕ таймаута исчезало бесследно.
 *
 * `handlerTimeout` телеграфа — это p-timeout, а он ничего не отменяет: reject
 * приходит снаружи, хендлер продолжает работать. Про это в bot-error-guard.ts
 * уже написано (GUARD_TIMEOUT_REPLY: «часть работы могла всё же выполниться»).
 * Не написано было другое: если хендлер потом ПАДАЕТ, об этом не узнаёт никто.
 *
 * p-timeout@4 оборачивает так:
 *   (async () => { try { resolve(await promise) } catch (e) { reject(e) } })()
 * Внутренний промис отреван — `unhandledRejection` не будет; но `reject(e)`
 * зовётся у промиса, который таймер отклонил минуту назад, то есть это no-op.
 * Телеграф свой catch отработал тогда же и второй раз не придёт. Итог: ни
 * `[bot-catch]`, ни UNCAUGHT, ни строчки в логе.
 *
 * Пять минут HANDLER_TIMEOUT_MS перебирает тяжёлый ход smm (web_search +
 * обложка + публикация) — тот самый, где падение дороже всего.
 */
import { describe, expect, test, spyOn, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import type { Context } from "telegraf";
import pTimeout from "p-timeout";
import { log } from "../lib/log.ts";
import { buildErrorGuard, buildLateErrorCatcher } from "../lib/bot-error-guard.ts";

const CHAT = "-100777";
const ALLOWED = [CHAT];

function fakeCtx(): Context {
  return {
    chat: { id: Number(CHAT) },
    update: { update_id: 42 },
    reply: async () => undefined,
  } as unknown as Context;
}

function timeoutError(): Error {
  const e = new Error("Promise timed out after 300000 milliseconds");
  e.name = "TimeoutError";
  return e;
}

const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => {
  while (spies.length) spies.pop()!.mockRestore();
});

function spyErrors(): string[] {
  const seen: string[] = [];
  const s = spyOn(log, "error").mockImplementation(((m: string) => {
    seen.push(m);
  }) as never);
  spies.push(s as unknown as { mockRestore: () => void });
  return seen;
}

describe("предпосылки: p-timeout молча съедает поздний reject", () => {
  test("после таймаута отказ внутреннего промиса не всплывает нигде", async () => {
    let rejectLate: (e: unknown) => void = () => {};
    const inner = new Promise((_, rej) => {
      rejectLate = rej;
    });
    const wrapped = pTimeout(inner, 10);

    const first = await wrapped.then(
      () => "resolved",
      (e: { name?: string }) => e?.name,
    );
    expect(first).toBe("TimeoutError");

    // Хендлер падает уже после таймаута.
    let late: unknown = "не всплыло";
    const onUnhandled = (e: unknown) => {
      late = e;
    };
    process.on("unhandledRejection", onUnhandled);
    rejectLate(new Error("упал после таймаута"));
    await new Promise((r) => setTimeout(r, 20));
    process.off("unhandledRejection", onUnhandled);

    // Ни второго reject у обёртки, ни unhandledRejection: ошибка исчезла.
    expect(late).toBe("не всплыло");
    await expect(wrapped).rejects.toThrow(/timed out/);
  });
});

describe("buildLateErrorCatcher", () => {
  test("до таймаута ошибка пробрасывается как раньше", async () => {
    const catcher = buildLateErrorCatcher("orchestrator");
    const ctx = fakeCtx();
    const boom = new Error("бум");
    await expect(
      catcher(ctx, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });

  test("после таймаута ошибка не пробрасывается, но попадает в лог", async () => {
    const seen = spyErrors();
    const guard = buildErrorGuard("orchestrator", ALLOWED);
    const catcher = buildLateErrorCatcher("orchestrator");
    const ctx = fakeCtx();

    await guard(timeoutError(), ctx);
    await catcher(ctx, async () => {
      throw new Error("упал после таймаута");
    });

    expect(seen.some((m) => m.includes("уже после таймаута"))).toBe(true);
  });

  test("метка живёт на своём апдейте, а не на всех сразу", async () => {
    const guard = buildErrorGuard("orchestrator", ALLOWED);
    const timedOut = fakeCtx();
    const other = fakeCtx();
    await guard(timeoutError(), timedOut);

    const boom = new Error("бум");
    await expect(
      buildLateErrorCatcher("orchestrator")(other, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });

  test("обычная ошибка апдейт не метит — следующая пробрасывается", async () => {
    const guard = buildErrorGuard("orchestrator", ALLOWED);
    const ctx = fakeCtx();
    await guard(new Error("обычное падение"), ctx);

    const boom = new Error("бум");
    await expect(
      buildLateErrorCatcher("orchestrator")(ctx, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });

  test("успешный хендлер проходит насквозь", async () => {
    let ran = false;
    await buildLateErrorCatcher("orchestrator")(fakeCtx(), async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  test("без ctx ошибка пробрасывается, а не глотается", async () => {
    const boom = new Error("бум");
    await expect(
      buildLateErrorCatcher("orchestrator")(undefined as unknown as Context, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });
});

describe("прежнее поведение guard не съехало", () => {
  test("таймаут по-прежнему отвечает своим текстом", async () => {
    spyErrors();
    const replies: string[] = [];
    const ctx = {
      chat: { id: Number(CHAT) },
      update: { update_id: 42 },
      reply: async (t: string) => {
        replies.push(t);
      },
    } as unknown as Context;
    await buildErrorGuard("orchestrator", ALLOWED)(timeoutError(), ctx);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("Не успел");
  });

  test("чужой чат метится, но ответа не получает", async () => {
    spyErrors();
    const replies: string[] = [];
    const ctx = {
      chat: { id: -100999 },
      update: { update_id: 7 },
      reply: async (t: string) => {
        replies.push(t);
      },
    } as unknown as Context;
    await buildErrorGuard("orchestrator", ALLOWED)(timeoutError(), ctx);
    expect(replies).toEqual([]);
    // Метка ставится до проверки allowlist: молчание в чужом чате — про ответ,
    // а не про лог.
    await buildLateErrorCatcher("orchestrator")(ctx, async () => {
      throw new Error("упал после таймаута");
    });
  });
});

describe("применение", () => {
  const SRC = readFileSync(new URL("../lib/bot-error-guard.ts", import.meta.url), "utf8");
  const CODE = SRC.split("\n")
    .filter((l) => {
      const t = l.trimStart();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");

  test("ловушка регистрируется там же, где guard", () => {
    expect(CODE).toContain("bot.catch(buildErrorGuard(agentKey, allowed));");
    expect(CODE).toContain("bot.use(buildLateErrorCatcher(agentKey));");
    // Строго после bot.catch и до всего остального: middleware видит только то,
    // что зарегистрировано ниже по цепочке.
    expect(CODE.indexOf("bot.catch(")).toBeLessThan(CODE.indexOf("bot.use("));
  });

  test("метка ставится в guard до логирования и ответа", () => {
    const body = CODE.slice(CODE.indexOf("return async (err, ctx) => {"));
    expect(body.indexOf("TIMED_OUT_UPDATES.add(ctx)")).toBeLessThan(body.indexOf("log.error("));
  });
});
