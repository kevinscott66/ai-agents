/**
 * Аудит 2026-08-28: остановленный роутер отдавал живые handle.
 *
 * `getAgentHandle` проверял `this.stopped` ТРЕТЬИМ — после кэша `sessions` и
 * после карты `starting`. То есть проверка срабатывала только когда `stopAll()`
 * уже дошёл до `sessions.clear()`, самой последней своей строки.
 *
 * А `stopAll()` зовут из `orchestrator/services.ts` БЕЗ await, параллельно с
 * живым диспатчем, и между `this.stopped = true` и `clear()` он ждёт сперва
 * все стартующие сессии, потом все `handle.stop()`. На сети это секунды. Всё
 * это время карта полна — и параллельный `setReaction`/`deleteMessage` получал
 * handle, чей gramjs-клиент прямо сейчас отключают. Вызов уходил в исключение
 * вместо тихого фолбэка на синглтон, ради которого null и возвращается.
 *
 * Ниже — обе половины окна (готовая сессия и стартующая), фолбэк на синглтон
 * и охранители по исходнику: порядок проверок иначе непроверяем, потому что
 * снаружи он наблюдается только через тайминг.
 */
import { test, expect, describe, afterEach } from "bun:test";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { UserbotRouter } from "../lib/userbot-router.ts";
import { setCurrentUserbot, getCurrentUserbot } from "../lib/userbot.ts";

const SRC = readFileSync(new URL("../lib/userbot-router.ts", import.meta.url), "utf8");
const DEFAULTS: Array<string | number> = [-1001];

function sessionFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "ubstop-"));
  const f = join(dir, "agent.session");
  writeFileSync(f, "stub");
  return f;
}

/** Тело `getAgentHandle` — от сигнатуры до начала приватного `startSession`. */
function handleFnBody(): string {
  const from = SRC.indexOf("async getAgentHandle(agentKey: string)");
  const to = SRC.indexOf("private async startSession(");
  expect(from).toBeGreaterThan(0);
  expect(to).toBeGreaterThan(from);
  return SRC.slice(from, to);
}

function fakeHandle(tag: string, onStop?: () => Promise<void>) {
  return {
    isNoop: false,
    tag,
    stops: 0,
    async stop() {
      (this as any).stops++;
      if (onStop) await onStop();
    },
    async setReaction() {
      throw new Error(`${tag}: клиент уже отключён`);
    },
    async deleteMessage() {
      throw new Error(`${tag}: клиент уже отключён`);
    },
  } as any;
}

function makeRouter(): UserbotRouter {
  const router = new UserbotRouter({ onMessage: () => {}, defaultAllowedChatIds: DEFAULTS });
  router.registerAgent("smm", { sessionFile: sessionFile(), allowedChatIds: [-1001] });
  return router;
}

afterEach(() => {
  setCurrentUserbot(null);
});

describe("окно остановки: handle не выдаётся", () => {
  test("готовая сессия не отдаётся, пока stopAll ещё гасит её", async () => {
    const router = makeRouter();
    let release: () => void = () => {};
    const stopping = new Promise<void>((r) => {
      release = r;
    });
    const handle = fakeHandle("smm", () => stopping);
    (router as any).sessions.set("smm", handle);

    const all = router.stopAll();
    // Мы внутри окна: stop() позвали, sessions.clear() ещё не было.
    expect((router as any).sessions.size).toBe(1);
    expect(handle.stops).toBe(1);

    expect(await router.getAgentHandle("smm")).toBeNull();

    release();
    await all;
    expect((router as any).sessions.size).toBe(0);
  });

  test("стартующая сессия тоже не отдаётся: stopAll её же и погасит", async () => {
    const router = makeRouter();
    let release: () => void = () => {};
    const pending = new Promise<void>((r) => {
      release = r;
    });
    const handle = fakeHandle("smm");
    (router as any).startSession = async (agentKey: string) => {
      await pending;
      (router as any).sessions.set(agentKey, handle);
      return handle;
    };

    const first = router.getAgentHandle("smm");
    expect((router as any).starting.size).toBe(1);

    const all = router.stopAll();
    expect(await router.getAgentHandle("smm")).toBeNull();

    release();
    expect(await first).toBe(handle);
    await all;
    // Стартовавшая в окне сессия всё равно погашена — инвариант 2026-08-27.
    expect(handle.stops).toBe(1);
    expect((router as any).sessions.size).toBe(0);
  });

  /**
   * Пересмотрено 2026-08-28 (аудит идентичности). Раньше здесь пиналось
   * обратное: «в окне остановки уходим на синглтон». Это и был дефект — smm
   * ЗАРЕГИСТРИРОВАН в makeRouter(), значит оператор объявил ему личную
   * сессию, и подмена её на общий аккаунт владельца — ровно та подмена
   * личности, которую запрещает `getUserbotHandle`. Окно остановки —
   * частный случай «объявлена, но сейчас недоступна», и обращаться с ним
   * иначе, чем с протухшим файлом сессии, не за что.
   *
   * Инвариант самого окна («отключённый клиент наружу не отдаётся») жив:
   * синглтон не зовут, handle не отдают.
   */
  test("setReaction в окне остановки отказывает, а не подменяет аккаунт", async () => {
    const router = makeRouter();
    let release: () => void = () => {};
    const stopping = new Promise<void>((r) => {
      release = r;
    });
    (router as any).sessions.set("smm", fakeHandle("smm", () => stopping));

    const calls: string[] = [];
    setCurrentUserbot({
      isNoop: false,
      async setReaction(chatId: number | string, msgId: number, emoji: string) {
        calls.push(`${chatId}/${msgId}/${emoji}`);
      },
    } as any);

    const all = router.stopAll();
    await expect(router.setReaction("smm", -1001, 42, "👍")).rejects.toThrow(
      "No userbot session available",
    );
    expect(calls).toEqual([]);

    release();
    await all;
  });

  test("deleteMessage в окне остановки — тоже отказ", async () => {
    const router = makeRouter();
    let release: () => void = () => {};
    const stopping = new Promise<void>((r) => {
      release = r;
    });
    (router as any).sessions.set("smm", fakeHandle("smm", () => stopping));

    const calls: string[] = [];
    setCurrentUserbot({
      isNoop: false,
      async deleteMessage(chatId: number | string, msgId: number) {
        calls.push(`${chatId}/${msgId}`);
      },
    } as any);

    const all = router.stopAll();
    await expect(router.deleteMessage("smm", -1001, 7)).rejects.toThrow(
      "No userbot session available",
    );
    expect(calls).toEqual([]);

    release();
    await all;
  });

  test("без синглтона окно остановки даёт явную ошибку, а не отключённый клиент", async () => {
    const router = makeRouter();
    let release: () => void = () => {};
    const stopping = new Promise<void>((r) => {
      release = r;
    });
    (router as any).sessions.set("smm", fakeHandle("smm", () => stopping));
    setCurrentUserbot(null);
    expect(getCurrentUserbot()).toBeNull();

    const all = router.stopAll();
    await expect(router.setReaction("smm", -1001, 42, "👍")).rejects.toThrow(
      "No userbot session available",
    );

    release();
    await all;
  });
});

describe("инварианты 2026-08-27 не тронуты", () => {
  test("после завершённого stopAll новая сессия не поднимается", async () => {
    const router = makeRouter();
    let starts = 0;
    (router as any).startSession = async (agentKey: string) => {
      starts++;
      const h = fakeHandle(agentKey);
      (router as any).sessions.set(agentKey, h);
      return h;
    };

    await router.stopAll();
    expect(await router.getAgentHandle("smm")).toBeNull();
    expect(starts).toBe(0);
  });

  test("до остановки handle отдаётся как раньше — и кэшируется", async () => {
    const router = makeRouter();
    let starts = 0;
    const handle = fakeHandle("smm");
    (router as any).startSession = async (agentKey: string) => {
      starts++;
      (router as any).sessions.set(agentKey, handle);
      return handle;
    };

    expect(await router.getAgentHandle("smm")).toBe(handle);
    expect(await router.getAgentHandle("smm")).toBe(handle);
    expect(starts).toBe(1);
  });

  test("незарегистрированный агент по-прежнему даёт null", async () => {
    const router = makeRouter();
    expect(await router.getAgentHandle("qa")).toBeNull();
  });
});

describe("охранители по исходнику", () => {
  test("проверка stopped стоит раньше кэша sessions и карты starting", () => {
    const body = handleFnBody();
    const stopped = body.indexOf("if (this.stopped)");
    const cache = body.indexOf("this.sessions.has(agentKey)");
    const starting = body.indexOf("this.starting.get(agentKey)");
    expect(stopped).toBeGreaterThan(0);
    expect(cache).toBeGreaterThan(stopped);
    expect(starting).toBeGreaterThan(stopped);
  });

  test("stopAll ставит флаг до первого await", () => {
    const from = SRC.indexOf("async stopAll()");
    const to = SRC.indexOf("getActiveAgents()");
    expect(from).toBeGreaterThan(0);
    const body = SRC.slice(from, to);
    const flag = body.indexOf("this.stopped = true;");
    const firstAwait = body.indexOf("await Promise.allSettled");
    expect(flag).toBeGreaterThan(0);
    expect(firstAwait).toBeGreaterThan(flag);
  });

  test("флаг не сбрасывается нигде, кроме объявления", () => {
    expect(SRC.split("this.stopped = ").length - 1).toBe(1);
    expect(SRC).not.toContain("this.stopped = false");
  });
});
