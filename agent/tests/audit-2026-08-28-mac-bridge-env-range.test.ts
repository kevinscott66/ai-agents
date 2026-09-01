/**
 * Аудит 2026-08-28: пять настроек моста читались префиксом строки.
 *
 * Шестая настройка — порт — уже читается строго (`_resolveBridgePort`, аудит
 * 2026-08-08). Остальные пять шли через `Number.parseInt`, а он берёт
 * ЛИДИРУЮЩИЙ префикс и молча выбрасывает хвост, и верхней границы у них не
 * было вовсе. Ни один негодный случай не давал ошибки при старте: значение
 * принималось, лог оставался бодрым, ломалось поведение.
 *
 * Цена, в порядке заметности:
 *  - `MAC_RUN_TIMEOUT_MS=600_000` (привычная запись пяти минут) → 600 мс:
 *    каждый прогон рвётся по таймауту почти сразу. MAC_RUN_CLAUDE — это
 *    единственный способ команды из 12 ролей дотянуться до Mac и его скиллов.
 *  - `MAC_BRIDGE_AUTH_TIMEOUT_MS=1e4` → 1 мс вместо десяти секунд: демон не
 *    успевает аутентифицироваться никогда, мост выглядит поднятым и пустым.
 *  - Любое значение ≥ 2^31 у обоих таймеров переполняет 32-битный счётчик, и
 *    setTimeout срабатывает через 1 мс.
 *  - `MAC_MAX_CONCURRENT_RUNS` — это число процессов `claude` на машине
 *    владельца, каждый в режиме bypass. Потолка не было.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  _readMaxConcurrentRuns,
  _readRunTimeoutMs,
  bridgeConnectionLimits,
} from "../lib/mac-bridge.ts";
import { MINUTE_MS } from "../lib/time-constants.ts";
import { MAX_TIMER_MS } from "../lib/constants.ts";

const VARS = [
  "MAC_RUN_TIMEOUT_MS",
  "MAC_MAX_CONCURRENT_RUNS",
  "MAC_BRIDGE_MAX_CONNECTIONS",
  "MAC_BRIDGE_MAX_CONNECTIONS_PER_IP",
  "MAC_BRIDGE_AUTH_TIMEOUT_MS",
] as const;
const saved = new Map(VARS.map((v) => [v, process.env[v]]));

afterEach(() => {
  // Без восстановления env течёт в соседние файлы: bun гоняет каталог одним
  // процессом (CLAUDE.md §3.8 п.7).
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Формы, которые `parseInt` принимал, отрезав хвост. */
const PREFIXED = ["600_000", "10m", "5 minutes", "8080abc"] as const;

describe("предпосылки", () => {
  test("parseInt берёт префикс, Number — нет", () => {
    expect(Number.parseInt("600_000", 10)).toBe(600);
    expect(Number.parseInt("10m", 10)).toBe(10);
    expect(Number.parseInt("5 minutes", 10)).toBe(5);
    expect(Number.parseInt("0x20", 10)).toBe(0);
    for (const raw of PREFIXED) expect(Number.isInteger(Number(raw))).toBe(false);
  });

  test("`1e4` — не мусор, а десять тысяч: parseInt делал из них единицу", () => {
    // Единственная из разобранных форм, где строгий разбор не отвергает
    // значение, а возвращает автору написанное.
    expect(Number.parseInt("1e4", 10)).toBe(1);
    expect(Number("1e4")).toBe(10_000);
    process.env.MAC_BRIDGE_AUTH_TIMEOUT_MS = "1e4";
    expect(bridgeConnectionLimits().authTimeoutMs).toBe(10_000);
  });

  test("таймер за 2^31 срабатывает почти сразу, а не через вечность", async () => {
    // Значение принимается, ошибки нет — просто таймаут наступает мгновенно.
    const t0 = Date.now();
    await new Promise<void>((r) => setTimeout(r, 2 ** 31));
    expect(Date.now() - t0).toBeLessThan(200);
  });
});

describe("MAC_RUN_TIMEOUT_MS", () => {
  test("префиксные формы отбрасываются, а не подрезаются", () => {
    for (const raw of PREFIXED) {
      process.env.MAC_RUN_TIMEOUT_MS = raw;
      expect(_readRunTimeoutMs()).toBe(5 * MINUTE_MS);
    }
  });

  test("значение за потолком таймера отбрасывается", () => {
    for (const raw of [String(MAX_TIMER_MS + 1), "1e12", String(2 ** 31)]) {
      process.env.MAC_RUN_TIMEOUT_MS = raw;
      expect(_readRunTimeoutMs()).toBe(5 * MINUTE_MS);
    }
  });

  test("годные значения проходят, границы включительно", () => {
    for (const [raw, want] of [
      ["1", 1],
      ["600000", 600_000],
      [String(MAX_TIMER_MS), MAX_TIMER_MS],
    ] as const) {
      process.env.MAC_RUN_TIMEOUT_MS = raw;
      expect(_readRunTimeoutMs()).toBe(want);
    }
  });

  test("пусто, ноль, отрицательное и мусор — дефолт", () => {
    for (const raw of ["", "0", "-1", "abc", " "]) {
      process.env.MAC_RUN_TIMEOUT_MS = raw;
      expect(_readRunTimeoutMs()).toBe(5 * MINUTE_MS);
    }
    delete process.env.MAC_RUN_TIMEOUT_MS;
    expect(_readRunTimeoutMs()).toBe(5 * MINUTE_MS);
  });
});

describe("MAC_MAX_CONCURRENT_RUNS", () => {
  test("префиксные формы отбрасываются", () => {
    for (const raw of PREFIXED) {
      process.env.MAC_MAX_CONCURRENT_RUNS = raw;
      expect(_readMaxConcurrentRuns()).toBe(2);
    }
  });

  test("у числа процессов claude на маке есть потолок", () => {
    for (const raw of ["33", "1000", "1e6"]) {
      process.env.MAC_MAX_CONCURRENT_RUNS = raw;
      expect(_readMaxConcurrentRuns()).toBe(2);
    }
  });

  test("годные значения проходят", () => {
    for (const [raw, want] of [
      ["1", 1],
      ["4", 4],
      ["32", 32],
    ] as const) {
      process.env.MAC_MAX_CONCURRENT_RUNS = raw;
      expect(_readMaxConcurrentRuns()).toBe(want);
    }
  });
});

describe("bridgeConnectionLimits", () => {
  test("префиксные формы отбрасываются во всех трёх настройках", () => {
    for (const raw of PREFIXED) {
      process.env.MAC_BRIDGE_MAX_CONNECTIONS = raw;
      process.env.MAC_BRIDGE_MAX_CONNECTIONS_PER_IP = raw;
      process.env.MAC_BRIDGE_AUTH_TIMEOUT_MS = raw;
      expect(bridgeConnectionLimits()).toEqual({
        total: 16,
        perIp: 4,
        authTimeoutMs: 10_000,
      });
    }
  });

  test("окно аутентификации не переполняет таймер", () => {
    process.env.MAC_BRIDGE_AUTH_TIMEOUT_MS = String(2 ** 31);
    expect(bridgeConnectionLimits().authTimeoutMs).toBe(10_000);
  });

  test("у числа соединений есть потолок", () => {
    process.env.MAC_BRIDGE_MAX_CONNECTIONS = "1025";
    process.env.MAC_BRIDGE_MAX_CONNECTIONS_PER_IP = "1e9";
    expect(bridgeConnectionLimits().total).toBe(16);
    expect(bridgeConnectionLimits().perIp).toBe(4);
  });

  test("годные значения проходят", () => {
    process.env.MAC_BRIDGE_MAX_CONNECTIONS = "32";
    process.env.MAC_BRIDGE_MAX_CONNECTIONS_PER_IP = "8";
    process.env.MAC_BRIDGE_AUTH_TIMEOUT_MS = "30000";
    expect(bridgeConnectionLimits()).toEqual({
      total: 32,
      perIp: 8,
      authTimeoutMs: 30_000,
    });
  });
});
