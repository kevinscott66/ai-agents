/**
 * Аудит 2026-08-28: провал подключения юзербота выглядел как успех.
 *
 * `startUserbot` делал `await real.connect();` и выбрасывал результат. У
 * gramjs это не исключение: `MTProtoSender.connect` ловит каждую из пяти
 * попыток внутри себя и возвращает `this._finishedConnecting`, а
 * `TelegramClient.connect` на неудаче возвращает `false`
 * (`TelegramClient.js:1088-1093`). То есть падения не было — было `false`,
 * которое никто не смотрел.
 *
 * Дальше всё шло по счастливому пути: `registerSelfAccount` глотает свой
 * `getMe` в log.warn (так и задумано), обработчик вешался на мёртвого
 * клиента, `buildHandle` отдавал хендл с `isNoop: false`, а
 * `orchestrator/services.ts:347` печатал «[userbot] connected, listening».
 * Вместо честного no-op (у которого методы говорят «userbot not available»)
 * команда получала живой на вид юзербот, ломающийся на первом же вызове.
 *
 * Отдельно: в ветке отказа gramjs успевает запустить `_updateLoop`
 * (`TelegramClient.js:1089-1092`), поэтому брошенный клиент — это ещё и
 * работающий цикл переподключения. Его надо гасить явно.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { _startRealClient, buildHandle } from "../lib/userbot.ts";
import type { StartUserbotOpts, UserbotClientLike } from "../lib/userbot.ts";
import { _resetSelfAccounts } from "../lib/userbot-self-sends.ts";

const OPTS: StartUserbotOpts = { onMessage: () => {}, allowedChatIds: [-100500] };
const API = {} as any;

interface Fake extends UserbotClientLike {
  added: number;
  disconnected: number;
  gotMe: number;
}

function fakeClient(
  connect: () => Promise<boolean | void>,
  disconnect: () => Promise<void> = async () => {},
): Fake {
  const f: Fake = {
    added: 0,
    disconnected: 0,
    gotMe: 0,
    connect,
    async disconnect() {
      f.disconnected += 1;
      await disconnect();
    },
    addEventHandler() {
      f.added += 1;
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
      f.gotMe += 1;
      return { id: 777 };
    },
  };
  return f;
}

beforeEach(() => {
  // Реестр своих аккаунтов глобальный, а bun гоняет каталог одним процессом.
  _resetSelfAccounts();
});
afterEach(() => {
  _resetSelfAccounts();
});

describe("предпосылки", () => {
  test("gramjs сообщает о провале возвратом, а не исключением", () => {
    // Если этот тест покраснел после обновления telegram — предпосылку правки
    // надо перепроверить: возможно, connect стал бросать.
    const sender = readFileSync(
      new URL("../node_modules/telegram/network/MTProtoSender.js", import.meta.url),
      "utf8",
    );
    expect(sender).toContain("return this._finishedConnecting;");
    const client = readFileSync(
      new URL("../node_modules/telegram/client/TelegramClient.js", import.meta.url),
      "utf8",
    );
    expect(client).toContain("if (!(await this._sender.connect(connection, false))) {");
  });

  test("хендл, построенный из клиента, живой по определению", () => {
    // Поэтому единственное место, где можно отличить мёртвое подключение от
    // живого, — до buildHandle.
    expect(buildHandle(fakeClient(async () => true), API).isNoop).toBe(false);
  });
});

describe("_startRealClient", () => {
  test("connect() вернул false — отдаём no-op, а не живой хендл", async () => {
    const c = fakeClient(async () => false);
    const h = await _startRealClient(c, API, OPTS);
    expect(h.isNoop).toBe(true);
    // Методы у no-op честно отказывают, а не падают где-то в gramjs.
    await expect(h.setReaction(-100500, 1, "👍")).rejects.toThrow(/not available/);
  });

  test("брошенный клиент гасится: цикл переподключения не остаётся жить", async () => {
    const c = fakeClient(async () => false);
    await _startRealClient(c, API, OPTS);
    expect(c.disconnected).toBe(1);
    // На мёртвом клиенте ни обработчика, ни getMe быть не должно.
    expect(c.added).toBe(0);
    expect(c.gotMe).toBe(0);
  });

  test("disconnect() бросил — всё равно no-op, а не падение запуска", async () => {
    const c = fakeClient(
      async () => false,
      async () => {
        throw new Error("already dead");
      },
    );
    const h = await _startRealClient(c, API, OPTS);
    expect(h.isNoop).toBe(true);
    expect(c.disconnected).toBe(1);
  });

  test("успешный connect() — прежнее поведение целиком", async () => {
    const c = fakeClient(async () => true);
    const h = await _startRealClient(c, API, OPTS);
    expect(h.isNoop).toBe(false);
    expect(c.added).toBe(1);
    expect(c.gotMe).toBe(1);
    expect(c.disconnected).toBe(0);
  });

  test("connect() без возврата (void) — это успех, а не отказ", async () => {
    // Отказом считается ровно `false`. Клиенты из фабрик ничего не возвращают,
    // и `!undefined` превратило бы их в no-op на ровном месте.
    const c = fakeClient(async () => undefined);
    const h = await _startRealClient(c, API, OPTS);
    expect(h.isNoop).toBe(false);
    expect(c.added).toBe(1);
  });

  test("connect() бросил — ошибка уходит наверх, где её ждёт catch запуска", async () => {
    const c = fakeClient(async () => {
      throw new Error("network down");
    });
    await expect(_startRealClient(c, API, OPTS)).rejects.toThrow(/network down/);
  });
});

describe("применение", () => {
  test("реальная ветка запуска идёт через ту же функцию", () => {
    const src = readFileSync(new URL("../lib/userbot.ts", import.meta.url), "utf8");
    const i = src.indexOf("export async function startUserbot");
    expect(i).toBeGreaterThan(-1);
    // Конец региона — объявление СЛЕДУЮЩЕЙ функции, а не текст докблока над
    // ней: докблок переписывают, объявление — нет. Прежний якорь
    // («Экспортируется для тестов») к тому же встречается в файле дважды, то
    // есть держался на том, что первое вхождение окажется нужным.
    //
    // Тянуть конец дальше, до `_startRealClient`, нельзя: утверждение здесь —
    // об ОТСУТСТВИИ строки, а докблок `_startRealClient` эту строку цитирует
    // в прозе. Регион должен кончаться там, где кончается сама функция.
    const end = src.indexOf("export function makeHandler(", i);
    expect(end).toBeGreaterThan(i);
    const body = src.slice(i, end);
    expect(body).toContain("_startRealClient(");
    // Голого `await real.connect()` в запуске больше нет.
    expect(body).not.toContain("await real.connect()");
  });
});
