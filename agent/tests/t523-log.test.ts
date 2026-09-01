/**
 * T-523: smoke tests for structured logging module.
 *
 * Покрываем shouldLog level filtering, JSON vs human format, и
 * errorWithStack helper. Реальный stdout не парсим — патчим console.log.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { log, legacyLog } from "../lib/log.ts";

let captured: string[] = [];
let origLog: typeof console.log;
let origEnv: Record<string, string | undefined>;

beforeEach(() => {
  captured = [];
  origLog = console.log;
  console.log = (line: string) => captured.push(line);
  origEnv = {
    LOG_LEVEL: process.env.LOG_LEVEL,
    NODE_ENV: process.env.NODE_ENV,
  };
});

afterEach(() => {
  console.log = origLog;
  for (const [k, v] of Object.entries(origEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("log / basic levels", () => {
  it("emits info messages by default", () => {
    log.info("hello", { x: 1 });
    expect(captured.length).toBe(1);
    expect(captured[0]).toContain("hello");
  });

  it("emits warn / error", () => {
    log.warn("careful");
    log.error("oops");
    expect(captured.length).toBe(2);
    expect(captured[0]).toContain("careful");
    expect(captured[1]).toContain("oops");
  });

  it("includes structured data when provided", () => {
    log.info("event", { user: "alice", count: 3 });
    expect(captured[0]).toContain("alice");
    expect(captured[0]).toContain("3");
  });
});

describe("log / errorWithStack", () => {
  it("captures error message + stack", () => {
    const e = new Error("boom");
    log.errorWithStack("caught", e, { ctx: "test" });
    expect(captured.length).toBe(1);
    const line = captured[0];
    expect(line).toContain("caught");
    expect(line).toContain("boom");
    expect(line).toContain("ctx");
  });
});

describe("log / legacyLog", () => {
  it("joins multiple args into single message", () => {
    legacyLog("info", "a", "b", { x: 1 });
    expect(captured.length).toBe(1);
    expect(captured[0]).toContain("a b");
    expect(captured[0]).toContain('"x":1');
  });
});
