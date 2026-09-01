/**
 * Аудит 2026-08-20: getFixChainMaxDepth() пропускал ноль.
 *
 * Проверка на месте вызова — `parentChain.length >= maxDepth`
 * (action-dispatch.ts). При maxDepth=0 она истинна на ПУСТОЙ цепочке, то есть
 * при первом же падении любого действия. Одна опечатка в .env выключала
 * self-diag целиком и подменяла настоящий текст ошибки на «circuit breaker
 * tripped (fix_chain depth 0 >= 0)».
 */
import { describe, it, expect, afterEach } from "bun:test";
import {
  getFixChainMaxDepth,
  diagTaskThrottleMax,
  getFixChain,
  appendFixChain,
} from "../lib/fix-chain.ts";

const DEPTH = "INTER_AGENT_FIX_CHAIN_MAX_DEPTH";
const RATE = "DIAG_TASK_MAX_PER_HOUR";
const savedDepth = process.env[DEPTH];
const savedRate = process.env[RATE];

afterEach(() => {
  if (savedDepth === undefined) delete process.env[DEPTH];
  else process.env[DEPTH] = savedDepth;
  if (savedRate === undefined) delete process.env[RATE];
  else process.env[RATE] = savedRate;
});

/** Ровно то, что делает action-dispatch.ts на месте вызова. */
const trips = (chainLength: number) => chainLength >= getFixChainMaxDepth();

describe("потолок цепочки не может стать нулём", () => {
  const zeroish = ["0", "-0", "0.4", "0.9", " 0 ", "+0"];
  for (const v of zeroish) {
    it(`${DEPTH}=${JSON.stringify(v)} → дефолт 3, а не 0`, () => {
      process.env[DEPTH] = v;
      expect(getFixChainMaxDepth()).toBe(3);
    });
  }

  it("на пустой цепочке брейкер не срабатывает ни при одном из этих значений", () => {
    for (const v of zeroish) {
      process.env[DEPTH] = v;
      // Это и есть сам дефект: до правки trips(0) === true, то есть
      // «сработал анти-луп» на первом же падении.
      expect(trips(0)).toBe(false);
    }
  });

  const bad = ["-1", "-3", "garbage", "NaN", "Infinity", "-Infinity"];
  for (const v of bad) {
    it(`${DEPTH}=${JSON.stringify(v)} → дефолт 3`, () => {
      process.env[DEPTH] = v;
      expect(getFixChainMaxDepth()).toBe(3);
    });
  }

  it("валидные значения по-прежнему работают", () => {
    for (const [v, want] of [
      ["1", 1],
      ["3", 3],
      ["5", 5],
      ["3.9", 3],
    ] as const) {
      process.env[DEPTH] = v;
      expect(getFixChainMaxDepth()).toBe(want);
    }
  });

  it("пусто и отсутствие переменной — дефолт 3", () => {
    process.env[DEPTH] = "";
    expect(getFixChainMaxDepth()).toBe(3);
    delete process.env[DEPTH];
    expect(getFixChainMaxDepth()).toBe(3);
  });

  it("=1 срабатывает на первом звене, но не на пустой цепочке", () => {
    process.env[DEPTH] = "1";
    expect(trips(0)).toBe(false);
    expect(trips(1)).toBe(true);
  });
});

describe("оба потолка модуля валидируются одинаково", () => {
  it("throttle тоже отвергает ноль и мусор", () => {
    for (const v of ["0", "-0", "-1", "garbage", "0.4"]) {
      process.env[RATE] = v;
      expect(diagTaskThrottleMax()).toBe(5);
    }
  });

  it("throttle принимает валидное", () => {
    process.env[RATE] = "2";
    expect(diagTaskThrottleMax()).toBe(2);
  });

  it("ни один потолок не может вернуть значение < 1", () => {
    // Инвариант, ради которого правка и делалась: обе функции — это «сколько
    // раз можно», и ноль тут означает не «ноль раз», а «всегда стоп».
    for (const v of ["0", "-0", "-1", "0.4", "garbage", "", "1"]) {
      process.env[DEPTH] = v;
      process.env[RATE] = v;
      expect(getFixChainMaxDepth()).toBeGreaterThanOrEqual(1);
      expect(diagTaskThrottleMax()).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("чистые хелперы не тронуты", () => {
  it("getFixChain фильтрует не-строки и не-массивы", () => {
    expect(getFixChain({ _fix_chain: ["a", 1, null, "b"] })).toEqual(["a", "b"]);
    expect(getFixChain({ _fix_chain: "a" })).toEqual([]);
    expect(getFixChain(null)).toEqual([]);
    expect(getFixChain("nope")).toEqual([]);
  });

  it("appendFixChain не мутирует вход", () => {
    const src = ["a"];
    expect(appendFixChain(src, "b")).toEqual(["a", "b"]);
    expect(src).toEqual(["a"]);
  });
});
