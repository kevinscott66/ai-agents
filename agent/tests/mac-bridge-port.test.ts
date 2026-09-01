/**
 * Аудит 2026-08-08: опечатка в MAC_BRIDGE_PORT уводила мост на случайный порт.
 *
 * Порт читался как `Number(process.env.MAC_BRIDGE_PORT ?? DEFAULT)`. NaN от
 * опечатки Bun.serve трактует как «порт 0» и поднимает сервер на случайном
 * эфемерном порту (проверено на рантайме проекта: 62257). Старт при этом
 * успешный, в логе «listening», а ssh-туннель с Mac стучится в фиксированный
 * порт и не находит никого: MAC_RUN_CLAUDE перестаёт работать молча.
 */
import { describe, test, expect } from "bun:test";
import { _resolveBridgePort } from "../lib/mac-bridge.ts";
import { DEFAULT_MAC_BRIDGE_PORT } from "../lib/constants.ts";

describe("_resolveBridgePort", () => {
  test("мусор откатывается к дефолту, а не к случайному порту", () => {
    for (const bad of ["abc", "8788x", "", "порт", "1e4x"]) {
      expect(_resolveBridgePort(bad)).toBe(DEFAULT_MAC_BRIDGE_PORT);
    }
  });

  test("значения вне диапазона портов отвергаются", () => {
    for (const bad of ["0", "-1", "65536", "99999", "8788.5"]) {
      expect(_resolveBridgePort(bad)).toBe(DEFAULT_MAC_BRIDGE_PORT);
    }
  });

  test("не задано — дефолт", () => {
    expect(_resolveBridgePort(undefined)).toBe(DEFAULT_MAC_BRIDGE_PORT);
  });

  test("корректный порт уважается", () => {
    expect(_resolveBridgePort("9001")).toBe(9001);
    expect(_resolveBridgePort("65535")).toBe(65535);
    expect(_resolveBridgePort("1")).toBe(1);
  });
});

describe("почему это важно", () => {
  test("Bun.serve действительно поднимается на случайном порту при NaN", () => {
    // Тест-документация: иначе «NaN → случайный порт» выглядит домыслом.
    const s = Bun.serve({
      port: NaN as unknown as number,
      hostname: "127.0.0.1",
      fetch: () => new Response("x"),
    });
    try {
      expect(s.port).not.toBe(DEFAULT_MAC_BRIDGE_PORT);
      expect(s.port).toBeGreaterThan(0);
    } finally {
      s.stop(true);
    }
  });
});
