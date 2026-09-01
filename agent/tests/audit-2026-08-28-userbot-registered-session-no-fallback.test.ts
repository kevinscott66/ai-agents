/**
 * Аудит 2026-08-28: провалившаяся персональная сессия молча уходила на личный
 * аккаунт владельца.
 *
 * Откат на синглтон делался ТРИЖДЫ на одном пути: сперва в `getUserbotHandle`,
 * потом в каждой из двух копий `resolveUserbotHandle`
 * (`lib/action-dispatch.ts`, `lib/dispatch/telegram.ts`). Для агента БЕЗ
 * объявленной сессии это исходный режим и он верен. Для агента, чья сессия
 * ОБЪЯВЛЕНА оператором, но не поднялась, — это подмена личности: оператор
 * заводит `USERBOT_SESSION_SMM` ровно затем, чтобы smm ходил со своего
 * аккаунта; файл сессии протухает (Telegram инвалидирует их штатно) — и
 * каждая следующая публикация уходит В КАНАЛ с личного аккаунта владельца,
 * а действие отчитывается `ok, via: "userbot"`. Ни строки о подмене.
 *
 * Через эти же резолверы ходят PUBLISH_TO_CHANNEL, WRITE_WIKI, SCHEDULE_POST
 * и CREATE_TEAM_CHANNEL — ни один не ограничен оркестратором, в отличие от
 * `via_userbot`-путей, вокруг которых построен весь SEC-4.
 *
 * Решение об откате теперь принимается ровно в одном месте, поэтому копии
 * резолверов проверяются охранителями по исходнику: обе приватны и завязаны
 * на живой gramjs.
 */
import { test, expect, describe, afterEach } from "bun:test";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  UserbotRouter,
  getUserbotHandle,
  setUserbotRouter,
} from "../lib/userbot-router.ts";
import { setCurrentUserbot } from "../lib/userbot.ts";

const DISPATCH_SRC = readFileSync(new URL("../lib/action-dispatch.ts", import.meta.url), "utf8");
const TELEGRAM_SRC = readFileSync(new URL("../lib/dispatch/telegram.ts", import.meta.url), "utf8");
const DEFAULTS: Array<string | number> = [-1001];

function sessionFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "ubfall-"));
  const f = join(dir, "agent.session");
  writeFileSync(f, "stub");
  return f;
}

const OWNER = { isNoop: false, who: "owner-singleton" } as any;

function routerWith(agents: string[]): UserbotRouter {
  const router = new UserbotRouter({ onMessage: () => {}, defaultAllowedChatIds: DEFAULTS });
  for (const key of agents) {
    router.registerAgent(key, { sessionFile: sessionFile(), allowedChatIds: [-1001] });
  }
  return router;
}

/** Тело функции по имени — до следующего `export`/объявления верхнего уровня. */
function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  expect(a).toBeGreaterThan(0);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

afterEach(() => {
  setUserbotRouter(null);
  setCurrentUserbot(null);
});

describe("объявленная сессия не деградирует до общего аккаунта", () => {
  test("сессия объявлена и не поднялась → null, а не аккаунт владельца", async () => {
    const router = routerWith(["smm"]);
    (router as any).startSession = async () => null;
    setUserbotRouter(router);
    setCurrentUserbot(OWNER);

    expect(await getUserbotHandle("smm")).toBeNull();
  });

  test("сессия объявлена и поднялась → отдаётся именно она, не синглтон", async () => {
    const router = routerWith(["smm"]);
    const own = { isNoop: false, who: "smm-session" } as any;
    (router as any).startSession = async (agentKey: string) => {
      (router as any).sessions.set(agentKey, own);
      return own;
    };
    setUserbotRouter(router);
    setCurrentUserbot(OWNER);

    expect(await getUserbotHandle("smm")).toBe(own);
  });

  test("сессия НЕ объявлена → откат на синглтон как раньше", async () => {
    const router = routerWith(["smm"]);
    setUserbotRouter(router);
    setCurrentUserbot(OWNER);

    expect(await getUserbotHandle("qa")).toBe(OWNER);
  });

  test("роутера нет вовсе → синглтон", async () => {
    setUserbotRouter(null);
    setCurrentUserbot(OWNER);

    expect(await getUserbotHandle("smm")).toBe(OWNER);
  });

  test("без agentKey решать нечего → синглтон", async () => {
    setUserbotRouter(routerWith(["smm"]));
    setCurrentUserbot(OWNER);

    expect(await getUserbotHandle()).toBe(OWNER);
  });

  test("остановленный роутер: объявленный агент не уходит на владельца", async () => {
    const router = routerWith(["smm"]);
    setUserbotRouter(router);
    setCurrentUserbot(OWNER);
    await router.stopAll();

    expect(await getUserbotHandle("smm")).toBeNull();
    // Незарегистрированный — по-прежнему синглтон: это исходный режим.
    expect(await getUserbotHandle("qa")).toBe(OWNER);
  });

  test("отказ одного агента не трогает соседнего", async () => {
    const router = routerWith(["smm", "design"]);
    const own = { isNoop: false, who: "design-session" } as any;
    (router as any).startSession = async (agentKey: string) => {
      if (agentKey === "smm") return null;
      (router as any).sessions.set(agentKey, own);
      return own;
    };
    setUserbotRouter(router);
    setCurrentUserbot(OWNER);

    expect(await getUserbotHandle("smm")).toBeNull();
    expect(await getUserbotHandle("design")).toBe(own);
  });
});

describe("охранители по исходнику: второго отката нет", () => {
  test("action-dispatch отдаёт результат getUserbotHandle как есть", () => {
    const body = slice(DISPATCH_SRC, "async function resolveUserbotHandle", "\n}\n\n\n/**");
    expect(body).toContain("return await getUserbotHandle(ctx.agentKey);");
    // Ветка catch больше не проваливается на синглтон.
    const catchIdx = body.indexOf("} catch (error) {");
    const singleton = body.indexOf("return getCurrentUserbot();");
    expect(catchIdx).toBeGreaterThan(0);
    expect(singleton).toBeGreaterThan(catchIdx);
    expect(body.slice(catchIdx, singleton)).toContain("return null;");
  });

  test("dispatch/telegram не откатывается после ветки роутера", () => {
    const body = slice(TELEGRAM_SRC, "async function resolveUserbotHandle", "\n/**");
    expect(body).toContain("return uh && !uh.isNoop ? uh : null;");
    // Синглтон остаётся только для случая «роутер выключен».
    expect(body.split("return getCurrentUserbot();").length - 1).toBe(1);
  });

  test("оба резолвера ходят через общую точку решения", () => {
    expect(DISPATCH_SRC).toContain("getUserbotHandle(ctx.agentKey)");
    expect(TELEGRAM_SRC).toContain("getUserbotHandle(ctx.agentKey)");
  });
});
