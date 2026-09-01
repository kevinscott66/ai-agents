/**
 * Аудит 2026-08-08: ANTHROPIC_LARGE_MODEL на проде не влиял ни на что.
 *
 * USE_AGENT_SDK=true, а `opts.model` в query() не передавался — CLI брал свою
 * дефолтную модель. Переменная выглядела рабочей ручкой и ею не была. Просто
 * пробросить opts.model нельзя: там API-шный id, CLI ждёт свои имена, и
 * неизвестное имя роняет ход всех 12 ролей — поэтому отдельная переменная
 * (как ANTHROPIC_SMALL_MODEL_SDK у компактора), а незаданная означает прежнее
 * поведение.
 *
 * Заодно maxTurns: разбор был `Number(env) || 14` и пропускал отрицательные и
 * дробные значения.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { sdkModelOverride, sdkMaxTurns } from "../lib/agent-sdk-runtime.ts";

const SAVED = {
  model: process.env.ANTHROPIC_LARGE_MODEL_SDK,
  iters: process.env.MAX_TOOL_ITERS,
};

function setEnv(k: string, v: string | undefined): void {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

afterEach(() => {
  setEnv("ANTHROPIC_LARGE_MODEL_SDK", SAVED.model);
  setEnv("MAX_TOOL_ITERS", SAVED.iters);
});

describe("sdkModelOverride", () => {
  test("не задана → undefined (дефолт CLI, прежнее поведение)", () => {
    setEnv("ANTHROPIC_LARGE_MODEL_SDK", undefined);
    expect(sdkModelOverride()).toBeUndefined();
  });

  test("пустая строка и пробелы — тоже «не задана»", () => {
    setEnv("ANTHROPIC_LARGE_MODEL_SDK", "");
    expect(sdkModelOverride()).toBeUndefined();
    setEnv("ANTHROPIC_LARGE_MODEL_SDK", "   ");
    expect(sdkModelOverride()).toBeUndefined();
  });

  test("задана → отдаётся без пробелов по краям", () => {
    setEnv("ANTHROPIC_LARGE_MODEL_SDK", " opus ");
    expect(sdkModelOverride()).toBe("opus");
  });
});

describe("sdkMaxTurns", () => {
  test("не задана → 14, как на raw-пути", () => {
    setEnv("MAX_TOOL_ITERS", undefined);
    expect(sdkMaxTurns()).toBe(14);
  });

  test("нормальное число", () => {
    setEnv("MAX_TOOL_ITERS", "6");
    expect(sdkMaxTurns()).toBe(6);
  });

  test("мусор, ноль и отрицательные откатываются к 14", () => {
    for (const v of ["0", "-1", "abc", "", "  "]) {
      setEnv("MAX_TOOL_ITERS", v);
      expect(sdkMaxTurns()).toBe(14);
    }
  });

  test("дробное усекается до целого, а не уходит в SDK как есть", () => {
    setEnv("MAX_TOOL_ITERS", "7.9");
    expect(sdkMaxTurns()).toBe(7);
  });
});
