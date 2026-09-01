/**
 * T-726: разбор протокола моста в mac-демоне.
 *
 * Раньше входящий кадр уходил в обработчик как `msg as RunMsg` — слепой каст.
 * `run` без `project` не отсеивался: `pathResolve(undefined)` бросал TypeError
 * внутри `handleRun`, `.catch` его логировал, и ответа мост не получал вовсе —
 * вызывающий видел `mac_timeout`, то есть «мак завис» вместо «кадр кривой».
 *
 * Инвариант, который держат эти тесты: на кривой `run` с адресуемым `id` демон
 * обязан вернуть ошибку, а не промолчать; и ни один кривой кадр не должен
 * доехать до спавна процесса.
 */
import { test, expect, describe } from "bun:test";
import {
  parseBridgeMsg,
  toPermissionMode,
  RUN_MODES,
} from "../mac-daemon/protocol.ts";

const okRun = {
  type: "run",
  id: "r1",
  project: "/Users/x/programs/p",
  prompt: "hi",
  mode: "plan",
};

describe("parseBridgeMsg — валидный трафик", () => {
  test("полный run разбирается как есть", () => {
    expect(parseBridgeMsg(JSON.stringify(okRun))).toEqual({
      type: "run",
      id: "r1",
      project: "/Users/x/programs/p",
      prompt: "hi",
      mode: "plan",
    });
  });

  test("run без mode получает самый строгий режим, а не пустой", () => {
    const { mode, ...noMode } = okRun;
    const parsed = parseBridgeMsg(JSON.stringify(noMode));
    expect(parsed).toMatchObject({ type: "run", mode: "ask" });
    expect(toPermissionMode("ask")).toBe("default");
  });

  test("служебные кадры разбираются", () => {
    expect(parseBridgeMsg('{"type":"ping"}')).toEqual({ type: "ping" });
    expect(parseBridgeMsg('{"type":"auth_ok"}')).toEqual({ type: "auth_ok" });
    expect(parseBridgeMsg('{"type":"stop"}')).toEqual({ type: "stop" });
    expect(parseBridgeMsg('{"type":"cancel","id":"r1"}')).toEqual({
      type: "cancel",
      id: "r1",
    });
    expect(parseBridgeMsg('{"type":"auth_fail","error":"bad_secret"}')).toEqual({
      type: "auth_fail",
      error: "bad_secret",
    });
  });

  test("auth_fail без текста ошибки не падает", () => {
    expect(parseBridgeMsg('{"type":"auth_fail"}')).toEqual({
      type: "auth_fail",
      error: undefined,
    });
  });

  test("нестроковый data приводится к строке перед разбором", () => {
    // ev.data у WebSocket не обязан быть string — раньше это делал сам daemon.
    expect(parseBridgeMsg(Buffer.from('{"type":"ping"}'))).toEqual({
      type: "ping",
    });
  });
});

describe("parseBridgeMsg — кривой run отвечает, а не молчит", () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["без project", { type: "run", id: "r1", prompt: "hi" }, /project/],
    ["project не строка", { type: "run", id: "r1", project: 42, prompt: "hi" }, /project/],
    ["project пустой", { type: "run", id: "r1", project: "", prompt: "hi" }, /project/],
    ["без prompt", { type: "run", id: "r1", project: "/p" }, /prompt/],
    ["prompt не строка", { type: "run", id: "r1", project: "/p", prompt: {} }, /prompt/],
    [
      "неизвестный mode",
      { type: "run", id: "r1", project: "/p", prompt: "hi", mode: "yolo" },
      /unknown mode/,
    ],
  ];
  for (const [name, raw, re] of cases) {
    test(name, () => {
      const parsed = parseBridgeMsg(JSON.stringify(raw));
      expect(parsed).toMatchObject({ type: "bad_run", id: "r1" });
      expect((parsed as { reason: string }).reason).toMatch(re);
    });
  }

  test("неизвестный mode НЕ подменяется молча на разрешающий", () => {
    const parsed = parseBridgeMsg(
      JSON.stringify({ ...okRun, mode: "bypassPermissions" }),
    );
    // Даже похожее на валидное значение CLI — отказ: рассинхрон версий моста и
    // демона не должен тихо расширять права исполнения на машине владельца.
    expect(parsed).toMatchObject({ type: "bad_run" });
  });
});

describe("parseBridgeMsg — молча роняем то, на что некому ответить", () => {
  for (const raw of [
    "не json",
    "null",
    '"строка"',
    "[]",
    "42",
    '{"type":"run"}', // без id — мост не сопоставит ответ
    '{"type":"run","id":""}',
    '{"type":"run","id":7,"project":"/p","prompt":"x"}',
    '{"type":"cancel"}', // отменять нечего: id — единственный адрес прогона
    '{"type":"cancel","id":""}',
    '{"type":"unknown_kind"}',
    "{}",
  ]) {
    test(`${raw} → null`, () => {
      expect(parseBridgeMsg(raw)).toBeNull();
    });
  }
});

describe("toPermissionMode", () => {
  test("пять наших режимов → четыре режима CLI", () => {
    expect(toPermissionMode("ask")).toBe("default");
    expect(toPermissionMode("accept_edits")).toBe("acceptEdits");
    expect(toPermissionMode("auto")).toBe("acceptEdits");
    expect(toPermissionMode("plan")).toBe("plan");
    expect(toPermissionMode("bypass")).toBe("bypassPermissions");
  });

  test("auto не даёт больше прав, чем accept_edits", () => {
    // SEC-audit LOW-1: "auto" когда-то уходил в CLI как есть, и неизвестное
    // значение будущий CLI мог счесть разрешающим.
    expect(toPermissionMode("auto")).toBe(toPermissionMode("accept_edits"));
    expect(toPermissionMode("auto")).not.toBe("bypassPermissions");
  });

  test("каждый объявленный режим отображается в валидное значение CLI", () => {
    const valid = new Set([
      "default",
      "acceptEdits",
      "plan",
      "bypassPermissions",
    ]);
    for (const m of RUN_MODES) expect(valid.has(toPermissionMode(m))).toBe(true);
  });
});
