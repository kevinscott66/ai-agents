/**
 * Аудит 2026-08-28, два отказа запуска юзербота, которые молчат не о том.
 *
 * (1) Подключённый клиент утекал. `_startRealClient` после успешного
 * `connect()` делает ещё три вещи — динамический импорт событий,
 * `registerSelfAccount`, `addEventHandler`. Любая из них может бросить, и
 * тогда ошибка уходила наверх мимо `disconnect()`: у `startUserbot` её ловит
 * общий catch и возвращает no-op, а живой MTProto-клиент остаётся с
 * работающим `_updateLoop` — тем самым, который уже гасили в ветке
 * `connect() === false`. Ссылки на него не остаётся ни у кого: погасить
 * некому и нечем. При рестартах по таймеру такие клиенты копятся на аккаунте.
 *
 * (2) Забытый ключ выглядел как сломанная сессия. Файл, начинающийся с `v1:`,
 * зашифрован (`tools/userbot-login.ts:53`). Если `USERBOT_SESSION_KEY` не
 * задан — а из systemd `KEY=` приходит пустой строкой, то есть ровно этим
 * случаем — расшифровка просто пропускалась, и в `StringSession` уезжал
 * литерал `v1:iv:tag:enc`. Дальше gramjs отвечал отказом подключения, и
 * оператор читал в логе про сеть и сессию. Причина же — одна забытая
 * переменная окружения, и она известна до первого байта в сеть.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _startRealClient, startUserbot } from "../lib/userbot.ts";
import type { StartUserbotOpts, UserbotClientLike } from "../lib/userbot.ts";
import { _resetSelfAccounts } from "../lib/userbot-self-sends.ts";

const OPTS: StartUserbotOpts = { onMessage: () => {}, allowedChatIds: [-100500] };
const API = {} as any;

let dir = "";
const prevId = process.env.TELEGRAM_API_ID;
const prevHash = process.env.TELEGRAM_API_HASH;
const prevKey = process.env.USERBOT_SESSION_KEY;

beforeEach(() => {
  _resetSelfAccounts();
  dir = mkdtempSync(join(tmpdir(), "ub-start-"));
  process.env.TELEGRAM_API_ID = "12345";
  process.env.TELEGRAM_API_HASH = "hash";
  delete process.env.USERBOT_SESSION_KEY;
});

afterEach(() => {
  _resetSelfAccounts();
  rmSync(dir, { recursive: true, force: true });
  // bun гоняет каталог одним процессом — env обязан вернуться (CLAUDE.md §3.8 п.7).
  for (const [k, v] of [
    ["TELEGRAM_API_ID", prevId],
    ["TELEGRAM_API_HASH", prevHash],
    ["USERBOT_SESSION_KEY", prevKey],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

interface Fake extends UserbotClientLike {
  disconnected: number;
}

function fakeClient(onAdd: () => void): Fake {
  const f: Fake = {
    disconnected: 0,
    async connect() {
      return true;
    },
    async disconnect() {
      f.disconnected += 1;
    },
    addEventHandler() {
      onAdd();
    },
    async invoke() {
      throw new Error("не должно вызываться");
    },
    async deleteMessages() {
      throw new Error("не должно вызываться");
    },
    async getInputEntity() {
      throw new Error("не должно вызываться");
    },
    async sendMessage() {
      throw new Error("не должно вызываться");
    },
    async getMe() {
      return { id: 777 };
    },
  } as Fake;
  return f;
}

describe("подключённый клиент не остаётся брошенным", () => {
  test("падение после connect() гасит соединение", async () => {
    const c = fakeClient(() => {
      throw new Error("addEventHandler не поддержан");
    });
    await expect(_startRealClient(c, API, OPTS)).rejects.toThrow(/addEventHandler/);
    expect(c.disconnected).toBe(1);
  });

  test("ошибка запуска по-прежнему уходит наверх — её ждёт catch в startUserbot", async () => {
    // Гасим соединение, но не проглатываем причину: наружу должен идти
    // прежний `start failed: ...`, а не тихий no-op без объяснения.
    const c = fakeClient(() => {
      throw new Error("боом");
    });
    await expect(_startRealClient(c, API, OPTS)).rejects.toThrow("боом");
  });

  test("disconnect() тоже бросил — наружу идёт исходная причина", async () => {
    const c = fakeClient(() => {
      throw new Error("исходная причина");
    });
    c.disconnect = async () => {
      c.disconnected += 1;
      throw new Error("already dead");
    };
    await expect(_startRealClient(c, API, OPTS)).rejects.toThrow("исходная причина");
    expect(c.disconnected).toBe(1);
  });

  test("успешный запуск ничего не гасит", async () => {
    const c = fakeClient(() => {});
    const h = await _startRealClient(c, API, OPTS);
    expect(h.isNoop).toBe(false);
    expect(c.disconnected).toBe(0);
  });
});

describe("зашифрованная сессия без ключа названа причиной", () => {
  function session(content: string): string {
    const p = join(dir, "userbot.session");
    writeFileSync(p, content);
    return p;
  }

  test("v1: без USERBOT_SESSION_KEY — no-op, и клиент даже не строится", async () => {
    let built = 0;
    const h = await startUserbot({
      ...OPTS,
      sessionPath: session("v1:aXY=:dGFn:ZW5j"),
      _clientFactory: async () => {
        built += 1;
        throw new Error("сюда не должны дойти");
      },
    } as StartUserbotOpts);
    expect(h.isNoop).toBe(true);
    expect(built).toBe(0);
  });

  test("пустой USERBOT_SESSION_KEY считается отсутствующим", async () => {
    // Из systemd `USERBOT_SESSION_KEY=` приходит пустой строкой, а не undefined.
    process.env.USERBOT_SESSION_KEY = "";
    let built = 0;
    const h = await startUserbot({
      ...OPTS,
      sessionPath: session("v1:aXY=:dGFn:ZW5j"),
      _clientFactory: async () => {
        built += 1;
        throw new Error("сюда не должны дойти");
      },
    } as StartUserbotOpts);
    expect(h.isNoop).toBe(true);
    expect(built).toBe(0);
  });

  test("сырой блоб больше не уезжает в StringSession", async () => {
    let seen: string | undefined;
    await startUserbot({
      ...OPTS,
      sessionPath: session("v1:aXY=:dGFn:ZW5j"),
      _clientFactory: async (s: string) => {
        seen = s;
        throw new Error("stop");
      },
    } as StartUserbotOpts);
    expect(seen).toBeUndefined();
  });

  test("незашифрованная сессия без ключа отклоняется до построения клиента", async () => {
    let seen: string | undefined;
    await startUserbot({
      ...OPTS,
      sessionPath: session("1BQANOTEuMTA4LjU2"),
      _clientFactory: async (s: string) => {
        seen = s;
        throw new Error("stop");
      },
    } as StartUserbotOpts);
    expect(seen).toBeUndefined();
  });
});
