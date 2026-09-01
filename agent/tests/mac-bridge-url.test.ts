/**
 * Аудит 2026-08-13: демон отдавал MAC_BRIDGE_SECRET первому, кто ответит.
 *
 * `ws.addEventListener("open", …)` шлёт `{type:"auth", secret}` сразу, до
 * любого обмена, а проверка на старте смотрела только на непустоту URL. Плата
 * за опечатку в хосте или за `ws://` при выносе бриджа наружу — ключ запуска
 * `claude` на Mac с доступом к MAC_PROJECT_ROOTS. Все адреса в документации
 * репо на момент аудита — plaintext `ws://localhost`, то есть заметить переход
 * «localhost → удалённый хост» было бы не на чем.
 *
 * Проверяется предикат, а не демон: `daemon.ts` вызывает `connect()` на уровне
 * модуля, импорт его в тест поднял бы сокет и потомков.
 */
import { describe, test, expect } from "bun:test";
import { bridgeSecretTransportError } from "../mac-daemon/bridge-url.ts";

describe("wss:// доверяем всегда", () => {
  test("удалённый хост по TLS проходит", () => {
    expect(bridgeSecretTransportError("wss://agents.example.com:8787")).toBeNull();
  });

  test("wss на петлю тоже проходит", () => {
    expect(bridgeSecretTransportError("wss://localhost:8788")).toBeNull();
  });
});

describe("ws:// — только петля", () => {
  test.each([
    "ws://localhost:8788",
    "ws://127.0.0.1:8788",
    "ws://127.0.0.2:8788",
    "ws://[::1]:8788",
    "ws://LOCALHOST:8788",
  ])("%s проходит", (url) => {
    expect(bridgeSecretTransportError(url)).toBeNull();
  });

  test("удалённый хост открытым текстом — отказ", () => {
    const err = bridgeSecretTransportError("ws://203.0.113.10:8788");
    expect(err).toBeTruthy();
    // Сообщение должно называть виновника: иначе владелец не поймёт, что чинить.
    expect(err).toContain("203.0.113.10");
    expect(err).toContain("wss://");
  });

  test("похожий на петлю, но чужой адрес не проходит", () => {
    // 127.0.0.1.example.com и 1270.0.0.1 — классические обходы наивной проверки.
    expect(bridgeSecretTransportError("ws://127.0.0.1.example.com")).toBeTruthy();
    expect(bridgeSecretTransportError("ws://1270.0.0.1")).toBeTruthy();
    expect(bridgeSecretTransportError("ws://127.0.0.999")).toBeTruthy();
    expect(bridgeSecretTransportError("ws://localhost.attacker.tld")).toBeTruthy();
  });
});

describe("прочие схемы и мусор", () => {
  test.each(["http://localhost:8788", "https://localhost:8788", "file:///tmp/x"])(
    "%s — отказ",
    (url) => {
      expect(bridgeSecretTransportError(url)).toContain("ws:// or wss://");
    },
  );

  test("непарсящийся URL — отказ, а не исключение", () => {
    expect(bridgeSecretTransportError("не-урл")).toContain("not a valid URL");
    expect(bridgeSecretTransportError("")).toContain("not a valid URL");
  });
});

describe("лазейка для уже зашифрованного транспорта", () => {
  test("флаг снимает запрет с ws:// наружу", () => {
    expect(bridgeSecretTransportError("ws://100.64.0.7:8788", true)).toBeNull();
  });

  test("флаг не легализует чужую схему и мусор", () => {
    expect(bridgeSecretTransportError("http://example.com", true)).toBeTruthy();
    expect(bridgeSecretTransportError("не-урл", true)).toBeTruthy();
  });

  test("по умолчанию лазейка закрыта", () => {
    expect(bridgeSecretTransportError("ws://100.64.0.7:8788")).toBeTruthy();
  });
});
