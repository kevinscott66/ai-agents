/**
 * Аудит 2026-08-20: демон исполнял `run` от кого угодно, кто занял адрес моста.
 *
 * Аутентификация между мостом и демоном односторонняя: демон первым же кадром
 * доказывает себя секретом (`mac-bridge.ts:340-385` держит `state.authed` и до
 * него ничего от клиента не принимает), а мост себя не доказывает ничем. В
 * `daemon.ts` не было ни одной проверки, что `auth_ok` вообще приходил: switch
 * по `msg.type` исполнял `run` сразу.
 *
 * Реальный вектор — плейнтекст на loopback, который `bridge-url.ts` намеренно
 * разрешает (боевая схема — SSH-туннель на 127.0.0.1:8787). Любой локальный
 * процесс, занявший порт раньше туннеля, становится «мостом»: секрет ему не
 * нужен — он его просто игнорирует и шлёт `run` с `mode: "bypass"`, то есть
 * получает исполнение `claude --permission-mode bypassPermissions` в проекте
 * владельца. Аллоулист проектов при этом соблюдён и ничего не ловит.
 *
 * Гейт закрывает направление мост→демон симметрично: до `auth_ok` принимаются
 * только служебные кадры (`ping`/`auth_ok`/`auth_fail`), всё исполняемое —
 * после.
 */
import { test, expect, describe } from "bun:test";
import { createAuthGate } from "../mac-daemon/auth-gate.ts";
import { parseBridgeMsg } from "../mac-daemon/protocol.ts";

const RUN = JSON.stringify({
  type: "run",
  id: "r1",
  project: "/tmp/x",
  prompt: "p",
  mode: "bypass",
});

describe("BridgeAuthGate (аудит 2026-08-20)", () => {
  test("новый гейт не аутентифицирован", () => {
    expect(createAuthGate().authenticated).toBe(false);
  });

  test("run до auth_ok отбрасывается", () => {
    const g = createAuthGate();
    expect(g.accepts(parseBridgeMsg(RUN))).toBe(false);
  });

  test("run после auth_ok исполняется", () => {
    const g = createAuthGate();
    g.markAuthenticated();
    expect(g.accepts(parseBridgeMsg(RUN))).toBe(true);
  });

  test("cancel и stop до auth_ok тоже отбрасываются", () => {
    const g = createAuthGate();
    // `stop` без гейта — это kill всех активных прогонов по кадру от кого
    // угодно, то есть отказ в обслуживании даром.
    expect(g.accepts(parseBridgeMsg(JSON.stringify({ type: "stop" })))).toBe(false);
    expect(
      g.accepts(parseBridgeMsg(JSON.stringify({ type: "cancel", id: "r1" }))),
    ).toBe(false);
    g.markAuthenticated();
    expect(g.accepts(parseBridgeMsg(JSON.stringify({ type: "stop" })))).toBe(true);
    expect(
      g.accepts(parseBridgeMsg(JSON.stringify({ type: "cancel", id: "r1" }))),
    ).toBe(true);
  });

  test("кривой run (bad_run) до auth_ok тоже отбрасывается", () => {
    const g = createAuthGate();
    const bad = parseBridgeMsg(JSON.stringify({ type: "run", id: "r1" }));
    expect(bad).toEqual({
      type: "bad_run",
      id: "r1",
      reason: "project must be a non-empty string",
    });
    // Ответ на bad_run — это подтверждение «демон здесь и слушает» тому, кто
    // ещё не доказал, что он мост.
    expect(g.accepts(bad)).toBe(false);
  });

  test("ping принимается до auth_ok — иначе мост не дождётся pong", () => {
    const g = createAuthGate();
    expect(g.accepts(parseBridgeMsg(JSON.stringify({ type: "ping" })))).toBe(true);
  });

  test("auth_ok и auth_fail принимаются до auth_ok", () => {
    const g = createAuthGate();
    expect(g.accepts(parseBridgeMsg(JSON.stringify({ type: "auth_ok" })))).toBe(true);
    expect(
      g.accepts(parseBridgeMsg(JSON.stringify({ type: "auth_fail", error: "bad_secret" }))),
    ).toBe(true);
  });

  test("markAuthenticated переводит состояние необратимо в рамках гейта", () => {
    const g = createAuthGate();
    g.markAuthenticated();
    g.markAuthenticated();
    expect(g.authenticated).toBe(true);
  });

  test("гейты независимы: реконнект не наследует аутентификацию", () => {
    // Ради этого гейт — объект на соединение, а не модульный флаг: иначе один
    // удачный коннект к настоящему мосту открывал бы двери всем последующим,
    // включая коннект к тому, кто занял порт после падения туннеля.
    const first = createAuthGate();
    first.markAuthenticated();
    const second = createAuthGate();
    expect(second.authenticated).toBe(false);
    expect(second.accepts(parseBridgeMsg(RUN))).toBe(false);
  });

  test("null (мусорный кадр) не принимается", () => {
    const g = createAuthGate();
    g.markAuthenticated();
    expect(g.accepts(parseBridgeMsg("не json"))).toBe(false);
  });
});

describe("daemon.ts подключён к гейту", () => {
  // Модульных тестов на сам daemon.ts быть не может: это скрипт с побочками на
  // импорте (`process.exit(1)` при отсутствии env, `connect()` в конце файла) —
  // ровно та причина, по которой из него в T-726 вынесли `protocol.ts`. Поэтому
  // проводка проверяется по исходнику: без неё гейт есть, но не работает.
  const src = require("node:fs").readFileSync(
    new URL("../mac-daemon/daemon.ts", import.meta.url),
    "utf8",
  ) as string;

  test("импортирует createAuthGate", () => {
    expect(src).toContain("createAuthGate");
  });

  test("гейт создаётся внутри connect(), а не в модульной области", () => {
    const connectAt = src.indexOf("function connect()");
    expect(connectAt).toBeGreaterThan(-1);
    const gateAt = src.indexOf("createAuthGate()");
    expect(gateAt).toBeGreaterThan(connectAt);
  });

  test("проверка гейта стоит до switch по типу сообщения", () => {
    const gateCheck = src.indexOf("gate.accepts(");
    const dispatch = src.indexOf("switch (msg.type)");
    expect(gateCheck).toBeGreaterThan(-1);
    expect(dispatch).toBeGreaterThan(-1);
    expect(gateCheck).toBeLessThan(dispatch);
  });

  test("auth_ok отмечает гейт аутентифицированным", () => {
    expect(src).toContain("gate.markAuthenticated()");
  });
});
