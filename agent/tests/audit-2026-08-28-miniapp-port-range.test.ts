/**
 * Аудит 2026-08-28: MINIAPP_PORT проверялся потолком таймера, а не порта.
 *
 * Значение читалось через `_envPositiveInt`, у которого граница — MAX_TIMER_MS
 * (2^31-1). Для интервала это верно, для порта — не значит ничего:
 * `MINIAPP_PORT=87878` (лишняя цифра в 8787) целое, положительное, меньше
 * потолка, и доезжает до Bun.serve целиком.
 *
 * Bun при этом не бросает, а молча зажимает порт в 65535 — см. тест
 * «предпосылки» ниже. В логе бодрое «Mini App backend on :87878», nginx
 * ходит в 8787 и не находит никого. Ровно тот же класс, что MAC_BRIDGE_PORT
 * с NaN до аудита 2026-08-08, и чинится так же (`_resolveBridgePort`).
 */
import { describe, test, expect, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { _envPort, _envPositiveInt } from "../orchestrator/services.ts";
import { DEFAULT_MINIAPP_PORT } from "../lib/constants.ts";

const VAR = "TEST_PORT_RANGE_PROBE";
const prev = process.env[VAR];

afterEach(() => {
  // Без восстановления env течёт в соседние тесты (CLAUDE.md §3.8 п.7).
  if (prev === undefined) delete process.env[VAR];
  else process.env[VAR] = prev;
});

const SERVICES_SRC = readFileSync(
  new URL("../orchestrator/services.ts", import.meta.url),
  "utf-8",
);

describe("предпосылки", () => {
  test("Bun.serve молча зажимает порт вне диапазона, а не бросает", () => {
    // Смысл всей правки: отказа, по которому видно причину, здесь не будет.
    const s = Bun.serve({ port: 70000, fetch: () => new Response("ok") });
    const bound = s.port;
    s.stop(true);
    expect(bound).toBe(65535);
  });

  test("прежний санитайзер такое значение пропускал", () => {
    process.env[VAR] = "87878";
    expect(_envPositiveInt(VAR, 8787)).toBe(87878);
  });
});

describe("_envPort", () => {
  test("значение вне диапазона портов — дефолт", () => {
    for (const bad of ["87878", "65536", "70000", "2147483647"]) {
      process.env[VAR] = bad;
      expect(_envPort(VAR, 8787)).toBe(8787);
    }
  });

  test("нуль, отрицательное, дробное и мусор — тоже дефолт", () => {
    for (const bad of ["0", "-1", "8787.5", "abc", "8787abc", " "]) {
      process.env[VAR] = bad;
      expect(_envPort(VAR, 8787)).toBe(8787);
    }
  });

  test("пусто и отсутствие — дефолт", () => {
    process.env[VAR] = "";
    expect(_envPort(VAR, 8787)).toBe(8787);
    delete process.env[VAR];
    expect(_envPort(VAR, 8787)).toBe(8787);
  });

  test("рабочие значения проходят, границы включительно", () => {
    for (const [raw, want] of [
      ["8787", 8787],
      ["8788", 8788],
      ["1", 1],
      ["65535", 65535],
    ] as const) {
      process.env[VAR] = raw;
      expect(_envPort(VAR, 8787)).toBe(want);
    }
  });
});

describe("применение", () => {
  test("MINIAPP_PORT читается портовым санитайзером и общим дефолтом", () => {
    expect(SERVICES_SRC).toContain('_envPort("MINIAPP_PORT", DEFAULT_MINIAPP_PORT)');
    expect(SERVICES_SRC).not.toContain('_envPositiveInt("MINIAPP_PORT"');
    // Дефолт больше не литерал рядом с константой того же значения.
    expect(DEFAULT_MINIAPP_PORT).toBe(8787);
  });

  test("потолок объявлен константой и применён в проверке", () => {
    expect(SERVICES_SRC).toContain("const MAX_PORT = 65535;");
    expect(SERVICES_SRC).toContain("n <= MAX_PORT");
  });
});
